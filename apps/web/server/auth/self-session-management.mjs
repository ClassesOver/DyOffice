import { randomUUID } from 'node:crypto'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const validId = value => typeof value === 'string' && UUID.test(value)
export class SessionManagementError extends Error {
  constructor(code) { super(code); this.name = 'SessionManagementError'; this.code = code }
}
const deny = code => { throw new SessionManagementError(code) }
function fields(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !allowed.includes(key))) deny('INVALID_INPUT')
}
const ACTOR = `SELECT u.id, u.auth_version FROM dyoffice_users u JOIN dyoffice_sessions s
  ON s.user_id = u.id AND s.deployment_id = u.deployment_id
  WHERE u.deployment_id = $1::uuid AND u.id = $2::uuid AND s.id = $3::uuid
    AND u.status = 'active' AND u.disabled_at IS NULL AND s.auth_version = u.auth_version
    AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
    AND s.last_seen_at > clock_timestamp() - ($4::bigint * interval '1 millisecond')
    AND EXISTS (SELECT 1 FROM dyoffice_user_roles r WHERE r.deployment_id = u.deployment_id AND r.user_id = u.id)
  FOR UPDATE OF u, s`

/** Owner-only session management, not mounted into the shared application. */
export function createSelfSessionManagement({ pool, sessionService, csrfPolicy, deploymentId,
  idleTimeoutMs = 8 * 60 * 60 * 1000 } = {}) {
  if (!pool || typeof pool.connect !== 'function' ||
      !sessionService || typeof sessionService.authenticate !== 'function' ||
      !csrfPolicy || typeof csrfPolicy.verify !== 'function' || !validId(deploymentId) ||
      !Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 60_000 || idleTimeoutMs > 86_400_000) {
    throw new TypeError('Validated session-management dependencies required')
  }
  deploymentId = deploymentId.toLowerCase()
  async function transaction(request, mutating, operation) {
    let principal
    try { principal = await sessionService.authenticate(request, { deploymentId }) } catch { deny('UNAVAILABLE') }
    if (!principal || principal.deploymentId !== deploymentId || !validId(principal.userId) || !validId(principal.sessionId)) deny('UNAUTHORIZED')
    if (mutating && csrfPolicy.verify(request, principal) !== true) deny('FORBIDDEN')
    const userId = principal.userId.toLowerCase(), currentId = principal.sessionId.toLowerCase()
    let client
    try { client = await pool.connect() } catch { deny('UNAVAILABLE') }
    let begun = false, releaseError
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED'); begun = true
      await client.query("SET LOCAL lock_timeout = '5s'")
      await client.query("SET LOCAL statement_timeout = '20s'")
      // Same lock/order as account reset and password change. No shared app or
      // session issuer is changed; this only serializes these management calls.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('dyoffice:accounts:' || $1::text, 0))", [deploymentId])
      const actor = await client.query('/* self-sessions:actor */ ' + ACTOR, [deploymentId, userId, currentId, idleTimeoutMs])
      if (actor.rowCount !== 1 || actor.rows[0]?.id !== userId) deny('UNAUTHORIZED')
      const result = await operation(client, { userId, currentId, version: actor.rows[0].auth_version })
      await client.query('COMMIT'); begun = false
      return result
    } catch (error) {
      if (begun) { try { await client.query('ROLLBACK') } catch (e) { releaseError = e } }
      if (error instanceof SessionManagementError) throw error
      deny('UNAVAILABLE')
    } finally { client.release(releaseError) }
  }
  async function audit(client, actor, targetId, action, count) {
    if (!Number.isSafeInteger(count) || count < 0) deny('UNAVAILABLE')
    if (!count) return // Missing, foreign and already revoked targets are indistinguishable.
    const result = await client.query(`/* self-sessions:audit */ INSERT INTO dyoffice_session_security_events
      (id,deployment_id,user_id,actor_session_id,target_session_id,action,affected_count)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [randomUUID(), deploymentId, actor.userId, actor.currentId, targetId, action, count])
    if (result.rowCount !== 1) deny('UNAVAILABLE')
  }
  return Object.freeze({
    async list(request, input = {}) {
      fields(input, ['limit', 'before'])
      const limit = input.limit ?? 20
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
          (input.before !== undefined && !validId(input.before))) deny('INVALID_INPUT')
      const before = input.before?.toLowerCase() ?? null
      return transaction(request, false, async (client, actor) => {
        if (before) {
          const anchor = await client.query(`/* self-sessions:cursor */ SELECT id FROM dyoffice_sessions
            WHERE deployment_id = $1 AND user_id = $2 AND id = $3`, [deploymentId, actor.userId, before])
          if (anchor.rowCount !== 1) deny('INVALID_CURSOR')
        }
        const result = await client.query(`/* self-sessions:list */ SELECT s.id, s.created_at, s.last_seen_at, s.expires_at
          FROM dyoffice_sessions s WHERE s.deployment_id = $1 AND s.user_id = $2 AND s.auth_version = $3::bigint
            AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
            AND s.last_seen_at > clock_timestamp() - ($4::bigint * interval '1 millisecond')
            AND ($5::uuid IS NULL OR (s.created_at,s.id) <
              (SELECT c.created_at,c.id FROM dyoffice_sessions c WHERE c.deployment_id=$1 AND c.user_id=$2 AND c.id=$5::uuid))
          ORDER BY s.created_at DESC, s.id DESC LIMIT $6`,
        [deploymentId, actor.userId, actor.version, idleTimeoutMs, before, limit + 1])
        const page = result.rows.slice(0, limit)
        return { sessions: page.map(row => ({ sessionId: row.id, createdAt: row.created_at,
          lastSeenAt: row.last_seen_at, expiresAt: row.expires_at, current: row.id === actor.currentId })),
        nextCursor: result.rows.length > limit ? page.at(-1).id : null }
      })
    },
    async revoke(request, input) {
      fields(input, ['sessionId'])
      if (!validId(input.sessionId)) deny('INVALID_INPUT')
      const targetId = input.sessionId.toLowerCase()
      return transaction(request, true, async (client, actor) => {
        const result = await client.query(`/* self-sessions:revoke */ UPDATE dyoffice_sessions SET revoked_at = clock_timestamp()
          WHERE deployment_id = $1 AND user_id = $2 AND id = $3 AND revoked_at IS NULL`,
        [deploymentId, actor.userId, targetId])
        await audit(client, actor, targetId, 'session.revoked', result.rowCount)
        return { currentRevoked: result.rowCount === 1 && targetId === actor.currentId }
      })
    },
    async revokeOthers(request, input = {}) {
      fields(input, [])
      return transaction(request, true, async (client, actor) => {
        // This statement revokes sessions visible at this point, not future
        // logins. The current session is preserved; auth_version is unchanged.
        const result = await client.query(`/* self-sessions:revoke-others */ UPDATE dyoffice_sessions SET revoked_at = clock_timestamp()
          WHERE deployment_id = $1 AND user_id = $2 AND id <> $3 AND revoked_at IS NULL`,
        [deploymentId, actor.userId, actor.currentId])
        await audit(client, actor, null, 'session.others_revoked', result.rowCount)
        return { currentRevoked: false }
      })
    },
  })
}
