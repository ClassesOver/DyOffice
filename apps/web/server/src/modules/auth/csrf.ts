import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import type { IdentityStore } from '../../db/identity.ts'
import { authError, tokenHash } from './sessions.ts'

export const SESSION_COOKIE = '__Host-dyoffice-session'
export const LOGIN_COOKIE = '__Host-dyoffice-login'
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
  for (const name of [SESSION_COOKIE, LOGIN_COOKIE]) {
    if (result[name] !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(result[name])) throw authError()
  }
  return { session: result[SESSION_COOKIE], login: result[LOGIN_COOKIE] }
}
export function serializeCookie(name: string, token: string, maxAge?: number) {
  return `${name}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax${maxAge === undefined ? '' : '; Max-Age=' + maxAge}`
}
export function createCsrfService({ db, deploymentId, origin, key }: { db: IdentityStore; deploymentId: string; origin: string; key: string }) {
  const parsed = new URL(origin)
  if (parsed.origin !== origin || parsed.username || parsed.password || !(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)))) throw new Error('Invalid canonical origin')
  if (typeof key !== 'string' || Buffer.byteLength(key) < 32 || Buffer.byteLength(key) > 4096) throw new Error('CSRF key must contain at least 32 bytes')
  const derive = (kind: string, token: string) => createHmac('sha256', key).update(`${kind}:${token}`).digest('base64url')
  function originCheck(request: FastifyRequest, write = true) {
    const supplied = uniqueHeader(request, 'origin')
    const site = uniqueHeader(request, 'sec-fetch-site')
    if ((write && supplied !== origin) || (supplied !== undefined && supplied !== origin) || (site !== undefined && site !== 'same-origin' && site !== 'none')) throw authError(403)
  }
  function check(request: FastifyRequest, kind: string, token?: string, write = true) {
    originCheck(request, write)
    const supplied = uniqueHeader(request, 'x-csrf-token')
    if (!token || !supplied || !/^[A-Za-z0-9_-]{43}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(derive(kind, token)))) throw authError(403)
  }
  return {
    originCheck,
    sessionToken: (token: string) => derive('session', token),
    requireSession: (request: FastifyRequest, token?: string) => check(request, 'session', token),
    requireSessionRead: (request: FastifyRequest, token?: string) => check(request, 'session', token, false),
    async issueLogin() {
      const token = randomBytes(32).toString('base64url')
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
