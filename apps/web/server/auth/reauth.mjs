import { isIP } from 'node:net'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class ReauthError extends Error {
  constructor(code) { super(code); this.name = 'ReauthError'; this.code = code }
}
const deny = code => { throw new ReauthError(code) }

const ACTOR = `SELECT u.id, u.username_normalized, u.password_hash
  FROM dyoffice_users u JOIN dyoffice_sessions s
    ON s.user_id = u.id AND s.deployment_id = u.deployment_id
  WHERE u.deployment_id = $1::uuid AND u.id = $2::uuid AND s.id = $3::uuid
    AND u.status = 'active' AND u.disabled_at IS NULL AND u.auth_version = s.auth_version
    AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
    AND s.last_seen_at > clock_timestamp() - ($4::bigint * interval '1 millisecond')`

/**
 * Fresh password check for an already authenticated session.
 * Does not rotate the session, change auth_version, or return a secret.
 */
export function createReauthService({ pool, passwordHasher, sessionService, csrfPolicy, throttle,
  deploymentId, idleTimeoutMs = 8 * 60 * 60 * 1000 } = {}) {
  if (!pool || typeof pool.query !== 'function' ||
      !passwordHasher || typeof passwordHasher.verifyPassword !== 'function' ||
      !sessionService || typeof sessionService.authenticate !== 'function' ||
      !csrfPolicy || typeof csrfPolicy.verify !== 'function' ||
      !throttle || typeof throttle.consume !== 'function' ||
      typeof deploymentId !== 'string' || !UUID.test(deploymentId) ||
      !Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 60_000 || idleTimeoutMs > 86_400_000) {
    throw new TypeError('Validated reauthentication dependencies required')
  }
  return Object.freeze({
    async reauthenticate(request, input) {
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).some(key => key !== 'password') ||
          typeof input.password !== 'string' || input.password.length === 0 ||
          Buffer.byteLength(input.password) > 1024) deny('INVALID_INPUT')
      const ip = request?.socket?.remoteAddress
      if (typeof ip !== 'string' || !isIP(ip)) deny('INVALID_INPUT')
      let principal
      try { principal = await sessionService.authenticate(request, { deploymentId }) }
      catch { deny('UNAVAILABLE') }
      if (!principal || principal.deploymentId !== deploymentId) deny('UNAUTHORIZED')
      if (csrfPolicy.verify(request, principal) !== true) deny('FORBIDDEN')
      let actor
      try {
        const result = await pool.query('/* reauth:actor */ ' + ACTOR, [deploymentId, principal.userId, principal.sessionId, idleTimeoutMs])
        actor = result.rowCount === 1 ? result.rows[0] : null
      } catch { deny('UNAVAILABLE') }
      if (!actor) deny('UNAUTHORIZED')
      let rate
      let verified
      try { rate = await throttle.consume({ deploymentId, usernameNormalized: actor.username_normalized, ipAddress: ip }) }
      catch { deny('UNAVAILABLE') }
      if (rate?.allowed !== true) deny('RATE_LIMITED')
      try { verified = await passwordHasher.verifyPassword(actor.password_hash, input.password) }
      catch { deny('UNAVAILABLE') }
      if (verified !== true) deny('REAUTHENTICATION_REQUIRED')
      return { ok: true, userId: principal.userId, reauthenticatedAt: new Date().toISOString() }
    },
  })
}
