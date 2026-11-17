import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {spawn} from 'node:child_process'
import {password} from '../helpers/identity.mjs'
import {tokenHash} from '../../server/src/modules/auth/sessions.ts'
import {restrictedFixture} from '../helpers/restricted.mjs'
const budget=await import('../../server/src/modules/providers/budget.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e})
async function fixture(t,amount=20,price=10){
 const f=await restrictedFixture(t,{businessMax:4})
 assert.equal((await f.ownerPool.query("SELECT to_regclass('provider_budget_accounts') IS NOT NULL AS installed")).rows[0].installed,true)
 await budget.grantProviderBudgetRuntime(f.ownerPool,f.names.business)
 const asAdminOwner=async fn=>{const c=await f.ownerPool.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true),set_config('dyoffice.session_id',$3,true),set_config('dyoffice.global_session_hash',$4,true),set_config('dyoffice.global_idle_ms','28800000',true)",[f.deploymentId,f.initial.id,f.adminSigned.sessionId,tokenHash(f.adminSigned.token)]);const result=await fn(c);await c.query('COMMIT');return result}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}}
 await asAdminOwner(c=>c.query('INSERT INTO global_configs(deployment_id,revision) VALUES($1,1)',[f.deploymentId]))
 await asAdminOwner(c=>c.query("INSERT INTO global_config_entries(deployment_id,id,kind,provider_id,label,model,base_url,enabled) VALUES($1,'model','chat','openai','Model','model','https://api.example.com/',true)",[f.deploymentId]))
 const binding={turnId:randomUUID(),entryId:'model',configRevision:1,requestDigest:'a'.repeat(64)}
 const service=budget.createProviderBudgetService({transactions:f.transactions})
 const provision=()=>f.ownerPool.query('INSERT INTO provider_budget_accounts(deployment_id,owner_id,entry_id,config_revision,available_units,per_call_units) VALUES($1,$2,$3,1,$4,$5)',[f.deploymentId,f.initial.id,'model',amount,price])
 const available=async()=>Number((await f.ownerPool.query('SELECT available_units FROM provider_budget_accounts')).rows[0].available_units)
 return {...f,binding,service,provision,available,asAdminOwner,token:f.adminSigned.token}
}
test('real budget defaults deny and ordinary user cannot reserve even with matching configuration',async t=>{
 assert.equal(typeof budget.createProviderBudgetService,'function')
 const f=await fixture(t)
 await assert.rejects(()=>f.service.reserve(f.token,f.binding));await f.provision()
 await assert.rejects(()=>f.service.reserve(f.alice.token,f.binding));assert.equal(await f.available(),20)
})
test('real concurrent reserves never overspend and replay requires exact request identity',async t=>{
 const f=await fixture(t,10);await f.provision()
 const outcomes=await Promise.allSettled([f.service.reserve(f.token,f.binding),f.service.reserve(f.token,{...f.binding,turnId:randomUUID()})]);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(await f.available(),0)
 const win=outcomes.find(x=>x.status==='fulfilled').value
 const b={...f.binding,turnId:win.turnId};assert.equal((await f.service.reserve(f.token,b)).id,win.id)
 await assert.rejects(()=>f.service.reserve(f.token,{...b,requestDigest:'b'.repeat(64)}));assert.equal(await f.available(),0)
})
test('claim and dispatch are single atomic durable steps; unknown holds funds and full settlement is idempotent',async t=>{
 const f=await fixture(t);await f.provision();const reserved=await f.service.reserve(f.token,f.binding)
 const claims=await Promise.allSettled([f.service.claim(f.token,f.binding),f.service.claim(f.token,f.binding)]);assert.equal(claims.filter(x=>x.status==='fulfilled').length,1)
 const claim=claims.find(x=>x.status==='fulfilled').value;assert.equal(claim.id,reserved.id)
 const dispatches=await Promise.allSettled([f.service.takeForDispatch(f.token,f.binding,claim.claimId),f.service.takeForDispatch(f.token,f.binding,claim.claimId)]);assert.equal(dispatches.filter(x=>x.status==='fulfilled').length,1)
 const recreated=budget.createProviderBudgetService({transactions:f.transactions});assert.equal((await recreated.status(f.token,f.binding)).state,'unknown');assert.equal(await f.available(),10)
 await assert.rejects(()=>recreated.cancel(f.token,f.binding));await assert.rejects(()=>recreated.takeForDispatch(f.token,f.binding,claim.claimId))
 assert.equal((await recreated.settle(f.token,f.binding,claim.claimId)).state,'settled');assert.equal((await recreated.settle(f.token,f.binding,claim.claimId)).state,'settled');assert.equal(await f.available(),10)
})
test('only unclaimed reservations refund once; config-changed claims fail closed',async t=>{
 const f=await fixture(t);await f.provision();await f.service.reserve(f.token,f.binding);await f.service.cancel(f.token,f.binding);await f.service.cancel(f.token,f.binding);assert.equal(await f.available(),20)
 await assert.rejects(()=>f.service.claim(f.token,f.binding))
 const b={...f.binding,turnId:randomUUID()};await f.service.reserve(f.token,b);await f.asAdminOwner(c=>c.query('UPDATE global_configs SET revision=2'));await assert.rejects(()=>f.service.claim(f.token,b));assert.equal(await f.available(),10)
})
test('runtime SQL cannot mint or refund money and cannot spoof another session',async t=>{
 const f=await fixture(t);await f.provision();await f.service.reserve(f.token,f.binding)
 await assert.rejects(()=>f.businessPool.query('UPDATE provider_budget_accounts SET available_units=999'),{code:'42501'})
 await assert.rejects(()=>f.businessPool.query('UPDATE provider_budget_reservations SET state=\'cancelled\''),{code:'42501'})
 await assert.rejects(()=>f.authPool.query('SELECT * FROM provider_budget_reservations'),{code:'42501'})
 await assert.rejects(()=>f.service.status(f.alice.token,f.binding));assert.equal(await f.available(),10)
})

test('another session of the same admin and forged claim IDs cannot consume an existing turn',async t=>{
 const f=await fixture(t);await f.provision();await f.service.reserve(f.token,f.binding);const claim=await f.service.claim(f.token,f.binding)
 const other=await f.sessions.login('owner',password)
 await assert.rejects(()=>f.service.status(other.token,f.binding));await assert.rejects(()=>f.service.takeForDispatch(other.token,f.binding,claim.claimId))
 await assert.rejects(()=>f.service.takeForDispatch(f.token,f.binding,randomUUID()))
 await assert.rejects(()=>f.service.takeForDispatch(f.token,{...f.binding,requestDigest:'b'.repeat(64)},claim.claimId));assert.equal((await f.service.status(f.token,f.binding)).state,'dispatching')
})
test('zero provisioned budget and revoked sessions fail closed without refunding the reserved amount',async t=>{
 const zero=await fixture(t,0);await zero.provision();await assert.rejects(()=>zero.service.reserve(zero.token,zero.binding));assert.equal(await zero.available(),0)
 const f=await fixture(t);await f.provision();await f.service.reserve(f.token,f.binding);await f.sessions.revoke(f.token,f.adminSigned.sessionId)
 await assert.rejects(()=>f.service.claim(f.token,f.binding));assert.equal(await f.available(),10)
})
test('concurrent cancel and claim cannot both succeed or refund a claimed turn',async t=>{
 const f=await fixture(t);await f.provision();await f.service.reserve(f.token,f.binding)
 const result=await Promise.allSettled([f.service.cancel(f.token,f.binding),f.service.claim(f.token,f.binding)])
 assert.equal(result.filter(r=>r.status==='fulfilled').length,1)
 const s=await f.service.status(f.token,f.binding);assert.ok(['cancelled','dispatching'].includes(s.state));assert.equal(await f.available(),s.state==='cancelled'?20:10)
})
test('process crash after committed dispatch intent leaves durable unknown and cannot replay',async t=>{
 const f=await fixture(t);await f.provision();await f.service.reserve(f.token,f.binding);const claim=await f.service.claim(f.token,f.binding)
 const code=`import {Pool} from 'pg';import {createPrincipalTransactions} from './server/src/db/context.ts';import {createProviderBudgetService} from './server/src/modules/providers/budget.ts';const pool=new Pool({connectionString:process.env.BUDGET_DB});const service=createProviderBudgetService({transactions:createPrincipalTransactions({pool,deploymentId:process.env.BUDGET_DEP})});await service.takeForDispatch(process.env.BUDGET_TOKEN,JSON.parse(process.env.BUDGET_BINDING),process.env.BUDGET_CLAIM);process.exit(77);`
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code],{cwd:new URL('../..',import.meta.url),env:{...process.env,BUDGET_DB:f.urls.business,BUDGET_DEP:f.deploymentId,BUDGET_TOKEN:f.token,BUDGET_BINDING:JSON.stringify(f.binding),BUDGET_CLAIM:claim.claimId},stdio:['ignore','ignore','pipe']})
 let errors='';child.stderr.on('data',b=>errors+=b)
 assert.equal(await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve)}),77,errors)
 assert.equal((await f.service.status(f.token,f.binding)).state,'unknown');assert.equal(await f.available(),10)
 await assert.rejects(()=>f.service.takeForDispatch(f.token,f.binding,claim.claimId));await assert.rejects(()=>f.service.cancel(f.token,f.binding))
})

test('two separate admin login sessions share one account lock and cannot overspend',async t=>{
 const f=await fixture(t,10);await f.provision();const other=await f.sessions.login('owner',password)
 const otherBinding={...f.binding,turnId:randomUUID()}
 const outcomes=await Promise.allSettled([f.service.reserve(f.token,f.binding),f.service.reserve(other.token,otherBinding)])
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(await f.available(),0)
 const rows=(await f.ownerPool.query('SELECT session_id,amount_units,state FROM provider_budget_reservations')).rows
 assert.equal(rows.length,1);assert.equal(Number(rows[0].amount_units),10);assert.equal(rows[0].state,'reserved')
 assert.ok([f.adminSigned.sessionId,other.sessionId].includes(rows[0].session_id))
})
