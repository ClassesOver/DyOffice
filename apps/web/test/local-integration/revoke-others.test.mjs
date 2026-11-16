import { test } from 'node:test'
import assert from 'node:assert/strict'
import { restrictedFixture, restrictedOrigin, waitForDatabaseLock } from '../helpers/restricted.mjs'
import { password } from '../helpers/identity.mjs'
import { createCsrfService } from '../../server/src/modules/auth/csrf.ts'
import { createSessionService } from '../../server/src/modules/auth/sessions.ts'
const url = '/api/v1/auth/sessions/revoke-others'
const credential = token => ({kind:'session',token})
const deferred = () => { let resolve; const promise = new Promise(done => {resolve=done}); return {promise,resolve} }
const settled = p => p.then(value=>({value}),error=>({error}))
const barrier = (ready,p) => Promise.race([ready.promise,p.then(r=>{throw r.error??new Error('Transaction ended before barrier')})])
function headers(f,token=f.alice.token) {
  const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey})
  return {origin:restrictedOrigin,cookie:'__Host-dyoffice-session='+token,'x-csrf-token':csrf.sessionToken(token)}
}
async function eventRows(f) { return (await f.ownerPool.query("SELECT request_id,session_id,actor_id FROM auth_security_events WHERE deployment_id=$1 AND actor_id=$2 AND event='session_revoked' ORDER BY session_id",[f.deploymentId,f.alice.user.id])).rows }
function holdBeforeCommit(f,ready,release,rollback=false) {
  const db={...f.db,transaction:fn=>f.db.transaction(async connection=>{
    const result=await fn(connection)
    ready.resolve();await release.promise
    if(rollback)throw Error('controlled revoke rollback')
    return result
  })}
  return createSessionService({db,accounts:f.accounts,deploymentId:f.deploymentId})
}

