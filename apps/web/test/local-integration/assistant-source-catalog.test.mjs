import test from 'node:test'
import assert from 'node:assert/strict'
import {randomBytes} from 'node:crypto'
import {restrictedFixture,restrictedOrigin} from '../helpers/restricted.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {createCsrfService} from '../../server/src/modules/auth/csrf.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'

test('opt-in assistant lists only own published enabled metadata; no source connections or credentials',async t=>{
 const sourcesCredentialKeys='k1:'+randomBytes(32).toString('base64')
 const f=await restrictedFixture(t,{sourcesCredentialKeys,businessMax:4})
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey})
 const headers=token=>({origin:restrictedOrigin,cookie:'__Host-dyoffice-session='+token,'x-csrf-token':csrf.sessionToken(token)})
 const entry={id:'chat',kind:'chat',providerId:'openai',label:'Chat',model:'test',baseUrl:'https://provider.invalid/v1',enabled:true}
 const keyring={activeKeyId:'test',keys:{test:new Uint8Array(32).fill(7)}}
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[{...entry,apiKey:'synthetic-test-key'}],defaults:{chat:'chat'}})
 await f.ownerPool.query('INSERT INTO provider_budget_accounts(deployment_id,owner_id,entry_id,config_revision,available_units,per_call_units) VALUES($1,$2,$3,1,10,10)',[f.deploymentId,f.alice.user.id,'chat'])
 const profile={deploymentId:f.deploymentId,entryId:'chat',revision:1,providerId:'openai',model:'test',baseUrl:entry.baseUrl,endpoint:entry.baseUrl+'/chat/completions',allowedIpv4:['8.8.8.8'],maxOutputTokens:128}
 const config={db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin:restrictedOrigin,csrfKey:f.csrfKey,globalConfigKeyring:keyring,providerGateway:{profiles:[profile]},sourcesCredentialKeys}
 const off=await buildLocalApp(config), app=await buildLocalApp({...config,assistantSourceCatalog:true})
 f.cleanup.push(()=>off.close(),()=>app.close())
 assert.equal((await off.inject({method:'POST',url:'/api/v1/ai/sources/list',headers:headers(f.alice.token),payload:{}})).statusCode,501)
 assert.equal((await off.inject({url:'/api/v1/ai/catalog',headers:headers(f.alice.token)})).json().sourceCatalog,undefined)
 assert.equal((await app.inject({url:'/api/v1/ai/catalog',headers:headers(f.alice.token)})).json().sourceCatalog,true)
 const create=async(token,sourceId,published=true)=>{
  const response=await app.inject({method:'POST',url:'/api/v1/sources',headers:headers(token),payload:{sourceId,name:sourceId,kind:'http',config:{},secret:'https://source.invalid/data?key=synthetic-secret'}})
  assert.equal(response.statusCode,201,response.body)
  if(published)assert.equal((await app.inject({method:'POST',url:'/api/v1/sources/'+sourceId+'/publish',headers:headers(token),payload:{expectedVersion:1}})).statusCode,200)
 }
 await create(f.alice.token,'visible');await create(f.alice.token,'draft',false);await create(f.bob.token,'bob-only')
 await create(f.alice.token,'disabled')
 assert.equal((await app.inject({method:'PUT',url:'/api/v1/sources/disabled',headers:headers(f.alice.token),payload:{expectedVersion:1,enabled:false}})).statusCode,200)
 // A draft rename must never alter the published metadata exposed to AI.
 assert.equal((await app.inject({method:'PUT',url:'/api/v1/sources/visible',headers:headers(f.alice.token),payload:{expectedVersion:1,name:'unpublished-private-name'}})).statusCode,200)
 // Hidden IDs sort before visible and must not fill a page or become cursors.
 for(let i=0;i<51;i++)await create(f.alice.token,'hidden-'+String(i).padStart(2,'0'),false)
 const list=token=>app.inject({method:'POST',url:'/api/v1/ai/sources/list',headers:headers(token),payload:{}})
 assert.deepEqual((await list(f.alice.token)).json(),{items:[{sourceId:'visible',name:'visible',kind:'http',sourceVersion:1}],nextCursor:null})
 assert.deepEqual((await list(f.bob.token)).json().items.map(s=>s.sourceId),['bob-only'])
 for(let i=0;i<51;i++)await create(f.alice.token,'page-'+String(i).padStart(2,'0'))
 const first=(await list(f.alice.token)).json()
 assert.equal(first.items.length,50);assert.equal(first.nextCursor,'page-49')
 const second=(await app.inject({method:'POST',url:'/api/v1/ai/sources/list',headers:headers(f.alice.token),payload:{after:first.nextCursor}})).json()
 assert.deepEqual(second.items.map(row=>row.sourceId),['page-50','visible']);assert.equal(second.nextCursor,null)
 const stale=await app.inject({method:'POST',url:'/api/v1/ai/sources/list',headers:{...headers(f.bob.token),'x-csrf-token':csrf.sessionToken(f.alice.token)},payload:{}})
 assert.equal(stale.statusCode,403)
 await f.sessions.logout(f.alice.token)
 assert.equal((await list(f.alice.token)).statusCode,401)
})
