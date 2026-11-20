import {test} from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import {registerCodingRoutes} from '../../server/src/modules/coding/routes.ts'
import {createHarnessRegistry} from '../../server/src/modules/coding/registry.ts'
import {registerProviderRoutes} from '../../server/src/modules/providers/routes.ts'
import {createProviderTurns} from '../../server/src/modules/providers/turns.ts'

const token='a'.repeat(43),otherSession='b'.repeat(43),otherUser='c'.repeat(43)
const fileId='10000000-0000-4000-8000-000000000001',otherFile='10000000-0000-4000-8000-000000000002'
const request={system:'',messages:[{role:'user',text:JSON.stringify({instruction:'Compute',officeModelId:'office'})}],tools:[]}
function headers(session=token){return {'cookie':'__Host-dyoffice-session='+session,'content-type':'application/json','x-csrf-token':'z'.repeat(43)}}

test('a document Harness task survives observer disconnect and is recoverable only in its document and session',{timeout:10000},async t=>{
 const app=Fastify();t.after(()=>app.close())
 let runs=0,release,allowed=true
 const gate=new Promise(resolve=>{release=resolve})
 t.after(release)
 const registry=createHarnessRegistry([{descriptor:{id:'codex',name:'Codex',origin:'builtin',capabilities:['coding']},async run(_input,signal,context){
  runs++
  context.onProgress({kind:'status',text:'Computing'})
  await gate
  signal.throwIfAborted()
  return {summary:'Done',output:'42'}
 }}],'codex')
 registerCodingRoutes(app,{registry,sessions:{async authenticate(session){
  return {deploymentId:'deployment',userId:session===otherUser?'other':'owner',sessionId:session,roles:['personal']}
 }},csrf:{
  requireSession(req){assert.equal(req.method,'POST');assert.equal(req.headers['x-csrf-token'],'z'.repeat(43))},
  requireSessionRead(req){assert.equal(req.method,'GET');assert.equal(req.headers['x-csrf-token'],'z'.repeat(43))},
 },
 async authorizeDocument(){if(!allowed)throw Object.assign(Error('Not found'),{statusCode:404})}})
 const origin=await app.listen({port:0,host:'127.0.0.1'})
 const body={turnId:'recovery-test',modelId:'codex',documentId:fileId,request}
 const controller=new AbortController()
 const response=await fetch(origin+'/api/v1/agents/tasks',{method:'POST',headers:headers(),body:JSON.stringify(body),signal:controller.signal})
 assert.equal(response.status,200)
 const reader=response.body.getReader(),decoder=new TextDecoder()
 let frames=''
 while(!frames.includes('Computing')){
  const frame=await reader.read()
  assert.equal(frame.done,false)
  frames+=decoder.decode(frame.value,{stream:true})
 }
 controller.abort()
 const status=(id=fileId,session=token)=>app.inject({url:'/api/v1/agents/tasks/recovery-test/status?documentId='+id,headers:headers(session)})
 const running=await status()
 assert.equal(running.statusCode,200)
 assert.equal(running.json().state,'running')
 assert.equal(running.json().activity,'Computing')
 for(const unrelated of [await status(otherFile),await status(fileId,otherSession),await status(fileId,otherUser)])assert.equal(unrelated.statusCode,404)
 allowed=false
 assert.equal((await status()).statusCode,404)
 allowed=true
 const duplicate=await app.inject({method:'POST',url:'/api/v1/agents/tasks',headers:headers(),payload:body})
 assert.doesNotMatch(duplicate.body,/Done/)
 assert.equal(runs,1)
 release()
 let finished
 for(let i=0;i<50;i++){
  finished=(await status()).json()
  if(finished.state!=='running')break
  await new Promise(resolve=>setTimeout(resolve,10))
 }
 assert.equal(finished.state,'succeeded')
 assert.deepEqual(finished.result,{summary:'Done',output:'42'})
 assert.equal(runs,1)
})

