import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApiShell } from '../server/src/framework.ts'
import { registerAuthRoutes } from '../server/src/modules/auth/routes.ts'
import { createCsrfService } from '../server/src/modules/auth/csrf.ts'
const token = 'a'.repeat(43), origin = 'https://office.example'
async function fixture(t) {
  const app = await createApiShell(), calls = []
  t.after(() => app.close())
  const csrf = createCsrfService({ db: {pool:{query(){throw Error('No DB expected in route test')}}}, deploymentId:'11111111-1111-4111-8111-111111111111', origin, key:'k'.repeat(64) })
  registerAuthRoutes(app, { csrf, sessions:{async revokeOthers(...args){ calls.push(args) }}, users:{}, throttle:{} })
  const headers = {origin,cookie:'__Host-dyoffice-session='+token,'x-csrf-token':csrf.sessionToken(token)}
  return {app,calls,headers}
}
test('revoke-others uses the cookie credential and preserves the current cookie', async t => {
  const {app,calls,headers} = await fixture(t)
  const reply = await app.inject({method:'POST',url:'/api/v1/auth/sessions/revoke-others',headers})
  assert.equal(reply.statusCode,204); assert.equal(reply.headers['set-cookie'],undefined)
  assert.equal(calls.length,1); assert.equal(calls[0][0],token)
  assert.deepEqual(Object.keys(calls[0][1]),['requestId'])
  assert.equal((await app.inject({method:'POST',url:'/api/v1/auth/sessions/revoke-others',headers,payload:{}})).statusCode,204)
  assert.equal(calls.length,2)
})
test('revoke-others rejects cross-origin and missing CSRF before mutating sessions', async t => {
  const {app,calls,headers} = await fixture(t)
  for(const patch of [{origin:'https://evil.example'},{'x-csrf-token':''},{cookie:''}]) {
    const reply = await app.inject({method:'POST',url:'/api/v1/auth/sessions/revoke-others',headers:{...headers,...patch}})
    assert.equal(reply.statusCode,403)
  }
  assert.equal(calls.length,0)
})
test('revoke-others accepts no caller-selected owner or session identifiers', async t => {
  const {app,calls,headers} = await fixture(t)
  for(const input of [{payload:{ownerId:'other'}},{url:'/api/v1/auth/sessions/revoke-others?userId=other'},{payload:{sessionId:'other'}}]) {
    const reply = await app.inject({method:'POST',url:'/api/v1/auth/sessions/revoke-others',headers,...input})
    assert.equal(reply.statusCode,400)
  }
  assert.equal(calls.length,0)
})
