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
 for(const clause of ['revoked_at=clock_timestamp()',"created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day'","last_seen_at=clock_timestamp()-interval '9 hours'",'auth_version=auth_version+1']) {
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

test('failure attribution uses one MVCC snapshot across uncommitted rename, commit and rollback',async t=>{
 const f=await restrictedFixture(t),owner=await f.ownerPool.connect()
 try {
  await owner.query('BEGIN');await owner.query('UPDATE users SET username_normalized=$1 WHERE id=$2',['alice-renamed',f.alice.user.id])
  await failures(f,'alice') // The uncommitted rename is not visible to this statement.
  assert.equal((await f.ownerPool.query("SELECT subject_user_id FROM auth_security_events WHERE event='login_failed'")).rows[0].subject_user_id,f.alice.user.id)
  await owner.query('COMMIT')
  await failures(f,'alice') // Name is no longer owned after commit.
  await owner.query('BEGIN');await owner.query('UPDATE users SET username_normalized=$1 WHERE id=$2',['alice-temporary',f.alice.user.id])
  await failures(f,'alice-renamed')
  await owner.query('ROLLBACK')
  const rows=(await f.ownerPool.query("SELECT subject_user_id FROM auth_security_events WHERE event='login_failed' ORDER BY created_at,id")).rows
  assert.deepEqual(rows.map(row=>row.subject_user_id),[f.alice.user.id,null,f.alice.user.id])
  assert.equal((await history(f)).filter(e=>e.outcome==='failure').length,2)
 } finally {await owner.query('ROLLBACK');owner.release()}
})

test('known and unknown invalid credentials have the same response despite a locked account row',async t=>{
 const f=await restrictedFixture(t),owner=await f.ownerPool.connect()
 const attempt=async username=>{
  const challenge=await f.app.inject({method:'GET',url:'/api/v1/auth/csrf',headers:{origin:'https://office.example'}})
  const set=challenge.headers['set-cookie'],cookies=(Array.isArray(set)?set:[set]).filter(Boolean).map(v=>v.split(';')[0]).join('; ')
  return f.app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'https://office.example',cookie:cookies,'x-csrf-token':challenge.json().csrfToken},payload:{username,password:'wrong password'}})
 }
 try {
  await owner.query('BEGIN');await owner.query('UPDATE users SET display_name=$1 WHERE id=$2',['locked',f.alice.user.id])
  const before=(await f.ownerPool.query('SELECT count(*) AS n FROM sessions')).rows[0].n
  const [known,unknown]=await Promise.all([attempt('alice'),attempt('not-a-user')])
  assert.equal((await f.ownerPool.query('SELECT count(*) AS n FROM sessions')).rows[0].n,before)
  assert.equal(known.headers['set-cookie'],undefined);assert.equal(unknown.headers['set-cookie'],undefined)
  assert.equal(unknown.statusCode,401)
  // Prior FOR SHARE attribution returns 500 on the known account's lock timeout.
  assert.equal(known.statusCode,unknown.statusCode)
  const {requestId:knownRequestId,...knownBody}=known.json(),{requestId:unknownRequestId,...unknownBody}=unknown.json()
  for(const [id,reply] of [[knownRequestId,known],[unknownRequestId,unknown]]){assert.match(id,/^[0-9a-f-]{36}$/);assert.equal(id,reply.headers['x-request-id'])}
  assert.deepEqual(knownBody,unknownBody)
  const events=(await f.ownerPool.query("SELECT subject_user_id FROM auth_security_events WHERE event='login_failed'")).rows
  assert.equal(events.length,2);assert.equal(events.filter(e=>e.subject_user_id===f.alice.user.id).length,1);assert.equal(events.filter(e=>e.subject_user_id===null).length,1)
 }finally{await owner.query('ROLLBACK');owner.release()}
})

test('known and unknown throttled accounts retain counters and one audit each while a user row is locked',async t=>{
 const f=await restrictedFixture(t),owner=await f.ownerPool.connect(),throttle=createLoginThrottle(f.db,f.deploymentId,f.csrfKey,{accountMax:1,ipMax:20,globalMax:100})
 await throttle.reserve('alice','192.0.2.10');await throttle.reserve('not-a-user','192.0.2.11')
 try {
  await owner.query('BEGIN');await owner.query('UPDATE users SET display_name=$1 WHERE id=$2',['locked',f.alice.user.id])
  const results=await Promise.all([['alice','192.0.2.10'],['not-a-user','192.0.2.11']].map(args=>throttle.reserve(...args).then(()=>({unexpected:true}),error=>({status:error.statusCode}))))
  assert.deepEqual(results,[{status:429},{status:429}])
  const counters=(await f.ownerPool.query("SELECT attempts,strikes,blocked_until IS NOT NULL AS blocked FROM login_throttles WHERE kind='account'")).rows
  assert.equal(counters.length,2);assert.ok(counters.every(c=>c.attempts===2&&c.strikes===1&&c.blocked))
  const events=(await f.ownerPool.query("SELECT subject_user_id FROM auth_security_events WHERE event='login_throttled'")).rows
  assert.equal(events.length,2);assert.equal(events.filter(e=>e.subject_user_id===f.alice.user.id).length,1);assert.equal(events.filter(e=>e.subject_user_id===null).length,1)
 }finally{await owner.query('ROLLBACK');owner.release()}
})

test('paged retained history crosses twenty, stable equal-timestamp ordering and rejects foreign anchors',async t=>{
 const f=await restrictedFixture(t)
 const ids=Array.from({length:27},()=>randomUUID()).sort().reverse()
 for(const id of ids)await f.ownerPool.query("INSERT INTO auth_security_events(id,deployment_id,actor_id,event,request_id,created_at) VALUES($1,$2,$3,'login_succeeded',$4,'2030-01-01T00:00:00.123456Z')",[id,f.deploymentId,f.alice.user.id,randomUUID()])
 let after,seen=0,cursors=[]
 do {
  const r=await f.app.inject({method:'GET',url:url+'?limit=5'+(after?'&after='+after:''),headers:headers(f.alice.token)});assert.equal(r.statusCode,200,r.body)
  const page=r.json();seen+=page.events.length;after=page.nextCursor;if(after)cursors.push(after)
 }while(after)
 assert.equal(seen,28);assert.deepEqual(cursors,ids.filter((_,i)=>(i+1)%5===0))
 for(const token of [f.bob.token])assert.equal((await f.app.inject({method:'GET',url:url+'?limit=5&after='+ids[0],headers:headers(token)})).statusCode,400)
 await assert.rejects(()=>f.businessPool.query('SELECT * FROM read_login_history_page($1,$2,$3,$4,$5)',[f.deploymentId,tokenHash(f.alice.token),28800000,5,null]),{code:'42501'})
 await f.ownerPool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1',[f.alice.sessionId])
 assert.equal((await f.app.inject({method:'GET',url:url+'?limit=5&after='+ids[0],headers:headers(f.alice.token)})).statusCode,401)
})