test('explicit cancellation still signals a recoverable task on the server',{timeout:10000},async t=>{
 const app=Fastify();t.after(()=>app.close())
 let started,cancelled
 const ready=new Promise(resolve=>{started=resolve}),stopped=new Promise(resolve=>{cancelled=resolve})
 const registry=createHarnessRegistry([{descriptor:{id:'codex',name:'Codex',origin:'builtin',capabilities:['coding']},async run(_,signal){
  return new Promise((_,reject)=>{
   signal.addEventListener('abort',()=>{cancelled();reject(signal.reason)},{once:true})
   started()
  })
 }}],'codex')
 registerCodingRoutes(app,{registry,sessions:{async authenticate(session){return {deploymentId:'d',userId:'u',sessionId:session,roles:['personal']}}},csrf:{requireSession(){},requireSessionRead(){}},authorizeDocument:async()=>{}})
 const pending=app.inject({method:'POST',url:'/api/v1/agents/tasks',headers:headers(),payload:{turnId:'cancel-test',modelId:'codex',documentId:fileId,request}})
 await ready
 const cancel=session=>app.inject({method:'POST',url:'/api/v1/agents/tasks/cancel-test/cancel',headers:{cookie:'__Host-dyoffice-session='+session}})
 const status=()=>app.inject({url:'/api/v1/agents/tasks/cancel-test/status?documentId='+fileId,headers:headers()})
 assert.equal((await cancel(otherSession)).statusCode,204)
 assert.equal((await status()).json().state,'running')
 assert.equal((await cancel(token)).statusCode,204)
 await stopped
 assert.match((await pending).body,/Harness cancellation requested/)
 assert.equal((await status()).json().state,'unknown_outcome')
})

