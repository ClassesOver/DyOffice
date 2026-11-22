import { createHash } from 'node:crypto'
import type { SourceService } from './service.ts'
import type { createWorkspaceSourceResults } from './results.ts'
import { SOURCE_AGENT_TOOLS, type SourceToolName } from '../../../../../../packages/web-contracts/src/source-tools.ts'
import { object, sourceError } from './config.ts'

type Results = ReturnType<typeof createWorkspaceSourceResults>
const uuid = (value: unknown): string => { if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw sourceError(); return value.toLowerCase() }
const safeError = (error: unknown) => {
  const status = (error as { statusCode?: number }).statusCode
  return Object.assign(new Error('Workspace source tool unavailable'), { statusCode: [400,401,403,404,409,410,413,429,502,503,504].includes(status ?? 0) ? status : 503 })
}

/** Steers the model back to database-side aggregation instead of reasoning over a partial row set. */
export const truncatedNotice = (rows: number) => `TRUNCATED: only the first ${rows} rows were kept (this connection's row or size limit); reading later pages does not recover omitted rows. Do not compute totals, averages, counts, shares or rankings from these rows. Re-query with the computation in SQL instead: GROUP BY with SUM/COUNT/AVG/MIN/MAX, bucket dates (for example date_trunc or DATE_FORMAT), filter to the needed time range, and select only needed columns. If row-level detail is really needed, ORDER BY the relevant measure with an explicit LIMIT and state that the list is partial.`

/** The credential is supplied by trusted request composition, never by model
 * arguments. These tools cannot create connections, reveal secrets, choose an
 * owner/workspace or write arbitrary paths. Query results are captured once. */
export function createWorkspaceSourceTools({ sources, results }: { sources: SourceService; results: Results }) {
  return {
    definitions: SOURCE_AGENT_TOOLS,
    async execute(token: string, input: unknown): Promise<unknown> {
      try {
        const call = object(input, ['name','arguments'])
        if (typeof call.name !== 'string' || !SOURCE_AGENT_TOOLS.some(tool => tool.name === call.name)) throw sourceError()
        const name = call.name as SourceToolName
        if (name === 'sources.list') {
          const args = object(call.arguments, ['after'])
          return sources.listSavedMetadata(token, args)
        }
        if (name === 'sources.describe') {
          const args = object(call.arguments, ['sourceId','table'])
          return sources.describe(token, args.sourceId, args.table === undefined ? {} : { table: args.table })
        }
        if (name === 'sources.query') {
          const args = object(call.arguments, ['sourceId','sql'])
          const query = { ...(args.sql === undefined ? {} : { sql: args.sql }) }
          const snapshot = await sources.querySource(token, args.sourceId, query)
          const queryHash = createHash('sha256').update(JSON.stringify({ sourceId: snapshot.sourceId, sourceVersion: snapshot.sourceVersion, sql: args.sql ?? null })).digest('hex')
          const artifact = await results.capture(token, snapshot, queryHash)
          return { artifact, schema: snapshot.schema, timezone: snapshot.timezone, preview: snapshot.rows.slice(0, 100),
            totalRows: snapshot.rows.length, sourceTruncated: snapshot.truncated, sha256: snapshot.sha256,
            nextOffset: snapshot.rows.length > 100 ? 100 : null,
            notice: snapshot.truncated ? truncatedNotice(snapshot.rows.length) : 'Frozen query result; later reads and saving do not execute SQL again.' }
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
