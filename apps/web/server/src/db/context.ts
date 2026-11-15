import type { Pool, PoolClient } from 'pg'
import { assertRuntimePool } from './roles.ts'
import { tokenHash, authError } from '../modules/auth/sessions.ts'
import type { Principal } from '../../../../../packages/web-contracts/src/api.ts'

export type BusinessPrincipal = Principal & { roles: readonly string[]; authVersion: number }
export interface SessionCredential { kind: 'session'; token: string }
export function createPrincipalTransactions({ pool, deploymentId, idleMs = 8 * 3600_000 }: { pool: Pool; deploymentId: string; idleMs?: number }) {
  let admitted: ReturnType<typeof assertRuntimePool> | undefined
  return {
    async withPrincipalTransaction<T>(credential: SessionCredential, operation: (connection: PoolClient, principal: BusinessPrincipal) => Promise<T>): Promise<T> {
      await (admitted ??= assertRuntimePool(pool, 'business'))
      if (credential?.kind !== 'session' || typeof credential.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(credential.token)) throw authError()
      const connection = await pool.connect()
      let discard: Error | undefined
      try {
        await connection.query('BEGIN')
        await connection.query("SET LOCAL lock_timeout='5s'")
        await connection.query("SET LOCAL statement_timeout='10s'")
        const { rows: [locked] } = await connection.query('SELECT * FROM lock_business_session($1::uuid,$2::text,$3::bigint)', [deploymentId, tokenHash(credential.token), idleMs])
        if (!locked) throw authError()
        const principal: BusinessPrincipal = Object.freeze({ deploymentId, userId: locked.user_id, sessionId: locked.session_id, authVersion: locked.auth_version, roles: Object.freeze(locked.roles), scopes: Object.freeze(locked.roles.includes('personal') ? ['workspace:read','preferences:read','preferences:write','files:read','files:write'] : []) })
        await connection.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true),set_config('dyoffice.session_id',$3,true)", [deploymentId, principal.userId, principal.sessionId])
        const result = await operation(connection, principal)
        // Object I/O may outlast a session deadline. Locks prevent revocation
        // races, but clock-based expiry must also be checked before commit.
        await connection.query('SELECT * FROM lock_business_session($1::uuid,$2::text,$3::bigint)', [deploymentId, tokenHash(credential.token), idleMs])
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
