import { HARNESS_DATA_MAX_METADATA_BYTES } from '../../../../../../packages/web-contracts/src/harness-data.ts'
import type { SourceService } from '../sources/service.ts'

type Description = Awaited<ReturnType<SourceService['describe']>>
type Column = { name: string; dataType: string; nullable: boolean; unit?: string }
type ColumnGroup = { schema?: string; name: string; columns: Column[] }
type Table = { schema?: string; name: string; type: string } | ColumnGroup
const invalid = () => new Error('Invalid source catalog')
const encodedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))

/** The task client accepts catalog metadata, while query rows travel only through frozen downloads. */
export function harnessSourceCatalog(description: Description, input: Record<string, unknown>) {
  const { sourceId, sourceVersion, kind, config, metadata } = description
  if (kind === 'http') return description
  if (!metadata) throw invalid()
  const columns = input.table !== undefined || input.tables !== undefined
  const path = typeof input.table === 'string' ? input.table.split('.') : []
  const database = 'database' in config ? config.database : undefined
  const singleSchema = path.length === 2 ? path[0] : (kind === 'postgres' ? 'public' : database)
  const tables: Table[] = []
  const page = { sourceId, sourceVersion, kind, timezone: config.timezone, tables, truncated: false }
  // Reserve the longest possible cursor before filling the metadata-only response.
  let size = encodedBytes({ ...page, ...(columns ? { nextOffset: Number.MAX_SAFE_INTEGER } : {}) })
  let group: ColumnGroup | undefined
  let consumed = 0
  for (const row of metadata.rows) {
    const schema = row.table_schema ?? singleSchema, name = row.table_name ?? path.at(-1)
    if (typeof name !== 'string' || (schema !== undefined && typeof schema !== 'string')) throw invalid()
    if (columns) {
      if (typeof row.column_name !== 'string' || typeof row.data_type !== 'string' || (row.is_nullable !== 'YES' && row.is_nullable !== 'NO')) throw invalid()
      const unit = config.units && Object.hasOwn(config.units, row.column_name) ? config.units[row.column_name] : undefined
      const column: Column = { name: row.column_name, dataType: row.data_type, nullable: row.is_nullable === 'YES', unit }
      const table: ColumnGroup = group && group.schema === schema && group.name === name ? group : { schema, name, columns: [] }
      const tableBytes = table === group ? 0 : encodedBytes(table) + (tables.length ? 1 : 0)
      const added = tableBytes + encodedBytes(column) + (table.columns.length ? 1 : 0)
      if (size + added > HARNESS_DATA_MAX_METADATA_BYTES) break
      if (table !== group) tables.push(table)
      group = table
      table.columns.push(column)
      size += added
    } else {
      if (typeof row.table_type !== 'string') throw invalid()
      const table = { schema, name, type: row.table_type }
      const added = encodedBytes(table) + (tables.length ? 1 : 0)
      if (size + added > HARNESS_DATA_MAX_METADATA_BYTES) break
      tables.push(table)
      size += added
    }
    consumed++
  }
  if (!consumed && metadata.rows.length) throw invalid()
  const truncated = metadata.truncated || consumed < metadata.rows.length
  const nextOffset = truncated ? Number(input.columnOffset ?? 0) + consumed : null
  return { ...page, truncated, ...(columns ? { nextOffset } : {}) }
}
