const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DEV_ID = /^(dev-personal|dev-admin)$/
const DEPLOYMENT = /^(dev|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i
const ROLES = new Set(['user', 'config_admin', 'operator', 'auditor'])

/**
 * Development bearer principal. The owner id matches the object-store dev
 * owner. It is not a database user id. Request bodies cannot change it.
 * A mounted session authenticator replaces this for that process.
 */
export const DEV_PERSONAL_PRINCIPAL = Object.freeze({
  userId: 'dev-personal',
  ownerId: 'dev-personal',
  deploymentId: 'dev',
  sessionId: 'dev-editor',
  roles: Object.freeze(['user']),
  source: 'dev-token',
})

/** Configuration admin. The role does not grant file ownership. */
export const DEV_ADMIN_PRINCIPAL = Object.freeze({
  userId: 'dev-admin',
  ownerId: 'dev-admin',
  deploymentId: 'dev',
  sessionId: 'dev-admin',
  roles: Object.freeze(['config_admin']),
  source: 'dev-token',
})

function unauthenticated() {
  return Object.assign(new Error('请登录'), { code: 'UNAUTHENTICATED', status: 401, publicCode: 'UNAUTHENTICATED' })
}

export function devPrincipalFor(kind) {
  if (kind === 'personal') return DEV_PERSONAL_PRINCIPAL
  if (kind === 'admin') return DEV_ADMIN_PRINCIPAL
  return null
}

/**
 * Session rows from createSessionService.authenticate(). ownerId is the
 * session user id. A caller-supplied owner is ignored.
 */
export function principalFromSession(session) {
  if (!session || typeof session !== 'object') return null
  try {
    return normalizePrincipal({
      userId: session.userId,
      ownerId: session.userId,
      deploymentId: session.deploymentId,
      sessionId: session.sessionId,
      roles: session.roles,
      source: 'session',
    })
  } catch {
    return null
  }
}

export function normalizePrincipal(principal) {
  if (!principal || typeof principal !== 'object') throw unauthenticated()
  const userId = typeof principal.userId === 'string' ? principal.userId : principal.ownerId
  const ownerId = typeof principal.ownerId === 'string' ? principal.ownerId : userId
  if (typeof userId !== 'string' || typeof ownerId !== 'string' || userId !== ownerId) throw unauthenticated()
  if (!UUID.test(userId) && !DEV_ID.test(userId)) throw unauthenticated()
  if (typeof principal.deploymentId !== 'string' || !DEPLOYMENT.test(principal.deploymentId)) throw unauthenticated()
  if (typeof principal.sessionId !== 'string' || principal.sessionId.length < 1 || principal.sessionId.length > 200) {
    throw unauthenticated()
  }
  const roles = principal.roles === undefined ? [] : principal.roles
  if (!Array.isArray(roles) || roles.some((role) => typeof role !== 'string' || !ROLES.has(role))) throw unauthenticated()
  const source = principal.source === 'session' || principal.source === 'dev-token' ? principal.source : 'server'
  return {
    userId,
    ownerId,
    deploymentId: principal.deploymentId,
    sessionId: principal.sessionId,
    roles: Object.freeze([...roles]),
    source,
  }
}

/** Owner for a request the server already authenticated. Never a body field. */
export function ownerIdFromRequest(request, fallback) {
  const principal = request?.dyofficePrincipal
  if (principal && typeof principal.ownerId === 'string') return principal.ownerId
  return fallback
}
