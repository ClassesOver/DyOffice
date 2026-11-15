import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { normalizeUsername, validateNewPassword, inspectArgon2idHash } from './credential-policy.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TOKEN = /^[A-Za-z0-9_-]{43}$/
const MAX_LIFETIME = 60 * 60 * 1000

export class AccountLifecycleError extends Error {
  constructor(code) { super(code); this.name = 'AccountLifecycleError'; this.code = code }
}
const reject = code => { throw new AccountLifecycleError(code) }
const validId = value => typeof value === 'string' && UUID.test(value)
const digest = token => createHash('sha256').update(token, 'utf8').digest()

function fields(input, names) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !names.includes(key))) reject('INVALID_INPUT')
}
function passwordInput(password) {
  if (typeof password !== 'string' || !password.length || Buffer.byteLength(password) > 1024) reject('INVALID_INPUT')
}
function sourceIp(request) {
  const ip = request?.socket?.remoteAddress
  if (typeof ip !== 'string' || !isIP(ip)) reject('INVALID_INPUT')
  return ip // Deliberately ignores user-controlled forwarded headers.
}

const ACTOR = `SELECT u.id, u.deployment_id, u.username_normalized, u.password_hash, u.auth_version,
  s.id AS session_id
  FROM dyoffice_users u JOIN dyoffice_sessions s
    ON s.user_id = u.id AND s.deployment_id = u.deployment_id
  WHERE u.deployment_id = $1::uuid AND u.id = $2::uuid AND s.id = $3::uuid
    AND u.status = 'active' AND u.disabled_at IS NULL AND u.auth_version = s.auth_version
    AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
    AND s.last_seen_at > clock_timestamp() - ($4::bigint * interval '1 millisecond')
    AND EXISTS (SELECT 1 FROM dyoffice_user_roles r WHERE r.deployment_id = u.deployment_id
      AND r.user_id = u.id AND r.role = 'config_admin')`
const GRANT = `SELECT t.id, t.user_id, t.purpose, u.auth_version, u.status
  FROM dyoffice_password_action_tokens t JOIN dyoffice_users u
    ON t.user_id = u.id AND t.deployment_id = u.deployment_id
  WHERE t.deployment_id = $1::uuid AND t.token_hash = $2::bytea
    AND t.consumed_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > clock_timestamp()
    AND t.purpose IN ('activate', 'reset') AND u.status = 'pending' AND u.disabled_at IS NULL`

/**
 * Internal account-management core. No public route, default password, role
 * escalation API, or document permission is introduced. All administrator
 * mutations require a live DB session, CSRF and a fresh password verification.
 */
