import { randomBytes } from 'node:crypto'
import { normalizeUsername } from './credential-policy.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const INVALID = Object.freeze({ ok:false, code:'INVALID_CREDENTIALS' })
const LIMITED = Object.freeze({ ok:false, code:'RATE_LIMITED' })

/**
 * Create an internal authentication service, NOT a public login HTTP route.
 * All login attempts hit a shared PostgreSQL rate limiter before password work.
 * An absent/disabled user receives the same password-hash work as a real user.
 */
export async function createLocalLoginService({
  pool, passwordHasher, sessionService, throttle, deploymentId,
} = {}) {
  if (!pool || typeof pool.query !== 'function' ||
      !passwordHasher || typeof passwordHasher.hashPassword !== 'function' || typeof passwordHasher.verifyPassword !== 'function' ||
      !sessionService || typeof sessionService.issue !== 'function' ||
      !throttle || typeof throttle.consume !== 'function' ||
      typeof deploymentId !== 'string' || !UUID.test(deploymentId)) {
    throw new TypeError('Authenticated PostgreSQL dependencies and deployment ID required')
  }
  // An absent account still performs a real Argon2id verification. This hash is
  // generated at startup rather than hardcoded in the repository.
  const fakeHash = await passwordHasher.hashPassword(randomBytes(32).toString('base64url'))
  return Object.freeze({
    async login({ username, password, ipAddress } = {}) {
      // Reject malformed input cheaply without giving attackers unlimited
      // Argon2 work; frontend returns one generic credential error.
      if (typeof username !== 'string' || username.length > 256 ||
          typeof password !== 'string' || password.length === 0 ||
          Buffer.byteLength(password, 'utf8') > 1024) return INVALID
      let normalized
      try { normalized = normalizeUsername(username) } catch { return INVALID }
      const rate = await throttle.consume({ deploymentId, usernameNormalized:normalized, ipAddress })
      if (!rate || rate.allowed !== true) return LIMITED
      const query = await pool.query(
        'SELECT id, password_hash, status, disabled_at, auth_version FROM dyoffice_users WHERE deployment_id=$1 AND username_normalized=$2',
        [deploymentId, normalized],
      )
      const row = query.rows?.[0]
      const active = query.rowCount === 1 && row && row.status === 'active' &&
        row.disabled_at === null && typeof row.password_hash === 'string'
      // Do not distinguish inactive, deleted and nonexistent accounts.
      const verified = await passwordHasher.verifyPassword(active ? row.password_hash : fakeHash, password)
      if (!active || verified !== true) return INVALID
      // Commit-time check in session.issue prevents a password-reset race from
      // authenticating a stale password after auth_version was incremented.
      const session = await sessionService.issue({
        deploymentId, userId:row.id, expectedAuthVersion:row.auth_version,
      })
      if (!session) return INVALID
      return { ok:true, userId:row.id, sessionId:session.sessionId,
        cookie:session.cookie, expiresAt:session.expiresAt }
    },
  })
}
