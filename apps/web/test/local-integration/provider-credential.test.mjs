import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {restrictedFixture,waitForDatabaseLock} from '../helpers/restricted.mjs'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {tokenHash} from '../../server/src/modules/auth/sessions.ts'
import {createScopedAdminCredentialConsumer} from '../../server/src/modules/providers/credential-consumer.ts'
const keyring={activeKeyId:'k1',keys:{k1:new Uint8Array(32).fill(37)}}
const entry={id:'primary',kind:'chat',providerId:'openai',label:'Test',model:'synthetic-model',baseUrl:'https://provider.example/v1',enabled:true}
const secret='synthetic-local-only-credential'
async function fixture(t,consume){
 const f=await restrictedFixture(t,{businessMax:4})
 const settings=createGlobalConfigService({transactions:f.transactions,keyring})
 await settings.saveGlobalConfig(f.adminSigned.token,0,{upserts:[{...entry,apiKey:secret}]})
 const profile={deploymentId:f.deploymentId,entryId:entry.id,revision:1,providerId:entry.providerId,model:entry.model,baseUrl:entry.baseUrl,endpoint:entry.baseUrl+'/chat/completions'}
 const request={reservationId:randomUUID(),claimId:randomUUID(),entryId:entry.id,configRevision:1,requestDigest:'a'.repeat(64),turnId:randomUUID()}
 let taken=false
 // Isolates secret/RLS integration. Durable adapter is tested separately and
 // production composition must replace this single-use synthetic claim.
 const takeForDispatch=async()=>{if(taken)throw Error('already taken');taken=true;return {...request,deploymentId:f.deploymentId,userId:f.initial.id,sessionId:f.adminSigned.sessionId}}
 const consumer=createScopedAdminCredentialConsumer({transactions:f.transactions,keyring,profiles:[profile],consume,takeForDispatch})
 t.after(()=>consumer.dispose())
 return {...f,settings,consumer,request}
}
async function admin(f,fn){return f.transactions.withPrincipalTransaction({kind:'session',token:f.adminSigned.token},async(c,p)=>{
 await c.query("SELECT set_config('dyoffice.global_session_hash',$1,true),set_config('dyoffice.global_idle_ms',$2,true)",[tokenHash(f.adminSigned.token),String(f.transactions.sessionIdleMs)])
 return fn(c,p)
})}
test('real restricted PostgreSQL admin key is consumed only in callback and zeroed',async t=>{
 let retained,calls=0
 const f=await fixture(t,async scope=>{calls++;retained=scope.credential;assert.equal(retained.toString(),secret);assert.equal(scope.endpoint,entry.baseUrl+'/chat/completions')})
 assert.equal(await f.consumer.run(f.adminSigned.token,f.request),undefined)
 assert.equal(calls,1);assert.ok(retained.every(b=>b===0))
 await assert.rejects(f.consumer.run(f.adminSigned.token,f.request));assert.equal(calls,1)
})
test('ordinary member cannot consume deployment credentials even with synthetic claim',async t=>{
 let calls=0;const f=await fixture(t,async()=>{calls++})
 await assert.rejects(f.consumer.run(f.alice.token,f.request),{message:'Provider credential unavailable'})
 assert.equal(calls,0)
 const r=await f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async c=>{
 await c.query("SELECT set_config('dyoffice.global_session_hash',$1,true),set_config('dyoffice.global_idle_ms',$2,true)",[tokenHash(f.alice.token),String(f.transactions.sessionIdleMs)])
 return c.query('SELECT * FROM global_config_secrets')})
 assert.equal(r.rowCount,0)
})
test('config mutation while waiting for lock rejects before callback',async t=>{
 let calls=0;const f=await fixture(t,async()=>{calls++})
 let release,ready;const gate=new Promise(r=>release=r),entered=new Promise(r=>ready=r)
 const holding=admin(f,async c=>{
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['dyoffice:global-config:'+f.deploymentId])
 ready();await gate;await c.query('UPDATE global_configs SET revision=revision+1 WHERE deployment_id=$1',[f.deploymentId])
 })
 await entered
 const running=f.consumer.run(f.adminSigned.token,f.request);running.catch(()=>{})
 try{await waitForDatabaseLock(f,'business');release();await holding;await assert.rejects(running,{message:'Provider credential unavailable'});assert.equal(calls,0)}
 finally{release();await Promise.allSettled([holding,running])}
})
test('AAD mismatch in persisted ciphertext fails closed without upstream error',async t=>{
 let calls=0;const f=await fixture(t,async()=>{calls++})
 await f.settings.saveGlobalConfig(f.adminSigned.token,1,{upserts:[{...entry,id:'other',apiKey:secret}]})
 // Restore the fixture revision solely to isolate persisted envelope AAD behavior.
 await admin(f,async c=>{await c.query("UPDATE global_config_secrets SET envelope=(SELECT envelope FROM global_config_secrets WHERE entry_id='other') WHERE entry_id='primary'");await c.query('UPDATE global_configs SET revision=1')})
 await assert.rejects(f.consumer.run(f.adminSigned.token,f.request),{message:'Provider credential unavailable'});assert.equal(calls,0)
})
test('callback error is generic and plaintext is zeroed on real transaction rollback',async t=>{
 let retained;const f=await fixture(t,async scope=>{retained=scope.credential;throw Error(secret)})
 await assert.rejects(f.consumer.run(f.adminSigned.token,f.request),{message:'Provider credential unavailable'})
 assert.ok(retained.every(b=>b===0))
})
test('real durable budget gate admits one credential callback and preserves unknown across replay',async t=>{
 const {createProviderBudgetService,grantProviderBudgetRuntime}=await import('../../server/src/modules/providers/budget.ts')
 const {createBudgetedAdminCredentialConsumer}=await import('../../server/src/modules/providers/budgeted-credential.ts')
 const f=await fixture(t,async()=>{})
 assert.equal((await f.ownerPool.query("SELECT to_regclass('provider_budget_accounts') IS NOT NULL AS installed")).rows[0].installed,true)
 await grantProviderBudgetRuntime(f.ownerPool,f.names.business)
 await f.ownerPool.query('INSERT INTO provider_budget_accounts(deployment_id,owner_id,entry_id,config_revision,available_units,per_call_units) VALUES($1,$2,$3,1,10,10)',[f.deploymentId,f.initial.id,entry.id])
 const budget=createProviderBudgetService({transactions:f.transactions})
 const binding={turnId:f.request.turnId,entryId:entry.id,configRevision:1,requestDigest:f.request.requestDigest}
 await budget.reserve(f.adminSigned.token,binding)
 const claim=await budget.claim(f.adminSigned.token,binding)
 let calls=0,retained
 const consumer=createBudgetedAdminCredentialConsumer({budget,transactions:f.transactions,keyring,
 profiles:[{deploymentId:f.deploymentId,entryId:entry.id,revision:1,providerId:entry.providerId,model:entry.model,baseUrl:entry.baseUrl,endpoint:entry.baseUrl+'/chat/completions'}],
 consume:async scope=>{calls++;retained=scope.credential;assert.equal(retained.toString(),secret)}})
 t.after(()=>consumer.dispose())
 const input={...binding,reservationId:claim.id,claimId:claim.claimId}
 const runs=await Promise.allSettled([consumer.run(f.adminSigned.token,input),consumer.run(f.adminSigned.token,input)])
 assert.equal(runs.filter(x=>x.status==='fulfilled').length,1);assert.equal(calls,1);assert.ok(retained.every(b=>b===0))
 assert.equal((await budget.status(f.adminSigned.token,binding)).state,'unknown')
 assert.equal(Number((await f.ownerPool.query('SELECT available_units FROM provider_budget_accounts')).rows[0].available_units),0)
 await assert.rejects(budget.cancel(f.adminSigned.token,binding))
 await budget.settle(f.adminSigned.token,binding,claim.claimId)
 assert.equal((await budget.status(f.adminSigned.token,binding)).state,'settled')
})
test('admin role removed while waiting for config lock rejects the earlier principal snapshot',async t=>{
 let calls=0;const f=await fixture(t,async()=>{calls++})
 const c=await f.ownerPool.connect()
 await c.query('BEGIN')
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['dyoffice:global-config:'+f.deploymentId])
 const running=f.consumer.run(f.adminSigned.token,f.request);running.catch(()=>{})
 try{
  await waitForDatabaseLock(f,'business')
  await f.authPool.query("DELETE FROM user_roles WHERE deployment_id=$1 AND user_id=$2 AND role='config_admin'",[f.deploymentId,f.initial.id])
  await c.query('COMMIT')
  await assert.rejects(running,{message:'Provider credential unavailable'});assert.equal(calls,0)
 }finally{await c.query('ROLLBACK');c.release();await Promise.allSettled([running])}
})
test('session expiry while waiting for config lock is rechecked before decrypt',async t=>{
 let calls=0;const f=await fixture(t,async()=>{calls++})
 const c=await f.ownerPool.connect()
 await c.query('BEGIN')
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['dyoffice:global-config:'+f.deploymentId])
 await f.authPool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1",[f.adminSigned.sessionId])
 const running=f.consumer.run(f.adminSigned.token,f.request);running.catch(()=>{})
 try{
  await waitForDatabaseLock(f,'business')
  await c.query('SELECT pg_sleep(2.1)')
  await c.query('COMMIT')
  await assert.rejects(running,{message:'Provider credential unavailable'});assert.equal(calls,0)
 }finally{await c.query('ROLLBACK');c.release();await Promise.allSettled([running])}
})
test('session revocation committed before principal admission prevents credential consumption',async t=>{
 let calls=0;const f=await fixture(t,async()=>{calls++})
 const c=await f.authPool.connect()
 await c.query('BEGIN')
 await c.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1',[f.adminSigned.sessionId])
 const running=f.consumer.run(f.adminSigned.token,f.request);running.catch(()=>{})
 try{
  await waitForDatabaseLock(f,'business');await c.query('COMMIT')
  await assert.rejects(running,{message:'Provider credential unavailable'});assert.equal(calls,0)
 }finally{await c.query('ROLLBACK');c.release();await Promise.allSettled([running])}
})
