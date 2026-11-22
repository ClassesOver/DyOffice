import sqlParser from 'node-sql-parser'
import type { SqlSourceKind } from '../../security/egress.ts'

const parser = new sqlParser.Parser()
const invalid = () => Object.assign(new Error('Only an approved read-only SELECT is allowed'), { statusCode: 400, code: 'SQL_POLICY_REJECTED' as const })
const functions = new Set(['abs','ceil','ceiling','floor','round','mod','power','sqrt','lower','upper','length','char_length','concat','concat_ws','substring','substr','trim','ltrim','rtrim','replace','coalesce','nullif','ifnull','greatest','least','current_date','current_timestamp','date_trunc','date_part','date_format','year','month','day','date','extract','generate_series'])
const extractFields = new Set(['YEAR','QUARTER','MONTH','WEEK','DAY','DOW','ISODOW','DOY','HOUR','MINUTE','SECOND','EPOCH'])
const intervalUnits = new Set(['YEAR','QUARTER','MONTH','WEEK','DAY','HOUR','MINUTE','SECOND'])
const intervalText = /^\s*-?\d{1,6}(?:\.\d{1,6})?\s*(?:years?|mons?|months?|weeks?|days?|hours?|mins?|minutes?|secs?|seconds?)(?:\s+-?\d{1,6}(?:\.\d{1,6})?\s*(?:years?|mons?|months?|weeks?|days?|hours?|mins?|minutes?|secs?|seconds?)){0,5}\s*$/i
const aggregates = new Set(['count','sum','avg','min','max','stddev','stddev_pop','stddev_samp','variance','var_pop','var_samp'])
const operators = new Set(['=','!=','<>','<','>','<=','>=','+','-','*','/','%','AND','OR','LIKE','NOT LIKE','ILIKE','NOT ILIKE','IS','IS NOT','IN','NOT IN','BETWEEN','NOT BETWEEN','||'])
const nodeTypes = new Set(['select','expr','column_ref','number','single_quote_string','double_quote_string','string','bool','null','star','default','origin','expr_list','binary_expr','unary_expr','function','aggr_func','case','when','else','cast','array'])
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
    const tokens = sql.replace(/'(?:''|\\.|[^'\\])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|--[^\r\n]*|\/\*[\s\S]*?\*\//g, ' ')
    for (const match of tokens.matchAll(/\b(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/g)) if ((match[0].match(/\d/g)?.length ?? 0) > 15) throw invalid()
    const result = parser.astify(sql, { database })
    if (Array.isArray(result) && result.length !== 1) throw invalid()
    const ast = Array.isArray(result) ? result[0] : result
    let nodes = 0
    function walk(value: unknown, depth = 0): void {
      if (value === null || value === undefined || typeof value !== 'object') return
      if (++nodes > 8000 || depth > 64) throw invalid()
      if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return }
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
        if (Object.keys(node).some(key => !selectKeys.has(key)) || node.options || node.locking_read || node.window || node.collate || node.into && Object.values(node.into).some(v => v !== null) || node.set_op && !['union','union all','intersect','except'].includes(node.set_op)) throw invalid()
      }
      if (node.type === 'function') {
        const name = node.name
        if (!name || name.schema || !Array.isArray(name.name) || name.name.length !== 1 || node.over) throw invalid()
        const fn = String(name.name[0].value).toLowerCase()
        if (!functions.has(fn) && !(dialect === 'postgres' && fn === 'to_char')) throw invalid()
      }
      if (node.type === 'aggr_func' && (!aggregates.has(String(node.name).toLowerCase()) || node.over)) throw invalid()
      if (node.type === 'number' && (!Number.isFinite(Number(node.value)) || Number.isInteger(Number(node.value)) && !Number.isSafeInteger(Number(node.value)))) throw invalid()
      if (node.type === 'binary_expr' && !operators.has(String(node.operator).toUpperCase())) throw invalid()
      if (node.type === 'unary_expr' && !['NOT','+','-'].includes(String(node.operator).toUpperCase())) throw invalid()
      if (node.type === 'cast' && (!Array.isArray(node.target) || node.target.some((target: any) => !['INT','INTEGER','BIGINT','SMALLINT','DECIMAL','NUMERIC','DOUBLE','DOUBLE PRECISION','FLOAT','REAL','TEXT','VARCHAR','CHAR','DATE','TIMESTAMP','BOOLEAN','SIGNED','UNSIGNED'].includes(String(target.dataType).toUpperCase()) || target.schema))) throw invalid()
      // A relation column alias list (FROM f() AS g(x)) does not survive re-serialization: it would
      // come back as the identifier "g(x)". Output labels such as AS "Paid (USD)" are unaffected.
      if (Array.isArray(node.from) && node.from.some((item: any) => typeof item?.as === 'string' && /[()]/.test(item.as))) throw invalid()
      if (node.collate || node.suffix && Array.isArray(node.suffix) && node.suffix.length) throw invalid()
      for (const child of Object.values(node)) walk(child, depth + 1)
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
    return parser.sqlify(ast, { database })
  } catch { throw invalid() }
}
