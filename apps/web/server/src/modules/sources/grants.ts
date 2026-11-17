import type { SqlSourceKind } from '../../security/egress.ts'
import { validateReadOnlyGrants } from './sql-policy.ts'

const denied = () => Object.assign(new Error('Source role is not verified read-only'), { statusCode: 403 })
const identifier = '(?:`(?:``|[^`])+`|[A-Za-z_][A-Za-z0-9_$-]*)'
const scopePattern = new RegExp(`^(${identifier})(?:\\.(${identifier}|\\*))?(?:\\.(${identifier}|\\*))?$`)
const accountPattern = /^(?:'([^'\r\n]+)'|`([^`\r\n]+)`|([A-Za-z_][A-Za-z0-9_$.-]*))@(?:'([^'\r\n]+)'|`([^`\r\n]+)`|([A-Za-z0-9_%:.-]+))$/
const unquote = (value: string) => value.startsWith('`') ? value.slice(1, -1).replaceAll('``', '`') : value
function account(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1024) throw denied()
  const matched = accountPattern.exec(value.trim())
  if (!matched) throw denied()
  return JSON.stringify([matched[1] ?? matched[2] ?? matched[3], matched[4] ?? matched[5] ?? matched[6]])
}

/** StarRocks 3.5 returns UserIdentity/Catalog/Grants, unlike MySQL's single
 * grant-string column. Neither inherited roles nor unknown privilege shapes
 * establish a read-only account. They remain denied, including the root role.
 */
export const sourceGrantQuery = (kind: Exclude<SqlSourceKind, 'postgres'>): string =>
  kind === 'starrocks' ? 'SHOW GRANTS' : 'SHOW GRANTS FOR CURRENT_USER()'

export function validateSourceGrantRows(kind: Exclude<SqlSourceKind, 'postgres'>, rows: unknown, fields: readonly { name: string }[], database: string): void {
  if (!Array.isArray(rows) || !rows.length || rows.length > 256 || !Array.isArray(fields)) throw denied()
  if (kind === 'mysql') {
    if (fields.length !== 1 || rows.some(row => !Array.isArray(row) || row.length !== 1 || typeof row[0] !== 'string')) throw denied()
    validateReadOnlyGrants(rows.map(row => row[0]), database)
    return
  }
  const names = fields.map(field => typeof field?.name === 'string' ? field.name.toLowerCase() : '')
  if (names.length !== 3 || new Set(names).size !== 3 || !['useridentity', 'catalog', 'grants'].every(name => names.includes(name))) throw denied()
  const identityIndex = names.indexOf('useridentity'), catalogIndex = names.indexOf('catalog'), grantIndex = names.indexOf('grants')
  let hasSelect = false, identity: string | undefined
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== fields.length) throw denied()
    const rowIdentity = account(row[identityIndex])
    if (identity !== undefined && identity !== rowIdentity) throw denied()
    identity = rowIdentity
    if (!['default', 'default_catalog'].includes(row[catalogIndex])) throw denied()
    const raw = row[grantIndex]
    if (typeof raw !== 'string' || raw.length > 16_384 || /[\u0000-\u001f]/.test(raw)) throw denied()
    const text = raw.trim().replace(/;$/, '').trim()
    if (text.includes(';') || /\bWITH\s+GRANT\s+OPTION\b/i.test(text)) throw denied()
    const grant = /^GRANT\s+(SELECT|USAGE)\s+ON\s+(TABLE|VIEW|CATALOG)\s+(.+?)\s+TO\s+USER\s+(.+)$/i.exec(text)
    if (!grant || account(grant[4]) !== identity) throw denied()
    const privilege = grant[1].toUpperCase(), objectType = grant[2].toUpperCase(), object = scopePattern.exec(grant[3])
    if (!object) throw denied()
    const parts = object.slice(1).filter((part): part is string => part !== undefined).map(unquote)
    if (privilege === 'USAGE') {
      if (objectType !== 'CATALOG' || parts.length !== 1 || parts[0] !== 'default_catalog') throw denied()
      continue
    }
    if (!['TABLE', 'VIEW'].includes(objectType) || parts.length < 2 || parts.length > 3) throw denied()
    const db = parts.length === 3 ? parts[1] : parts[0]
    if (parts.length === 3 && parts[0] !== 'default_catalog' || db !== database) throw denied()
    hasSelect = true
  }
  if (!hasSelect) throw denied()
}
