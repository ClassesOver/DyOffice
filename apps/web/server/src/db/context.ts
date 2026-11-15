import type { Pool, PoolClient } from 'pg'
import { assertRuntimePool } from './roles.ts'
import { tokenHash, authError } from '../modules/auth/sessions.ts'
import type { Principal } from '../../../../../packages/web-contracts/src/api.ts'

export interface JobCredential { kind: 'job'; jobId: string; epoch: number; token: string }
export type FileCredential = string | JobCredential
export type BusinessCredential = SessionCredential | JobCredential
export type BusinessPrincipal = Principal & { roles: readonly string[]; authVersion: number; job?: Readonly<{ id: string; epoch: number; fileId: string; baseRevision: string }> }
export interface SessionCredential { kind: 'session'; token: string }
export function createPrincipalTransactions({ pool, deploymentId, idleMs = 8 * 3600_000 }: { pool: Pool; deploymentId: string; idleMs?: number }) {
  deploymentId = deploymentId.toLowerCase()
  let admitted: ReturnType<typeof assertRuntimePool> | undefined
  return {
    get sessionIdleMs() { return idleMs },
    async withPrincipalTransaction<T>(input: BusinessCredential, operation: (connection: PoolClient, principal: BusinessPrincipal) => Promise<T>): Promise<T> {
      // Capture before the first await: callers cannot switch capabilities
      // between initial authorization and the final commit recheck.
      const credential = Object.freeze({ ...input })
      await (admitted ??= assertRuntimePool(pool, 'business'))
      if (!credential || !['session','job'].includes(credential.kind) || typeof credential.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(credential.token)) throw authError()
      if (credential.kind==='job' && (Object.keys(credential).some(key => !['kind','jobId','epoch','token'].includes(key)) || typeof credential.jobId!=='string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(credential.jobId) || !Number.isSafeInteger(credential.epoch) || credential.epoch<1)) throw authError()
      const connection = await pool.connect()
      let discard: Error | undefined
      try {
        await connection.query('BEGIN')
        await connection.query("SET LOCAL lock_timeout='5s'")
        await connection.query("SET LOCAL statement_timeout='10s'")
        const session = credential.kind==='session'
        const lock = (final: boolean) => session
          ? connection.query('SELECT * FROM lock_business_session($1::uuid,$2::text,$3::bigint)',[deploymentId,tokenHash(credential.token),idleMs])
          : connection.query('SELECT lock_job_principal($1::uuid,$2::uuid,$3::bigint,$4::text,$5::boolean) AS job',[deploymentId,(credential as JobCredential).jobId,(credential as JobCredential).epoch,tokenHash(credential.token),final])
        const { rows: [locked] } = await lock(false)
        if (!locked) throw authError()
        const j = locked.job, roles: readonly string[] = Object.freeze(session ? locked.roles : ['personal'])
        const principal: BusinessPrincipal = Object.freeze({ deploymentId,userId: session ? locked.user_id : j.userId,sessionId: session ? locked.session_id : j.sessionId,authVersion: session ? locked.auth_version : j.authVersion,roles,
          scopes: Object.freeze(session ? roles.includes('personal') ? ['workspace:read','preferences:read','preferences:write','files:read','files:write'] : [] : ['files:read','files:write']),
          ...(session ? {} : { job: Object.freeze({ id: j.jobId,epoch: j.epoch,fileId: j.fileId,baseRevision: j.baseRevision }) }) })
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
    },
  }
}
export type PrincipalTransactions = ReturnType<typeof createPrincipalTransactions>
