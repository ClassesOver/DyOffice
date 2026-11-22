import { createHash } from 'node:crypto'
import type { SourceConfig, SourceExecution, SourceKind } from '../../../../../../packages/web-contracts/src/sources.ts'
import { parseSourceDsn } from '../../security/egress.ts'

export const sourceError = (statusCode = 400) => Object.assign(new Error('Source operation unavailable'), { statusCode })
export const sourceId = (id: unknown): string => { if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id)) throw sourceError(); return id }
export function object(value: unknown, keys: readonly string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw sourceError()
  return value as Record<string, any>
}
export function positiveVersion(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 2_000_000_000) throw sourceError(); return value as number }
export function sourceName(value: unknown): string { if (typeof value !== 'string' || !value.trim() || value.trim().length > 200 || Buffer.byteLength(value.trim()) > 600 || /[\u0000-\u001f]/.test(value)) throw sourceError(); return value.trim() }
export function sourceConfig(kind: SourceKind, input: unknown): SourceConfig {
  const http = kind === 'http'
  const value = object(input, http ? ['timezone','maxRows','units','rowPath'] : ['timezone','maxRows','units','database','statementTimeoutMs','allowedTables','allowedSchemas'])
  const timezone = value.timezone ?? 'UTC'
  if (typeof timezone !== 'string' || timezone.length > 100) throw sourceError()
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }) } catch { throw sourceError() }
  const maxRows = value.maxRows ?? 1000
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 10_000) throw sourceError()
  const units: Record<string, string> = Object.create(null)
  if (value.units !== undefined) {
    if (!value.units || typeof value.units !== 'object' || Array.isArray(value.units) || Object.keys(value.units).length > 256) throw sourceError()
    for (const [name, unit] of Object.entries(value.units)) {
      if (!name || name.length > 200 || typeof unit !== 'string' || !unit || unit.length > 100 || /[\u0000-\u001f]/.test(name + unit)) throw sourceError()
      units[name] = unit
    }
  }
  const common = { timezone, maxRows, units }
  if (http) {
    if (value.rowPath !== undefined && (typeof value.rowPath !== 'string' || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){0,15}$/.test(value.rowPath) || value.rowPath.length > 512 || value.rowPath.split('.').some((s: string) => ['__proto__','prototype','constructor'].includes(s)))) throw sourceError()
    return { ...common, ...(value.rowPath === undefined ? {} : { rowPath: value.rowPath }) }
  }
  const statementTimeoutMs = value.statementTimeoutMs ?? 5000
  if (!Number.isSafeInteger(statementTimeoutMs) || statementTimeoutMs < 100 || statementTimeoutMs > 30_000 || value.database !== undefined && (typeof value.database !== 'string' || !/^[A-Za-z_][A-Za-z0-9_$.-]{0,127}$/.test(value.database))) throw sourceError()
  let allowedTables: string[] | undefined
  if (value.allowedTables !== undefined) {
    if (!Array.isArray(value.allowedTables) || value.allowedTables.length > 256) throw sourceError()
    for (const table of value.allowedTables) {
      if (typeof table !== 'string' || !/^[A-Za-z_][A-Za-z0-9_$]{0,127}(?:\.[A-Za-z_][A-Za-z0-9_$]{0,127})?$/.test(table) || /^(?:pg_|information_schema\.|mysql\.|sys\.|performance_schema\.)/i.test(table)) throw sourceError()
    }
    allowedTables = [...new Set<string>(value.allowedTables)]
  }
  let allowedSchemas: string[] | undefined
  if (value.allowedSchemas !== undefined) {
    if (!Array.isArray(value.allowedSchemas) || value.allowedSchemas.length > 256 ||
        value.allowedSchemas.some(schema => typeof schema !== 'string' || !/^[A-Za-z_][A-Za-z0-9_$]{0,127}$/.test(schema) || /^(?:pg_|information_schema$|mysql$|sys$|performance_schema$)/i.test(schema))) throw sourceError()
    allowedSchemas = [...new Set<string>(value.allowedSchemas)]
  }
  return { ...common, statementTimeoutMs, ...(allowedSchemas === undefined ? {} : { allowedSchemas }), ...(allowedTables === undefined ? {} : { allowedTables }), ...(value.database === undefined ? {} : { database: value.database }) }
}
/** Frozen SQL result budget: room for up to 10,000 detail rows of moderate width (stored snapshots allow 8 MB). */
export const SQL_RESULT_MAX_BYTES = 4_000_000
export function executionFor(kind: SourceKind, config: SourceConfig): SourceExecution {
  return kind === 'http' ? { maxRows: config.maxRows!, requestTimeoutMs: 10_000, maxResponseBytes: 1_000_000 } : { maxRows: config.maxRows!, statementTimeoutMs: ('statementTimeoutMs' in config ? config.statementTimeoutMs : undefined) ?? 5000, maxResponseBytes: SQL_RESULT_MAX_BYTES }
}
export function validateSourceSecret(kind: SourceKind, secret: unknown, config: SourceConfig): string {
  if (typeof secret !== 'string' || !secret || Buffer.byteLength(secret) > 7000 || /[\u0000-\u001f]/.test(secret)) throw sourceError()
  try {
    if (kind === 'http') {
      const url = new URL(secret)
      if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.hash) throw sourceError()
      return url.href
    }
    const parsed = parseSourceDsn(kind, secret)
    if ('database' in config && config.database !== undefined && parsed.database !== config.database) throw sourceError()
    return secret
  } catch { throw sourceError() }
}
function canonical(value: any): any { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])); return value }
export const contentHash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
export const secretHash = (secret: string) => createHash('sha256').update(secret).digest('hex')
