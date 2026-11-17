import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {Readable} from 'node:stream'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {restrictedFixture,waitForDatabaseLock} from '../helpers/restricted.mjs'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {createProviderBudgetService,grantProviderBudgetRuntime} from '../../server/src/modules/providers/budget.ts'
import {registerAdminProviderAssembly} from '../../server/src/modules/providers/assembly.ts'
import {registerProviderRoutes} from '../../server/src/modules/providers/routes.ts'
import {tokenHash} from '../../server/src/modules/auth/sessions.ts'
import {createCsrfService} from '../../server/src/modules/auth/csrf.ts'
import {createApiShell} from '../../server/src/framework.ts'
import {createSseAgentTransport} from '../../../../packages/browser-host/src/ai-transport.ts'
const pipeline=await import('../../server/src/modules/providers/admin-pipeline.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e})
const keyring={activeKeyId:'k1',keys:{k1:new Uint8Array(32).fill(71)}},syntheticKey='pipeline-synthetic-not-real'
const request={system:'Synthetic test only',messages:[{role:'user',text:'hello'}],tools:[{name:'replace_text',description:'Synthetic candidate',inputSchema:{type:'object'}}]}
const frame=value=>Buffer.from('data: '+JSON.stringify(value)+'\n\n')
const validChunks=[frame({choices:[{delta:{content:'Hello'}}]}),frame({choices:[{delta:{tool_calls:[{index:0,id:'call1',function:{name:'replace_text',arguments:'{"text":"ok"}'}}]},finish_reason:'tool_calls'}]}),frame({choices:[],usage:{prompt_tokens:3,completion_tokens:4}}),Buffer.from('data: [DONE]\n\n')]
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
function bounded(p,ms=2000){let timer;return Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("Gate timeout")),ms)})]).finally(()=>clearTimeout(timer))}
function network(t,chunks=validChunks,options){return mockProviderNetwork(t,chunks,options)}
async function fixture(t,{wrapTransactions,timeoutMs=5000}={}){
 assert.equal(typeof pipeline.createAdminProviderPipeline,'function')
 const f=await restrictedFixture(t,{businessMax:1})
 const config=createGlobalConfigService({transactions:f.transactions,keyring})
 await config.saveGlobalConfig(f.adminSigned.token,0,{upserts:[{id:'primary',kind:'chat',providerId:'openai',label:'Synthetic',model:'synthetic',baseUrl:'https://provider.example/v1',enabled:true,apiKey:syntheticKey}]})
 await grantProviderBudgetRuntime(f.ownerPool,f.names.business)
 await f.ownerPool.query("INSERT INTO provider_budget_accounts(deployment_id,owner_id,entry_id,config_revision,available_units,per_call_units) VALUES($1,$2,'primary',1,100,10)",[f.deploymentId,f.initial.id])
 const profile={deploymentId:f.deploymentId,entryId:'primary',revision:1,providerId:'openai',model:'synthetic',baseUrl:'https://provider.example/v1',endpoint:'https://provider.example/v1/chat/completions',allowedIpv4:['8.8.8.8'],maxOutputTokens:128}
 const appPipeline=pipeline.createAdminProviderPipeline({transactions:wrapTransactions?wrapTransactions(f.transactions):f.transactions,keyring,profiles:[profile],timeoutMs})
 t.after(()=>appPipeline.dispose())
 const budget=createProviderBudgetService({transactions:f.transactions}),turnId=randomUUID()
 const binding=wire=>({turnId,entryId:'primary',configRevision:1,requestDigest:createHash('sha256').update(wire).digest('hex')})
 const input={token:f.adminSigned.token,turnId,modelId:'primary',request}
 return {...f,appPipeline,budget,turnId,binding,input,profile}
}
async function idle(f){const until=Date.now()+4000;while(f.appPipeline.turns.activeCount()){if(Date.now()>until)throw Error('Pipeline did not release');await new Promise(r=>setTimeout(r,5))}}
test('single-connection real PG + scoped secret + mock pinned HTTPS + SSE parser settles exact wire digest once',async t=>{
 const n=network(t),f=await fixture(t),events=[]
 await f.appPipeline.turns.run(f.input,async e=>events.push(e));await idle(f)
 assert.equal(n.writes,1);assert.equal(n.header,'Bearer '+syntheticKey)
 assert.equal(JSON.parse(n.wire).model,'synthetic');assert.equal(JSON.parse(n.wire).max_tokens,128)
 assert.deepEqual(events.map(e=>e.type),['delta','tool_call','usage'])
 assert.deepEqual(events[1],{type:'tool_call',id:'call1',name:'replace_text',input:{text:'ok'}})
 assert.equal((await f.budget.status(f.adminSigned.token,f.binding(n.wire))).state,'settled')
 await assert.rejects(f.appPipeline.turns.run(f.input,async()=>{}));assert.equal(n.writes,1)
 assert.equal(Number((await f.ownerPool.query('SELECT available_units FROM provider_budget_accounts')).rows[0].available_units),90)
})
test('truncated upstream stays unknown and never exposes completed tool candidate or retries',async t=>{
 const n=network(t,validChunks.slice(0,2)),f=await fixture(t),events=[]
 await assert.rejects(f.appPipeline.turns.run(f.input,async e=>events.push(e)),/AI turn unavailable/);await idle(f)
 assert.equal(events.some(e=>e.type==='tool_call'),false)
 assert.equal((await f.budget.status(f.adminSigned.token,f.binding(n.wire))).state,'unknown')
 await assert.rejects(f.appPipeline.turns.run(f.input,async()=>{}));assert.equal(n.writes,1)
})
test('downstream failure cancels producer and conservatively holds unknown without leaking secret',async t=>{
 const n=network(t),f=await fixture(t)
 await assert.rejects(f.appPipeline.turns.run(f.input,async()=>{throw Error(syntheticKey)}),{message:'AI turn unavailable'});await idle(f)
 assert.equal((await f.budget.status(f.adminSigned.token,f.binding(n.wire))).state,'unknown')
})
test('ordinary members and client transport fields fail before budget or HTTPS',async t=>{
 const n=network(t),f=await fixture(t)
 await assert.rejects(f.appPipeline.turns.run({...f.input,token:f.alice.token},async()=>{}))
 await assert.rejects(f.appPipeline.turns.run({...f.input,request:{...request,baseURL:'https://evil.example/'}},async()=>{}))
 assert.equal(n.writes,0);assert.equal((await f.ownerPool.query('SELECT * FROM provider_budget_reservations')).rowCount,0)
})
test('revocation commits during stalled response with one business connection and blocks subsequent chunks',async t=>{
 let res;const n=network(t,()=>{res=new Readable({read(){}});res.push(validChunks[0]);return res}),f=await fixture(t)
 let gotDelta;const delta=new Promise(r=>gotDelta=r),events=[],work=f.appPipeline.turns.run(f.input,async e=>{events.push(e);gotDelta()});work.catch(()=>{})
 await delta
 await f.authPool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1',[f.adminSigned.sessionId])
 res.push(validChunks[1]);res.push(validChunks[2]);res.push(validChunks[3]);res.push(null)
 await assert.rejects(work);await idle(f)
 assert.equal(events.length,1);assert.equal(n.writes,1)
 assert.equal((await f.ownerPool.query('SELECT state FROM provider_budget_reservations')).rows[0].state,'unknown')
})
test('explicit cancellation closes a stalled response and retains unknown budget',async t=>{
 let res;const n=network(t,()=>{res=new Readable({read(){}});res.push(validChunks[0]);return res}),f=await fixture(t)
 let gotDelta;const delta=new Promise(r=>gotDelta=r),work=f.appPipeline.turns.run(f.input,async()=>gotDelta());work.catch(()=>{})
 await delta;assert.equal(await f.appPipeline.turns.cancel(f.adminSigned.token,f.turnId),true)
 await assert.rejects(work);await idle(f);assert.equal(res.destroyed,true)
 assert.equal((await f.budget.status(f.adminSigned.token,f.binding(n.wire))).state,'unknown')
})
test('explicit HTTP adapter plus browser SSE callbacks terminates once through the same controlled pipeline',async t=>{
 const n=network(t),f=await fixture(t),app=await createApiShell(),origin='https://office.example'
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin,key:f.csrfKey})
 registerProviderRoutes(app,{turns:f.appPipeline.turns,sessions:f.sessions,csrf});await app.ready();t.after(()=>app.close())
 let done=0,error,toolCalls=0
 const transport=createSseAgentTransport({modelId:'primary',createTurnId:()=>f.turnId,getCsrfToken:async()=>csrf.sessionToken(f.adminSigned.token),
 fetchImpl:async(url,options)=>{
  const r=await app.inject({method:options.method,url,headers:{...options.headers,cookie:'__Host-dyoffice-session='+f.adminSigned.token,origin},...(options.body?{payload:JSON.parse(options.body)}:{})})
  return new Response(r.body,{status:r.statusCode,headers:r.headers})
 }})
 await new Promise(resolve=>transport.stream(request,{onDelta(){},onToolCall(){toolCalls++},onError(e){error=e},onDone(){done++;resolve()}}))
 assert.equal(error,undefined);assert.equal(done,1);assert.equal(toolCalls,1);assert.equal(n.writes,1)
})
test('revocation before TLS authority callback prevents any credential header or body',async t=>{
 const secure=deferred(),n=network(t,validChunks,{secureGate:secure.promise}),f=await fixture(t)
 const work=f.appPipeline.turns.run(f.input,async()=>{});work.catch(()=>{})
 await bounded(n.connected)
 await f.authPool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1',[f.adminSigned.sessionId])
 secure.resolve();await assert.rejects(work);await idle(f)
 assert.equal(n.writes,0);assert.equal(n.header,undefined)
 assert.ok(['dispatching','unknown'].includes((await f.ownerPool.query('SELECT state FROM provider_budget_reservations')).rows[0].state))
 assert.equal(Number((await f.ownerPool.query('SELECT available_units FROM provider_budget_accounts')).rows[0].available_units),90)
})
test('short flush transaction serializes revoke only until cancellation, then releases locks',async t=>{
 const finish=deferred(),n=network(t,validChunks,{finishGate:finish.promise}),f=await fixture(t),control=new AbortController()
 const work=f.appPipeline.turns.run({...f.input,signal:control.signal},async()=>{});work.catch(()=>{})
 await bounded(n.sent)
 const revoked=f.authPool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1',[f.adminSigned.sessionId])
 await waitForDatabaseLock(f,'auth');control.abort()
 await assert.rejects(work);await idle(f);await bounded(revoked);finish.resolve()
 assert.equal(n.writes,1);assert.equal((await f.ownerPool.query('SELECT state FROM provider_budget_reservations')).rows[0].state,'unknown')
})
test('already-accepted event may deliver across a revoke, but no subsequent event is accepted',async t=>{
 const accepted=deferred(),deliver=deferred();let permitChecks=0
 const n=network(t),f=await fixture(t,{wrapTransactions:real=>({...real,withPrincipalTransaction:async(input,operation)=>{
  const result=await real.withPrincipalTransaction(input,operation)
  // authorize, pre-stream revalidate, pre-connect, chunk, then event acceptance.
  if(result?.profile&&result?.identity&&++permitChecks===5){accepted.resolve();await deliver.promise}
  return result
 }})}),events=[]
 const work=f.appPipeline.turns.run(f.input,async e=>events.push(e));work.catch(()=>{})
 try{
  await bounded(accepted.promise)
  await f.authPool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1',[f.adminSigned.sessionId])
  deliver.resolve();await assert.rejects(work);await idle(f)
  assert.equal(events.length,1);assert.equal(events[0].type,'delta');assert.equal(n.writes,1)
 }finally{deliver.resolve();await Promise.allSettled([work])}
})
test('upstream secret-bearing error produces one generic SSE error/done and no console or audit key',async t=>{
 const logs=[];for(const method of ['log','warn','error'])t.mock.method(console,method,(...args)=>logs.push(args))
 const n=network(t,validChunks,{upstreamError:syntheticKey}),f=await fixture(t),app=await createApiShell(),origin='https://office.example'
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin,key:f.csrfKey})
 registerProviderRoutes(app,{turns:f.appPipeline.turns,sessions:f.sessions,csrf});await app.ready();t.after(()=>app.close())
 const result=await app.inject({method:'POST',url:'/api/v1/ai/turns',headers:{cookie:'__Host-dyoffice-session='+f.adminSigned.token,origin,'x-csrf-token':csrf.sessionToken(f.adminSigned.token)},payload:{turnId:f.turnId,modelId:'primary',request}})
 assert.equal((result.body.match(/event: error/g)||[]).length,1)
 assert.equal((result.body.match(/event: done/g)||[]).length,1)
 assert.equal(result.body.includes(syntheticKey),false);assert.equal(JSON.stringify(logs).includes(syntheticKey),false)
 const c=await f.ownerPool.connect();let audit
 try{
  await c.query('BEGIN')
  await c.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true),set_config('dyoffice.session_id',$3,true),set_config('dyoffice.global_session_hash',$4,true),set_config('dyoffice.global_idle_ms',$5,true)",[f.deploymentId,f.initial.id,f.adminSigned.sessionId,tokenHash(f.adminSigned.token),String(f.transactions.sessionIdleMs)])
  audit=(await c.query('SELECT * FROM global_config_audit')).rows
 }finally{await c.query('ROLLBACK');c.release()}
 assert.ok(audit.length);assert.equal(JSON.stringify(audit).includes(syntheticKey),false)
 await idle(f);assert.equal(n.writes,1)
 assert.equal((await f.budget.status(f.adminSigned.token,f.binding(n.wire))).state,'unknown')
})

