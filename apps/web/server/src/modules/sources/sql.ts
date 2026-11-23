import type { SourceExecution } from '../../../../../../packages/web-contracts/src/sources.ts'
import type { SourceEgressPolicy, SqlSourceKind } from '../../security/egress.ts'
import { sourceConnectionFailure, sourceError } from './config.ts'
import type { SqlTableScope } from './sql-policy.ts'
import { queryDbhubSource } from './dbhub.ts'
import type { SqlRows } from './sql-types.ts'

export type { SqlRows }

/** Execute every SQL source through the default DBHub MCP server. */
export async function querySqlSource(policy: SourceEgressPolicy, kind: SqlSourceKind, secret: string, sql: unknown, execution: SourceExecution, scope?: SqlTableScope): Promise<SqlRows> {
  return queryDbhubSource(policy, kind, secret, sql, execution, scope)
}

export function safeFailure(error: unknown, _kind: SqlSourceKind, _executingStatement = true): never {
  const code = (error as { code?: string }).code
  if (code === 'HANDSHAKE_NO_SSL_SUPPORT') throw Object.assign(sourceError(502), { code: 'SOURCE_TLS_UNSUPPORTED' })
  if (/^(?:08[0-9A-Z]{3}|57P0[1-5])$/.test(code ?? '') || ['PROTOCOL_CONNECTION_LOST','ER_SERVER_SHUTDOWN','ECONNRESET','EPIPE','ECONNABORTED','ENOTCONN'].includes(code ?? '') || _kind === 'postgres' && error instanceof Error && !code && ['Connection terminated','Connection terminated unexpectedly'].includes(error.message)) throw Object.assign(sourceError(502), { code: 'SOURCE_UNAVAILABLE' })
  if (code === '42501' || code === '25006' || ['ER_TABLEACCESS_DENIED_ERROR','ER_DBACCESS_DENIED_ERROR','ER_SPECIFIC_ACCESS_DENIED_ERROR'].includes(code ?? '')) throw Object.assign(sourceError(403), { code: 'SOURCE_SCOPE_DENIED' })
  if (code === '57014' || ['PROTOCOL_SEQUENCE_TIMEOUT','ER_QUERY_TIMEOUT','ETIMEDOUT'].includes(code ?? '')) throw Object.assign(sourceError(504), { code: 'SOURCE_TIMEOUT' })
  if (_kind === 'postgres' && error instanceof Error && code === undefined && error.message === 'Query read timeout') throw Object.assign(sourceError(504), { code: 'SOURCE_TIMEOUT' })
  if (/^(?:42[0-9A-Z]{3}|22[0-9A-Z]{3})$/.test(code ?? '') || ['ER_PARSE_ERROR','ER_BAD_FIELD_ERROR','ER_NO_SUCH_TABLE'].includes(code ?? '')) throw Object.assign(sourceError(400), { code: 'SQL_DATABASE_ERROR' })
  const status = (error as { statusCode?: number }).statusCode
  const failure = status ? error as { statusCode: number } : sourceError(502)
  if (!_executingStatement) Object.assign(failure, { [sourceConnectionFailure]: true })
  throw failure
}
