import { createHmac, timingSafeEqual } from 'node:crypto'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CSRF_HEADER = 'x-dyoffice-csrf'
const ENCODED_DIGEST = /^[A-Za-z0-9_-]{43}$/

/**
 * A cookie-authenticated write must provide an authenticated, session-bound
 * CSRF token and an exact, configured Origin. Never derive the trusted origin
 * from the Host/X-Forwarded-* headers supplied by the request.
 *
 * This is a policy primitive, not an HTTP route or an authentication handler:
 * the caller MUST first authenticate its session against PostgreSQL.
 */
export function createCsrfPolicy({ secret, trustedOrigin } = {}) {
  if (!(secret instanceof Uint8Array) || secret.byteLength < 32) {
    throw new TypeError('CSRF HMAC key must contain at least 32 random bytes')
  }
  if (typeof trustedOrigin !== 'string') throw new TypeError('Trusted origin is required')
  let origin
  try {
    const url = new URL(trustedOrigin)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash || trustedOrigin !== url.origin) {
      throw new Error('Untrusted origin format')
    }
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error('Cleartext external origin not permitted')
    }
    origin = url.origin
  } catch {
    throw new TypeError('Trusted origin must be a canonical HTTPS origin (HTTP localhost allowed)')
  }
  const key = Buffer.from(secret)
  function digest(principal) {
    if (!principal || !UUID.test(principal.sessionId) || !UUID.test(principal.deploymentId)) {
      throw new TypeError('Authenticated session and deployment identifiers required')
    }
    return createHmac('sha256', key)
      .update('dyoffice-csrf-v1\0')
      .update(principal.deploymentId.toLowerCase())
      .update('\0')
      .update(principal.sessionId.toLowerCase())
      .digest()
  }
  function onlyHeader(request, name) {
    const values = request?.headersDistinct?.[name]
    if (Array.isArray(values) && values.length !== 1) return null
    if (Array.isArray(request?.rawHeaders)) {
      let matches = 0
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        if (String(request.rawHeaders[i]).toLowerCase() === name) matches++
      }
      if (matches !== 1) return null
    }
    const value = request?.headers?.[name]
    return typeof value === 'string' ? value : null
  }
  return Object.freeze({
    /** Expose only via a cookie-authenticated endpoint with Cache-Control: no-store. */
    issue(principal) {
      return digest(principal).toString('base64url')
    },
    /** False by default: Origin is mandatory even on a same-site subdomain. */
    verify(request, principal) {
      const suppliedOrigin = onlyHeader(request, 'origin')
      if (suppliedOrigin !== origin) return false
      const token = onlyHeader(request, CSRF_HEADER)
      if (typeof token !== 'string' || !ENCODED_DIGEST.test(token)) return false
      let expected
      try { expected = digest(principal) } catch { return false }
      const received = Buffer.from(token, 'base64url')
      return received.length === expected.length && timingSafeEqual(received, expected)
    },
  })
}
