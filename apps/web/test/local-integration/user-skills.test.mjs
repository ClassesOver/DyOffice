import test from 'node:test'
import assert from 'node:assert/strict'
import {restrictedFixture} from '../helpers/restricted.mjs'
import {createSkillService} from '../../server/src/modules/skills/service.ts'
import {tokenHash} from '../../server/src/modules/auth/sessions.ts'

// Removing owner binding, FORCE RLS, or the live session check must break this test.
test('Skills with the same name stay private to each user including config admins and direct SQL', async t => {
  const f = await restrictedFixture(t), skills = createSkillService(f.transactions)
  await skills.save(f.alice.token, 'report', {description: 'Alice only', body: '# Alice private steps'})
  await skills.save(f.bob.token, 'report', {description: 'Bob only', body: '# Bob private steps'})
  assert.deepEqual(await skills.list(f.adminSigned.token), [])
  assert.equal((await skills.read(f.alice.token, 'report')).body, '# Alice private steps')
  assert.equal((await skills.read(f.bob.token, 'report')).body, '# Bob private steps')
  await assert.rejects(skills.read(f.adminSigned.token, 'report'), {statusCode: 404})
  await f.transactions.withPrincipalTransaction({kind: 'session', token: f.bob.token}, async c => {
    await c.query("SELECT set_config('dyoffice.global_session_hash',$1,true),set_config('dyoffice.global_idle_ms',$2,true)", [tokenHash(f.bob.token), String(f.transactions.sessionIdleMs)])
    assert.deepEqual((await c.query('SELECT body FROM user_skills')).rows, [{body: '# Bob private steps'}])
    await c.query("SELECT set_config('dyoffice.user_id',$1,true)", [f.alice.user.id])
    assert.equal((await c.query('SELECT body FROM user_skills')).rowCount, 0)
  })
  assert.equal((await f.businessPool.query('SELECT * FROM user_skills')).rowCount, 0)
  await skills.remove(f.bob.token, 'report')
  assert.deepEqual(await skills.list(f.bob.token), [])
  assert.equal((await skills.list(f.alice.token))[0].description, 'Alice only')
  await f.sessions.logout(f.alice.token)
  await assert.rejects(skills.read(f.alice.token, 'report'), {statusCode: 401})
})

test('Skills API derives ownership from cookie, rejects injected principals, and requires CSRF on writes', async t => {
  const f = await restrictedFixture(t)
  const cookie = '__Host-dyoffice-session=' + f.alice.token
  const headers = {cookie, origin: 'https://office.example'}
  const proof = await f.app.inject({url: '/api/v1/auth/csrf', headers})
  headers['x-csrf-token'] = proof.json().csrfToken
  const path = '/api/v1/skills/report'
  const draft = {description: 'Private', body: '# Personal skill'}
  assert.equal((await f.app.inject({method: 'PUT', url: path, headers: {cookie}, payload: draft})).statusCode, 403)
  assert.equal((await f.app.inject({method: 'PUT', url: path, headers, payload: {...draft, ownerId: f.bob.user.id}})).statusCode, 400)
  assert.equal((await f.app.inject({method: 'PUT', url: path, headers, payload: draft})).statusCode, 200)
  assert.equal((await f.app.inject({url: path, headers: {cookie: '__Host-dyoffice-session=' + f.bob.token, 'x-csrf-token': (await f.app.inject({url: '/api/v1/auth/csrf', headers: {cookie: '__Host-dyoffice-session=' + f.bob.token}})).json().csrfToken}})).statusCode, 404)
  assert.equal((await f.app.inject({url: path + '?ownerId=' + f.alice.user.id, headers})).statusCode, 400)
  const result = await f.app.inject({url: '/api/v1/skills', headers})
  assert.deepEqual(result.json(), [{name: 'report', description: 'Private'}])
  assert.match(result.headers['cache-control'], /no-store/)
  assert.equal((await f.app.inject({method: 'DELETE', url: path, headers})).statusCode, 204)
})
