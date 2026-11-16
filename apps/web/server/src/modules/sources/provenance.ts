import { createHash } from 'node:crypto'
import type { QueryCell, QueryColumn, QuerySnapshot } from '../../../../../../packages/web-contracts/src/sources.ts'

function fail(): never { throw new Error('Invalid source snapshot') }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value)

/** Pure evidence builder only. Call AFTER source authorization and bounded connector I/O.
 * It accepts no credential, URL or raw SQL. Never use a snapshot as an access grant.
 * Row order is evidence-significant; object property order is not.
 */
export function createQuerySnapshot(input: unknown, { maxRows = 10_000, maxBytes = 8_000_000 }: { maxRows?: number; maxBytes?: number } = {}): QuerySnapshot {
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 10_000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8_000_000) fail()
  if (!record(input) || !text(input.sourceId, 200) || !Number.isSafeInteger(input.sourceVersion) || (input.sourceVersion as number) < 1 || !text(input.timezone, 100) || typeof input.sourceTruncated !== 'boolean' || !Array.isArray(input.schema) || input.schema.length < 1 || input.schema.length > 256 || !Array.isArray(input.rows)) fail()
  try { new Intl.DateTimeFormat('en', { timeZone: input.timezone as string }) } catch { fail() }
  const names = new Set<string>()
  const schema: readonly QueryColumn[] = Object.freeze((input.schema as unknown[]).map(column => {
    if (!record(column) || Object.keys(column).some(k => !['name','type','unit'].includes(k)) || !text(column.name, 200) || names.has(column.name) || !['string','number','boolean'].includes(column.type as string) || (column.unit !== undefined && !text(column.unit, 100))) fail()
    names.add(column.name as string)
    return Object.freeze({ name: column.name as string, type: column.type as QueryColumn['type'], ...(column.unit === undefined ? {} : {unit: column.unit as string}) })
  }))
  const truncated = input.sourceTruncated || (input.rows as unknown[]).length > maxRows
  const rows: Readonly<Record<string, QueryCell>>[] = []
  // Check bytes incrementally to avoid constructing an oversized evidence string.
  let bytes = Buffer.byteLength(JSON.stringify({version:1,sourceId:input.sourceId,sourceVersion:input.sourceVersion,schema,timezone:input.timezone,rows:[],truncated,sha256:'0'.repeat(64)}), 'utf8')
  for (const raw of (input.rows as unknown[]).slice(0,maxRows)) {
    if (!record(raw) || Object.keys(raw).length !== schema.length) fail()
    const row: Record<string, QueryCell> = Object.create(null)
    for (const column of schema) {
      if (!Object.hasOwn(raw, column.name)) fail()
      const value = raw[column.name]
      if (value !== null && (typeof value !== column.type || (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value,-0))))) fail()
      row[column.name] = value as QueryCell
    }
    bytes += Buffer.byteLength(JSON.stringify(row), 'utf8') + (rows.length ? 1 : 0)
    if (bytes > maxBytes) fail()
    rows.push(Object.freeze(row))
  }
  if (bytes > maxBytes) fail()
  const evidence = {version:1 as const,sourceId:input.sourceId as string,sourceVersion:input.sourceVersion as number,schema,timezone:input.timezone as string,rows:Object.freeze(rows),truncated}
  const sha256 = createHash('sha256').update(JSON.stringify(evidence)).digest('hex')
  return Object.freeze({...evidence,sha256})
}
