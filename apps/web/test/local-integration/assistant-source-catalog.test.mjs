import test from 'node:test'
import assert from 'node:assert/strict'
import {randomBytes,randomUUID} from 'node:crypto'
import {Readable} from 'node:stream'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {restrictedFixture,restrictedOrigin} from '../helpers/restricted.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {createCsrfService} from '../../server/src/modules/auth/csrf.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'

test('opt-in assistant lists only own saved enabled metadata; no source connections or credentials',async t=>{
 const sourcesCredentialKeys='k1:'+randomBytes(32).toString('base64')
 const f=await restrictedFixture(t,{sourcesCredentialKeys,businessMax:4})
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey})
 const headers=token=>({origin:restrictedOrigin,cookie:'__Host-dyoffice-session='+token,'x-csrf-token':csrf.sessionToken(token)})
 const entry={id:'chat',kind:'chat',providerId:'openai',label:'Chat',model:'test',baseUrl:'https://provider.example/v1',enabled:true}
 const keyring={activeKeyId:'test',keys:{test:new Uint8Array(32).fill(7)}}
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[{...entry,apiKey:'synthetic-test-key'}],defaults:{chat:'chat'}})
 await f.ownerPool.query('INSERT INTO provider_budget_accounts(deployment_id,owner_id,entry_id,config_revision,available_units,per_call_units) VALUES($1,$2,$3,1,100,10)',[f.deploymentId,f.alice.user.id,'chat'])
 const profile={deploymentId:f.deploymentId,entryId:'chat',revision:1,providerId:'openai',model:'test',baseUrl:entry.baseUrl,endpoint:entry.baseUrl+'/chat/completions',allowedIpv4:['8.8.8.8'],maxOutputTokens:128}
 const config={db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin:restrictedOrigin,csrfKey:f.csrfKey,globalConfigKeyring:keyring,providerGateway:{profiles:[profile]},sourcesCredentialKeys}
 await assert.rejects(()=>buildLocalApp({...config,assistantSourceMode:'invalid'}), /source mode/)
 await assert.rejects(()=>buildLocalApp({...config,sourcesCredentialKeys:undefined,assistantSourceMode:'read-only-analysis'}), /source credential keys/)
 const off=await buildLocalApp(config), app=await buildLocalApp({...config,assistantSourceCatalog:true})
 const analysis=await buildLocalApp({...config,assistantSourceMode:'read-only-analysis'})
 f.cleanup.push(()=>off.close(),()=>app.close(),()=>analysis.close())
 assert.equal((await off.inject({method:'POST',url:'/api/v1/ai/sources/list',headers:headers(f.alice.token),payload:{}})).statusCode,501)
 assert.equal((await off.inject({url:'/api/v1/ai/catalog',headers:headers(f.alice.token)})).json().sourceCatalog,undefined)
 assert.equal((await app.inject({url:'/api/v1/ai/catalog',headers:headers(f.alice.token)})).json().sourceCatalog,true)
 const create=async(token,sourceId,enabled=true)=>{
  const response=await app.inject({method:'POST',url:'/api/v1/sources',headers:headers(token),payload:{sourceId,name:sourceId,kind:'http',config:{},secret:'https://source.invalid/data?key=synthetic-secret'}})
  assert.equal(response.statusCode,201,response.body)
  if(!enabled)assert.equal((await app.inject({method:'PUT',url:'/api/v1/sources/'+sourceId,headers:headers(token),payload:{expectedVersion:1,enabled:false}})).statusCode,200)
 }
 await create(f.alice.token,'visible');await create(f.alice.token,'draft',false);await create(f.bob.token,'bob-only')
 const url='/api/v1/ai/sources/execute'
 const execute=(instance,name,arguments_,token=f.alice.token)=>instance.inject({method:'POST',url,headers:headers(token),payload:{name,arguments:arguments_}})
 assert.equal((await analysis.inject({url:'/api/v1/ai/catalog',headers:headers(f.alice.token)})).json().sourceMode,'read-only-analysis')
 assert.notEqual((await execute(off,'sources.describe',{sourceId:'visible'})).statusCode,200)
 assert.notEqual((await execute(app,'sources.describe',{sourceId:'visible'})).statusCode,200)
 const desc=await execute(analysis,'sources.describe',{sourceId:'visible'})
 assert.equal(desc.statusCode,200,desc.body)
 assert.equal(desc.json().kind,'http')
 assert.equal(desc.json().metadata,null)
 assert.doesNotMatch(desc.body,/synthetic-secret/)
 assert.equal((await execute(analysis,'sources.describe',{sourceId:'visible'},f.bob.token)).statusCode,404)
 assert.equal((await execute(analysis,'sources.save_result',{})).statusCode,403)
 const offered=[]
 const network=mockProviderNetwork(t,()=>{
  const wire=JSON.parse(network.wire.toString())
  offered.push((wire.tools??[]).map(tool=>tool.function.name))
  return Readable.from([Buffer.from('data: {"choices":[{"delta":{"content":"checked"}}]}\n\ndata: [DONE]\n\n')])
 })
 const formats=['docx','xlsx','pptx','pdf']
 const analysisNames=['sources_list','sources_describe','sources_query','sources_read_result']
 const tools=[...analysisNames,'sources_save_result'].map(name=>({name,description:name,inputSchema:{type:'object'}}))
 const turn=(instance,format)=>instance.inject({method:'POST',url:'/api/v1/ai/turns',headers:headers(f.alice.token),payload:{
  turnId:randomUUID(),modelId:'chat',request:{format,system:'Test analysis tool policy',messages:[{role:'user',text:'List tables'}],tools},
 }})
 for(const format of formats){
  const response=await turn(analysis,format)
  assert.match(response.body,/checked/)
  assert.deepEqual(offered.at(-1),analysisNames)
 }
 assert.match((await turn(app,'docx')).body,/checked/)
 assert.deepEqual(offered.at(-1),['sources_list'])
 assert.match((await turn(off,'docx')).body,/checked/)
 assert.deepEqual(offered.at(-1),[])


 await create(f.alice.token,'disabled')
 assert.equal((await app.inject({method:'PUT',url:'/api/v1/sources/disabled',headers:headers(f.alice.token),payload:{expectedVersion:1,enabled:false}})).statusCode,200)
 // Saved names immediately become the AI metadata.
 assert.equal((await app.inject({method:'PUT',url:'/api/v1/sources/visible',headers:headers(f.alice.token),payload:{expectedVersion:1,name:'Current visible name'}})).statusCode,200)
 // Hidden IDs sort before visible and must not fill a page or become cursors.
 for(let i=0;i<51;i++)await create(f.alice.token,'hidden-'+String(i).padStart(2,'0'),false)
 const list=token=>app.inject({method:'POST',url:'/api/v1/ai/sources/list',headers:headers(token),payload:{}})
 assert.deepEqual((await list(f.alice.token)).json(),{items:[{sourceId:'visible',name:'Current visible name',kind:'http',sourceVersion:2}],nextCursor:null})
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
