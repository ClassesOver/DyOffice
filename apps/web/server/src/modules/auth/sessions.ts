import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { Principal } from '../../../../../../packages/web-contracts/src/api.ts'
import type { IdentityStore } from '../../db/identity.ts'
import type { createAccountService } from './service.ts'
import { appendAuthEvent, appendLoginAttempt, type AuthContext } from './audit.ts'

export const authError = (statusCode = 401) => Object.assign(new Error('Authentication failed'), { statusCode })
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex')
export type SessionPrincipal = Principal & { roles: string[]; authVersion: number; username: string; displayName: string }

export interface AuthorityUser {
  id: string; deployment_id: string; username_normalized: string; display_name: string;
  status: string; password_hash: string | null; password_reset_required: boolean; auth_version: number
}
export interface AuthoritySession {
  id: string; user_id: string; token_hash: string; auth_version: number; expires_at: Date;
  last_seen_at: Date; revoked_at: Date | null; created_at: Date; reauthenticated_at: Date | null
}
export interface AuthorityOptions {
  userIds?: string[]; sessionIds?: string[]; lockUsers?: 'update';
  lockAllCredentials?: boolean; guardAdmins?: boolean; requireAdmin?: boolean; requireRecent?: boolean
}
export interface AuthorityContext {
  connection: PoolClient; principal: SessionPrincipal; session: AuthoritySession; now: Date;
  users: Map<string, AuthorityUser>
}

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
    const { rows: [session] } = await db.pool.query("SELECT s.id,s.user_id FROM sessions s JOIN users u ON u.id=s.user_id AND u.deployment_id=s.deployment_id WHERE s.deployment_id=$1 AND s.token_hash=$2 AND s.revoked_at IS NULL AND s.auth_version=u.auth_version AND u.status='active' AND NOT u.password_reset_required AND s.expires_at>clock_timestamp() AND s.last_seen_at>clock_timestamp()-$3*interval '1 millisecond'", [deploymentId, tokenHash(token), idleMs])
    if (!session) throw authError()
    return session as { id: string; user_id: string }
  }
  async function withAuthority<T>(token: string, options: AuthorityOptions, operation: (context: AuthorityContext) => Promise<T>): Promise<T> {
    const identity = await actor(token)
    // Fast rejection only: final authority is still rebuilt under the locks below.
    // A personal credential must not acquire every administrator's update lock.
    if (options.requireAdmin) {
      const allowed = await db.pool.query("SELECT 1 FROM user_roles WHERE deployment_id=$1 AND user_id=$2 AND role='config_admin'", [deploymentId, identity.user_id])
      if (!allowed.rowCount) throw authError(403)
    }
    const subjects = [...new Set([identity.user_id, ...(options.userIds ?? []).map(id => id.toLowerCase())])]
    return db.transaction(async connection => {
      const guards = options.guardAdmins ? (await connection.query("SELECT user_id FROM user_roles WHERE deployment_id=$1 AND role='config_admin'", [deploymentId])).rows.map(row => row.user_id as string) : []
      const ids = [...new Set([...subjects, ...guards])]
      // All user rows in UUID order precede all credential locks. Admin mutations
      // include current administrators to serialize concurrent last-admin changes.
      const userRows = await connection.query<AuthorityUser>(`SELECT * FROM users WHERE deployment_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR ${options.lockUsers === 'update' ? 'UPDATE' : 'SHARE'}`, [deploymentId, ids])
      const users = new Map(userRows.rows.map(user => [user.id, user]))
      const user = users.get(identity.user_id)
      if (options.lockAllCredentials) {
        // Credential kind order is password_action before session, then UUID.
        await connection.query('SELECT id FROM password_action_tokens WHERE deployment_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY id FOR UPDATE', [deploymentId, subjects])
      }
      const locked = options.lockAllCredentials
        ? await connection.query<AuthoritySession>('SELECT * FROM sessions WHERE deployment_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY id FOR UPDATE', [deploymentId, subjects])
        : await connection.query<AuthoritySession>('SELECT * FROM sessions WHERE deployment_id=$1 AND user_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR UPDATE', [deploymentId, identity.user_id, [identity.id, ...(options.sessionIds ?? [])]])
      const session = locked.rows.find(row => row.id === identity.id)
      // Roles and the authority clock belong to this same locked request. Read
      // them together; never reuse a principal or deadline across requests.
      const authority = (await connection.query<{ now: Date; roles: string[] }>("SELECT clock_timestamp() AS now,ARRAY(SELECT role FROM user_roles WHERE deployment_id=$1 AND user_id=$2 ORDER BY role) AS roles", [deploymentId, identity.user_id])).rows[0]
      const now = authority.now
      if (!user || user.status !== 'active' || user.password_reset_required || !session || session.token_hash !== tokenHash(token) || session.revoked_at || session.auth_version !== user.auth_version || session.expires_at <= now || session.last_seen_at.getTime() + idleMs <= now.getTime()) throw authError()
      const principal: SessionPrincipal = { deploymentId, userId: user.id, sessionId: session.id, authVersion: user.auth_version, scopes: [], roles: authority.roles, username: user.username_normalized, displayName: user.display_name }
      if (options.requireAdmin && !principal.roles.includes('config_admin')) throw authError(403)
      if (options.requireRecent && now.getTime() - (session.reauthenticated_at ?? session.created_at).getTime() > 15 * 60_000) throw authError(403)
      // Every successful request extends the persisted idle deadline. A write
      // throttle would make a later request expire before its true idle limit.
      await connection.query('UPDATE sessions SET last_seen_at=$1 WHERE id=$2', [now, session.id])
      // Capture immutable deadlines before callbacks rotate/revoke credentials
      // (password changes and self-revocation intentionally invalidate the token).
      // Row locks serialize revocation, but do not stop wall-clock expiry.
      const expiresAt = session.expires_at.getTime()
      const idleDeadline = now.getTime() + idleMs
      const recentDeadline = (session.reauthenticated_at ?? session.created_at).getTime() + 15 * 60_000
      const result = await operation({ connection, principal, session, now, users })
      const finishedAt: Date = (await connection.query('SELECT clock_timestamp() AS now')).rows[0].now
      if (finishedAt.getTime() >= expiresAt || finishedAt.getTime() >= idleDeadline) throw authError()
      if (options.requireRecent && finishedAt.getTime() > recentDeadline) throw authError(403)
      return result
    })
  }
  function withSession<T>(token: string, extraIds: string[], operation: (connection: PoolClient, principal: SessionPrincipal, session: AuthoritySession, now: Date) => Promise<T>) {
    return withAuthority(token, { sessionIds: extraIds }, ({ connection, principal, session, now }) => operation(connection, principal, session, now))
  }
  return {
    withAuthority, absoluteMs,
    async login(username: unknown, password: unknown, context: AuthContext = {}) {
      const candidate = await accounts.verifyCredentials(username, password)
      if (!candidate) { await db.transaction(connection => appendLoginAttempt(connection, deploymentId, 'login_failed', username, context)); throw authError() }
      return db.transaction(async connection => {
        const { rows: [user] } = await connection.query('SELECT * FROM users WHERE deployment_id=$1 AND id=$2 FOR SHARE', [deploymentId, candidate.userId])
        if (!user || user.status !== 'active' || user.password_reset_required || user.auth_version !== candidate.authVersion) throw authError()
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
    loginHistory: (token: string) => withSession(token, [], async connection => {
      const result = await connection.query<{ occurred_at: Date; outcome: 'success' | 'failure' | 'throttled' }>('SELECT * FROM read_login_history($1,$2,$3)', [deploymentId, tokenHash(token), idleMs])
      return result.rows.map(row => ({ occurredAt: row.occurred_at.toISOString(), outcome: row.outcome }))
    }),
    loginHistoryPage: (token: string, { limit = 20, after }: {limit?: number; after?: string} = {}) => withSession(token, [], async connection => {
      if (!Number.isInteger(limit) || limit < 1 || limit > 20 || (after !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(after))) throw authError(400)
      try {
        const result = await connection.query<{event_id: string; occurred_at: Date; outcome: 'success'|'failure'|'throttled'}>('SELECT * FROM read_login_history_page($1,$2,$3,$4,$5)', [deploymentId, tokenHash(token), idleMs, limit, after ?? null])
        const rows = result.rows.slice(0, limit)
        return {events: rows.map(row => ({occurredAt: row.occurred_at.toISOString(), outcome: row.outcome})), nextCursor: result.rows.length > limit ? rows.at(-1)!.event_id : null}
      } catch (error) { if ((error as {code?: string}).code === '22023') throw authError(400); throw error }
    }),
    list: (token: string) => withSession(token, [], async (connection, principal, _session, now) => {
      const result = await connection.query('SELECT id,created_at,last_seen_at,expires_at FROM sessions WHERE deployment_id=$1 AND user_id=$2 AND auth_version=$3 AND revoked_at IS NULL AND expires_at>$4 AND last_seen_at>$4-$5*interval \'1 millisecond\' ORDER BY created_at,id', [deploymentId, principal.userId, principal.authVersion, now, idleMs])
      return result.rows.map(row => ({ id: row.id, createdAt: row.created_at.toISOString(), lastSeenAt: row.last_seen_at.toISOString(), expiresAt: row.expires_at.toISOString(), current: row.id === principal.sessionId }))
    }),
    listPage: (token: string, {limit = 20, after}: {limit?: number; after?: string} = {}) => withSession(token, [], async (connection, principal, _session, now) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (after !== undefined && (typeof after !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(after)))) throw authError(400)
      let boundary: string | null = null
      if (after !== undefined) {
        // A revoked/expired owned session remains a valid boundary. Never use
        // JS Date precision or accept another user's/tenant's anchor. Copy the
        // immutable timestamp so deletion after this read cannot shift the page.
        const anchor = (await connection.query('SELECT created_at::text AS created_at FROM sessions WHERE deployment_id=$1 AND user_id=$2 AND id=$3', [deploymentId, principal.userId, after])).rows[0]
        if (!anchor) throw authError(400)
        boundary = anchor.created_at
      }
      const result = await connection.query("SELECT id,created_at,last_seen_at,expires_at FROM sessions WHERE deployment_id=$1 AND user_id=$2 AND auth_version=$3 AND revoked_at IS NULL AND expires_at>$4 AND last_seen_at>$4-$5*interval '1 millisecond' AND ($6::timestamptz IS NULL OR (created_at,id)>($6::timestamptz,$7::uuid)) ORDER BY created_at,id LIMIT $8", [deploymentId, principal.userId, principal.authVersion, now, idleMs, boundary, after ?? null, limit+1])
      const rows = result.rows.slice(0, limit)
      return {sessions: rows.map(row => ({id: row.id, createdAt: row.created_at.toISOString(), lastSeenAt: row.last_seen_at.toISOString(), expiresAt: row.expires_at.toISOString(), current: row.id === principal.sessionId})), nextCursor: result.rows.length > limit ? rows.at(-1)!.id as string : null}
    }),
    revoke: (token: string, targetId: string, context: AuthContext = {}) => withSession(token, [targetId], async (connection, principal) => {
      const result = await connection.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE deployment_id=$1 AND user_id=$2 AND id=$3 RETURNING id', [deploymentId, principal.userId, targetId])
      if (!result.rowCount) throw authError(404)
      await appendAuthEvent(connection, deploymentId, 'session_revoked', { ...context, actorId: principal.userId, sessionId: result.rows[0].id })
      return { self: principal.sessionId === result.rows[0].id }
    }),
    revokeOthers: (token: string, context: AuthContext = {}) => withAuthority(token, { lockUsers: 'update', lockAllCredentials: true }, async ({ connection, principal }) => {
      // Serialize against login and other credential changes. Only sessions
      // already present are revoked; future logins remain valid. Keep this
      // session and auth_version unchanged, never accept a caller-selected owner.
      const revoked = await connection.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE deployment_id=$1 AND user_id=$2 AND id<>$3 AND revoked_at IS NULL RETURNING id', [deploymentId, principal.userId, principal.sessionId])
      for (const row of revoked.rows) await appendAuthEvent(connection, deploymentId, 'session_revoked', { ...context, actorId: principal.userId, sessionId: row.id })
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