test('real app.close ends active synthetic provider stream and holds committed budget unknown',async t=>{
 let response
 const n=network(t,()=>{response=new Readable({read(){}});response.push(validChunks[0]);return response})
 const f=await fixture(t), app=await createApiShell()
 registerAdminProviderAssembly(app,{enabled:true,transactions:f.transactions,keyring,profiles:[f.profile],timeoutMs:5000,
  sessions:{authenticate:async()=>{}},csrf:{requireSession(){}}})
 const result=app.inject({method:'POST',url:'/api/v1/ai/turns',headers:{cookie:'__Host-dyoffice-session='+f.adminSigned.token},payload:{turnId:f.turnId,modelId:'primary',request}}).then(r=>r)
 await bounded(n.sent)
 try {
  await bounded(Promise.all([app.close(),result]),1000)
  const r=await result
  assert.equal((r.body.match(/event: done/g)||[]).length,1)
  assert.equal(n.writes,1)
  assert.equal(response.destroyed,true)
  // Cleanup settlement is asynchronous after downstream ends. Wait explicitly,
  // without implying that app.close cancelled or rolled back the DB transaction.
  const until=Date.now()+2000
  while((await f.ownerPool.query('SELECT state FROM provider_budget_reservations')).rows[0]?.state!=='unknown'){
   if(Date.now()>until)throw Error('Unknown settlement not observed')
   await new Promise(r=>setTimeout(r,5))
  }
 } finally {response?.destroy();await app.close()}
})
for(const failure of [false,true])test(`drain ${failure?'reports failed':'waits for delayed'} unknown settlement before resource close`,async t=>{
 const {createProviderShutdown}=await import('../../server/src/modules/providers/shutdown.ts')
 const held=deferred(),release=deferred(),delta=deferred();let closed=0
 const n=network(t,()=>{const res=new Readable({read(){}});res.push(validChunks[0]);return res})
 const f=await fixture(t,{wrapTransactions:base=>({...base,withPrincipalTransaction:(input,fn)=>base.withPrincipalTransaction(input,(client,p)=>fn(new Proxy(client,{get(target,key){
  if(key==='query')return async(sql,params)=>{
   if(String(sql).includes('provider_budget_action')&&params?.[0]==='unknown'){
    held.resolve();await release.promise;if(failure)throw Error('synthetic settlement failure')
   }
   return target.query(sql,params)
  }
  const value=target[key];return typeof value==='function'?value.bind(target):value
 }}),p))})})
 const work=f.appPipeline.turns.run(f.input,async()=>delta.resolve());void work.catch(()=>{})
 await bounded(delta.promise)
 const shutdown=createProviderShutdown({pipeline:f.appPipeline,timeoutMs:1000,closeResources:async()=>{
  assert.equal((await f.ownerPool.query('SELECT state FROM provider_budget_reservations')).rows[0].state,'unknown')
  await f.businessPool.end();closed++
 }})
 const closing=shutdown();void closing.catch(()=>{})
 try{
  await bounded(held.promise);await assert.rejects(work)
  assert.equal(closed,0);await assert.rejects(f.appPipeline.drain({timeoutMs:20}),/drain/)
  await assert.rejects(f.appPipeline.turns.run({...f.input,turnId:randomUUID()},async()=>{}));assert.equal(n.writes,1)
  release.resolve()
  if(failure){await assert.rejects(closing,/drain/);assert.equal(closed,0);await assert.rejects(f.appPipeline.drain({timeoutMs:100}),/drain/)}
  else{await closing;assert.equal(closed,1);await shutdown();assert.equal(closed,1)}
 }finally{release.resolve();await closing.catch(()=>{})}
})
test('ambiguous committed reservation response cannot report clean drain or close resources',async t=>{
 const {createProviderShutdown}=await import('../../server/src/modules/providers/shutdown.ts')
 let ambiguous=true,closed=0
 const n=network(t),f=await fixture(t,{wrapTransactions:base=>({...base,async withPrincipalTransaction(input,fn){
  let reserve=false
  const result=await base.withPrincipalTransaction(input,(client,p)=>fn(new Proxy(client,{get(target,key){
   if(key==='query')return async(sql,params)=>{if(String(sql).includes('provider_budget_action')&&params?.[0]==='reserve')reserve=true;return target.query(sql,params)}
   const value=target[key];return typeof value==='function'?value.bind(target):value
  }}),p))
  if(reserve&&ambiguous){ambiguous=false;throw Error('synthetic lost commit response')}
  return result
 }})})
 await assert.rejects(f.appPipeline.turns.run(f.input,async()=>{}));assert.equal(n.writes,0)
 assert.equal((await f.ownerPool.query('SELECT state FROM provider_budget_reservations')).rows[0].state,'reserved')
 const shutdown=createProviderShutdown({pipeline:f.appPipeline,timeoutMs:100,closeResources:async()=>{closed++}})
 await assert.rejects(shutdown(),/drain/);assert.equal(closed,0)
 assert.equal((await f.ownerPool.query('SELECT state FROM provider_budget_reservations')).rows[0].state,'reserved')
})
async function wiredApp(f,options={}){
 const {buildLocalApp}=await import('../../server/src/app.ts')
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin:'https://office.example',csrfKey:f.csrfKey,globalConfigKeyring:keyring,adminAiSyntheticProbe:true,adminProviderProbe:{profiles:[f.profile]},...options})
 f.cleanup.push(()=>app.close().catch(()=>{}))
 return app
}
function probeHeaders(f){const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:'https://office.example',key:f.csrfKey});return {cookie:'__Host-dyoffice-session='+f.adminSigned.token,origin:'https://office.example','x-csrf-token':csrf.sessionToken(f.adminSigned.token)}}
test('actual default-off fixed probe accepts only synthetic scenario and never mounts generic AI',async t=>{
 const n=network(t),f=await fixture(t),app=await wiredApp(f)
 const h=probeHeaders(f),url='/api/v1/admin/ai-probe/turns',payload={turnId:f.turnId,modelId:'primary',scenario:'hello'}
 assert.equal((await f.app.inject({method:'POST',url,headers:h,payload})).statusCode,501)
 for(const extra of [{request},{apiKey:'synthetic'},{endpoint:'https://evil.example'}])assert.equal((await app.inject({method:'POST',url,headers:h,payload:{...payload,...extra}})).statusCode,400)
 assert.equal((await app.inject({method:'POST',url:'/api/v1/ai/turns',headers:h,payload:{}})).statusCode,501)
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:'https://office.example',key:f.csrfKey})
 const member={...h,cookie:'__Host-dyoffice-session='+f.alice.token,'x-csrf-token':csrf.sessionToken(f.alice.token)}
 assert.equal((await app.inject({method:'POST',url,headers:member,payload})).statusCode,403)
 assert.equal(n.writes,0)
 const r=await app.inject({method:'POST',url,headers:h,payload})
 assert.equal(r.statusCode,200);assert.equal(n.writes,1)
 const body=JSON.parse(n.wire);assert.deepEqual(body.tools,undefined);assert.equal(body.messages.at(-1).content,'Synthetic hello probe.')
 // Mock tool output must remain rejected, never executed by the probe route.
 assert.match(r.body,/event: error/)
})
for(const timeout of [false,true])test(`actual loopback app close ${timeout?'times out without pool close':'drains unknown before pool close'}`,async t=>{
 const {request:httpRequest}=await import('node:http')
 const n=network(t,()=>{const res=new Readable({read(){}});res.push(validChunks[0]);return res}),f=await fixture(t)
 let closed=0
 const app=await wiredApp(f,{providerShutdownTimeoutMs:timeout?50:2000,closeDb:async()=>{
  assert.equal((await f.ownerPool.query('SELECT state FROM provider_budget_reservations')).rows[0].state,'unknown')
  await f.businessPool.end();closed++
 }})
 const address=await app.listen({host:'127.0.0.1',port:0}),delta=deferred()
 const response=new Promise((resolve,reject)=>{
  const req=httpRequest(address+'/api/v1/admin/ai-probe/turns',{method:'POST',agent:false,headers:{...probeHeaders(f),'content-type':'application/json'}},res=>{
   let body='';res.on('data',c=>{body+=c;if(body.includes('event: delta'))delta.resolve()});res.on('end',()=>resolve(body));res.on('error',reject)
  });req.on('error',reject);req.end(JSON.stringify({turnId:f.turnId,modelId:'primary',scenario:'hello'}))
 })
 await bounded(delta.promise)
 const lock=await f.ownerPool.connect();await lock.query('BEGIN');await lock.query('SELECT * FROM provider_budget_reservations FOR UPDATE')
 const closing=Promise.all([app.close(),app.close()]);void closing.catch(()=>{})
 try{
  if(timeout){await assert.rejects(bounded(closing),/drain/);assert.equal(closed,0)}
  else{await new Promise(r=>setTimeout(r,60));assert.equal(closed,0)}
  await lock.query('ROLLBACK');lock.release()
  if(!timeout){await bounded(closing);assert.equal(closed,1);await app.close();assert.equal(closed,1)}
  else{
   const until=Date.now()+2000
   while((await f.ownerPool.query('SELECT state FROM provider_budget_reservations')).rows[0].state!=='unknown'){
    if(Date.now()>until)throw Error('late unknown missing');await new Promise(r=>setTimeout(r,5))
   }
   assert.equal(closed,0)
  }
  assert.equal(n.writes,1);assert.equal((String(await response).match(/event: done/g)||[]).length,1)
 }catch(e){try{await lock.query('ROLLBACK');lock.release()}catch{};throw e}
})

