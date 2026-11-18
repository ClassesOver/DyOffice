import {test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {restrictedFixture,restrictedOrigin} from '../helpers/restricted.mjs'
const headers=token=>({cookie:'__Host-dyoffice-session='+token,origin:restrictedOrigin})
test('active sessions keyset pages preserve legacy, microseconds, owner isolation and revoked anchors',async t=>{
 const f=await restrictedFixture(t)
 const ids=Array.from({length:105},()=>randomUUID()).sort()
 for(const id of ids)await f.ownerPool.query(`INSERT INTO sessions(id,deployment_id,user_id,token_hash,auth_version,expires_at,last_seen_at,created_at) SELECT $1::uuid,deployment_id,user_id,md5(($1::uuid)::text)||md5(($1::uuid)::text),auth_version,expires_at,last_seen_at,'2020-01-01T00:00:00.123456Z' FROM sessions WHERE id=$2`,[id,f.alice.sessionId])
 const url='/api/v1/auth/sessions',get=query=>f.app.inject({method:'GET',url:url+query,headers:headers(f.alice.token)})
 const legacy=(await get('')).json();assert.equal(legacy.sessions.length,106);assert.equal(Object.hasOwn(legacy,'nextCursor'),false)
 let after,seen=[]
 do {const r=await get('?limit=20'+(after?'&after='+after:''));assert.equal(r.statusCode,200,r.body);const page=r.json();assert.ok(page.sessions.length<=20);seen.push(...page.sessions.map(x=>x.id));after=page.nextCursor}while(after)
 assert.deepEqual(seen,[...ids,f.alice.sessionId])
 await f.sessions.revoke(f.alice.token,ids[19])
 const next=(await get('?limit=20&after='+ids[19])).json();assert.equal(next.sessions[0].id,ids[20])
 for(const token of [f.bob.token,f.adminSigned.token])await assert.rejects(()=>f.sessions.listPage(token,{after:ids[19]}),e=>e.statusCode===400)
 for(const query of ['?limit=0','?limit=101','?limit=1&limit=2','?after=bad','?owner='+f.alice.user.id])assert.equal((await get(query)).statusCode,400,query)
 const newer='00000000-0000-4000-8000-000000000001',older='ffffffff-ffff-4fff-8fff-ffffffffffff'
 for(const [id,at] of [[older,'2019-01-01T00:00:00.123456Z'],[newer,'2019-01-01T00:00:00.123457Z']])await f.ownerPool.query(`INSERT INTO sessions(id,deployment_id,user_id,token_hash,auth_version,expires_at,last_seen_at,created_at) SELECT $1::uuid,deployment_id,user_id,md5(($1::uuid)::text)||md5(($1::uuid)::text),auth_version,expires_at,last_seen_at,$3::timestamptz FROM sessions WHERE id=$2`,[id,f.alice.sessionId,at])
 const first=await f.sessions.listPage(f.alice.token,{limit:1});assert.equal(first.nextCursor,older)
 assert.equal((await f.sessions.listPage(f.alice.token,{limit:1,after:older})).sessions[0].id,newer)
 await f.sessions.revoke(f.alice.token,f.alice.sessionId)
 assert.equal((await get('?limit=20')).statusCode,401)
})
test('session pages reject foreign tenants, retain expired boundaries and do not expose secrets',async t=>{
 const f=await restrictedFixture(t)
 const {createAccountService}=await import('../../server/src/modules/auth/service.ts')
 const {createSessionService}=await import('../../server/src/modules/auth/sessions.ts')
 const {password}=await import('../helpers/identity.mjs')
 const deploymentId=randomUUID()
 await createAccountService({db:f.ownerDb,passwords:f.passwords,deploymentId}).bootstrapAdmin({username:'other',password})
 const accounts=createAccountService({db:f.db,passwords:f.passwords,deploymentId})
 const other=createSessionService({db:f.db,accounts,deploymentId}),signed=await other.login('other',password)
 await assert.rejects(()=>f.sessions.listPage(signed.token),e=>e.statusCode===401)
 await assert.rejects(()=>other.listPage(signed.token,{after:f.alice.sessionId}),e=>e.statusCode===400)
 const expired=randomUUID()
 await f.ownerPool.query(`INSERT INTO sessions(id,deployment_id,user_id,token_hash,auth_version,expires_at,last_seen_at,created_at) SELECT $1::uuid,deployment_id,user_id,md5($1::text)||md5($1::text),auth_version,'2020-01-02','2020-01-01','2020-01-01' FROM sessions WHERE id=$2`,[expired,f.alice.sessionId])
 const page=await f.sessions.listPage(f.alice.token,{limit:100,after:expired.toUpperCase()})
 assert.deepEqual(page.sessions.map(s=>s.id),[f.alice.sessionId]);assert.equal(page.nextCursor,null)
 assert.deepEqual(Object.keys(page.sessions[0]).sort(),['createdAt','current','expiresAt','id','lastSeenAt'])
 assert.deepEqual(await f.sessions.listPage(f.alice.token,{after:f.alice.sessionId}),{sessions:[],nextCursor:null})
 await assert.rejects(()=>f.sessions.listPage(f.alice.token,{after:randomUUID()}),e=>e.statusCode===400)
 for(const limit of [0,101,1.5,NaN,Infinity])await assert.rejects(()=>f.sessions.listPage(f.alice.token,{limit}),e=>e.statusCode===400)
 const index=(await f.ownerPool.query("SELECT indexdef FROM pg_indexes WHERE indexname='sessions_active_page'")).rows[0]?.indexdef
 assert.match(index,/deployment_id, user_id, auth_version, created_at, id/)
 assert.match(index,/revoked_at IS NULL/)
})
