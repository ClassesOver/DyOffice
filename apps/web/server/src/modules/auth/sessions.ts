import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { Principal } from '../../../../../../packages/web-contracts/src/api.ts'
import type { IdentityStore } from '../../db/identity.ts'
import type { createAccountService } from './service.ts'
import { appendAuthEvent, type AuthContext } from './audit.ts'

export const authError = (statusCode = 401) => Object.assign(new Error('Authentication failed'), { statusCode })
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex')
export type SessionPrincipal = Principal & { roles: string[]; authVersion: number; username: string; displayName: string }

export function createSessionService({ db, accounts, deploymentId, idleMs = 8 * 3600_000, absoluteMs = 24 * 3600_000 }: {
  db: IdentityStore; accounts: ReturnType<typeof createAccountService>; deploymentId: string; idleMs?: number; absoluteMs?: number
}) {
  if (!Number.isSafeInteger(idleMs) || idleMs < 1 || !Number.isSafeInteger(absoluteMs) || absoluteMs < idleMs || absoluteMs > 30 * 24 * 3600_000) throw new Error('Invalid session lifetime')
  async function roles(connection: PoolClient, userId: string): Promise<string[]> {
    const result = await connection.query('SELECT role FROM user_roles WHERE deployment_id=$1 AND user_id=$2 ORDER BY role', [deploymentId, userId])
    return result.rows.map(row => row.role)
  }
  async function actor(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw authError()
    const { rows: [session] } = await db.pool.query('SELECT id,user_id FROM sessions WHERE deployment_id=$1 AND token_hash=$2', [deploymentId, tokenHash(token)])
    if (!session) throw authError()
    return session as { id: string; user_id: string }
  }
  async function withSession<T>(token: string, extraIds: string[], operation: (connection: PoolClient, principal: SessionPrincipal, session: { id: string; token_hash: string; auth_version: number; expires_at: Date; last_seen_at: Date; revoked_at: Date | null }, now: Date) => Promise<T>): Promise<T> {
    const identity = await actor(token)
    return db.transaction(async connection => {
      // Universal authority order: user rows first, then credentials in stable ID order.
      const { rows: [user] } = await connection.query('SELECT * FROM users WHERE deployment_id=$1 AND id=$2 FOR SHARE', [deploymentId, identity.user_id])
      const locked = await connection.query('SELECT * FROM sessions WHERE deployment_id=$1 AND user_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR UPDATE', [deploymentId, identity.user_id, [identity.id, ...extraIds]])
      const session = locked.rows.find(row => row.id === identity.id)
      const now: Date = (await connection.query('SELECT clock_timestamp() AS now')).rows[0].now
      if (!user || user.status !== 'active' || !session || session.token_hash !== tokenHash(token) || session.revoked_at || session.auth_version !== user.auth_version || session.expires_at <= now || session.last_seen_at.getTime() + idleMs <= now.getTime()) throw authError()
      const principal: SessionPrincipal = { deploymentId, userId: user.id, sessionId: session.id, authVersion: user.auth_version, scopes: [], roles: await roles(connection, user.id), username: user.username_normalized, displayName: user.display_name }
      await connection.query('UPDATE sessions SET last_seen_at=$1 WHERE id=$2', [now, session.id])
      return operation(connection, principal, session, now)
    })
  }
  return {
    async login(username: unknown, password: unknown, context: AuthContext = {}) {
      const candidate = await accounts.verifyCredentials(username, password)
      if (!candidate) { await appendAuthEvent(db.pool, deploymentId, 'login_failed', context); throw authError() }
      return db.transaction(async connection => {
        const { rows: [user] } = await connection.query('SELECT * FROM users WHERE deployment_id=$1 AND id=$2 FOR SHARE', [deploymentId, candidate.userId])
        if (!user || user.status !== 'active' || user.auth_version !== candidate.authVersion) throw authError()
        const token = randomBytes(32).toString('base64url'), sessionId = randomUUID()
        await connection.query('INSERT INTO sessions(id,deployment_id,user_id,token_hash,auth_version,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+$6*interval \'1 millisecond\')', [sessionId, deploymentId, user.id, tokenHash(token), user.auth_version, absoluteMs])
        await appendAuthEvent(connection, deploymentId, 'login_succeeded', { ...context, actorId: user.id, sessionId })
        return { token, sessionId, user: { id: user.id, username: user.username_normalized, displayName: user.display_name, roles: await roles(connection, user.id) } }
      })
    },
    authenticate: (token: string) => withSession(token, [], async (_connection, principal) => principal),
    async logout(token: string, context: AuthContext = {}) {
      try {
        await withSession(token, [], async (connection, principal) => {
          await connection.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1', [principal.sessionId])
          await appendAuthEvent(connection, deploymentId, 'logout', { ...context, actorId: principal.userId, sessionId: principal.sessionId })
        })
      } catch (error) { if ((error as { statusCode?: number }).statusCode !== 401) throw error }
    },
    list: (token: string) => withSession(token, [], async (connection, principal, _session, now) => {
      const result = await connection.query('SELECT id,created_at,last_seen_at,expires_at FROM sessions WHERE deployment_id=$1 AND user_id=$2 AND auth_version=$3 AND revoked_at IS NULL AND expires_at>$4 AND last_seen_at>$4-$5*interval \'1 millisecond\' ORDER BY created_at,id', [deploymentId, principal.userId, principal.authVersion, now, idleMs])
      return result.rows.map(row => ({ id: row.id, createdAt: row.created_at.toISOString(), lastSeenAt: row.last_seen_at.toISOString(), expiresAt: row.expires_at.toISOString(), current: row.id === principal.sessionId }))
    }),
    revoke: (token: string, targetId: string, context: AuthContext = {}) => withSession(token, [targetId], async (connection, principal) => {
      const result = await connection.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE deployment_id=$1 AND user_id=$2 AND id=$3 RETURNING id', [deploymentId, principal.userId, targetId])
      if (!result.rowCount) throw authError(404)
      await appendAuthEvent(connection, deploymentId, 'session_revoked', { ...context, actorId: principal.userId, sessionId: result.rows[0].id })
      return { self: principal.sessionId === targetId }
    }),
    async reauthenticate(token: string, password: unknown, context: AuthContext = {}) {
      const initial = await withSession(token, [], async (_connection, principal) => principal)
      const candidate = await accounts.verifyCredentials(initial.username, password)
      if (!candidate || candidate.userId !== initial.userId) { await appendAuthEvent(db.pool, deploymentId, 'login_failed', { ...context, actorId: initial.userId, sessionId: initial.sessionId }); throw authError() }
      return withSession(token, [], async (connection, principal, _session, now) => {
        if (candidate.authVersion !== principal.authVersion) throw authError()
        const replacement = randomBytes(32).toString('base64url')
        await connection.query('UPDATE sessions SET token_hash=$1,reauthenticated_at=$2 WHERE id=$3', [tokenHash(replacement), now, principal.sessionId])
        await appendAuthEvent(connection, deploymentId, 'reauthenticated', { ...context, actorId: principal.userId, sessionId: principal.sessionId })
        return replacement
      })
    },
  }
}
export type SessionService = ReturnType<typeof createSessionService>
