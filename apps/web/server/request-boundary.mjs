import { timingSafeEqual } from 'node:crypto'

/** Temporary dev-token boundary, never a substitute for enterprise sessions/RLS. */
function matchesOpaqueToken(candidate, configured) {
  if (typeof candidate !== 'string' || typeof configured !== 'string' || !configured.length) return false
  const a = Buffer.from(candidate, 'utf8')
  const b = Buffer.from(configured, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

export function identifyDevPrincipal(request, { userToken, adminToken }) {
  const fields = request.headersDistinct?.authorization
  if (Array.isArray(fields) && fields.length !== 1) return null
  const raw = request.rawHeaders
  if (Array.isArray(raw)) {
    let count = 0
    for (let i = 0; i < raw.length; i += 2) {
      if (String(raw[i]).toLowerCase() === 'authorization') count++
    }
    if (count !== 1) return null
  }
  const header = request.headers?.authorization
  if (typeof header !== 'string') return null
  const token = /^Bearer ([^\s,]+)$/.exec(header)?.[1]
  if (!token) return null
  if (matchesOpaqueToken(token, adminToken)) return 'admin'
  if (matchesOpaqueToken(token, userToken)) return 'personal'
  return null
}

export function isPersonalResource(path) {
  return path === '/api/preferences' || path === '/api/sources' ||
    path === '/api/files' || path.startsWith('/api/files/') ||
    path === '/api/v1/capabilities' || path === '/api/v1/files' ||
    path.startsWith('/api/v1/files/') ||
    path === '/api/v1/objects' || path.startsWith('/api/v1/objects/')
}

export function authorizeDevApi(request, credentials, path) {
  const principal = identifyDevPrincipal(request, credentials)
  if (!principal) return { status: 401, error: '请登录' }
  if (path.startsWith('/api/admin/') && principal !== 'admin') return { status: 403, error: '需要管理员权限' }
  if (isPersonalResource(path) && principal !== 'personal') return { status: 403, error: '需要个人工作区权限' }
  return { principal }
}
