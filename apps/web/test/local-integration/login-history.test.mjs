import {test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {restrictedFixture} from '../helpers/restricted.mjs'
import {password} from '../helpers/identity.mjs'
import {tokenHash} from '../../server/src/modules/auth/sessions.ts'
import {createLoginThrottle} from '../../server/src/modules/auth/throttle.ts'
import {appendAuthEvent} from '../../server/src/modules/auth/audit.ts'
const url='/api/v1/auth/login-history'
const headers=token=>({cookie:'__Host-dyoffice-session='+token})
async function history(f,token=f.alice.token){const r=await f.app.inject({method:'GET',url,headers:headers(token)});assert.equal(r.statusCode,200);return r.json().events}
async function failures(f,name='alice') {await assert.rejects(()=>f.sessions.login(name,'wrong password'),{statusCode:401})}

test('history returns only immutable own login outcomes with minimal DTO and no legacy hash-only failures',async t=>{
 const f=await restrictedFixture(t)
 await failures(f);await failures(f,'bob');await failures(f,'unknown')
 await appendAuthEvent(f.ownerPool,f.deploymentId,'login_failed',{accountKey:'a'.repeat(64)})
 const otherDeployment=randomUUID();await f.ownerPool.query('INSERT INTO deployments(id) VALUES($1)',[otherDeployment]);await appendAuthEvent(f.ownerPool,otherDeployment,'login_failed',{subjectUserId:f.alice.user.id})
 const events=await history(f)
 assert.equal(events.filter(e=>e.outcome==='failure').length,1);assert.equal(events.filter(e=>e.outcome==='success').length,1)
 assert.ok(events.every(e=>Object.keys(e).sort().join(',')==='occurredAt,outcome'))
 for(const secret of [password,f.alice.token,f.bob.token,f.alice.user.id,f.bob.user.id,'a'.repeat(64)])assert.equal(JSON.stringify(events).includes(secret),false)
 assert.equal((await history(f,f.bob.token)).filter(e=>e.outcome==='failure').length,1)
 const r=await f.app.inject({method:'GET',url,headers:headers(f.alice.token)});assert.equal(r.headers['cache-control'],'no-store')
})
test('history attribution survives rename and username reuse without giving new holder previous failures',async t=>{
 const f=await restrictedFixture(t);await failures(f,'alice')
 await f.ownerPool.query('UPDATE users SET username_normalized=$1 WHERE id=$2',['alice-old',f.alice.user.id])
 await f.ownerPool.query('UPDATE users SET username_normalized=$1 WHERE id=$2',['alice',f.bob.user.id])
 await failures(f,'alice')
 const stored=(await f.ownerPool.query("SELECT subject_user_id FROM auth_security_events WHERE event='login_failed' ORDER BY created_at,id")).rows
 assert.deepEqual(stored.map(r=>r.subject_user_id),[f.alice.user.id,f.bob.user.id])
 assert.equal((await history(f)).filter(e=>e.outcome==='failure').length,1);assert.equal((await history(f,f.bob.token)).filter(e=>e.outcome==='failure').length,1)
})
test('throttled attempts are bound to existing immutable subject without exposing unknown accounts',async t=>{
 const f=await restrictedFixture(t),throttle=createLoginThrottle(f.db,f.deploymentId,f.csrfKey,{accountMax:1,ipMax:20,globalMax:100})
 await throttle.reserve(' ALICE ','192.0.2.1');await assert.rejects(()=>throttle.reserve('alice','192.0.2.1'),{statusCode:429})
 await throttle.reserve('unknown','192.0.2.2');await assert.rejects(()=>throttle.reserve('unknown','192.0.2.2'),{statusCode:429})
 assert.equal((await history(f)).filter(e=>e.outcome==='throttled').length,1);assert.equal((await history(f,f.bob.token)).filter(e=>e.outcome==='throttled').length,0)
 const unknown=(await f.ownerPool.query("SELECT subject_user_id FROM auth_security_events WHERE event='login_throttled' AND subject_user_id IS NULL")).rows;assert.equal(unknown.length,1)
})
test('history fixed latest 20 excludes unrelated security events and is deterministically ordered',async t=>{
 const f=await restrictedFixture(t)
 for(let i=0;i<25;i++)await f.ownerPool.query("INSERT INTO auth_security_events(id,deployment_id,actor_id,event,request_id,created_at) VALUES($1,$2,$3,'login_succeeded',$4,$5)",[randomUUID(),f.deploymentId,f.alice.user.id,randomUUID(),new Date(Date.UTC(2030,0,1,0,0,i))])
 await appendAuthEvent(f.ownerPool,f.deploymentId,'session_revoked',{actorId:f.alice.user.id})
 const events=await history(f);assert.equal(events.length,20);assert.equal(events[0].occurredAt,'2030-01-01T00:00:24.000Z');assert.equal(events[19].occurredAt,'2030-01-01T00:00:05.000Z')
})
test('history function denies cross deployment and invalid parameters and HTTP rejects owner/hash selectors',async t=>{
 const f=await restrictedFixture(t)
 for(const key of ['ownerId','userId','deploymentId','accountKey','sessionHash','limit'])assert.equal((await f.app.inject({method:'GET',url:url+'?'+key+'='+f.bob.user.id,headers:headers(f.alice.token)})).statusCode,400)
 for(const args of [[null,tokenHash(f.alice.token),28800000],[f.deploymentId,null,28800000],[f.deploymentId,tokenHash(f.alice.token),null],[randomUUID(),tokenHash(f.alice.token),28800000],[f.deploymentId,'invalid',28800000],[f.deploymentId,tokenHash(f.alice.token),0],[f.deploymentId,tokenHash(f.alice.token),2592000001]])await assert.rejects(()=>f.authPool.query('SELECT * FROM read_login_history($1,$2,$3)',args),{code:'28000'})
 await assert.rejects(()=>f.authPool.query('SELECT * FROM read_login_history($1,$2,$3,$4)',[f.deploymentId,tokenHash(f.alice.token),28800000,f.bob.user.id]),{code:'42883'})
})
test('history function and HTTP reject revoked expired reset and changed-version credentials',async t=>{
 const f=await restrictedFixture(t)
 for(const clause of ['revoked_at=clock_timestamp()',"expires_at=clock_timestamp()-interval '1 second'","last_seen_at=clock_timestamp()-interval '9 hours'",'auth_version=auth_version+1']) {
  const s=await f.sessions.login('alice',password);await f.ownerPool.query('UPDATE sessions SET '+clause+' WHERE id=$1',[s.sessionId])
  assert.equal((await f.app.inject({method:'GET',url,headers:headers(s.token)})).statusCode,401)
  await assert.rejects(()=>f.authPool.query('SELECT * FROM read_login_history($1,$2,$3)',[f.deploymentId,tokenHash(s.token),28800000]),{code:'28000'})
 }
 await f.ownerPool.query("UPDATE users SET status='disabled' WHERE id=$1",[f.alice.user.id]);assert.equal((await f.app.inject({method:'GET',url,headers:headers(f.alice.token)})).statusCode,401)
 await assert.rejects(()=>f.authPool.query('SELECT * FROM read_login_history($1,$2,$3)',[f.deploymentId,tokenHash(f.alice.token),28800000]),{code:'28000'})
 await f.ownerPool.query("UPDATE users SET status='active' WHERE id=$1",[f.alice.user.id])
 await f.ownerPool.query('UPDATE users SET password_reset_required=true WHERE id=$1',[f.alice.user.id]);assert.equal((await f.app.inject({method:'GET',url,headers:headers(f.alice.token)})).statusCode,401)
 await assert.rejects(()=>f.authPool.query('SELECT * FROM read_login_history($1,$2,$3)',[f.deploymentId,tokenHash(f.alice.token),28800000]),{code:'28000'})
})
test('history grants only bounded function to auth, no table SELECT, no business or PUBLIC execution',async t=>{
 const f=await restrictedFixture(t,{worker:true}),args=[f.deploymentId,tokenHash(f.alice.token),28800000]
 await assert.rejects(()=>f.authPool.query('SELECT * FROM auth_security_events'),{code:'42501'})
 for(const pool of [f.businessPool,f.workerPool])await assert.rejects(()=>pool.query('SELECT * FROM read_login_history($1,$2,$3)',args),{code:'42501'})
 const row=(await f.ownerPool.query("SELECT p.prosecdef,p.proconfig,r.rolsuper,r.rolbypassrls,p.proowner=(SELECT relowner FROM pg_class WHERE oid='auth_security_events'::regclass) AS correct_owner,EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='read_login_history(uuid,text,bigint)'::regprocedure")).rows[0]
 assert.equal(row.prosecdef,true);assert.ok(row.proconfig.includes('search_path=pg_catalog'));assert.equal(row.correct_owner,true);assert.equal(row.rolsuper,false);assert.equal(row.rolbypassrls,false);assert.equal(row.public_execute,false)
 assert.equal((await f.authPool.query("SELECT has_function_privilege(current_user,'read_login_history(uuid,text,bigint)','EXECUTE WITH GRANT OPTION') AS allowed")).rows[0].allowed,false)
})

test('failure attribution waits for concurrent rename and never assigns stale username ownership',async t=>{
 const f=await restrictedFixture(t),owner=await f.ownerPool.connect()
 let attempted
 try {
  await owner.query('BEGIN');await owner.query('UPDATE users SET username_normalized=$1 WHERE id=$2',['alice-renamed',f.alice.user.id])
  attempted=f.sessions.login('alice','wrong password').then(()=>({unexpected:true}),error=>({error}))
  const deadline=Date.now()+4000
  while(!(await f.admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND application_name=$2 AND wait_event_type='Lock'",[f.database,f.authPool.options.application_name])).rowCount){if(Date.now()>deadline)throw Error('Expected audit attribution lock wait');await new Promise(resolve=>setImmediate(resolve))}
  await owner.query('COMMIT');assert.equal((await attempted).error?.statusCode,401)
  assert.equal((await f.ownerPool.query("SELECT subject_user_id FROM auth_security_events WHERE event='login_failed'")).rows[0].subject_user_id,null)
  assert.equal((await history(f)).filter(e=>e.outcome==='failure').length,0)
 } finally {await owner.query('ROLLBACK');owner.release();if(attempted)await attempted}
})
