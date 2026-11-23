import { randomUUID } from 'node:crypto'
import sqlParser from 'node-sql-parser'
import type { SqlSourceKind } from '../../security/egress.ts'

const parser = new sqlParser.Parser()
const invalid = () => Object.assign(new Error('Only an approved read-only SELECT is allowed'), { statusCode: 400, code: 'SQL_POLICY_REJECTED' as const })
// These functions write state, execute opaque SQL or access resources outside
// the table scope. Ordinary analytical functions do not need an allowlist.
const deniedFunctions = new Set(['load_file','set_config','nextval','setval','setseed','dblink','files','jdbc_query','query','query_to_xml','query_to_xmlschema','query_to_xml_and_xmlschema','table_to_xml','table_to_xmlschema','table_to_xml_and_xmlschema','schema_to_xml','schema_to_xmlschema','schema_to_xml_and_xmlschema','database_to_xml','database_to_xmlschema','database_to_xml_and_xmlschema','get_lock','release_lock','release_all_locks','lo_import','lo_export','lo_create','lo_creat','lo_unlink','lo_open','lo_get','lo_put','lowrite','loread'])
const purePgFunctions = new Set(['pg_typeof','pg_size_bytes','pg_size_pretty','pg_sleep','pg_sleep_for','pg_sleep_until'])
function checkFunction(name: string): void {
  const fn = name.toLowerCase()
  if (deniedFunctions.has(fn) || fn.startsWith('dblink_') || fn.startsWith('pg_') && !purePgFunctions.has(fn)) throw invalid()
}
const extractFields = new Set(['YEAR','QUARTER','MONTH','WEEK','DAY','DOW','ISODOW','DOY','HOUR','MINUTE','SECOND','EPOCH'])
const intervalUnits = new Set(['YEAR','QUARTER','MONTH','WEEK','DAY','HOUR','MINUTE','SECOND'])
const intervalText = /^\s*-?\d{1,6}(?:\.\d{1,6})?\s*(?:years?|mons?|months?|weeks?|days?|hours?|mins?|minutes?|secs?|seconds?)(?:\s+-?\d{1,6}(?:\.\d{1,6})?\s*(?:years?|mons?|months?|weeks?|days?|hours?|mins?|minutes?|secs?|seconds?)){0,5}\s*$/i
const nodeTypes = new Set(['select','expr','column_ref','number','single_quote_string','double_quote_string','string','bool','null','star','default','origin','expr_list','binary_expr','unary_expr','function','aggr_func','case','when','else','cast','array','window','window_func','rows','range'])
const selectKeys = new Set(['type','with','options','distinct','columns','into','from','where','groupby','having','orderby','limit','window','locking_read','collate','_next','set_op','parentheses'])
/** Fail closed on role grants, global SELECT, write/admin privileges and unknown
 * grant syntaxes. Unsupported StarRocks privilege output is an unverified role,
 * never a reason to silently skip target-side privilege validation. */
export function validateReadOnlyGrants(grants: readonly string[], database: string): void {
  const denied = () => Object.assign(new Error('Source role is not verified read-only'), { statusCode: 403, code: 'SOURCE_READONLY_REQUIRED' as const })
  if (!Array.isArray(grants) || !grants.length || grants.length > 256) throw denied()
  let select = false
  for (const grant of grants) {
    if (typeof grant !== 'string' || grant.length > 16_384 || /WITH\s+GRANT\s+OPTION/i.test(grant)) throw denied()
    const match = /^GRANT\s+(USAGE|SELECT)\s+ON\s+(?:(?:`([^`]+)`|([A-Za-z_][A-Za-z0-9_$]*))\.(?:\*|`[^`]+`|[A-Za-z_][A-Za-z0-9_$]*)|\*\.\*)\s+TO\s+.+$/i.exec(grant)
    if (!match) throw denied()
    if (match[1].toUpperCase() === 'SELECT') {
      if ((match[2] ?? match[3]) !== database) throw denied()
      select = true
    }
  }
  if (!select) throw denied()
}
/** Parser serialization removes comments/hints; the separate role/read-only
 * transaction remains mandatory. Numeric text must survive parsing unchanged. */
