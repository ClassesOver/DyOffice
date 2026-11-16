import { PasswordChangeError } from './password-change.mjs'

const PATH = '/api/v1/auth/change-password'
const MAX_BODY = 8192
const STATUS = Object.freeze({ INVALID_INPUT: 400, UNAUTHORIZED: 401, INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403, RATE_LIMITED: 429, AUTHENTICATION_CHANGED: 409, LEASE_REVOKE_FAILED: 503, UNAVAILABLE: 503 })

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

class BodyError extends Error {
  constructor(status) { super('Invalid request body'); this.status = status }
}
function readBody(request, timeoutMs) {
  // Event-based bounded reader allows a 413 response; breaking async iteration
  // on IncomingMessage would destroy its socket before that response is sent.
  return new Promise((resolve, reject) => {
    let size = 0, finished = false
    const chunks = []
    const finish = (error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      request.removeListener('data', data)
      request.removeListener('end', end)
      request.removeListener('error', failed)
      request.removeListener('aborted', failed)
      if (error) { request.resume(); reject(error) }
      else resolve(Buffer.concat(chunks).toString('utf8'))
    }
    const data = chunk => {
      size += chunk.byteLength
      if (size > MAX_BODY) return finish(new BodyError(413))
      chunks.push(chunk)
    }
    const end = () => finish()
    const failed = () => finish(new BodyError(400))
    const timer = setTimeout(() => finish(new BodyError(408)), timeoutMs)
    request.on('data', data).once('end', end).once('error', failed).once('aborted', failed)
  })
}
function reply(response, status, body, headers = {}) {
  if (response.destroyed) return
  if (response.headersSent) return response.destroy()
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Vary': 'Cookie', ...headers })
  response.end(JSON.stringify(body))
}

/** Standalone route contract. Does not register itself on the shared server. */
export function createPasswordChangeHttpAdapter({ service, trustedOrigin, bodyTimeoutMs = 5000 } = {}) {
  if (!service || typeof service.changePassword !== 'function' || typeof trustedOrigin !== 'string' ||
      !Number.isSafeInteger(bodyTimeoutMs) || bodyTimeoutMs < 10 || bodyTimeoutMs > 30_000) throw new TypeError('Invalid password-change HTTP dependencies')
  let url
  try { url = new URL(trustedOrigin) } catch { throw new TypeError('Invalid trusted origin') }
  if (url.origin !== trustedOrigin || url.username || url.password ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) {
    throw new TypeError('Canonical HTTPS origin required (HTTP loopback only)')
  }
  return async function handle(request, response) {
    let url
    try { url = new URL(request.url, 'http://localhost') } catch { return false }
    if (url.pathname !== PATH) return false
    try {
      if (url.search || url.hash) { reply(response, 400, { error: 'INVALID_INPUT' }); return true }
      if (request.method !== 'POST') { reply(response, 405, { error: 'METHOD_NOT_ALLOWED' }, { Allow: 'POST' }); return true }
      if (singleHeader(request, 'origin') !== trustedOrigin) { reply(response, 403, { error: 'FORBIDDEN' }); return true }
      if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(singleHeader(request, 'content-type') || '')) {
        reply(response, 415, { error: 'UNSUPPORTED_MEDIA_TYPE' }); return true
      }
      const length = singleHeader(request, 'content-length')
      if (length !== null) {
        if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))) throw new BodyError(400)
        if (Number(length) > MAX_BODY) throw new BodyError(413)
      }
      let input
      const text = await readBody(request, bodyTimeoutMs)
      try { input = JSON.parse(text) } catch { throw new BodyError(400) }
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).some(k => !['currentPassword','newPassword'].includes(k)) ||
          typeof input.currentPassword !== 'string' || typeof input.newPassword !== 'string') throw new BodyError(400)
      const changed = await service.changePassword(request, input)
      if (typeof changed?.cookie !== 'string' || /[\r\n]/.test(changed.cookie)) throw new Error('Invalid session response')
      reply(response, 200, { ok: true }, { 'Set-Cookie': changed.cookie })
    } catch (error) {
      const bodyError = error instanceof BodyError
      const status = bodyError ? error.status : error instanceof PasswordChangeError ? STATUS[error.code] || 503 : 503
      const code = bodyError ? (status === 413 ? 'PAYLOAD_TOO_LARGE' : status === 408 ? 'REQUEST_TIMEOUT' : 'INVALID_INPUT') :
        error instanceof PasswordChangeError && STATUS[error.code] ? error.code : 'UNAVAILABLE'
      reply(response, status, { error: code }, bodyError ? { Connection: 'close' } : {})
    }
    return true
  }
}
