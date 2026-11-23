import { createHash } from 'node:crypto'
import type { SourceService } from './service.ts'
import type { createWorkspaceSourceResults } from './results.ts'
import { MAX_BATCH_QUERIES, SOURCE_AGENT_TOOLS, type SourceToolName } from '../../../../../../packages/web-contracts/src/source-tools.ts'
import { object, sourceError } from './config.ts'
import { isAssistantErrorCode, type AssistantErrorCode } from '../../../../../../packages/web-contracts/src/assistant-errors.ts'

type Results = ReturnType<typeof createWorkspaceSourceResults>
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

export async function runQueryBatch<T>(queries: unknown, execute: (sql: string) => Promise<T>) {
  if (!Array.isArray(queries) || queries.length < 1 || queries.length > MAX_BATCH_QUERIES ||
      queries.some(sql => typeof sql !== 'string' || !sql.trim()) ||
      queries.reduce((bytes, sql) => bytes + Buffer.byteLength(sql), 0) > 32768) throw sourceError()
  const items = []
  for (const sql of queries) {
    try {
      items.push({ ok: true as const, result: await execute(sql) })
    } catch (cause) {
      const error = safeError(cause)
      if (![400,502,504].includes(error.statusCode)) throw error
      items.push({ ok: false as const, status: error.statusCode, code: error.code })
    }
  }
  return { items }
}

/** Steers the model back to database-side aggregation instead of reasoning over a partial row set. */
export const truncatedNotice = (rows: number) => `TRUNCATED: only the first ${rows} rows were kept (this connection's row or size limit); reading later pages does not recover omitted rows. Do not compute totals, averages, counts, shares or rankings from these rows. Re-query with the computation in SQL instead: GROUP BY with SUM/COUNT/AVG/MIN/MAX, bucket dates (for example date_trunc or DATE_FORMAT), filter to the needed time range, and select only needed columns. If row-level detail is really needed, ORDER BY the relevant measure with an explicit LIMIT and state that the list is partial.`

/** The credential is supplied by trusted request composition, never by model
 * arguments. These tools cannot create connections, reveal secrets, choose an
 * owner/workspace or write arbitrary paths. Query results are captured once. */
export function createWorkspaceSourceTools({ sources, results }: { sources: SourceService; results: Results }) {
  return {
    definitions: SOURCE_AGENT_TOOLS,
    async execute(token: string, input: unknown, documentId?: string): Promise<unknown> {
      try {
        const call = object(input, ['name','arguments'])
        if (typeof call.name !== 'string' || !SOURCE_AGENT_TOOLS.some(tool => tool.name === call.name)) throw sourceError()
        const name = call.name as SourceToolName
        if (documentId !== undefined && (name === 'sources.list' || name === 'sources.describe' || name === 'sources.query')) {
          await results.requireDocument(token, documentId)
        }
        if (name === 'sources.list') {
          const args = object(call.arguments, ['after'])
          return sources.listSavedMetadata(token, args)
        }
        if (name === 'sources.describe') {
          const { sourceId, ...filters } = object(call.arguments, ['sourceId','table','tables','schema','tablePrefix'])
          return sources.describe(token, sourceId, filters)
        }
        if (name === 'sources.query') {
          const args = object(call.arguments, ['sourceId','sql','queries'])
          const batch = args.queries !== undefined
          if (batch && args.sql !== undefined) throw sourceError()
          const query = async (sql?: string) => {
            const snapshot = await sources.querySource(token, args.sourceId, sql === undefined ? {} : { sql })
            const queryHash = createHash('sha256').update(JSON.stringify({ sourceId: snapshot.sourceId, sourceVersion: snapshot.sourceVersion, sql: sql ?? null })).digest('hex')
            const artifact = await results.capture(token, snapshot, queryHash, documentId)
            const preview = snapshot.rows.slice(0, batch ? 3 : 100)
            if (batch && Buffer.byteLength(JSON.stringify(preview)) > 2048) preview.length = 0
            return { artifact, schema: snapshot.schema, timezone: snapshot.timezone, preview,
              totalRows: snapshot.rows.length, sourceTruncated: snapshot.truncated, sha256: snapshot.sha256,
              nextOffset: snapshot.rows.length > preview.length ? preview.length : null,
              notice: snapshot.truncated ? truncatedNotice(snapshot.rows.length) : 'Frozen query result; later reads and saving do not execute SQL again.' }
          }
          return batch ? await runQueryBatch(args.queries, query) : await query(args.sql)
        }
        if (name === 'sources.save_result') {
          const args = object(call.arguments, ['resultId','name','commandId'])
          return results.save(token, { resultId: uuid(args.resultId), commandId: uuid(args.commandId), name: args.name }, documentId)
        }
        const args = object(call.arguments, ['resultId','offset','limit'])
        return results.read(token, { resultId: uuid(args.resultId), ...(args.offset === undefined ? {} : { offset: args.offset }), ...(args.limit === undefined ? {} : { limit: args.limit }) }, documentId)
      } catch (error) { throw safeError(error) }
    },
  }
}
export type WorkspaceSourceTools = ReturnType<typeof createWorkspaceSourceTools>
