import { createHash, randomBytes, randomUUID } from 'node:crypto'

export const SESSION_COOKIE_NAME = '__Host-dyoffice_session'
export const CLEAR_SESSION_COOKIE = SESSION_COOKIE_NAME + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DEFAULT_IDLE_MS = 8 * 60 * 60 * 1000
const DEFAULT_ABSOLUTE_MS = 24 * 60 * 60 * 1000

function validId(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new TypeError('Invalid ' + label)
  return value
}

function tokenDigest(token) {
  return createHash('sha256').update(token, 'utf8').digest()
}

/** Reject duplicate Cookie headers and duplicate/invalid session cookie values. */
export function readSessionCookie(request) {
  if (!request || !request.headers) return null
  if (Array.isArray(request.headersDistinct?.cookie) && request.headersDistinct.cookie.length !== 1) return null
  if (Array.isArray(request.rawHeaders)) {
    let count = 0
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      if (String(request.rawHeaders[i]).toLowerCase() === 'cookie') count++
    }
    if (count > 1) return null
  }
  const header = request.headers.cookie
  if (typeof header !== 'string' || header.length === 0 || header.length > 4096) return null
  let token = null
  for (const part of header.split(';')) {
    const segment = part.trim()
    if (!segment.startsWith(SESSION_COOKIE_NAME + '=')) continue
    if (token !== null) return null
    const value = segment.slice(SESSION_COOKIE_NAME.length + 1)
    if (!TOKEN_PATTERN.test(value)) return null
    token = value
  }
  return token
}

function issueCookie(token, absoluteTimeoutMs) {
  const seconds = Math.ceil(absoluteTimeoutMs / 1000)
  return SESSION_COOKIE_NAME + '=' + token +
    '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + seconds
}

const SQL_ISSUE = [
  'INSERT INTO dyoffice_sessions (id, deployment_id, user_id, session_token_hash, auth_version, expires_at)',
  "SELECT $1::uuid, u.deployment_id, u.id, $4::bytea, u.auth_version, clock_timestamp() + ($5::bigint * INTERVAL '1 millisecond')",
  'FROM dyoffice_users u',
  "WHERE u.deployment_id = $2::uuid AND u.id = $3::uuid AND u.status = 'active' AND u.disabled_at IS NULL",
  'AND ($6::bigint IS NULL OR u.auth_version = $6::bigint)',
  'AND EXISTS (SELECT 1 FROM dyoffice_user_roles r WHERE r.deployment_id = u.deployment_id AND r.user_id = u.id)',
  'RETURNING id, expires_at'
].join(' ')

// Refresh idle time in the same atomic SQL operation as session-state checks.
// Authorization for a later file write must still be revalidated in that write TX.
const SQL_AUTH = [
  'UPDATE dyoffice_sessions s SET last_seen_at = clock_timestamp()',
  'FROM dyoffice_users u',
  'WHERE s.session_token_hash = $1::bytea AND s.deployment_id = $2::uuid',
  'AND u.id = s.user_id AND u.deployment_id = s.deployment_id',
  "AND u.status = 'active' AND u.disabled_at IS NULL AND u.auth_version = s.auth_version",
  'AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()',
  "AND s.last_seen_at > clock_timestamp() - ($3::bigint * INTERVAL '1 millisecond')",
  'AND EXISTS (SELECT 1 FROM dyoffice_user_roles r WHERE r.deployment_id = u.deployment_id AND r.user_id = u.id)',
  'RETURNING s.id AS session_id, s.user_id, s.deployment_id, s.auth_version, s.expires_at,',
  '(SELECT ARRAY(SELECT r.role::text FROM dyoffice_user_roles r',
  'WHERE r.deployment_id = s.deployment_id AND r.user_id = s.user_id ORDER BY r.role)) AS roles'
].join(' ')

const SQL_REVOKE = [
  'UPDATE dyoffice_sessions SET revoked_at = clock_timestamp()',
  'WHERE session_token_hash = $1::bytea AND deployment_id = $2::uuid AND revoked_at IS NULL'
].join(' ')
const SQL_REVOKE_ALL = [
  'UPDATE dyoffice_sessions SET revoked_at = clock_timestamp()',
  'WHERE deployment_id = $1::uuid AND user_id = $2::uuid AND revoked_at IS NULL'
].join(' ')

/**
 * Internal-only session persistence. No login route or shared development token
 * fallback is exposed by this module. Call issue() only AFTER credential check.
 */
export function createSessionService({ pool, idleTimeoutMs = DEFAULT_IDLE_MS, absoluteTimeoutMs = DEFAULT_ABSOLUTE_MS } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('PostgreSQL application pool required')
  if (![idleTimeoutMs, absoluteTimeoutMs].every(n => Number.isSafeInteger(n) && n >= 60_000 && n <= DEFAULT_ABSOLUTE_MS) ||
      idleTimeoutMs > absoluteTimeoutMs) throw new TypeError('Invalid session lifetime')

  return Object.freeze({
    async issue({ deploymentId, userId, expectedAuthVersion = null }) {
      validId(deploymentId, 'deployment ID')
      validId(userId, 'user ID')
      if (expectedAuthVersion !== null &&
          !(typeof expectedAuthVersion === 'string' && /^[1-9][0-9]*$/.test(expectedAuthVersion) &&
            BigInt(expectedAuthVersion) <= 9223372036854775807n)) {
        throw new TypeError('Invalid expected authentication version')
      }
      const sessionId = randomUUID()
      const token = randomBytes(32).toString('base64url')
      const result = await pool.query(SQL_ISSUE, [
        sessionId, deploymentId, userId, tokenDigest(token), absoluteTimeoutMs, expectedAuthVersion,
      ])
      if (result.rowCount !== 1) return null
      return {
        sessionId,
        expiresAt: result.rows[0].expires_at,
        cookie: issueCookie(token, absoluteTimeoutMs),
      }
    },
    async authenticate(request, { deploymentId }) {
      validId(deploymentId, 'deployment ID')
      const token = readSessionCookie(request)
      if (!token) return null
      const result = await pool.query(SQL_AUTH, [tokenDigest(token), deploymentId, idleTimeoutMs])
      const row = result.rows[0]
      if (result.rowCount !== 1 || !row || !Array.isArray(row.roles) || row.roles.length === 0) return null
      return {
        sessionId: row.session_id,
        userId: row.user_id,
        deploymentId: row.deployment_id,
        authVersion: row.auth_version == null ? null : String(row.auth_version),
        roles: row.roles,
        expiresAt: row.expires_at,
      }
    },
    async revoke(request, { deploymentId }) {
      validId(deploymentId, 'deployment ID')
      const token = readSessionCookie(request)
      if (!token) return false
      const result = await pool.query(SQL_REVOKE, [tokenDigest(token), deploymentId])
      return result.rowCount === 1
    },
    async revokeAllForUser({ deploymentId, userId }) {
      validId(deploymentId, 'deployment ID')
      validId(userId, 'user ID')
      const result = await pool.query(SQL_REVOKE_ALL, [deploymentId, userId])
      return result.rowCount
    },
  })
}
