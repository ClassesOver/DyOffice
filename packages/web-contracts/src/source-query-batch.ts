import { MAX_BATCH_QUERIES } from './source-tools.ts'

// Covers one 30 s statement, connector setup, authorization and frozen capture.
export const SOURCE_QUERY_REQUEST_TIMEOUT_MS = 60_000

const maxSqlBytes = 32_768
const utf8 = new TextEncoder()

export function parsedSourceQueryBatch(queries: unknown): string[] | undefined {
  if (!Array.isArray(queries) || queries.length < 1 || queries.length > MAX_BATCH_QUERIES) return
  const count = queries.length
  const statements: string[] = []
  let bytes = 0
  for (let index = 0; index < count; index++) {
    const sql = queries[index]
    if (typeof sql !== 'string' || sql.length > maxSqlBytes || !sql.trim()) return
    bytes += utf8.encode(sql).byteLength
    if (bytes > maxSqlBytes) return
    statements.push(sql)
  }
  return statements
}

export function sourceQueryBatchSize(operation: unknown, args: unknown): number | undefined {
  if (operation !== 'sources.query' || !args || typeof args !== 'object') return
  const call = args as Record<string, unknown>
  if (typeof call.sourceId !== 'string' || Object.keys(call).some(key => key !== 'sourceId' && key !== 'queries')) return
  return parsedSourceQueryBatch(call.queries)?.length
}
