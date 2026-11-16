import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { password } from './identity.mjs'
import { restrictedIdentityFixture } from './restricted-identity.mjs'
import { buildLocalApp } from '../../server/src/app.ts'
import { createSessionService } from '../../server/src/modules/auth/sessions.ts'
import { createUserService } from '../../server/src/modules/admin/users/service.ts'
export const origin = 'https://office.example'
export const nextPassword = 'silver lanterns follow distant rivers 9753'
export const responseAuth = response => {
  const cookie = response.headers['set-cookie'].find(value => value.startsWith('__Host-dyoffice-session=')).split(';')[0]
  return { cookie, token: cookie.split('=')[1], csrf: response.json().csrfToken }
}
export async function lifecycleFixture(t) {
  const f = await restrictedIdentityFixture(t)
  const app = await buildLocalApp({ db: f.db, passwords: f.passwords, deploymentId: f.deploymentId, origin, csrfKey: randomBytes(32).toString('hex') })
  f.cleanup.push(() => app.close())
  const sessions = createSessionService({ db: f.db, accounts: f.accounts, deploymentId: f.deploymentId })
  const users = createUserService({ db: f.db, accounts: f.accounts, sessions, passwords: f.passwords, deploymentId: f.deploymentId })
  const challenge = async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/csrf' })
    return { cookie: response.headers['set-cookie'].find(value => value.startsWith('__Host-dyoffice-login=')).split(';')[0], csrf: response.json().csrfToken }
  }
  const login = async (username = 'owner', candidate = password) => {
    const c = await challenge()
    return app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin, cookie: c.cookie, 'x-csrf-token': c.csrf }, payload: { username, password: candidate } })
  }
  const signed = await login()
  assert.equal(signed.statusCode, 200)
  const admin = responseAuth(signed)
  const request = (method, url, payload, auth = admin) => app.inject({ method, url, headers: { origin, cookie: auth.cookie, 'x-csrf-token': auth.csrf }, ...(payload === undefined ? {} : { payload }) })
  const create = async username => {
    const response = await request('POST', '/api/v1/admin/users', { username })
    assert.equal(response.statusCode, 201, response.body)
    return response.json()
  }
  const redeem = async (action, candidate = password) => {
    const c = await challenge()
    return app.inject({ method: 'POST', url: '/api/v1/auth/password-action', headers: { origin, cookie: c.cookie, 'x-csrf-token': c.csrf }, payload: { token: action.token, purpose: action.purpose, password: candidate } })
  }
  return { ...f, app, sessions, users, admin, challenge, login, request, create, redeem }
}
