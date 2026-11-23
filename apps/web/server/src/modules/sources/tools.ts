import { createHash } from 'node:crypto'
import type { SourceService } from './service.ts'
import type { createWorkspaceSourceResults } from './results.ts'
import { SOURCE_AGENT_TOOLS, type SourceToolName } from '../../../../../../packages/web-contracts/src/source-tools.ts'
import { parsedSourceQueryBatch } from '../../../../../../packages/web-contracts/src/source-query-batch.ts'
import { object, sourceConnectionFailure, sourceError } from './config.ts'
import { isAssistantErrorCode, type AssistantErrorCode } from '../../../../../../packages/web-contracts/src/assistant-errors.ts'

type Sources = Pick<SourceService, 'listSavedMetadata' | 'describe' | 'detail' | 'querySource'>
type Results = Pick<ReturnType<typeof createWorkspaceSourceResults>, 'capture' | 'save' | 'read'>
const uuid = (value: unknown): string => { if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw sourceError(); return value.toLowerCase() }
const safeError = (error: unknown) => {
  const raw = (error as { statusCode?: number }).statusCode
  const status = [400,401,403,404,409,410,413,429,502,503,504].includes(raw ?? 0) ? raw! : 503
  // Only a public classification crosses this boundary, never the message.
  const tagged = (error as { code?: unknown } | null)?.code
  const code: AssistantErrorCode | undefined = isAssistantErrorCode(tagged) ? tagged
    : status === 502 ? 'SOURCE_RESULT_UNUSABLE' : status === 503 ? 'SOURCE_UNAVAILABLE' : status === 504 ? 'SOURCE_TIMEOUT' : undefined
  return Object.assign(new Error('Workspace source tool unavailable'), { statusCode: status, ...(code ? { code } : {}) })
}

export type QueryBatchResult<T> = { items: ({ ok: true; result: T } | { ok: false; status: number; code?: AssistantErrorCode })[] }

async function runQueryBatch<T>(queries: unknown, currentVersion: () => Promise<number>, execute: (sql: string, version: number) => Promise<T>, checkGrant?: () => Promise<void>): Promise<QueryBatchResult<T>> {
  const statements = parsedSourceQueryBatch(queries)
  if (!statements) throw sourceError()
  const version = await currentVersion()
  const items = []
  for (const sql of statements) {
    if (checkGrant) await checkGrant()
    try {
      items.push({ ok: true as const, result: await execute(sql, version) })
    } catch (cause) {
      const error = safeError(cause)
      const statementError = error.statusCode === 400 && (!error.code || error.code === 'SQL_POLICY_REJECTED' || error.code === 'SQL_DATABASE_ERROR')
        || error.statusCode === 403 && error.code === 'SOURCE_SCOPE_DENIED'
        || error.statusCode === 502 && error.code === 'SOURCE_RESULT_UNUSABLE'
        || error.statusCode === 504 && error.code === 'SOURCE_TIMEOUT'
      if (!statementError || (cause as { [sourceConnectionFailure]?: true })?.[sourceConnectionFailure]) throw error
      items.push({ ok: false as const, status: error.statusCode, code: error.code })
    } finally {
      if (checkGrant) await checkGrant()
    }
  }
  if (await currentVersion() !== version) throw sourceError(409)
  return { items }
}

/** Steers the model back to database-side aggregation instead of reasoning over a partial row set. */
export const truncatedNotice = (rows: number) => `TRUNCATED: only the first ${rows} rows were kept (this connection's row or size limit); reading later pages does not recover omitted rows. Do not compute totals, averages, counts, shares or rankings from these rows. Re-query with the computation in SQL instead: GROUP BY with SUM/COUNT/AVG/MIN/MAX, bucket dates (for example date_trunc or DATE_FORMAT), filter to the needed time range, and select only needed columns. If row-level detail is really needed, ORDER BY the relevant measure with an explicit LIMIT and state that the list is partial.`

/** The credential is supplied by trusted request composition, never by model
 * arguments. These tools cannot create connections, reveal secrets, choose an
 * owner/workspace or write arbitrary paths. Query results are captured once. */
export function createWorkspaceSourceTools({ sources, results }: { sources: Sources; results: Results }) {
  return {
    definitions: SOURCE_AGENT_TOOLS,
    async execute(token: string, input: unknown, checkGrant?: () => Promise<void>): Promise<unknown> {
      try {
        const call = object(input, ['name','arguments'])
        if (typeof call.name !== 'string' || !SOURCE_AGENT_TOOLS.some(tool => tool.name === call.name)) throw sourceError()
        const name = call.name as SourceToolName
        if (name === 'sources.list') {
          const args = object(call.arguments, ['after'])
          return sources.listSavedMetadata(token, args)
        }
        if (name === 'sources.describe') {
          const { sourceId, ...filters } = object(call.arguments, ['sourceId','table','tables','schema','tablePrefix','columnOffset'])
          return sources.describe(token, sourceId, filters)
        }
        if (name === 'sources.query') {
          const { sourceId, sql, queries } = object(call.arguments, ['sourceId','sql','queries'])
          const batch = queries !== undefined
          if (batch && sql !== undefined) throw sourceError()
          const query = async (sql?: string, expectedVersion?: number) => {
            const snapshot = await sources.querySource(token, sourceId, sql === undefined ? {} : { sql }, expectedVersion)
            if (expectedVersion !== undefined && (snapshot.sourceId !== sourceId || snapshot.sourceVersion !== expectedVersion)) throw sourceError(409)
            const queryHash = createHash('sha256').update(JSON.stringify({ sourceId: snapshot.sourceId, sourceVersion: snapshot.sourceVersion, sql: sql ?? null })).digest('hex')
            const artifact = await results.capture(token, snapshot, queryHash)
            const preview = snapshot.rows.slice(0, batch ? 3 : 100)
            if (batch && Buffer.byteLength(JSON.stringify(preview)) > 2048) preview.length = 0
            return { artifact, schema: snapshot.schema, timezone: snapshot.timezone, preview,
              totalRows: snapshot.rows.length, sourceTruncated: snapshot.truncated, sha256: snapshot.sha256,
              nextOffset: snapshot.rows.length > preview.length ? preview.length : null,
              notice: snapshot.truncated ? truncatedNotice(snapshot.rows.length) : 'Frozen query result; later reads and saving do not execute SQL again.' }
          }
          if (!batch) return await query(sql)
          const currentVersion = async () => {
            // Hold the source version through the owner session's transaction recheck.
            const { source } = await sources.detail(token, sourceId, true)
            if (!source.enabled) throw sourceError(409)
            if (!source.hasCredential) throw sourceError(503)
            return source.version
          }
          return await runQueryBatch(queries, currentVersion, query, checkGrant)
        }
        if (name === 'sources.save_result') {
          const args = object(call.arguments, ['resultId','name','commandId'])
          return results.save(token, { resultId: uuid(args.resultId), commandId: uuid(args.commandId), name: args.name })
        }
        const args = object(call.arguments, ['resultId','offset','limit'])
        return results.read(token, { resultId: uuid(args.resultId), ...(args.offset === undefined ? {} : { offset: args.offset }), ...(args.limit === undefined ? {} : { limit: args.limit }) })
      } catch (error) { throw safeError(error) }
    },
  }
}
export type WorkspaceSourceTools = ReturnType<typeof createWorkspaceSourceTools>
