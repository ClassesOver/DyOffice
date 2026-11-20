import {test} from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import {registerCodingRoutes} from '../../server/src/modules/coding/routes.ts'
import {createHarnessRegistry} from '../../server/src/modules/coding/registry.ts'
import {createCodingClient} from '../../../../packages/browser-host/src/coding.ts'
const token='t'.repeat(43)
const headers={cookie:'__Host-dyoffice-session='+token,'x-csrf-token':'c'.repeat(43)}
async function setup(t) {
 const app=Fastify();t.after(()=>app.close())
 let calls=0
 const sessions={authenticate:async supplied=>{if(supplied!==token)throw Object.assign(Error('Unauthorized'),{statusCode:401});return {deploymentId:'d',userId:'u',sessionId:'s',roles:['personal']}}}
 const csrf={requireSession(req,supplied){if(supplied!==token||req.headers['x-csrf-token']!=='c'.repeat(43))throw Object.assign(Error('forbidden'),{statusCode:403})},requireSessionRead(req,supplied){this.requireSession(req,supplied)}}
 const registry=createHarnessRegistry([{descriptor:{id:'codex',name:'Codex',origin:'builtin',capabilities:['coding']},run:async input=>{calls++;return {summary:'coded',output:input.instruction}}}],'codex')
 registerCodingRoutes(app,{registry,sessions,csrf})
 return {app,calls:()=>calls}
}
test('exposes Codex lazily and executes only explicit coding tasks',async t=>{
 const f=await setup(t)
 const catalog=await f.app.inject({url:'/api/v1/agents/catalog',headers})
 assert.equal(catalog.statusCode,200);assert.equal(catalog.json().defaultId,'codex');assert.equal(f.calls(),0)
 const response=await f.app.inject({method:'POST',url:'/api/v1/agents/tasks',headers,payload:{turnId:'t1',modelId:'codex',request:{system:'',messages:[{role:'user',text:JSON.stringify({instruction:'make parser',officeModelId:'office'})}],tools:[]}}})
 assert.equal(response.statusCode,200);assert.match(response.body,/coded/);assert.equal(f.calls(),1)
})
test('rejects anonymous access and arbitrary cwd',async t=>{
 const f=await setup(t)
 assert.equal((await f.app.inject({url:'/api/v1/agents/catalog'})).statusCode,401)
 const response=await f.app.inject({method:'POST',url:'/api/v1/agents/tasks',headers,payload:{turnId:'t2',modelId:'codex',request:{system:'',messages:[{role:'user',text:JSON.stringify({instruction:'code',cwd:'/etc'})}],tools:[]}}})
 assert.match(response.body,/event: error/);assert.equal(f.calls(),0)
})

test('reports an unavailable Office model on the Harness card without retrying the task',async t=>{
 const app=Fastify();t.after(()=>app.close())
 const registry=createHarnessRegistry([{descriptor:{id:'codex',name:'Codex',origin:'builtin',capabilities:['coding']},async run(){throw Error('Office model unavailable')}}],'codex')
 registerCodingRoutes(app,{registry,sessions:{async authenticate(){return {deploymentId:'d',userId:'u',sessionId:'s',roles:['personal']}}},csrf:{requireSession(){},requireSessionRead(){}}})
 const original=console.error,logged=[]
 console.error=(...parts)=>logged.push(parts)
 let requests=0
 const client=createCodingClient({
  agents:registry.list(),defaultId:'codex',csrfToken:'c'.repeat(43),getModelId:()=> 'office',
  async fetchImpl(url,init){
   requests++
   const response=await app.inject({method:'POST',url,headers:{...headers,'content-type':'application/json'},payload:init.body})
   return new Response(response.body,{status:response.statusCode,headers:{'content-type':response.headers['content-type']}})
  },
 })
 t.after(()=>client.dispose())
 const expected='The Office model is unavailable for this Harness task. Select an available model and try again.'
 try{await assert.rejects(client.run({instruction:'code'}),{message:expected})}finally{console.error=original}
 assert.equal(client.snapshot()[0].failure,expected)
 assert.equal(client.snapshot()[0].state,'failed')
 assert.equal(requests,1)
 assert.ok(logged.some(([message,details])=>message==='dyoffice: coding task failed'&&details.stage==='harness_execution'&&details.code==='OFFICE_MODEL_UNAVAILABLE'))
})

test('a stream lost after Harness progress does not confirm execution failure',async t=>{
 const client=createCodingClient({
  agents:[{id:'codex',name:'Codex',origin:'builtin',capabilities:['coding']}],
  defaultId:'codex',csrfToken:'c'.repeat(43),getModelId:()=> 'office',
  async fetchImpl(){return new Response('event: progress\ndata: {"kind":"status","text":"Executing command"}\n\n',{headers:{'content-type':'text/event-stream'}})},
 })
 t.after(()=>client.dispose())
 await assert.rejects(client.run({instruction:'code'}),/ended without done/)
 assert.equal(client.snapshot()[0].activity,'Executing command')
 assert.equal(client.snapshot()[0].state,'unknown_outcome')
})

