import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { validateNewPassword, inspectArgon2idHash } from './credential-policy.mjs'
import { createSessionService } from './session-core.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const validId = value => typeof value === 'string' && UUID.test(value)
export class PasswordChangeError extends Error {
  constructor(code) { super(code); this.name = 'PasswordChangeError'; this.code = code }
}
const deny = code => { throw new PasswordChangeError(code) }
const SELF = `SELECT u.id, u.username_normalized, u.password_hash, u.auth_version
  FROM dyoffice_users u JOIN dyoffice_sessions s
    ON s.user_id = u.id AND s.deployment_id = u.deployment_id
  WHERE u.deployment_id = $1::uuid AND u.id = $2::uuid AND s.id = $3::uuid
    AND u.status = 'active' AND u.disabled_at IS NULL AND u.auth_version = s.auth_version
    AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
    AND s.last_seen_at > clock_timestamp() - ($4::bigint * interval '1 millisecond')
    AND EXISTS (SELECT 1 FROM dyoffice_user_roles r WHERE r.deployment_id = u.deployment_id AND r.user_id = u.id)`

/** Self-only credential change. Not mounted into the shared Web/Fastify app. */
export function createPasswordChangeService({ pool, passwordHasher, sessionService, csrfPolicy, throttle,
  deploymentId, idleTimeoutMs = 8 * 60 * 60 * 1000, absoluteTimeoutMs = 24 * 60 * 60 * 1000 } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function' ||
      !passwordHasher || typeof passwordHasher.verifyPassword !== 'function' || typeof passwordHasher.hashPassword !== 'function' ||
      !sessionService || typeof sessionService.authenticate !== 'function' ||
      !csrfPolicy || typeof csrfPolicy.verify !== 'function' || !throttle || typeof throttle.consume !== 'function' ||
      !validId(deploymentId) || ![idleTimeoutMs, absoluteTimeoutMs].every(n => Number.isSafeInteger(n) && n >= 60_000 && n <= 86_400_000) ||
      idleTimeoutMs > absoluteTimeoutMs) throw new TypeError('Validated password-change dependencies and configuration required')

  return Object.freeze({
    async changePassword(request, input) {
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).some(k => !['currentPassword', 'newPassword'].includes(k)) ||
          typeof input.currentPassword !== 'string' || !input.currentPassword.length ||
          Buffer.byteLength(input.currentPassword) > 1024 || input.currentPassword === input.newPassword) deny('INVALID_INPUT')
      try { validateNewPassword(input.newPassword) } catch { deny('INVALID_INPUT') }
      let principal
      try { principal = await sessionService.authenticate(request, { deploymentId }) } catch { deny('UNAVAILABLE') }
      if (!principal || principal.deploymentId !== deploymentId || !validId(principal.userId) || !validId(principal.sessionId)) deny('UNAUTHORIZED')
      if (csrfPolicy.verify(request, principal) !== true) deny('FORBIDDEN')
      const ipAddress = request?.socket?.remoteAddress
      if (typeof ipAddress !== 'string' || !isIP(ipAddress)) deny('INVALID_INPUT')
      const params = [deploymentId, principal.userId, principal.sessionId, idleTimeoutMs]
      let before
      try {
        const result = await pool.query('/* password-change:read */ ' + SELF, params)
        before = result.rowCount === 1 ? result.rows[0] : null
      } catch { deny('UNAVAILABLE') }
      if (!before) deny('UNAUTHORIZED')
      let rate, verified, hash
      try { rate = await throttle.consume({ deploymentId, usernameNormalized: before.username_normalized, ipAddress }) }
      catch { deny('UNAVAILABLE') }
      if (rate?.allowed !== true) deny('RATE_LIMITED')
      try { verified = await passwordHasher.verifyPassword(before.password_hash, input.currentPassword) }
      catch { deny('UNAVAILABLE') }
      if (verified !== true) deny('INVALID_CREDENTIALS')
      // Memory-hard work occurs outside the write transaction, but the exact
      // credential version and live session are checked again after taking locks.
      try { hash = await passwordHasher.hashPassword(input.newPassword) } catch { deny('UNAVAILABLE') }
      if (!inspectArgon2idHash(hash)) deny('UNAVAILABLE')
      let client
      try { client = await pool.connect() } catch { deny('UNAVAILABLE') }
      let begun = false, releaseError
      try {
        await client.query('BEGIN'); begun = true
        await client.query("SET LOCAL lock_timeout = '5s'")
        await client.query("SET LOCAL statement_timeout = '20s'")
        // Same lock/order as account-lifecycle: admin reset and self-change must
        // not independently overwrite each other after credential verification.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('dyoffice:accounts:' || $1::text, 0))", [deploymentId])
        const locked = await client.query('/* password-change:lock */ ' + SELF + ' FOR UPDATE OF u, s', params)
        const current = locked.rows[0]
        if (locked.rowCount !== 1 || !current || current.id !== before.id ||
            current.auth_version !== before.auth_version || current.password_hash !== before.password_hash) deny('AUTHENTICATION_CHANGED')
        const updated = await client.query(`/* password-change:update */ UPDATE dyoffice_users
          SET password_hash = $3, password_changed_at = clock_timestamp(), auth_version = auth_version + 1,
              updated_at = clock_timestamp()
          WHERE deployment_id = $1 AND id = $2 AND auth_version = $4::bigint RETURNING auth_version`,
        [deploymentId, current.id, hash, before.auth_version])
        if (updated.rowCount !== 1) deny('AUTHENTICATION_CHANGED')
        await client.query(`/* password-change:revoke_sessions */ UPDATE dyoffice_sessions SET revoked_at = clock_timestamp()
          WHERE deployment_id = $1 AND user_id = $2 AND revoked_at IS NULL`, [deploymentId, current.id])
        await client.query(`/* password-change:revoke_actions */ UPDATE dyoffice_password_action_tokens SET revoked_at = clock_timestamp()
          WHERE deployment_id = $1 AND user_id = $2 AND consumed_at IS NULL AND revoked_at IS NULL`, [deploymentId, current.id])
        await client.query(`/* password-change:audit */ INSERT INTO dyoffice_account_events
          (id, deployment_id, actor_user_id, target_user_id, action) VALUES ($1,$2,$3,$4,$5)`,
        [randomUUID(), deploymentId, current.id, current.id, 'password.changed'])
        // Use the existing cookie/token implementation on THIS transaction's
        // client. No cookie is exposed until credential, audit and session commit.
        const replacement = await createSessionService({ pool: client, idleTimeoutMs, absoluteTimeoutMs }).issue({
          deploymentId, userId: current.id, expectedAuthVersion: updated.rows[0].auth_version,
        })
        if (!replacement) deny('UNAVAILABLE')
        await client.query('COMMIT'); begun = false
        return replacement
      } catch (error) {
        if (begun) { try { await client.query('ROLLBACK') } catch (e) { releaseError = e } }
        if (error instanceof PasswordChangeError) throw error
        deny('UNAVAILABLE')
      } finally { client.release(releaseError) }
    },
  })
}
