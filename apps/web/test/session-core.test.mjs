import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import {
  createSessionService, readSessionCookie, SESSION_COOKIE_NAME, CLEAR_SESSION_COOKIE,
} from '../server/auth/session-core.mjs'

const deploymentId = randomUUID()
const userId = randomUUID()
const cookieRequest = cookie => ({ headers: { cookie }, rawHeaders: ['Cookie', cookie] })

function fakePool() {
  const state = { usersActive:true, revoked:false, roles:['user'], session:null, calls:[] }
  const pool = {
    state,
    async query(sql, params) {
      state.calls.push({sql,params})
      if (sql.startsWith('INSERT INTO dyoffice_sessions')) {
        if (!state.usersActive || state.roles.length === 0) return { rowCount:0, rows:[] }
        state.session = { id:params[0], deploymentId:params[1], userId:params[2], hash:params[3] }
        return { rowCount:1, rows:[{id:params[0], expires_at:new Date()}] }
      }
      if (sql.startsWith('UPDATE dyoffice_sessions s SET last_seen_at')) {
        if (!state.session || state.revoked || !state.usersActive ||
            !state.session.hash.equals(params[0]) || params[1] !== state.session.deploymentId ||
            state.roles.length === 0) return {rowCount:0,rows:[]}
        return { rowCount:1, rows:[{
          session_id:state.session.id,user_id:state.session.userId,
          deployment_id:state.session.deploymentId,expires_at:new Date(),
          roles:state.roles,
        }] }
      }
      if (sql.startsWith('UPDATE dyoffice_sessions SET revoked_at')) {
        if (!state.session || state.revoked) return {rowCount:0,rows:[]}
        if (sql.includes('session_token_hash') &&
            (!state.session.hash.equals(params[0]) || params[1] !== state.session.deploymentId)) return {rowCount:0,rows:[]}
        if (sql.includes('user_id = $2') &&
            (params[0] !== state.session.deploymentId || params[1] !== state.session.userId)) return {rowCount:0,rows:[]}
        state.revoked = true
        return {rowCount:1,rows:[]}
      }
      throw new Error('Unexpected SQL')
    },
  }
  return pool
}

test('issues 256-bit opaque session only for active user, never stores plaintext token', async () => {
  const pool = fakePool()
  const core = createSessionService({ pool })
  const created = await core.issue({deploymentId,userId})
  assert.match(created.cookie, new RegExp('^' + SESSION_COOKIE_NAME + '=[A-Za-z0-9_-]{43};'))
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=86400']) assert.ok(created.cookie.includes(flag), flag)
  const token = readSessionCookie(cookieRequest(created.cookie.split(';')[0]))
  assert.equal(Buffer.from(token, 'base64url').length, 32)
  assert.equal(pool.state.session.hash.length, 32)
  assert.ok(pool.state.session.hash.equals(createHash('sha256').update(token).digest()))
  assert.equal(JSON.stringify(pool.state.calls).includes(token), false)
  assert.equal(JSON.stringify(created).includes('argon2'), false)
  assert.ok(CLEAR_SESSION_COOKIE.includes('Max-Age=0'))
})

test('strict cookie parsing rejects duplicate, malformed, missing, and oversized values', async () => {
  const sample = 'A'.repeat(43)
  assert.equal(readSessionCookie(cookieRequest('prefs=x; ' + SESSION_COOKIE_NAME + '=' + sample)), sample)
  for (const invalid of [
    SESSION_COOKIE_NAME + '=' + sample + '; ' + SESSION_COOKIE_NAME + '=' + 'B'.repeat(43),
    SESSION_COOKIE_NAME + '="x"',
    SESSION_COOKIE_NAME + '=' + 'x'.repeat(5000),
    'unrelated=session',
    SESSION_COOKIE_NAME + '=abc',
  ]) assert.equal(readSessionCookie(cookieRequest(invalid)),null)
  assert.equal(readSessionCookie({headers:{cookie:SESSION_COOKIE_NAME+'='+sample},rawHeaders:['Cookie','x','Cookie','y']}),null)
  assert.equal(readSessionCookie({headers:{cookie:SESSION_COOKIE_NAME+'='+sample},headersDistinct:{cookie:['x','y']}}),null)
  assert.equal(readSessionCookie({headers:{cookie:0}}),null)
})

test('authentication requires trusted deployment, current user state and live DB roles', async () => {
  const pool = fakePool()
  const core = createSessionService({pool})
  const issued = await core.issue({deploymentId,userId})
  const request = cookieRequest(issued.cookie.split(';')[0])
  const authenticated = await core.authenticate(request,{deploymentId})
  assert.equal(authenticated.userId,userId)
  assert.equal(authenticated.deploymentId,deploymentId)
  assert.deepEqual(authenticated.roles,['user'])
  pool.state.roles=['config_admin']
  assert.deepEqual((await core.authenticate(request,{deploymentId})).roles,['config_admin'])
  assert.equal(await core.authenticate(request,{deploymentId:randomUUID()}),null)
  pool.state.usersActive=false
  assert.equal(await core.authenticate(request,{deploymentId}),null)
  const query=pool.state.calls.find(x=>x.sql.startsWith('UPDATE dyoffice_sessions s SET'))
  assert.match(query.sql,/u.auth_version = s.auth_version/)
  assert.match(query.sql,/s.revoked_at IS NULL/)
  assert.match(query.sql,/s.expires_at > clock_timestamp/)
  assert.match(query.sql,/s.last_seen_at > clock_timestamp/)
})

test('logout revokes only the matching token; user-wide revocation remains owner-scoped', async () => {
  const pool=fakePool()
  const core=createSessionService({pool})
  const issued=await core.issue({deploymentId,userId})
  const request=cookieRequest(issued.cookie.split(';')[0])
  assert.equal(await core.revoke(request,{deploymentId:randomUUID()}),false)
  assert.equal(await core.revoke(request,{deploymentId}),true)
  assert.equal(await core.revoke(request,{deploymentId}),false)
  assert.equal(await core.authenticate(request,{deploymentId}),null)
  pool.state.revoked=false
  assert.equal(await core.revokeAllForUser({deploymentId:randomUUID(),userId}),0)
  assert.equal(await core.revokeAllForUser({deploymentId,userId}),1)
  assert.equal(await core.revokeAllForUser({deploymentId,userId}),0)
})

test('rejects invalid callers and inactive accounts before issuing a usable cookie', async () => {
  const pool=fakePool()
  const core=createSessionService({pool})
  await assert.rejects(core.issue({deploymentId:'fake',userId}),TypeError)
  await assert.rejects(core.authenticate({}, {deploymentId:'fake'}),TypeError)
  pool.state.usersActive=false
  assert.equal(await core.issue({deploymentId,userId}),null)
  assert.throws(()=>createSessionService({pool, idleTimeoutMs:1000}),TypeError)
  assert.throws(()=>createSessionService({pool, idleTimeoutMs:90_000,absoluteTimeoutMs:60_000}),TypeError)
})