test('a Harness checkpoint survives a lost read but only one original model request can continue it',async t=>{
 const app=Fastify();t.after(()=>app.close())
 const revision='10000000-0000-4000-8000-000000000003',newRevision='10000000-0000-4000-8000-000000000004'
 let current=revision,runs=0,allowed=true
 const registry=createHarnessRegistry([{descriptor:{id:'codex',name:'Codex',origin:'builtin',capabilities:['coding']},async run(){runs++;return {summary:'Done',output:'42'}}}],'codex')
 const sessions={async authenticate(session){return {deploymentId:'d',userId:session===otherUser?'other':'u',sessionId:session,roles:['personal']}}}
 const csrf={requireSession(req){assert.equal(req.headers['x-csrf-token'],'z'.repeat(43))},requireSessionRead(){}}
 const {admitContinuation}=registerCodingRoutes(app,{registry,sessions,csrf,async authorizeDocument(){if(!allowed)throw Object.assign(Error('Not found'),{statusCode:404});return {file:{revision:current}}}})
 let modelRuns=0,busySlots=0,releaseCapacity,occupying
 const blocker=new Promise(resolve=>{releaseCapacity=resolve}),occupied=new Promise(resolve=>{occupying=resolve})
 t.after(releaseCapacity)
 const turns=createProviderTurns({identity:sessions.authenticate,async authorize(session){return {identity:await sessions.authenticate(session),revision:'model-revision'}},async revalidate(){},
  async *stream(_permit,_request,_signal,{turnId}){
   if(turnId.startsWith('occupy')){if(++busySlots===2)occupying();await blocker;return}
   modelRuns++;yield {type:'delta',text:'Resumed'}
  }},{maxActive:2})
 registerProviderRoutes(app,{sessions,csrf,admitContinuation,turns})
 const checkpoint={userIndex:0,turns:0,executedCalls:[],messages:[{role:'user',text:'Private original Office request'},{role:'assistant',text:'',toolCalls:[{id:'delegate',name:'delegate_agent_task',input:{instruction:'Compute'}}]}]}
 const path='/api/v1/agents/tasks',submit=(turnId,patch={})=>app.inject({method:'POST',url:path,headers:headers(),payload:{turnId,modelId:'codex',documentId:fileId,request,continuation:{revision,checkpoint},...patch}})
 const claim=(turnId,patch={},session=token)=>app.inject({method:'POST',url:path+'/'+turnId+'/continuation',headers:headers(session),payload:{documentId:fileId,revision,modelId:'office',defer:true,...patch}})
 const status=turnId=>app.inject({url:path+'/'+turnId+'/status?documentId='+fileId,headers:headers()})
 assert.match((await submit('checkpoint')).body,/event: delta/)
 const statusBefore=await status('checkpoint')
 assert.equal(statusBefore.json().hasContinuation,true)
 assert.doesNotMatch(statusBefore.body,/Private original Office request|"checkpoint"\s*:/)
 assert.equal((await claim('checkpoint',{},otherSession)).statusCode,404)
 assert.equal((await claim('checkpoint',{},otherUser)).statusCode,404)
 assert.equal((await claim('checkpoint',{documentId:otherFile})).statusCode,404)
 assert.equal((await claim('checkpoint',{modelId:'other-model'})).statusCode,409)
 allowed=false
 assert.equal((await claim('checkpoint')).statusCode,404)
 allowed=true
 assert.equal((await claim('checkpoint')).statusCode,200)
 const winning=await claim('checkpoint')
 assert.equal(winning.headers['cache-control'],'private, no-store')
 assert.deepEqual(winning.json(),{checkpoint, result:{id:'delegate',name:'delegate_agent_task',output:JSON.stringify({summary:'Done',output:'42'})}})
 assert.equal((await status('checkpoint')).json().hasContinuation,true)
 const model=(turnId,patch={},session=token)=>app.inject({method:'POST',url:'/api/v1/ai/turns',headers:headers(session),payload:{turnId,modelId:'office',request:{system:'',messages:[...checkpoint.messages,{role:'tool',results:[winning.json().result]}],tools:[]},harnessResume:{taskId:'checkpoint',documentId:fileId,revision},...patch}})
 assert.equal((await model('wrong-session',{},otherSession)).statusCode,404)
 assert.equal((await model('wrong-model',{modelId:'other-model'})).statusCode,409)
 assert.equal((await model('no-result',{request})).statusCode,409)
 const occupy1=model('occupy',{harnessResume:undefined}),occupy2=model('occupy2',{harnessResume:undefined})
 await occupied
 try{
  assert.equal((await model('capacity-rejected')).statusCode,503)
  assert.equal((await status('checkpoint')).json().hasContinuation,true)
 }finally{releaseCapacity()}
 await Promise.all([occupy1,occupy2])
 const responses=await Promise.all([model('resume-1'),model('resume-2')])
 assert.deepEqual(responses.map(response=>response.statusCode).sort(),[200,409])
 assert.equal(modelRuns,1)
 assert.equal((await claim('checkpoint')).statusCode,409)
 assert.equal((await status('checkpoint')).json().hasContinuation,false)
 assert.equal(runs,1)
 assert.match((await submit('stale')).body,/event: delta/)
 assert.equal((await claim('stale')).statusCode,200)
 current=newRevision
 assert.equal((await model('stale-resume',{harnessResume:{taskId:'stale',documentId:fileId,revision}})).statusCode,409)
 assert.equal(modelRuns,1)
 assert.equal((await claim('stale')).statusCode,409)
 assert.equal((await status('stale')).json().hasContinuation,false)
 assert.match((await submit('stale-admission')).body,/event: error/)
 current=revision
 const different=structuredClone(checkpoint)
 different.messages.at(-1).toolCalls[0].input.instruction='Unrelated instruction'
 assert.match((await submit('different-call',{continuation:{revision,checkpoint:different}})).body,/event: error/)
 assert.match((await submit('unbound',{documentId:undefined})).body,/event: error/)
 assert.equal(runs,2)
 assert.match((await submit('legacy')).body,/event: delta/)
 assert.equal((await claim('legacy',{defer:undefined})).statusCode,200)
 assert.equal((await claim('legacy',{defer:undefined})).statusCode,409)
})