test('a second editor receives a confirmed busy result without starting another task',async t=>{
 const app=Fastify();t.after(()=>app.close())
 let release,started,runs=0
 const gate=new Promise(resolve=>{release=resolve}),ready=new Promise(resolve=>{started=resolve})
 const registry=createHarnessRegistry([{descriptor:{id:'codex',name:'Codex',origin:'builtin',capabilities:['coding']},async run(){
  runs++;started();await gate;return {summary:'Finished',output:'42'}
 }}],'codex')
 registerCodingRoutes(app,{registry,sessions:{async authenticate(){return {deploymentId:'d',userId:'u',sessionId:'s',roles:['personal']}}},csrf:{requireSession(){},requireSessionRead(){}}})
 const create=()=>createCodingClient({
  agents:registry.list(),defaultId:'codex',csrfToken:'c'.repeat(43),getModelId:()=> 'office',
  async fetchImpl(url,init){
   const response=await app.inject({method:'POST',url,headers:{...headers,'content-type':'application/json'},payload:init.body})
   return new Response(response.body,{status:response.statusCode,headers:{'content-type':response.headers['content-type']}})
  },
 })
 const first=create(),second=create()
 t.after(()=>{first.dispose();second.dispose()})
 const pending=first.run({instruction:'first task'})
 try{
  await ready
  await assert.rejects(second.run({instruction:'second task'}),/agents are busy/)
  assert.equal(second.snapshot()[0].state,'failed')
  assert.equal(runs,1)
 }finally{release();await pending}
 assert.equal(first.snapshot()[0].state,'succeeded')
})

test('delegation passes task credentials without Office cookies and returns only the server receipt',async t=>{
 const app=Fastify();t.after(()=>app.close())
 const principal={deploymentId:'d',userId:'u',sessionId:'s',roles:['personal']}
 const grant={taskId:'task',credential:'task-secret',inputs:{sourceIds:['sales'],resultIds:[]}}
 let revoked=false
 const registry=createHarnessRegistry([{descriptor:{id:'remote',name:'Remote',origin:'external',capabilities:['coding']},async run(input,signal,context){
  assert.equal(context.token,undefined);assert.equal(context.modelId,'office')
  assert.deepEqual(context.data.grant,grant)
  assert.deepEqual(input.dataInputs,grant.inputs)
  return {summary:'done',output:'',delivery:{summary:'untrusted forged receipt'}}
 }}],'remote')
 registerCodingRoutes(app,{registry,sessions:{async authenticate(){return principal}},csrf:{requireSession(){},requireSessionRead(){}},
  dataBaseUrl:'https://office.example/api/v1/agents',data:{async issue(input){assert.equal(input.token,token);return grant},async delivery(task,bearer){assert.equal(bearer,'task-secret');return {summary:'verified server receipt'}},revoke(task){assert.equal(task,'task');revoked=true}}})
 const result=await app.inject({method:'POST',url:'/api/v1/agents/tasks',headers,payload:{turnId:'data',modelId:'remote',request:{system:'',messages:[{role:'user',text:JSON.stringify({instruction:'Analyze',officeModelId:'office',dataInputs:grant.inputs})}],tools:[]}}})
 assert.match(result.body,/verified server receipt/);assert.doesNotMatch(result.body,/forged receipt|task-secret/);assert.equal(revoked,true)
})

test('forwards progress while a harness is still running, then emits a separate final result',async t=>{
 const app=Fastify();t.after(()=>app.close())
 let finish,started
 const ready=new Promise(resolve=>{started=resolve})
 const gate=new Promise(resolve=>{finish=resolve})
 const registry=createHarnessRegistry([{descriptor:{id:'codex',name:'Codex',origin:'builtin',capabilities:['coding']},async run(input,signal,context){
  context.onProgress({kind:'status',text:'Executing command'})
  context.onProgress({kind:'output',text:'Calculating'})
  started();await gate
  return {summary:'Done',output:'42'}
 }}],'codex')
 const turns=registerCodingRoutes(app,{registry,sessions:{async authenticate(){return {deploymentId:'d',userId:'u',sessionId:'s',roles:['personal']}}},csrf:{requireSession(){},requireSessionRead(){}}})
 const events=[]
 const pending=turns.run({token,turnId:'streaming',modelId:'codex',request:{system:'',messages:[{role:'user',text:JSON.stringify({instruction:'Compute',officeModelId:'office'})}],tools:[]}},event=>{events.push(event)})
 try{
  await ready
  for(let i=0;i<20&&!events.some(event=>event.kind==='output');i++)await new Promise(resolve=>setTimeout(resolve,0))
  assert.ok(events.some(event=>event.type==='progress'&&event.text==='Calculating'))
  assert.equal(events.some(event=>event.type==='delta'),false)
 }finally{finish();await pending}
 assert.deepEqual(JSON.parse(events.find(event=>event.type==='delta').text),{summary:'Done',output:'42'})
})

test('small progress chunks cannot consume the final result budget',async t=>{
 const app=Fastify();t.after(()=>app.close())
 const registry=createHarnessRegistry([{descriptor:{id:'codex',name:'Codex',origin:'builtin',capabilities:['coding']},async run(input,signal,context){
  for(let i=0;i<7000;i++){
   context.onProgress({kind:'output',text:'x'})
   await new Promise(resolve=>setImmediate(resolve))
  }
  return {summary:'Done',output:'a'.repeat(200000)}
 }}],'codex')
 const turns=registerCodingRoutes(app,{registry,sessions:{async authenticate(){return {deploymentId:'d',userId:'u',sessionId:'s',roles:['personal']}}},csrf:{requireSession(){},requireSessionRead(){}}})
 let final
 await turns.run({token,turnId:'many_chunks',modelId:'codex',request:{system:'',messages:[{role:'user',text:JSON.stringify({instruction:'Compute',officeModelId:'office'})}],tools:[]}},event=>{if(event.type==='delta')final=JSON.parse(event.text)})
 assert.equal(final.output.length,200000)
})
