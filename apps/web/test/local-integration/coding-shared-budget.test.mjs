import test from 'node:test'
import assert from 'node:assert/strict'
import {randomBytes,randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {createIdentityStore} from '../../server/src/db/identity.ts'
import {provisionRuntimeRoles} from '../../server/src/db/roles.ts'
import {createPrincipalTransactions} from '../../server/src/db/context.ts'
import {createPasswordService} from '../../server/src/modules/auth/passwords.ts'
import {createAccountService} from '../../server/src/modules/auth/service.ts'
import {createSessionService} from '../../server/src/modules/auth/sessions.ts'
import {createUserService} from '../../server/src/modules/admin/users/service.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {createCsrfService} from '../../server/src/modules/auth/csrf.ts'
import {registerPersonalProviderGateway} from '../../server/src/modules/providers/gateway.ts'
import {createHarnessRegistry} from '../../server/src/modules/coding/registry.ts'
import {createCodingModelBridge} from '../../server/src/modules/coding/model-bridge.ts'
import {createApiShell} from '../../server/src/framework.ts'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {password} from '../helpers/identity.mjs'

// Focused ledger fixture: production migrations, grants and restricted logins.
// It deliberately does not boot unrelated editor/runtime readiness checks.
async function fixture(t) {
 const source=process.env.DYOFFICE_TEST_DATABASE_URL
 assert.ok(source,'Disposable PostgreSQL admin connection required')
 assert.match(new URL(source).pathname,/^\/dyoffice_test(?:_[a-z0-9_]+)?$/)
 const suffix=randomBytes(6).toString('hex'),database='dyoffice_test_coding_'+suffix
 const admin=new Pool({connectionString:source,connectionTimeoutMillis:5000}),pools=[],roles=[]
 let made=false,app,gateway
 t.after(async()=>{
  try{gateway?.dispose();await gateway?.drain();await app?.close()}
  finally{
   await Promise.allSettled(pools.map(pool=>pool.end()))
   try{if(made)await admin.query('DROP DATABASE '+database);for(const role of roles.reverse())await admin.query('DROP ROLE '+role)}
   finally{await admin.end()}
  }
 })
 const names={},urls={}
 for(const kind of ['owner','auth','business']) {
  const name='dy_'+suffix+'_'+kind,secret=randomBytes(24).toString('hex')
  await admin.query(`CREATE ROLE ${name} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${secret}'`)
  roles.push(name);names[kind]=name
  const url=new URL(source);url.username=name;url.password=secret;url.pathname='/'+database;urls[kind]=url.toString()
 }
 await admin.query('CREATE DATABASE '+database+' OWNER '+names.owner);made=true
 const pool=kind=>{const value=new Pool({connectionString:urls[kind],max:4,connectionTimeoutMillis:5000});pools.push(value);return value}
 const ownerPool=pool('owner'),ownerDb=createIdentityStore(ownerPool)
 await ownerDb.migrate();await provisionRuntimeRoles(ownerPool,{authRole:names.auth,businessRole:names.business})
 const authPool=pool('auth'),businessPool=pool('business'),db=createIdentityStore(authPool)
 const passwords=await createPasswordService(),deploymentId=randomUUID()
 await createAccountService({db:ownerDb,passwords,deploymentId}).bootstrapAdmin({username:'owner',password})
 const accounts=createAccountService({db,passwords,deploymentId}),sessions=createSessionService({db,accounts,deploymentId})
 const users=createUserService({db,accounts,sessions,passwords,deploymentId}),adminSigned=await sessions.login('owner',password)
 const created=await users.create(adminSigned.token,{username:'alice'})
 await users.redeemAction(created.action.token,'activate',password)
 const alice=await sessions.login('alice',password),transactions=createPrincipalTransactions({pool:businessPool,deploymentId})
 const keyring={activeKeyId:'test',keys:{test:new Uint8Array(32).fill(25)}}
 const entry={id:'shared-model',kind:'chat',providerId:'openai',label:'Shared',model:'synthetic',baseUrl:'https://provider.example/v1',enabled:true}
 await createGlobalConfigService({transactions,keyring}).saveGlobalConfig(adminSigned.token,0,{upserts:[{...entry,apiKey:'synthetic-private-key'}],defaults:{chat:entry.id}})
 await ownerPool.query('INSERT INTO provider_budget_accounts(deployment_id,owner_id,entry_id,config_revision,available_units,per_call_units) VALUES($1,$2,$3,1,30,10)',[deploymentId,created.user.id,entry.id])
 const origin='https://office.example',csrf=createCsrfService({db,deploymentId,origin,key:randomBytes(32).toString('hex')})
 app=await createApiShell()
 const harnesses=createHarnessRegistry([{descriptor:{id:'codex',name:'Codex',origin:'builtin',capabilities:['coding']},async run(){throw Error('Not invoked by model billing test')}}],'codex')
 const profile={deploymentId,entryId:entry.id,revision:1,providerId:entry.providerId,model:entry.model,baseUrl:entry.baseUrl,endpoint:entry.baseUrl+'/chat/completions',allowedIpv4:['8.8.8.8'],maxOutputTokens:128}
 gateway=registerPersonalProviderGateway(app,{transactions,sessions,csrf,keyring,profiles:[profile],deploymentId,harnesses})
 await app.ready()
 const headers={origin,cookie:'__Host-dyoffice-session='+alice.token,'x-csrf-token':csrf.sessionToken(alice.token)}
 return {app,gateway,headers,ownerPool,businessPool,alice,entry,created,deploymentId}
}

test('Office and coding rounds settle one real personal ledger and the fourth round cannot dispatch',async t=>{
 const frame=value=>Buffer.from('data: '+JSON.stringify(value)+'\n\n')
 const network=mockProviderNetwork(t,[frame({choices:[{delta:{content:'Synthetic answer'}}]}),frame({choices:[{delta:{},finish_reason:'stop'}]}),frame({choices:[],usage:{prompt_tokens:3,completion_tokens:4}}),Buffer.from('data: [DONE]\n\n')])
 const f=await fixture(t),controller=new AbortController()
 const bridge=await createCodingModelBridge({turns:f.gateway.codingTurns,token:f.alice.token,modelId:f.entry.id,signal:controller.signal})
 t.after(()=>bridge.close())
 const coding=()=>fetch(bridge.baseUrl+'/responses',{method:'POST',headers:{authorization:'Bearer '+bridge.apiKey},body:JSON.stringify({model:'untrusted-model',input:'write a parser',stream:true,tools:[{type:'function',name:'exec_command',parameters:{type:'object',properties:{cmd:{type:'string'}}}}]})}).then(r=>r.text())
 const office=()=>f.app.inject({method:'POST',url:'/api/v1/ai/turns',headers:f.headers,payload:{turnId:randomUUID(),modelId:f.entry.id,request:{system:'Office',messages:[{role:'user',text:'read this document'}],tools:[{name:'read_blocks',description:'Read',inputSchema:{type:'object'}},{name:'exec_command',description:'Forbidden direct shell',inputSchema:{type:'object'}}]}}})
 const first=await office();assert.doesNotMatch(first.body,/event: error/)
 assert.deepEqual(JSON.parse(network.wire).tools.map(x=>x.function.name),['read_blocks'])
 assert.match(await coding(),/response.completed/)
 assert.equal(JSON.parse(network.wire).model,'synthetic')
 assert.deepEqual(JSON.parse(network.wire).tools.map(x=>x.function.name),['exec_command'])
 const third=await office();assert.doesNotMatch(third.body,/event: error/)
 assert.equal(network.writes,3)
 const fourth=await coding();assert.match(fourth,/response.failed/);assert.doesNotMatch(fourth,/response.completed/)
 assert.equal(network.writes,3,'exhausted shared budget must fail before HTTPS body dispatch')
 const accounts=(await f.ownerPool.query('SELECT owner_id,entry_id,available_units FROM provider_budget_accounts')).rows
 assert.equal(accounts.length,1);assert.equal(accounts[0].owner_id,f.created.user.id);assert.equal(accounts[0].entry_id,f.entry.id);assert.equal(Number(accounts[0].available_units),0)
 const reservations=(await f.ownerPool.query('SELECT owner_id,entry_id,state,amount_units FROM provider_budget_reservations')).rows
 assert.equal(reservations.length,3)
 for(const row of reservations){assert.equal(row.owner_id,f.created.user.id);assert.equal(row.entry_id,f.entry.id);assert.equal(row.state,'settled');assert.equal(Number(row.amount_units),10)}
 await assert.rejects(f.businessPool.query('UPDATE provider_budget_accounts SET available_units=999'),{code:'42501'})
})
