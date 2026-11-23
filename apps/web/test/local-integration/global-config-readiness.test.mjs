import test from 'node:test'
import assert from 'node:assert/strict'
import {restrictedFixture} from '../helpers/restricted.mjs'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {tokenHash} from '../../server/src/modules/auth/sessions.ts'

const keyring={activeKeyId:'readiness-test',keys:{'readiness-test':new Uint8Array(32).fill(29)}}
const entry=(id,kind,providerId,extra={})=>({id,kind,providerId,label:id,model:kind==='chat'?'synthetic-model':'',baseUrl:'https://provider.example/v1',enabled:true,...extra})

test('ordinary users see configured readiness without gaining access to secrets',async t=>{
 const f=await restrictedFixture(t,{buildApp:false,businessMax:2})
 const config=createGlobalConfigService({transactions:f.transactions,keyring})
 await config.saveGlobalConfig(f.adminSigned.token,0,{upserts:[
  entry('chat','chat','deepseek',{apiKey:'synthetic-private-readiness-key'}),
  entry('search','image_search','serper',{apiKey:'synthetic-private-search-key'}),
  entry('missing','web_search','serper'),
  entry('keyless','web_search','parallel'),
  entry('disabled','chat','deepseek',{enabled:false,apiKey:'synthetic-disabled-key'}),
 ],defaults:{chat:'chat',image_search:'search'}})
 for(const user of [f.alice,f.bob,f.adminSigned]){
  const result=await config.getPublicSettings(user.token)
  assert.deepEqual(result.catalog.map(e=>[e.id,e.ready]),[['chat',true],['keyless',true],['missing',false],['search',true]])
  assert.deepEqual(result.defaults,{chat:'chat',image_search:'search'})
  assert.doesNotMatch(JSON.stringify(result),/synthetic-private|synthetic-disabled|envelope|ciphertext|baseUrl|has_key/)
 }
 await f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async connection=>{
  await connection.query("SELECT set_config('dyoffice.global_session_hash',$1,true),set_config('dyoffice.global_idle_ms',$2,true)",[tokenHash(f.alice.token),String(f.transactions.sessionIdleMs)])
  assert.equal((await connection.query('SELECT * FROM global_config_secrets')).rowCount,0)
  const readiness=await connection.query('SELECT * FROM global_config_key_readiness()')
  assert.deepEqual(readiness.rows,[{id:'chat',has_key:true},{id:'keyless',has_key:false},{id:'missing',has_key:false},{id:'search',has_key:true}])
 })
 await config.saveGlobalConfig(f.adminSigned.token,1,{upserts:[entry('chat','chat','deepseek',{clearKey:true})]})
 assert.equal((await config.getPublicSettings(f.alice.token)).catalog.find(e=>e.id==='chat').ready,false)
})

test('Custom media does not require a key, while keyed image and video providers still do',async t=>{
 const f=await restrictedFixture(t,{buildApp:false})
 const config=createGlobalConfigService({transactions:f.transactions,keyring})
 const model={model:'synthetic-model'}
 const defaults={image_generation:'custom-image',image_analysis:'custom-analysis',video_analysis:'keyed-video'}
 await config.saveGlobalConfig(f.adminSigned.token,0,{upserts:[
  entry('custom-image','image_generation','custom',model),
  entry('custom-analysis','image_analysis','custom',model),
  entry('keyed-image','image_generation','openai',model),
  entry('keyed-analysis','image_analysis','openai',model),
  entry('keyed-video','video_analysis','gemini',{...model,apiKey:'synthetic-private-video-key'}),
  entry('missing-video','video_analysis','gemini',model),
  entry('microsoft-image','image_generation','microsoft',model),
 ],defaults})
 const result=await config.getPublicSettings(f.alice.token)
 assert.deepEqual(result.defaults,defaults)
 assert.deepEqual(result.catalog.map(e=>[e.id,e.ready]),[
  ['custom-analysis',true],['custom-image',true],['keyed-analysis',false],['keyed-image',false],
  ['keyed-video',true],['microsoft-image',false],['missing-video',false],
 ])
 assert.doesNotMatch(JSON.stringify(result),/synthetic-private|envelope|baseUrl/)
 await assert.rejects(config.saveGlobalConfig(f.adminSigned.token,1,{upserts:[
  entry('custom-video','video_analysis','custom',model),
 ]}),e=>e.statusCode===400)
})

test('readiness rejects a forged token hash and an expired global session',async t=>{
 const f=await restrictedFixture(t,{buildApp:false})
 await assert.rejects(f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async connection=>{
  await connection.query("SELECT set_config('dyoffice.global_session_hash',$1,true),set_config('dyoffice.global_idle_ms',$2,true)",[tokenHash(f.bob.token),String(f.transactions.sessionIdleMs)])
  await connection.query('SELECT * FROM global_config_key_readiness()')
 }),e=>e.code==='42501')
 await assert.rejects(f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async connection=>{
  await connection.query("SELECT set_config('dyoffice.global_session_hash',$1,true),set_config('dyoffice.global_idle_ms','1',true)",[tokenHash(f.alice.token)])
  await connection.query('SELECT pg_sleep(0.01)')
  await connection.query('SELECT * FROM global_config_key_readiness()')
 }),e=>e.code==='42501')
})

test('Office embed origins default to loopback, require admin writes and expose only origins to auth runtime',async t=>{
 const f=await restrictedFixture(t,{buildApp:false})
 const config=createGlobalConfigService({transactions:f.transactions,keyring})
 const defaults=['http://localhost:3080','http://127.0.0.1:3080']
 assert.deepEqual((await config.getAdminConfig(f.adminSigned.token)).officeEmbedOrigins,defaults)
 await assert.rejects(config.saveGlobalConfig(f.alice.token,0,{officeEmbedOrigins:[]}),e=>e.statusCode===403)
 for(const origin of ['*','https://example.test/path','https://example.test; frame-ancestors *','https://user:password@example.test','javascript:alert(1)']){
  await assert.rejects(config.saveGlobalConfig(f.adminSigned.token,0,{officeEmbedOrigins:[origin]}),e=>e.statusCode===400)
 }
 const origins=[...defaults,'http://remote.example:3080']
 assert.deepEqual((await config.saveGlobalConfig(f.adminSigned.token,0,{officeEmbedOrigins:origins})).officeEmbedOrigins,origins)
 const read=async()=>(await f.authPool.query('SELECT read_office_embed_origins($1) AS origins',[f.deploymentId])).rows[0].origins
 assert.deepEqual(await read(),origins)
 await assert.rejects(f.authPool.query('SELECT * FROM global_configs'),e=>e.code==='42501')
 await assert.rejects(config.saveGlobalConfig(f.adminSigned.token,0,{officeEmbedOrigins:[]}),e=>e.statusCode===409)
 await config.saveGlobalConfig(f.adminSigned.token,1,{officeEmbedOrigins:[]})
 assert.deepEqual(await read(),[])
})