export interface SqlTableScope { allowedTables?: readonly string[]; allowedSchemas?: readonly string[]; defaultSchema: string }
export function validateReadOnlySql(sql: unknown, dialect: SqlSourceKind, scope?: SqlTableScope): string {
  if (typeof sql !== 'string' || !sql.trim() || Buffer.byteLength(sql) > 32_768 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(sql) || /\/\*[!+]/.test(sql)) throw invalid()
  try {
    const database = dialect === 'postgres' ? 'Postgresql' : 'MySQL'
    // node-sql-parser can round long unquoted decimal tokens internally. Mask
    // strings/quoted identifiers/comments and reject >15 digit literals before
    // parsing; exact large decimals may use CAST('text' AS NUMERIC) and the
    // evidence boundary will reject values that cannot survive the DTO number.
    const tokens = sql.replace(/'(?:''|\\.|[^'\\])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|--[^\r\n]*|\/\*[\s\S]*?\*\//g, match => ' '.repeat(match.length))
    for (const match of tokens.matchAll(/\b(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/g)) if ((match[0].match(/\d/g)?.length ?? 0) > 15) throw invalid()
    // The parser serializes AS g(x) as the single identifier "g(x)".
    // Replace only unquoted alias lists before parsing, then restore their SQL.
    const aliases = new Map<string, string>()
    let parseSql = sql
    const aliasLists = [...tokens.matchAll(/(?:\bAS\s+|\)\s*)([A-Za-z_][A-Za-z0-9_$]*)\s*\(\s*([A-Za-z_][A-Za-z0-9_$]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_$]*)*)\s*\)/gi)]
    for (const match of aliasLists.reverse()) {
      const start = match.index! + match[0].indexOf(match[1], match[0].startsWith(')') ? 1 : 2)
      const marker = 'alias_' + randomUUID().replaceAll('-', '')
      const quote = database === 'Postgresql' ? '"' : '`'
      const identifier = (name: string) => quote + (dialect === 'postgres' ? name.toLowerCase() : name) + quote
      aliases.set(quote + marker + quote, identifier(match[1]) + '(' + match[2].split(/\s*,\s*/).map(identifier).join(', ') + ')')
      parseSql = parseSql.slice(0, start) + marker + parseSql.slice(match.index! + match[0].length)
    }
    const result = parser.astify(parseSql, { database })
    if (Array.isArray(result) && result.length !== 1) throw invalid()
    const ast = Array.isArray(result) ? result[0] : result
    let nodes = 0
    function walk(value: unknown, depth = 0, inFrame = false): void {
      if (value === null || value === undefined || typeof value !== 'object') return
      if (++nodes > 8000 || depth > 64) throw invalid()
      if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1, inFrame); return }
      const node = value as Record<string, any>
      const pgDate = dialect === 'postgres' && node.type === 'date' && typeof node.value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(node.value) && Object.keys(node).length === 2
      // EXTRACT(<field> FROM <expr>) parses to its own node; only fixed date-part names are accepted.
      const extract = node.type === 'extract' && node.args && typeof node.args.field === 'string' && extractFields.has(node.args.field.toUpperCase()) && Object.keys(node.args).every(key => ['field','cast_type','source'].includes(key)) && (node.args.cast_type === undefined || node.args.cast_type === null)
      if (node.type === 'extract' && !extract) throw invalid()
      // INTERVAL '1 month' / INTERVAL 1 MONTH: a literal duration, nothing else.
      const interval = node.type === 'interval' && Object.keys(node).every(key => ['type','expr','unit'].includes(key)) && typeof node.unit === 'string' && (
        node.unit === '' ? node.expr?.type === 'single_quote_string' && typeof node.expr.value === 'string' && intervalText.test(node.expr.value)
          : intervalUnits.has(node.unit.toUpperCase()) && node.expr?.type === 'number' && Number.isFinite(Number(node.expr.value)))
      if (node.type === 'interval' && !interval) throw invalid()
      if (node.type !== undefined && node.type !== null && !nodeTypes.has(node.type) && !['ASC','DESC','DISTINCT'].includes(node.type) && !pgDate && !extract && !interval) throw invalid()
      if (node.type === 'select') {
        if (Object.keys(node).some(key => !selectKeys.has(key)) || node.options || node.locking_read || node.into && Object.values(node.into).some(v => v !== null) || node.set_op && !['union','union all','intersect','except'].includes(node.set_op)) throw invalid()
      }
      if (node.type === 'function') {
        const name = node.name
        if (!name || name.schema || !Array.isArray(name.name) || name.name.length !== 1) throw invalid()
        const fn = String(name.name[0].value).toLowerCase()
        checkFunction(fn)
      }
      if (node.type === 'aggr_func' || node.type === 'window_func') checkFunction(String(node.name))
      const frameOffset = inFrame && typeof node.value === 'string' && /^\d{1,15} (?:PRECEDING|FOLLOWING)$/i.test(node.value)
      if (node.type === 'number' && !frameOffset && (!Number.isFinite(Number(node.value)) || Number.isInteger(Number(node.value)) && !Number.isSafeInteger(Number(node.value)))) throw invalid()
      if (node.type === 'binary_expr' && [':=','=:', 'ASSIGN'].includes(String(node.operator).toUpperCase())) throw invalid()
      if (node.type === 'cast' && (!Array.isArray(node.target) || node.target.some((target: any) => target.schema))) throw invalid()
      if (node.suffix && Array.isArray(node.suffix) && node.suffix.length) throw invalid()
      for (const [key, child] of Object.entries(node)) walk(child, depth + 1, inFrame || key === 'window_frame_clause')
    }
    if (!ast || ast.type !== 'select') throw invalid()
    walk(ast)
    const defaultSchema = dialect === 'postgres' ? 'public' : scope?.defaultSchema
    const allowedSchemas = scope?.allowedSchemas === undefined ? undefined : new Set(scope.allowedSchemas)
    const allowed = scope?.allowedTables === undefined ? undefined : new Set(scope.allowedTables.map(table => table.includes('.') ? table : `${defaultSchema}.${table}`))
    // Resolve each CTE body before adding its alias: a nonrecursive CTE may
    // read a physical table with its own name, but cannot whitelist it.
    const qualify = (value: any, inherited: Set<string>) => {
      if (!value || typeof value !== 'object') return
      if (Array.isArray(value)) { for (const item of value) qualify(item, inherited); return }
      let names = inherited
      if (value.type === 'select') {
        names = new Set(inherited)
        for (const cte of value.with ?? []) {
          if (cte.recursive) names.add(String(cte.name?.value ?? cte.name))
          qualify(cte.stmt, names)
          names.add(String(cte.name?.value ?? cte.name))
        }
        for (const table of value.from ?? []) {
          if (table.schema) throw invalid()
          if (typeof table.table !== 'string') continue
          if (!table.db && names.has(table.table)) continue
          const schema = table.db ?? defaultSchema
          const name = `${schema}.${table.table}`
          if ((allowedSchemas && !allowedSchemas.has(String(schema))) || (allowed ? !allowed.has(name) : /^(?:pg_|information_schema$|mysql$|sys$|performance_schema$)/i.test(String(schema)))) throw invalid()
          if (!table.db && dialect === 'postgres') table.db = 'public'
        }
      }
      for (const [key, child] of Object.entries(value)) if (key !== 'with') qualify(child, names)
    }
    qualify(ast, new Set())
    let normalized = parser.sqlify(ast, { database })
    for (const [marker, alias] of aliases) normalized = normalized.replaceAll(marker, alias)
    return normalized
  } catch { throw invalid() }
}