export function createAccountLifecycle({ pool, passwordHasher, sessionService, csrfPolicy, throttle,
  deploymentId, tokenLifetimeMs = 15 * 60 * 1000, idleTimeoutMs = 8 * 60 * 60 * 1000 } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function' ||
      !passwordHasher || typeof passwordHasher.hashPassword !== 'function' || typeof passwordHasher.verifyPassword !== 'function' ||
      !sessionService || typeof sessionService.authenticate !== 'function' ||
      !csrfPolicy || typeof csrfPolicy.verify !== 'function' || !throttle || typeof throttle.consume !== 'function' ||
      !validId(deploymentId) || !Number.isSafeInteger(tokenLifetimeMs) || tokenLifetimeMs < 60_000 || tokenLifetimeMs > MAX_LIFETIME ||
      !Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 60_000 || idleTimeoutMs > 86_400_000) {
    throw new TypeError('Account lifecycle requires validated authentication services and configuration')
  }

  async function read(sql, params) {
    try { const result = await pool.query(sql, params); return result.rowCount === 1 ? result.rows[0] : null }
    catch { reject('UNAVAILABLE') }
  }
  async function budget(usernameNormalized, request) {
    const ipAddress = sourceIp(request)
    let result
    try { result = await throttle.consume({ deploymentId, usernameNormalized, ipAddress }) }
    catch { reject('UNAVAILABLE') }
    if (result?.allowed !== true) reject('RATE_LIMITED')
  }
  async function administrator(request, adminPassword) {
    passwordInput(adminPassword)
    let principal
    try { principal = await sessionService.authenticate(request, { deploymentId }) }
    catch { reject('UNAVAILABLE') }
    if (!principal || principal.deploymentId !== deploymentId || !validId(principal.userId) || !validId(principal.sessionId)) reject('UNAUTHORIZED')
    if (!csrfPolicy.verify(request, principal)) reject('FORBIDDEN')
    const params = [deploymentId, principal.userId, principal.sessionId, idleTimeoutMs]
    const actor = await read('/* account:actor */ ' + ACTOR, params)
    if (!actor) reject('FORBIDDEN')
    await budget(actor.username_normalized, request)
    let verified
    try { verified = await passwordHasher.verifyPassword(actor.password_hash, adminPassword) }
    catch { reject('UNAVAILABLE') }
    if (verified !== true) reject('REAUTHENTICATION_REQUIRED')
    return { ...actor, params }
  }
  async function transaction(actor, work) {
    let client
    try { client = await pool.connect() } catch { reject('UNAVAILABLE') }
    let begun = false, releaseError
    try {
      await client.query('BEGIN'); begun = true
      await client.query("SET LOCAL lock_timeout = '5s'")
      // Serialize low-frequency account mutations within a deployment. Tokens,
      // user rows and audits then commit together; the lock is transaction-bound.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('dyoffice:accounts:' || $1::text, 0))", [deploymentId])
      if (actor) {
        const current = await client.query('/* account:actor_lock */ ' + ACTOR + ' FOR UPDATE OF u, s', actor.params)
        const row = current.rows[0]
        if (current.rowCount !== 1 || !row || row.id !== actor.id || row.auth_version !== actor.auth_version ||
            row.password_hash !== actor.password_hash) reject('REAUTHENTICATION_REQUIRED')
      }
      const result = await work(client)
      await client.query('COMMIT'); begun = false
      return result
    } catch (error) {
      if (begun) {
        try { await client.query('ROLLBACK') } catch (rollbackError) { releaseError = rollbackError }
      }
      if (error instanceof AccountLifecycleError) throw error
      reject(error?.code === '23505' ? 'CONFLICT' : 'UNAVAILABLE')
    } finally { client.release(releaseError) }
  }
  async function audit(client, actorId, targetId, action) {
    await client.query(`/* account:audit */ INSERT INTO dyoffice_account_events
      (id, deployment_id, actor_user_id, target_user_id, action) VALUES ($1,$2,$3,$4,$5)`,
    [randomUUID(), deploymentId, actorId, targetId, action])
  }
  async function invalidate(client, targetId) {
    await client.query(`/* account:revoke_sessions */ UPDATE dyoffice_sessions SET revoked_at = clock_timestamp()
      WHERE deployment_id = $1 AND user_id = $2 AND revoked_at IS NULL`, [deploymentId, targetId])
    await client.query(`/* account:revoke_tokens */ UPDATE dyoffice_password_action_tokens SET revoked_at = clock_timestamp()
      WHERE deployment_id = $1 AND user_id = $2 AND revoked_at IS NULL AND consumed_at IS NULL`, [deploymentId, targetId])
  }
  async function issueToken(client, actorId, targetId, purpose) {
    const token = randomBytes(32).toString('base64url')
    const result = await client.query(`/* account:issue_token */ INSERT INTO dyoffice_password_action_tokens
      (id, deployment_id, user_id, purpose, token_hash, expires_at, issued_by)
      VALUES ($1,$2,$3,$4,$5,clock_timestamp() + ($6::bigint * interval '1 millisecond'),$7)
      RETURNING expires_at`, [randomUUID(), deploymentId, targetId, purpose, digest(token), tokenLifetimeMs, actorId])
    if (result.rowCount !== 1) reject('UNAVAILABLE')
    return { token, expiresAt: result.rows[0].expires_at }
  }
  async function target(client, targetId) {
    const row = await client.query(`/* account:target_lock */ SELECT id, status, password_hash FROM dyoffice_users
      WHERE deployment_id = $1 AND id = $2 FOR UPDATE`, [deploymentId, targetId])
    if (row.rowCount !== 1) reject('NOT_FOUND')
    return row.rows[0]
  }

  return Object.freeze({
    async createAccount(request, input) {
      fields(input, ['username', 'displayName', 'adminPassword'])
      let username
      try { username = normalizeUsername(input.username) } catch { reject('INVALID_INPUT') }
      if (typeof input.displayName !== 'string' || !input.displayName.trim() || input.displayName.length > 200) reject('INVALID_INPUT')
      const actor = await administrator(request, input.adminPassword)
      return transaction(actor, async client => {
        const userId = randomUUID()
        await client.query(`/* account:create_user */ INSERT INTO dyoffice_users
          (id, deployment_id, username_normalized, display_name, status) VALUES ($1,$2,$3,$4,'pending')`,
        [userId, deploymentId, username, input.displayName.trim()])
        await client.query(`/* account:create_role */ INSERT INTO dyoffice_user_roles
          (deployment_id,user_id,role) VALUES ($1,$2,$3)`, [deploymentId, userId, 'user'])
        await client.query(`/* account:create_workspace */ INSERT INTO dyoffice_personal_workspaces
          (id,deployment_id,owner_user_id) VALUES ($1,$2,$3)`, [randomUUID(), deploymentId, userId])
        const grant = await issueToken(client, actor.id, userId, 'activate')
        await audit(client, actor.id, userId, 'account.created')
        return { userId, username, status: 'pending', activationToken: grant.token, expiresAt: grant.expiresAt }
      })
    },
    async issuePasswordReset(request, input) {
      fields(input, ['userId', 'adminPassword'])
      if (!validId(input.userId)) reject('INVALID_INPUT')
      const actor = await administrator(request, input.adminPassword)
      if (input.userId.toLowerCase() === actor.id.toLowerCase()) reject('SELF_ACTION_FORBIDDEN')
      return transaction(actor, async client => {
        const user = await target(client, input.userId)
        if (user.status === 'disabled') reject('ACCOUNT_DISABLED')
        // Admin reset is deliberately a suspension: old credentials may not
        // log in again while the one-time action awaits secure delivery.
        await client.query(`/* account:suspend_password */ UPDATE dyoffice_users SET status = 'pending',
          password_hash = NULL, password_changed_at = NULL, auth_version = auth_version + 1, updated_at = clock_timestamp()
          WHERE deployment_id = $1 AND id = $2`, [deploymentId, user.id])
        await invalidate(client, user.id)
        const grant = await issueToken(client, actor.id, user.id, 'reset')
        await audit(client, actor.id, user.id, 'account.reset_issued')
        return { userId: user.id, status: 'pending', resetToken: grant.token, expiresAt: grant.expiresAt }
      })
    },
    async setAccountEnabled(request, input) {
      fields(input, ['userId', 'enabled', 'adminPassword'])
      if (!validId(input.userId) || typeof input.enabled !== 'boolean') reject('INVALID_INPUT')
      const actor = await administrator(request, input.adminPassword)
      if (input.userId.toLowerCase() === actor.id.toLowerCase()) reject('SELF_ACTION_FORBIDDEN')
      return transaction(actor, async client => {
        const user = await target(client, input.userId)
        if ((input.enabled && user.status !== 'disabled') || (!input.enabled && user.status === 'disabled')) {
          return { userId: user.id, status: user.status }
        }
        const status = input.enabled ? (user.password_hash ? 'active' : 'pending') : 'disabled'
        await client.query(`/* account:set_status */ UPDATE dyoffice_users SET status = $3::varchar,
          disabled_at = CASE WHEN $3::varchar = 'disabled' THEN clock_timestamp() ELSE NULL END,
          auth_version = auth_version + 1, updated_at = clock_timestamp() WHERE deployment_id = $1 AND id = $2`,
        [deploymentId, user.id, status])
        await invalidate(client, user.id)
        await audit(client, actor.id, user.id, input.enabled ? 'account.enabled' : 'account.disabled')
        return { userId: user.id, status }
      })
    },
    async redeemPasswordAction(request, input) {
      fields(input, ['token', 'newPassword'])
      if (typeof input.token !== 'string' || !TOKEN.test(input.token) ||
          Buffer.from(input.token, 'base64url').toString('base64url') !== input.token) reject('INVALID_ACTION')
      const tokenHash = digest(input.token)
      await budget('action.' + tokenHash.toString('hex').slice(0, 40), request)
      const params = [deploymentId, tokenHash]
      const before = await read('/* account:lookup_token */ ' + GRANT, params)
      if (!before) reject('INVALID_ACTION')
      try { validateNewPassword(input.newPassword) } catch { reject('INVALID_INPUT') }
      let hash
      try { hash = await passwordHasher.hashPassword(input.newPassword) } catch { reject('UNAVAILABLE') }
      if (!inspectArgon2idHash(hash)) reject('UNAVAILABLE')
      return transaction(null, async client => {
        const result = await client.query('/* account:token_lock */ ' + GRANT + ' FOR UPDATE OF t, u', params)
        const current = result.rows[0]
        if (result.rowCount !== 1 || !current || current.id !== before.id || current.auth_version !== before.auth_version) reject('INVALID_ACTION')
        const consume = await client.query(`/* account:consume_token */ UPDATE dyoffice_password_action_tokens
          SET consumed_at = clock_timestamp() WHERE id = $1 AND deployment_id = $2
          AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > clock_timestamp() RETURNING id`, [current.id, deploymentId])
        if (consume.rowCount !== 1) reject('INVALID_ACTION')
        await client.query(`/* account:change_password */ UPDATE dyoffice_users SET password_hash = $3,
          password_changed_at = clock_timestamp(), status = 'active', disabled_at = NULL,
          auth_version = auth_version + 1, updated_at = clock_timestamp() WHERE deployment_id = $1 AND id = $2`,
        [deploymentId, current.user_id, hash])
        await invalidate(client, current.user_id)
        await audit(client, current.user_id, current.user_id, current.purpose === 'activate' ? 'password.activated' : 'password.reset')
        return { userId: current.user_id, requiresLogin: true }
      })
    },
  })
}