test('HTTP revoke-others keeps current cookie, revokes only same-owner sessions and audits no secrets',async t=>{
  const f=await restrictedFixture(t), other=await f.sessions.login('alice',password), another=await f.sessions.login('alice',password)
  const beforeVersion=(await f.ownerPool.query('SELECT auth_version FROM users WHERE id=$1',[f.alice.user.id])).rows[0].auth_version
  const reply=await f.app.inject({method:'POST',url,headers:headers(f)})
  assert.equal(reply.statusCode,204);assert.equal(reply.headers['set-cookie'],undefined)
  await f.sessions.authenticate(f.alice.token);await f.sessions.authenticate(f.bob.token);await f.sessions.authenticate(f.adminSigned.token)
  for(const s of [other,another])await assert.rejects(()=>f.sessions.authenticate(s.token),{statusCode:401})
  assert.equal((await f.ownerPool.query('SELECT auth_version FROM users WHERE id=$1',[f.alice.user.id])).rows[0].auth_version,beforeVersion)
  const events=await eventRows(f)
  assert.deepEqual(events.map(e=>e.session_id).sort(),[other.sessionId,another.sessionId].sort())
  assert.ok(events.every(e=>e.request_id===reply.headers['x-request-id']&&e.actor_id===f.alice.user.id))
  for(const secret of [password,f.alice.token,other.token])assert.equal(JSON.stringify(events).includes(secret),false)
  assert.equal((await f.app.inject({method:'POST',url,headers:headers(f)})).statusCode,204)
  assert.deepEqual(await eventRows(f),events)
})
test('real PG revoke-others CSRF, Origin and identity injection failures leave all sessions intact',async t=>{
  const f=await restrictedFixture(t), other=await f.sessions.login('alice',password)
  for(const options of [{headers:{...headers(f),origin:'https://evil.example'}},{headers:{...headers(f),'x-csrf-token':''}},{headers:headers(f),payload:{ownerId:f.bob.user.id}},{headers:headers(f),url:url+'?deploymentId=other'}]) {
    const reply=await f.app.inject({method:'POST',url,...options})
    assert.ok([400,403].includes(reply.statusCode))
  }
  await f.sessions.authenticate(other.token);await f.sessions.authenticate(f.alice.token)
  assert.deepEqual(await eventRows(f),[])
})
test('concurrent same-current revoke-others calls are idempotent and emit one audit per revoked session',async t=>{
  const f=await restrictedFixture(t), other=await f.sessions.login('alice',password)
  const results=await Promise.all([1,2].map(()=>f.app.inject({method:'POST',url,headers:headers(f)})))
  assert.deepEqual(results.map(r=>r.statusCode),[204,204])
  assert.deepEqual((await eventRows(f)).map(e=>e.session_id),[other.sessionId])
  await f.sessions.authenticate(f.alice.token)
})
test('mutual revoke-others has one authenticated winner rather than revoking both callers',async t=>{
  const f=await restrictedFixture(t), other=await f.sessions.login('alice',password)
  const results=await Promise.all([f.alice.token,other.token].map(token=>f.app.inject({method:'POST',url,headers:headers(f,token)})))
  assert.deepEqual(results.map(r=>r.statusCode).sort(),[204,401])
  const active=(await f.ownerPool.query('SELECT id FROM sessions WHERE user_id=$1 AND revoked_at IS NULL',[f.alice.user.id])).rows
  assert.equal(active.length,1)
  assert.equal(active[0].id,results[0].statusCode===204?f.alice.sessionId:other.sessionId)
})
test('login blocked by revoke-others user lock becomes a valid future session after commit', {timeout:15000},async t=>{
  const f=await restrictedFixture(t), other=await f.sessions.login('alice',password)
  const ready=deferred(),release=deferred(), revoker=settled(holdBeforeCommit(f,ready,release).revokeOthers(f.alice.token))
  let login
  try{
    await barrier(ready,revoker)
    login=settled(f.sessions.login('alice',password))
    await waitForDatabaseLock(f,'auth')
    release.resolve();assert.equal((await revoker).error,undefined)
    const signed=(await login).value;assert.ok(signed)
    await f.sessions.authenticate(signed.token);await f.sessions.authenticate(f.alice.token)
    await assert.rejects(()=>f.sessions.authenticate(other.token),{statusCode:401})
  }finally{release.resolve();await Promise.allSettled([revoker,login].filter(Boolean))}
})
test('revoke-others waits for another session business writer then fences its next write',{timeout:15000},async t=>{
  const f=await restrictedFixture(t),other=await f.sessions.login('alice',password)
  await f.preferences.update(other.token,{authorName:'before'})
  const ready=deferred(),release=deferred(),writer=settled(f.transactions.withPrincipalTransaction(credential(other.token),async c=>{
    await c.query("UPDATE personal_preferences SET data=data||'{\"authorName\":\"committed\"}'::jsonb")
    ready.resolve();await release.promise
  }))
  let revoker
  try{
    await barrier(ready,writer);revoker=settled(f.sessions.revokeOthers(f.alice.token))
    await waitForDatabaseLock(f,'auth');release.resolve()
    assert.equal((await writer).error,undefined);assert.equal((await revoker).error,undefined)
    await assert.rejects(()=>f.preferences.update(other.token,{authorName:'forbidden'}),{statusCode:401})
    assert.equal((await f.preferences.get(f.alice.token)).authorName,'committed')
  }finally{release.resolve();await Promise.allSettled([writer,revoker].filter(Boolean))}
})
for(const rollback of [false,true])test(`revoke-others ${rollback?'rollback restores sessions and audit':'commit rejects a waiting other-session writer'}`,{timeout:15000},async t=>{
  const f=await restrictedFixture(t),other=await f.sessions.login('alice',password)
  await f.preferences.update(other.token,{authorName:'before'})
  const ready=deferred(),release=deferred(),revoker=settled(holdBeforeCommit(f,ready,release,rollback).revokeOthers(f.alice.token))
  let writer
  try{
    await barrier(ready,revoker);writer=settled(f.preferences.update(other.token,{authorName:'waiting'}))
    await waitForDatabaseLock(f,'business');release.resolve()
    const revoked=await revoker,written=await writer
    if(rollback){assert.match(revoked.error?.message??'',/controlled revoke rollback/);assert.equal(written.error,undefined);assert.deepEqual(await eventRows(f),[]);await f.sessions.authenticate(other.token)}
    else{assert.equal(revoked.error,undefined);assert.equal(written.error?.statusCode,401);assert.equal((await eventRows(f)).length,1)}
    assert.equal((await f.preferences.get(f.alice.token)).authorName,rollback?'waiting':'before')
  }finally{release.resolve();await Promise.allSettled([writer,revoker].filter(Boolean))}
})

test('a revoked caller cannot revoke a still-valid same-user session',async t=>{
  const f=await restrictedFixture(t),other=await f.sessions.login('alice',password)
  await f.sessions.logout(f.alice.token)
  const reply=await f.app.inject({method:'POST',url,headers:headers(f)})
  assert.equal(reply.statusCode,401)
  await f.sessions.authenticate(other.token)
  assert.deepEqual(await eventRows(f),[])
})
