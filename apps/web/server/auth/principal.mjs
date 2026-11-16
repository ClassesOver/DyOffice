const ROLES = new Set(['user', 'config_admin', 'operator', 'auditor'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Session principal consumed by later authorization (T04) and write leases (T06).
 * Identity only: this does not open a database transaction or apply RLS.
 * `ownerId` matches the revision-lease principal. `authVersion` is the value
 * the session row matched at authentication time; T04 re-reads it inside
 * `withPrincipalTransaction` and must not trust a client-supplied copy.
 */
export function principalContext(session) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) return null
  if (!UUID.test(session.userId || '') || !UUID.test(session.deploymentId || '') || !UUID.test(session.sessionId || '')) return null
  if (!Array.isArray(session.roles) || session.roles.length === 0 || session.roles.some(role => !ROLES.has(role))) return null
  const authVersion = session.authVersion == null ? null : String(session.authVersion)
  if (authVersion !== null && !/^[1-9][0-9]*$/.test(authVersion)) return null
  return Object.freeze({
    deploymentId: session.deploymentId,
    userId: session.userId,
    ownerId: session.userId,
    sessionId: session.sessionId,
    roles: Object.freeze([...session.roles]),
    authVersion,
  })
}

/**
 * Personal files belong to the account that owns them.
 * `config_admin` does not widen this check. Row-level security is T04.
 */
export function canReadPersonalFiles(principal, ownerUserId) {
  if (!principal || typeof ownerUserId !== 'string' || !UUID.test(ownerUserId)) return false
  return principal.userId === ownerUserId && principal.ownerId === ownerUserId
}
