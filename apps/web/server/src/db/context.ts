import type { Pool, PoolClient } from 'pg'
import { assertRuntimePool } from './roles.ts'
import { tokenHash, authError } from '../modules/auth/sessions.ts'
import type { McpExternalCredential } from '../modules/mcp-server/credential.ts'
import type { Principal } from '../../../../../packages/web-contracts/src/api.ts'

export interface JobCredential { kind: 'job'; jobId: string; epoch: number; token: string }
export type FileCredential = string | JobCredential
export type OfficeReadCredential = FileCredential | McpExternalCredential
export type McpReadScope = Readonly<{ fileId: string; revision: string }>
type TransactionCredential = BusinessCredential | McpExternalCredential
export type BusinessCredential = SessionCredential | JobCredential
export type BusinessPrincipal = Principal & { roles: readonly string[]; authVersion: number; job?: Readonly<{ id: string; epoch: number; fileId: string; baseRevision: string }>; mcpRead?: McpReadScope }
export interface SessionCredential { kind: 'session'; token: string }
export function createPrincipalTransactions({ pool, deploymentId, idleMs = 8 * 3600_000 }: { pool: Pool; deploymentId: string; idleMs?: number }) {
  if (!Number.isSafeInteger(idleMs) || idleMs < 1 || idleMs > 2592000000) throw new Error('Invalid session idle lifetime')
  deploymentId = deploymentId.toLowerCase()
  let admitted: ReturnType<typeof assertRuntimePool> | undefined
  async function transact<T>(input: TransactionCredential, operation: (connection: PoolClient, principal: BusinessPrincipal) => Promise<T>): Promise<T> {
    // Capture before the first await: callers cannot switch capabilities
    // between initial authorization and the final commit recheck.
    const credential = Object.freeze({ ...input })
    await (admitted ??= assertRuntimePool(pool, 'business'))
    if (!credential || !['session','job','external-token'].includes(credential.kind) || typeof credential.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(credential.token)) throw authError()
    if (credential.kind==='job' && (Object.keys(credential).some(key => !['kind','jobId','epoch','token'].includes(key)) || typeof credential.jobId!=='string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(credential.jobId) || !Number.isSafeInteger(credential.epoch) || credential.epoch<1)) throw authError()
    const connection = await pool.connect()
    let discard: Error | undefined
    try {
      await connection.query('BEGIN')
      await connection.query("SET LOCAL lock_timeout='5s'")
      await connection.query("SET LOCAL statement_timeout='10s'")
      const hash = tokenHash(credential.token)
      const lock = (final: boolean) => {
        switch (credential.kind) {
          case 'session':
            return connection.query('SELECT * FROM lock_business_session($1::uuid,$2::text,$3::bigint)', [deploymentId, hash, idleMs])
          case 'job':
            return connection.query('SELECT lock_job_principal($1::uuid,$2::uuid,$3::bigint,$4::text,$5::boolean) AS job', [deploymentId, credential.jobId, credential.epoch, hash, final])
          case 'external-token':
            return connection.query('SELECT * FROM lock_mcp_read_grant($1::uuid,$2::text,$3::bigint)', [deploymentId, hash, idleMs])
        }
      }
      const { rows: [locked] } = await lock(false)
      if (!locked) throw authError()
      const job = locked.job
      const roles: readonly string[] = Object.freeze(credential.kind === 'session' ? locked.roles : ['personal'])
      const scopes = {
        session: roles.includes('personal') ? ['workspace:read','preferences:read','preferences:write','files:read','files:write'] : [],
        job: ['files:read', 'files:write'],
        'external-token': ['files:read'],
      }
      const principal: BusinessPrincipal = Object.freeze({
        deploymentId,
        userId: job ? job.userId : locked.user_id,
        sessionId: job ? job.sessionId : locked.session_id,
        authVersion: job ? job.authVersion : locked.auth_version,
        roles,
        scopes: Object.freeze(scopes[credential.kind]),
        ...(job && { job: Object.freeze({ id: job.jobId, epoch: job.epoch, fileId: job.fileId, baseRevision: job.baseRevision }) }),
        ...(credential.kind === 'external-token' && { mcpRead: Object.freeze({ fileId: locked.file_id, revision: locked.revision_id }) }),
      })
      await connection.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true),set_config('dyoffice.session_id',$3,true)", [deploymentId, principal.userId, principal.sessionId])
      const result = await operation(connection, principal)
      // Object I/O may outlast a session deadline. Locks prevent revocation
      // races, but clock-based expiry must also be checked before commit.
      await lock(true)
      await connection.query('COMMIT')
      return result
    } catch (error) {
      try { await connection.query('ROLLBACK') } catch (rollback) { discard = rollback instanceof Error ? rollback : new Error('Rollback failed') }
      if ((error as { code?: string }).code === '28000') throw authError()
      throw error
    } finally { connection.release(discard) }
  }
  return {
    get sessionIdleMs() { return idleMs },
    async withPrincipalTransaction<T>(credential: BusinessCredential, operation: (connection: PoolClient, principal: BusinessPrincipal) => Promise<T>) {
      if (credential?.kind !== 'session' && credential?.kind !== 'job') throw authError()
      return transact(credential, operation)
    },
    async withMcpReadTransaction<T>(credential: McpExternalCredential, target: McpReadScope, operation: (connection: PoolClient, principal: BusinessPrincipal) => Promise<T>) {
      if (credential?.kind !== 'external-token') throw authError()
      const { fileId, revision } = target
      return transact(credential, (connection, principal) => {
        if (principal.mcpRead?.fileId !== fileId || principal.mcpRead.revision !== revision) throw authError(404)
        return operation(connection, principal)
      })
    },
    async inspectMcpReadScope(credential: McpExternalCredential): Promise<McpReadScope> {
      if (credential?.kind !== 'external-token') throw authError()
      return transact(credential, async (_connection, principal) => principal.mcpRead!)
    },
  }
}
export type McpPrincipalTransactions = ReturnType<typeof createPrincipalTransactions>
export type PrincipalTransactions = Pick<McpPrincipalTransactions, 'sessionIdleMs' | 'withPrincipalTransaction'>
