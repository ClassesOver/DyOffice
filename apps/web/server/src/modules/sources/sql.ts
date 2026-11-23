import { Client, types as pgTypes } from 'pg'
import mysql, { type RowDataPacket, type FieldPacket } from 'mysql2/promise'
import { isIP } from 'node:net'
import { createBoundedSourceSocket } from './wire-budget.ts'
import { checkServerIdentity } from 'node:tls'
import type { SourceExecution } from '../../../../../../packages/web-contracts/src/sources.ts'
import type { SourceEgressPolicy, SqlSourceKind } from '../../security/egress.ts'
import { validateReadOnlySql, type SqlTableScope } from './sql-policy.ts'
import { sourceGrantQuery, validateSourceGrantRows } from './grants.ts'
import { sourceConnectionFailure, sourceError } from './config.ts'
import { withAssistantErrorCode } from '../../../../../../packages/web-contracts/src/assistant-errors.ts'

export interface SqlRows { names: string[]; rows: unknown[][]; types: ('string' | 'number' | 'boolean')[] }
const pgType = (oid: number): 'string' | 'number' | 'boolean' => oid === 16 ? 'boolean' : [20,21,23,26,700,701,1700].includes(oid) ? 'number' : 'string'
const mysqlType = (id: number): 'string' | 'number' | 'boolean' => [0,1,2,3,4,5,8,9,13,246].includes(id) ? 'number' : 'string'
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
/** No connectionString is passed to either driver. The socket always dials
 * the numeric address checked by the egress policy. */
export async function querySqlSource(policy: SourceEgressPolicy, kind: SqlSourceKind, secret: string, sql: unknown, execution: SourceExecution, scope?: SqlTableScope): Promise<SqlRows> {
  const normalized = validateReadOnlySql(sql, kind, scope)
  const target = await policy.sql(kind, secret)
  const timeout = execution.statementTimeoutMs ?? 5000, maxRows = execution.maxRows
  // Include bounded TLS/auth/row framing overhead; evidence has a stricter cap.
  const wireLimit = (execution.maxResponseBytes ?? 1_000_000) + 131_072 + (maxRows + 1) * 4096
  if (kind === 'postgres') {
    const socket = createBoundedSourceSocket(target, Math.min(wireLimit, 16_000_000))
    const client = new Client({ stream: () => socket, host: target.address, port: target.port, user: target.username, password: target.password, database: target.database, connectionTimeoutMillis: 3000, query_timeout: timeout + 1500, statement_timeout: timeout, application_name: 'dyoffice-source-reader', ssl: target.tls ? { rejectUnauthorized: true, ca: target.ca, servername: isIP(target.hostname) ? undefined : target.hostname, checkServerIdentity: (_host, cert) => checkServerIdentity(target.hostname, cert) } : false })
    let connected = false, expired = false, executingStatement = false
    const deadline = setTimeout(() => { expired = true; void client.end().catch(() => {}) }, timeout + 5000)
    client.on('error', () => {})
    try {
      await client.connect(); connected = true
      const role = (await client.query("SELECT current_user=session_user AS same_login,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication,rolinherit,current_setting('default_transaction_read_only') AS read_only, EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid<>me.oid AND pg_has_role(me.oid,r.oid,'MEMBER')) AS memberships FROM pg_roles me WHERE rolname=current_user")).rows[0]
      if (!role || !role.same_login || role.read_only !== 'on' || ['rolsuper','rolbypassrls','rolcreatedb','rolcreaterole','rolreplication','rolinherit','memberships'].some(k => role[k])) throw sourceError(403)
      const unsafe = (await client.query("SELECT has_database_privilege(current_user,current_database(),'CREATE,TEMPORARY') OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname<>'information_schema' AND has_schema_privilege(current_user,oid,'CREATE')) OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f') AND (c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) OR has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE,REFERENCES'))) AS unsafe")).rows[0]
      if (!unsafe || unsafe.unsafe) throw sourceError(403)
      await client.query("SET TIME ZONE 'UTC'")
      await client.query('BEGIN READ ONLY')
      await client.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true),set_config('search_path','pg_catalog',true)", [String(timeout)])
      // A server cursor bounds transfer/memory even when the SELECT has no LIMIT.
      executingStatement = true
      await client.query('DECLARE dyoffice_source_result NO SCROLL CURSOR FOR ' + normalized)
      const result = await client.query({ text: `FETCH FORWARD ${maxRows + 1} FROM dyoffice_source_result`, rowMode: 'array', types: { getTypeParser: (oid: number) => [20,21,23,26,700,701,1700].includes(oid) ? (value: string) => value : pgTypes.getTypeParser(oid) } })
      executingStatement = false
      await client.query('ROLLBACK')
      return { names: result.fields.map(f => f.name), types: result.fields.map(f => pgType(f.dataTypeID)), rows: result.rows }
    } catch (error) { return safeFailure(expired ? sourceError(504) : error, kind, executingStatement) } finally {
      clearTimeout(deadline)
      if (connected) await client.end().catch(() => {})
      else await client.end().catch(() => {})
    }
  }
  let connection: Awaited<ReturnType<typeof mysql.createConnection>> | undefined, expired = false, executingStatement = false
  const socket = createBoundedSourceSocket(target, Math.min(wireLimit, 16_000_000))
  socket.connect()
  // mysql2 owns handshake errors, but a socket can fail before it attaches.
  socket.on('error', () => {})
  const deadline = setTimeout(() => { expired = true; socket.destroy(); connection?.destroy() }, timeout + 5000)
  try {
    connection = await mysql.createConnection({ host: target.hostname, port: target.port, user: target.username, password: target.password, database: target.database, stream: socket, connectTimeout: 3000, multipleStatements: false, enableKeepAlive: false, rowsAsArray: true, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, decimalNumbers: false, charset: 'utf8mb4', flags: ['-LOCAL_FILES'], ssl: target.tls ? { rejectUnauthorized: true, ca: target.ca, verifyIdentity: true } : undefined })
    // Administrators may approve a privileged StarRocks login for this exact
    // target. SQL validation and execution limits also apply to that login.
    await connection.query("SET time_zone = '+00:00'")
    if (kind !== 'starrocks' || !target.allowPrivilegedAccount) {
      const [grants, grantFields] = await connection.query<RowDataPacket[]>(sourceGrantQuery(kind))
      validateSourceGrantRows(kind, grants, grantFields, target.database)
    }
    if (kind === 'starrocks') {
      await connection.query(`SET query_timeout = ${Math.max(1, Math.ceil(timeout / 1000))}`)
      await connection.query(`SET sql_select_limit = ${maxRows + 1}`)
    } else {
      await connection.query(`SET SESSION MAX_EXECUTION_TIME = ${timeout}`)
      await connection.query('SET SESSION TRANSACTION READ ONLY')
      await connection.query('START TRANSACTION READ ONLY')
    }
    executingStatement = true
    const [rows, fields] = await connection.query<RowDataPacket[]>({ sql: `SELECT * FROM (${normalized}) AS dyoffice_source_result LIMIT ${maxRows + 1}`, timeout })
    executingStatement = false
    if (kind === 'mysql') await connection.query('ROLLBACK')
    return { names: fields.map((f: FieldPacket) => f.name), types: fields.map((f: FieldPacket) => mysqlType(f.columnType ?? -1)), rows: rows as unknown as unknown[][] }
  } catch (error) { return safeFailure(expired ? sourceError(504) : error, kind, executingStatement) } finally {
    clearTimeout(deadline); connection?.destroy(); socket.destroy()
  }
}
