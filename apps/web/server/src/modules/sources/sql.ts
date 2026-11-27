import { Client, types as pgTypes } from 'pg'
import { isIP } from 'node:net'
import { checkServerIdentity } from 'node:tls'
import { withAssistantErrorCode } from '../../../../../../packages/web-contracts/src/assistant-errors.ts'
import type { SourceExecution } from '../../../../../../packages/web-contracts/src/sources.ts'
import type { SourceEgressPolicy, SqlSourceKind } from '../../security/egress.ts'
import { sourceConnectionFailure, sourceError } from './config.ts'
import { queryDbhubSource } from './dbhub.ts'
import { validateReadOnlySql, type SqlTableScope } from './sql-policy.ts'
import type { SqlRows } from './sql-types.ts'
import { createBoundedSourceSocket } from './wire-budget.ts'

export type { SqlRows }

const postgresNumericOids = new Set([20, 21, 23, 26, 700, 701, 1700])
const pgType = (oid: number): 'string' | 'number' | 'boolean' =>
  oid === 16 ? 'boolean' : postgresNumericOids.has(oid) ? 'number' : 'string'

function sqlFailure(error: unknown, kind: SqlSourceKind) {
  const code = (error as { code?: string }).code
  if (kind !== 'postgres' && code === 'HANDSHAKE_NO_SSL_SUPPORT') return Object.assign(sourceError(502), { code: 'SOURCE_TLS_UNSUPPORTED' })
  // A terminated connection can report its failure while executing the caller's SQL.
  if (/^(?:08[0-9A-Z]{3}|57P0[1-5])$/.test(code ?? '')
    || ['PROTOCOL_CONNECTION_LOST','ER_SERVER_SHUTDOWN','ECONNRESET','EPIPE','ECONNABORTED','ENOTCONN'].includes(code ?? '')
    || kind === 'postgres' && error instanceof Error && !code && ['Connection terminated','Connection terminated unexpectedly'].includes(error.message)) {
    return withAssistantErrorCode(sourceError(502), 'SOURCE_UNAVAILABLE')
  }
  if (code === '42501' || code === '25006' || ['ER_TABLEACCESS_DENIED_ERROR','ER_DBACCESS_DENIED_ERROR','ER_SPECIFIC_ACCESS_DENIED_ERROR'].includes(code ?? '')) return withAssistantErrorCode(sourceError(403), 'SOURCE_SCOPE_DENIED')
  if (code === '57014' || ['PROTOCOL_SEQUENCE_TIMEOUT','ER_QUERY_TIMEOUT','ETIMEDOUT'].includes(code ?? '')) return withAssistantErrorCode(sourceError(504), 'SOURCE_TIMEOUT')
  // The database refused the statement itself (syntax, unknown table/column/
  // function, type or data error): a fixable query, not an unusable source.
  if (/^(?:42[0-9A-Z]{3}|22[0-9A-Z]{3})$/.test(code ?? '') || ['ER_PARSE_ERROR','ER_BAD_FIELD_ERROR','ER_NO_SUCH_TABLE','ER_SP_DOES_NOT_EXIST','ER_WRONG_FIELD_WITH_GROUP','ER_TRUNCATED_WRONG_VALUE','ER_DIVISION_BY_ZERO'].includes(code ?? '')) return withAssistantErrorCode(sourceError(400), 'SQL_DATABASE_ERROR')
  // pg emits this exact local driver error without a SQLSTATE when its
  // query deadline fires before the server cancellation response arrives.
  if (kind === 'postgres' && error instanceof Error && code === undefined && error.message === 'Query read timeout') return withAssistantErrorCode(sourceError(504), 'SOURCE_TIMEOUT')
  if ((error as { statusCode?: number }).statusCode) return error as { statusCode: number }
  return sourceError(502)
}
export function safeFailure(error: unknown, kind: SqlSourceKind, executingStatement = true): never {
  const failure = sqlFailure(error, kind)
  if (!executingStatement) Object.assign(failure, { [sourceConnectionFailure]: true })
  throw failure
}
export async function querySqlSource(policy: SourceEgressPolicy, kind: SqlSourceKind, secret: string, sql: unknown, execution: SourceExecution, scope?: SqlTableScope): Promise<SqlRows> {
  if (kind !== 'postgres') return queryDbhubSource(policy, kind, secret, sql, execution, scope)

  // The PostgreSQL driver preserves SQLSTATE, field names on empty results,
  // and numeric OIDs so provenance can reject values that lose precision.
  const normalized = validateReadOnlySql(sql, kind, scope)
  const target = await policy.sql(kind, secret)
  const timeout = execution.statementTimeoutMs ?? 5000
  const maxRows = execution.maxRows
  const wireLimit = (execution.maxResponseBytes ?? 1_000_000) + 131_072 + (maxRows + 1) * 4096
  const socket = createBoundedSourceSocket(target, Math.min(wireLimit, 16_000_000))
  const client = new Client({
    stream: () => socket,
    host: target.address,
    port: target.port,
    user: target.username,
    password: target.password,
    database: target.database,
    connectionTimeoutMillis: 3000,
    query_timeout: timeout + 1500,
    statement_timeout: timeout,
    application_name: 'dyoffice-source-reader',
    ssl: target.tls ? {
      rejectUnauthorized: true,
      ca: target.ca,
      servername: isIP(target.hostname) ? undefined : target.hostname,
      checkServerIdentity: (_host, cert) => checkServerIdentity(target.hostname, cert),
    } : false,
  })
  let expired = false, executingStatement = false
  const deadline = setTimeout(() => {
    expired = true
    void client.end().catch(() => {})
  }, timeout + 5000)
  client.on('error', () => {})
  try {
    await client.connect()
    const { rows: [role] } = await client.query(`
      SELECT current_user = session_user AS same_login,
        rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolinherit,
        current_setting('default_transaction_read_only') AS read_only,
        EXISTS (SELECT 1 FROM pg_roles r WHERE r.oid <> me.oid AND pg_has_role(me.oid, r.oid, 'MEMBER')) AS memberships
      FROM pg_roles me WHERE rolname = current_user
    `)
    if (!role || !role.same_login || role.read_only !== 'on' || ['rolsuper','rolbypassrls','rolcreatedb','rolcreaterole','rolreplication','rolinherit','memberships'].some(k => role[k])) throw sourceError(403)
    const { rows: [unsafe] } = await client.query(`
      SELECT has_database_privilege(current_user, current_database(), 'CREATE,TEMPORARY')
        OR EXISTS (
          SELECT 1 FROM pg_namespace
          WHERE nspname !~ '^pg_' AND nspname <> 'information_schema' AND has_schema_privilege(current_user, oid, 'CREATE')
        ) OR EXISTS (
          SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f')
            AND (c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
              OR has_table_privilege(current_user, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
              OR has_any_column_privilege(current_user, c.oid, 'INSERT,UPDATE,REFERENCES'))
        ) AS unsafe
    `)
    if (!unsafe || unsafe.unsafe) throw sourceError(403)
    await client.query("SET TIME ZONE 'UTC'")
    await client.query('BEGIN READ ONLY')
    await client.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true),set_config('search_path','pg_catalog',true)", [String(timeout)])
    // A server cursor bounds transfer/memory even when the SELECT has no LIMIT.
    executingStatement = true
    await client.query('DECLARE dyoffice_source_result NO SCROLL CURSOR FOR ' + normalized)
    const result = await client.query({
      text: `FETCH FORWARD ${maxRows + 1} FROM dyoffice_source_result`,
      rowMode: 'array',
      types: { getTypeParser: (oid: number) => postgresNumericOids.has(oid) ? (value: string) => value : pgTypes.getTypeParser(oid) },
    })
    executingStatement = false
    await client.query('ROLLBACK')
    return { names: result.fields.map(f => f.name), types: result.fields.map(f => pgType(f.dataTypeID)), rows: result.rows }
  } catch (error) {
    return safeFailure(expired ? sourceError(504) : error, kind, executingStatement)
  } finally {
    clearTimeout(deadline)
    await client.end().catch(() => {})
  }
}
