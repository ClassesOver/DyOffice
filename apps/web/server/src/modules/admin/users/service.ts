import { randomBytes, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { IdentityStore } from '../../../db/identity.ts'
import { normalizeUsername, type PasswordService } from '../../auth/passwords.ts'
import { authError, tokenHash, type SessionService, type AuthorityContext } from '../../auth/sessions.ts'
import type { createAccountService } from '../../auth/service.ts'
import { appendAuthEvent, type AuthContext } from '../../auth/audit.ts'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const idOf = (value: string) => { if (!uuid.test(value)) throw authError(400); return value.toLowerCase() }
const roleNames = ['personal', 'config_admin', 'operator', 'auditor']
type Purpose = 'activate' | 'reset'

export function createUserService({ db, accounts, sessions, passwords, deploymentId }: { db: IdentityStore; accounts: ReturnType<typeof createAccountService>; sessions: SessionService; passwords: PasswordService; deploymentId: string }) {
  const adminOptions = { lockUsers: 'update', lockAllCredentials: true, guardAdmins: true, requireAdmin: true, requireRecent: true } as const
  async function publicUser(connection: PoolClient, userId: string) {
    const { rows: [user] } = await connection.query("SELECT u.id,u.username_normalized AS username,u.display_name AS \"displayName\",u.status,u.password_reset_required AS \"requiresPasswordReset\",ARRAY(SELECT role FROM user_roles r WHERE r.deployment_id=u.deployment_id AND r.user_id=u.id ORDER BY role) AS roles FROM users u WHERE u.deployment_id=$1 AND u.id=$2", [deploymentId, userId])
    if (!user) throw authError(404)
    return user as { id: string; username: string; displayName: string; status: string; requiresPasswordReset: boolean; roles: string[] }
  }
  async function invalidate(connection: PoolClient, userId: string) {
    const { rows: [user] } = await connection.query('UPDATE users SET auth_version=auth_version+1 WHERE deployment_id=$1 AND id=$2 RETURNING auth_version', [deploymentId, userId])
    await connection.query('UPDATE password_action_tokens SET consumed_at=COALESCE(consumed_at,clock_timestamp()) WHERE deployment_id=$1 AND user_id=$2', [deploymentId, userId])
    await connection.query('UPDATE sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE deployment_id=$1 AND user_id=$2', [deploymentId, userId])
    return user.auth_version as number
  }
  async function issue(connection: PoolClient, userId: string, actorId: string, purpose: Purpose, authVersion: number) {
    const token = randomBytes(32).toString('base64url')
    const { rows: [row] } = await connection.query("INSERT INTO password_action_tokens(id,deployment_id,user_id,purpose,token_hash,expires_at,issued_by,auth_version) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '15 minutes',$6,$7) RETURNING expires_at", [randomUUID(), deploymentId, userId, purpose, tokenHash(token), actorId, authVersion])
    return { token, purpose, expiresAt: row.expires_at.toISOString() }
  }
  async function keepAdministrator(connection: PoolClient, targetId: string, nextStatus: string, nextRoles: string[], resetRequired: boolean) {
    if (nextStatus === 'active' && !resetRequired && nextRoles.includes('config_admin')) return
    const count = await connection.query("SELECT count(*)::int AS count FROM users u JOIN user_roles r ON r.deployment_id=u.deployment_id AND r.user_id=u.id AND r.role='config_admin' WHERE u.deployment_id=$1 AND u.id<>$2 AND u.status='active' AND NOT u.password_reset_required", [deploymentId, targetId])
    if (count.rows[0].count === 0) throw authError(409)
  }
  async function lookupAction(token: string, purpose: Purpose) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !['activate', 'reset'].includes(purpose)) throw authError(400)
    const { rows: [row] } = await db.pool.query('SELECT id,user_id FROM password_action_tokens WHERE deployment_id=$1 AND token_hash=$2 AND purpose=$3 AND consumed_at IS NULL AND expires_at>clock_timestamp()', [deploymentId, tokenHash(token), purpose])
    if (!row) throw authError(400)
    return row as { id: string; user_id: string }
  }
  async function issueForUser(token: string, targetInput: string, purpose: Purpose, context: AuthContext) {
    const targetId = idOf(targetInput)
    return sessions.withAuthority(token, { ...adminOptions, userIds: [targetId] }, async ({ connection, principal, users }: AuthorityContext) => {
      const target = users.get(targetId)
      if (!target) throw authError(404)
      // Use self-service password change rather than freezing the current admin.
      if (targetId === principal.userId || (purpose === 'activate' ? target.status !== 'pending' || target.password_hash !== null : target.status !== 'active')) throw authError(409)
      const version = await invalidate(connection, targetId)
      if (purpose === 'reset') await connection.query('UPDATE users SET password_reset_required=true WHERE id=$1', [targetId])
      const action = await issue(connection, targetId, principal.userId, purpose, version)
      await appendAuthEvent(connection, deploymentId, purpose === 'reset' ? 'password_reset_issued' : 'activation_reissued', { ...context, actorId: principal.userId, sessionId: principal.sessionId, subjectUserId: targetId })
      return { action }
    })
  }
  return {
    async list(token: string, options: { limit?: number; after?: string } = {}) {
      const limit = options.limit ?? 20
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw authError(400)
      const after = options.after ? idOf(options.after) : null
      return sessions.withAuthority(token, { requireAdmin: true }, async ({ connection }) => {
        const result = await connection.query('SELECT id FROM users WHERE deployment_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3', [deploymentId, after, limit + 1])
        const page = result.rows.slice(0, limit)
        const users = []
        for (const row of page) users.push(await publicUser(connection, row.id))
        return { users, nextCursor: result.rows.length > limit ? page.at(-1)!.id : null }
      })
    },
    async create(token: string, input: { username: unknown; displayName?: unknown }, context: AuthContext = {}) {
      const username = normalizeUsername(input.username)
      const displayName = input.displayName ?? ''
      if (typeof displayName !== 'string' || [...displayName].length > 200) throw authError(400)
      try {
        return await sessions.withAuthority(token, adminOptions, async ({ connection, principal }) => {
          const id = randomUUID()
          await connection.query("INSERT INTO users(id,deployment_id,username_normalized,display_name,status) VALUES($1,$2,$3,$4,'pending')", [id, deploymentId, username, displayName])
          await connection.query("INSERT INTO user_roles(deployment_id,user_id,role) VALUES($1,$2,'personal')", [deploymentId, id])
          await connection.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true)", [deploymentId, id])
          await connection.query('INSERT INTO workspaces(id,deployment_id,owner_id) VALUES($1,$2,$3)', [randomUUID(), deploymentId, id])
          const action = await issue(connection, id, principal.userId, 'activate', 1)
          await appendAuthEvent(connection, deploymentId, 'admin_user_created', { ...context, actorId: principal.userId, sessionId: principal.sessionId, subjectUserId: id })
          return { user: await publicUser(connection, id), action }
        })
      } catch (error) { if ((error as { code?: string }).code === '23505') throw authError(409); throw error }
    },
    async update(token: string, targetInput: string, patch: { status?: 'active' | 'disabled'; roles?: string[] }, context: AuthContext = {}) {
      const targetId = idOf(targetInput)
      if (!patch || Object.keys(patch).some(key => !['status', 'roles'].includes(key)) || (patch.status === undefined && patch.roles === undefined) || (patch.status !== undefined && !['active', 'disabled'].includes(patch.status))) throw authError(400)
      let selected: string[] | undefined
      if (patch.roles !== undefined) {
        if (!Array.isArray(patch.roles) || !patch.roles.length || patch.roles.some(role => !roleNames.includes(role)) || new Set(patch.roles).size !== patch.roles.length) throw authError(400)
        selected = [...new Set(['personal', ...patch.roles])].sort()
      }
      return sessions.withAuthority(token, { ...adminOptions, userIds: [targetId] }, async ({ connection, principal, users }) => {
        const target = users.get(targetId)
        if (!target) throw authError(404)
        const before = await publicUser(connection, targetId)
        if (patch.status === 'active' && target.status === 'pending') throw authError(409)
        const nextStatus = patch.status === 'active' && target.status === 'disabled' ? (target.password_hash ? 'active' : 'pending') : patch.status ?? target.status
        const nextRoles = selected ?? before.roles
        const statusChanged = nextStatus !== target.status, rolesChanged = JSON.stringify([...nextRoles].sort()) !== JSON.stringify([...before.roles].sort())
        if (!statusChanged && !rolesChanged) return { user: before, selfInvalidated: false }
        if (before.roles.includes('config_admin')) await keepAdministrator(connection, targetId, nextStatus, nextRoles, target.password_reset_required)
        await invalidate(connection, targetId)
        await connection.query("UPDATE users SET status=$1,disabled_at=CASE WHEN $1='disabled' THEN clock_timestamp() ELSE NULL END WHERE id=$2", [nextStatus, targetId])
        if (rolesChanged) {
          await connection.query('DELETE FROM user_roles WHERE deployment_id=$1 AND user_id=$2', [deploymentId, targetId])
          for (const role of nextRoles) await connection.query('INSERT INTO user_roles(deployment_id,user_id,role) VALUES($1,$2,$3)', [deploymentId, targetId, role])
          await appendAuthEvent(connection, deploymentId, 'user_roles_changed', { ...context, actorId: principal.userId, sessionId: principal.sessionId, subjectUserId: targetId })
        }
        if (statusChanged) await appendAuthEvent(connection, deploymentId, nextStatus === 'disabled' ? 'user_disabled' : 'user_restored', { ...context, actorId: principal.userId, sessionId: principal.sessionId, subjectUserId: targetId })
        return { user: await publicUser(connection, targetId), selfInvalidated: targetId === principal.userId }
      })
    },
    issueReset: (token: string, userId: string, context: AuthContext = {}) => issueForUser(token, userId, 'reset', context),
    issueActivation: (token: string, userId: string, context: AuthContext = {}) => issueForUser(token, userId, 'activate', context),
    async actionIdentity(token: string, purpose: Purpose) { return (await lookupAction(token, purpose)).user_id },
    async redeemAction(token: string, purpose: Purpose, newPassword: unknown, context: AuthContext = {}) {
      const initial = await lookupAction(token, purpose)
      const encoded = await passwords.hash(newPassword)
      return db.transaction(async connection => {
        const { rows: [user] } = await connection.query('SELECT * FROM users WHERE deployment_id=$1 AND id=$2 FOR UPDATE', [deploymentId, initial.user_id])
        const actions = await connection.query('SELECT * FROM password_action_tokens WHERE deployment_id=$1 AND user_id=$2 ORDER BY id FOR UPDATE', [deploymentId, initial.user_id])
        await connection.query('SELECT id FROM sessions WHERE deployment_id=$1 AND user_id=$2 ORDER BY id FOR UPDATE', [deploymentId, initial.user_id])
        const now: Date = (await connection.query('SELECT clock_timestamp() AS now')).rows[0].now
        const action = actions.rows.find(row => row.id === initial.id)
        if (!user || !action || action.purpose !== purpose || action.consumed_at || action.expires_at <= now || action.auth_version !== user.auth_version || (purpose === 'activate' ? user.status !== 'pending' || user.password_hash !== null : user.status !== 'active' || !user.password_reset_required)) throw authError(400)
        await invalidate(connection, user.id)
        await connection.query("UPDATE users SET password_hash=$1,password_changed_at=clock_timestamp(),password_reset_required=false,status='active' WHERE id=$2", [encoded, user.id])
        await appendAuthEvent(connection, deploymentId, 'password_action_consumed', { ...context, subjectUserId: user.id })
      })
    },
    async changePassword(token: string, currentPassword: unknown, newPassword: unknown, context: AuthContext = {}) {
      const initial = await sessions.authenticate(token)
      const candidate = await accounts.verifyCredentials(initial.username, currentPassword)
      if (!candidate || candidate.userId !== initial.userId) {
        await appendAuthEvent(db.pool, deploymentId, 'login_failed', { ...context, actorId: initial.userId, sessionId: initial.sessionId, subjectUserId: initial.userId })
        throw authError()
      }
      const encoded = await passwords.hash(newPassword)
      return sessions.withAuthority(token, { lockUsers: 'update', lockAllCredentials: true }, async ({ connection, principal }) => {
        if (candidate.authVersion !== principal.authVersion) throw authError()
        const version = await invalidate(connection, principal.userId)
        await connection.query('UPDATE users SET password_hash=$1,password_changed_at=clock_timestamp(),password_reset_required=false WHERE id=$2', [encoded, principal.userId])
        const replacement = randomBytes(32).toString('base64url'), sessionId = randomUUID()
        await connection.query("INSERT INTO sessions(id,deployment_id,user_id,token_hash,auth_version,expires_at,reauthenticated_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+$6*interval '1 millisecond',clock_timestamp())", [sessionId, deploymentId, principal.userId, tokenHash(replacement), version, sessions.absoluteMs])
        await appendAuthEvent(connection, deploymentId, 'password_changed', { ...context, actorId: principal.userId, sessionId, subjectUserId: principal.userId })
        return replacement
      })
    },
  }
}
export type UserService = ReturnType<typeof createUserService>
