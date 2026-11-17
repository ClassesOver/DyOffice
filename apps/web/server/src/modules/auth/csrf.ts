import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import type { IdentityStore } from '../../db/identity.ts'
import { authError, tokenHash } from './sessions.ts'

export const SESSION_COOKIE = '__Host-dyoffice-session'
export const LOGIN_COOKIE = '__Host-dyoffice-login'
const DEV_SESSION_COOKIE = 'dyoffice-dev-session'
const DEV_LOGIN_COOKIE = 'dyoffice-dev-login'
// Request-scoped trusted policy; never inferred from Origin/Forwarded headers.
type CookiePolicy = { dev: boolean; verify: (kind: 'login' | 'session', token: string) => void }
const requestPolicies = new WeakMap<object, CookiePolicy>()
export function assertHttpDevelopmentMode(enabled: boolean | undefined, origin: string) {
  if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('Invalid HTTP development mode')
  const parsed = new URL(origin)
  if (enabled && (process.env.NODE_ENV !== 'development' || parsed.protocol !== 'http:')) throw new Error('Insecure HTTP requires explicit development mode and HTTP origin')
  if (parsed.origin !== origin || parsed.username || parsed.password || !(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && (enabled || ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))))) throw new Error('Invalid canonical origin')
}
export function uniqueHeader(request: FastifyRequest, name: string): string | undefined {
  let count = 0
  for (let i = 0; i < request.raw.rawHeaders.length; i += 2) if (request.raw.rawHeaders[i].toLowerCase() === name) count++
  const value = request.headers[name]
  if (count > 1 || (value !== undefined && typeof value !== 'string')) throw authError()
  return value as string | undefined
}
export function cookies(request: FastifyRequest) {
  if (uniqueHeader(request, 'authorization') !== undefined) throw authError()
  const header = uniqueHeader(request, 'cookie')
  const result: Record<string, string> = Object.create(null)
  if (header) {
    if (Buffer.byteLength(header) > 8192) throw authError()
    for (const field of header.split(';')) {
      const index = field.indexOf('=')
      if (index < 1) throw authError()
      const name = field.slice(0, index).trim(), value = field.slice(index + 1).trim()
      if (Object.hasOwn(result, name)) throw authError()
      result[name] = value
    }
  }
  const policy = requestPolicies.get(request.raw)
  const dev = policy?.dev === true
  const sessionName = dev ? DEV_SESSION_COOKIE : SESSION_COOKIE
  const loginName = dev ? DEV_LOGIN_COOKIE : LOGIN_COOKIE
  // Never accept a cookie from the other security mode, even if both are supplied.
  for (const name of dev ? [SESSION_COOKIE, LOGIN_COOKIE] : [DEV_SESSION_COOKIE, DEV_LOGIN_COOKIE]) {
    if (result[name] !== undefined) throw authError()
  }
  for (const name of [sessionName, loginName]) {
    if (result[name] !== undefined && !(dev ? /^dev1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/ : /^[A-Za-z0-9_-]{43}$/).test(result[name])) throw authError()
  }
  if (result[sessionName]) policy?.verify('session', result[sessionName])
  if (result[loginName]) policy?.verify('login', result[loginName])
  return { session: result[sessionName], login: result[loginName] }
}
export function serializeCookie(name: string, token: string, maxAge?: number) {
  return `${name}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax${maxAge === undefined ? '' : '; Max-Age=' + maxAge}`
}
export function createCsrfService({ db, deploymentId, origin, key, insecureHttpDev }: { db: IdentityStore; deploymentId: string; origin: string; key: string; insecureHttpDev?: boolean }) {
  const parsed = new URL(origin)
  assertHttpDevelopmentMode(insecureHttpDev, origin)
  if (typeof key !== 'string' || Buffer.byteLength(key) < 32 || Buffer.byteLength(key) > 4096) throw new Error('CSRF key must contain at least 32 bytes')
  // Secure tokens and CSRF remain backward-compatible. Only opt-in dev tokens
  // use a disjoint envelope; DB hashes the FULL envelope, never the inner nonce.
  const domain = JSON.stringify(['dyoffice-http-dev-v1', deploymentId, origin])
  const tag = (kind: 'login' | 'session', nonce: string) => createHmac('sha256', key).update(domain).update(':' + kind + ':' + nonce).digest('base64url')
  const issue = (kind: 'login' | 'session') => {
    const nonce = randomBytes(32).toString('base64url')
    return insecureHttpDev ? `dev1.${nonce}.${tag(kind, nonce)}` : nonce
  }
  const verify = (kind: 'login' | 'session', token: string) => {
    if (!insecureHttpDev) { if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw authError(); return }
    const match = /^dev1\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(token)
    if (!match || !timingSafeEqual(Buffer.from(match[2]), Buffer.from(tag(kind, match[1])))) throw authError()
  }
  const policy = Object.freeze({ dev: insecureHttpDev === true, verify })
  const derive = (kind: string, token: string) => createHmac('sha256', key).update(insecureHttpDev ? domain + ':' : '').update(`${kind}:${token}`).digest('base64url')
  function bindRequest(request: FastifyRequest) {
    // Host is checked directly, not request.hostname or proxy-derived headers.
    if (insecureHttpDev && uniqueHeader(request, 'host') !== parsed.host) throw authError(403)
    requestPolicies.set(request.raw, policy)
  }
  function originCheck(request: FastifyRequest, write = true) {
    bindRequest(request)
    const supplied = uniqueHeader(request, 'origin')
    const site = uniqueHeader(request, 'sec-fetch-site')
    if ((write && supplied !== origin) || (supplied !== undefined && supplied !== origin) || (site !== undefined && site !== 'same-origin' && site !== 'none')) throw authError(403)
  }
  function check(request: FastifyRequest, kind: string, token?: string, write = true) {
    originCheck(request, write)
    if (token) verify(kind === 'session' ? 'session' : 'login', token)
    const supplied = uniqueHeader(request, 'x-csrf-token')
    if (!token || !supplied || !/^[A-Za-z0-9_-]{43}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(derive(kind, token)))) throw authError(403)
  }
  return {
    bindRequest,
    sessionCredentials: Object.freeze({ issue: () => issue('session'), verify: (token: string) => verify('session', token) }),
    serializeCookie(name: string, token: string, maxAge?: number) {
      if (token) verify(name === SESSION_COOKIE ? 'session' : 'login', token)
      if (!insecureHttpDev) return serializeCookie(name, token, maxAge)
      if (![SESSION_COOKIE, LOGIN_COOKIE].includes(name)) throw new Error('Invalid development cookie')
      const selected = name === SESSION_COOKIE ? DEV_SESSION_COOKIE : DEV_LOGIN_COOKIE
      return `${selected}=${token}; Path=/; HttpOnly; SameSite=Lax${maxAge === undefined ? '' : '; Max-Age=' + maxAge}`
    },
    originCheck,
    sessionToken: (token: string) => derive('session', token),
    requireSession: (request: FastifyRequest, token?: string) => check(request, 'session', token),
    requireSessionRead: (request: FastifyRequest, token?: string) => check(request, 'session', token, false),
    async issueLogin() {
      const token = issue('login')
      await db.pool.query('DELETE FROM login_challenges WHERE deployment_id=$1 AND expires_at<clock_timestamp()', [deploymentId])
      await db.pool.query("INSERT INTO login_challenges(deployment_id,token_hash,expires_at) VALUES($1,$2,clock_timestamp()+interval '5 minutes')", [deploymentId, tokenHash(token)])
      return { token, csrfToken: derive('login', token) }
    },
    async consumeLogin(request: FastifyRequest, token?: string) {
      check(request, 'login', token)
      const used = await db.pool.query('UPDATE login_challenges SET consumed_at=clock_timestamp() WHERE deployment_id=$1 AND token_hash=$2 AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING token_hash', [deploymentId, tokenHash(token!)])
      if (!used.rowCount) throw authError(403)
    },
  }
}
