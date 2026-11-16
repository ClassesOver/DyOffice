import { CLEAR_SESSION_COOKIE } from './session-core.mjs'

const ROOT = '/api/v1/auth/sessions'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
function singleHeader(request, name) {
  const value = request.headers?.[name]
  if (typeof value !== 'string') return null
  if (Array.isArray(request.headersDistinct?.[name]) && request.headersDistinct[name].length !== 1) return null
  if (Array.isArray(request.rawHeaders)) {
    let count = 0
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      if (String(request.rawHeaders[i]).toLowerCase() === name) count++
    }
    if (count !== 1) return null
  }
  return value
}
function send(response, status, body, headers = {}) {
  if (response.headersSent) { response.destroy(); return }
  response.writeHead(status, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', Vary: 'Cookie',
    ...(status !== 204 ? { 'Content-Type': 'application/json; charset=utf-8' } : {}), ...headers })
  response.end(status === 204 ? undefined : JSON.stringify(body))
}

/** Standalone HTTP adapter; callers must mount deliberately after review. */
export function createSelfSessionHttpAdapter({ service, trustedOrigin } = {}) {
  if (!service || !['list', 'revoke', 'revokeOthers'].every(k => typeof service[k] === 'function')) {
    throw new TypeError('Session management service required')
  }
  let origin
  try {
    origin = new URL(trustedOrigin)
    if (origin.origin !== trustedOrigin || origin.username || origin.password ||
        !(origin.protocol === 'https:' || (origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))) throw Error()
  } catch { throw new TypeError('Canonical trusted HTTPS origin required') }
  return async function handle(request, response) {
    const raw = typeof request.url === 'string' ? request.url : ''
    const path = raw.split('?')[0]
    const list = path === ROOT, others = path === ROOT + '/revoke-others'
    const target = path.startsWith(ROOT + '/') ? path.slice(ROOT.length + 1) : ''
    const one = UUID.test(target)
    if (!list && !others && !one) return false
    const reject = (status, error, headers) => { send(response, status, { error }, headers); return true }
    try {
      const method = list ? 'GET' : others ? 'POST' : 'DELETE'
      if (request.method !== method) return reject(405, 'Method not allowed', { Allow: method })
      if (!list && singleHeader(request, 'origin') !== trustedOrigin) return reject(403, 'Forbidden')
      // These endpoints have no request body. Reject framed content without
      // buffering/draining arbitrary bytes, and close rejected connections.
      const length = request.headers?.['content-length']
      if (request.headers?.['transfer-encoding'] !== undefined ||
          (length !== undefined && (singleHeader(request, 'content-length') !== '0'))) {
        return reject(400, 'Request body not allowed', { Connection: 'close' })
      }
      const url = new URL(raw, 'http://localhost')
      if (url.hash || (!list && url.search)) return reject(400, 'Invalid request')
      if (list) {
        const params = url.searchParams
        if ([...params.keys()].some(k => !['limit', 'before'].includes(k) || params.getAll(k).length !== 1)) return reject(400, 'Invalid query')
        const input = {}
        if (params.has('limit')) {
          const limit = params.get('limit')
          if (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > 100) return reject(400, 'Invalid query')
          input.limit = Number(limit)
        }
        if (params.has('before')) {
          const before = params.get('before')
          if (!UUID.test(before)) return reject(400, 'Invalid query')
          input.before = before
        }
        send(response, 200, await service.list(request, input))
      } else {
        const result = others ? await service.revokeOthers(request) : await service.revoke(request, { sessionId: target })
        // The service returns only after COMMIT. Never clear the current cookie
        // on another user's target, missing target, or failed transaction.
        send(response, 204, undefined, result.currentRevoked === true ? { 'Set-Cookie': CLEAR_SESSION_COOKIE } : {})
      }
    } catch (error) {
      const statuses = { INVALID_INPUT: 400, INVALID_CURSOR: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, UNAVAILABLE: 503 }
      const status = Object.hasOwn(statuses, error?.code) ? statuses[error.code] : 503
      return reject(status, status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : status === 400 ? 'Invalid request' : 'Service unavailable')
    }
    return true
  }
}