test('actual fixed probe completes a tool-free mocked provider response',async t=>{
 const n=network(t,[validChunks[0],frame({choices:[{delta:{},finish_reason:'stop'}]}),validChunks[2],validChunks[3]]),f=await fixture(t),app=await wiredApp(f)
 const r=await app.inject({method:'POST',url:'/api/v1/admin/ai-probe/turns',headers:probeHeaders(f),payload:{turnId:f.turnId,modelId:'primary',scenario:'hello'}})
 assert.equal(r.statusCode,200);assert.doesNotMatch(r.body,/event: error/);assert.match(r.body,/event: delta/)
 assert.equal((r.body.match(/event: done/g)||[]).length,1);assert.equal(n.writes,1)
})
test('actual app rejects malformed provider admission and shutdown deadline',async t=>{
 const {buildLocalApp}=await import('../../server/src/app.ts'),f=await fixture(t)
 const base={db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin:'https://office.example',csrfKey:f.csrfKey,globalConfigKeyring:keyring}
 for(const value of [null,false,{}, {profiles:[]},{profiles:[{...f.profile,deploymentId:'other'}]}, {profiles:[f.profile],enabled:true}])await assert.rejects(buildLocalApp({...base,adminProviderProbe:value}),/probe/)
 await assert.rejects(buildLocalApp({...base,globalConfigKeyring:undefined,adminProviderProbe:{profiles:[f.profile]}}),/probe/)
 for(const value of [0,35001,'50',NaN])await assert.rejects(buildLocalApp({...base,providerShutdownTimeoutMs:value}),/timeout/)
})
