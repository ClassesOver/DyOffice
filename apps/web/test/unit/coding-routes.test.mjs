import {test} from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import {registerCodingRoutes} from '../../server/src/modules/coding/routes.ts'
import {createHarnessRegistry} from '../../server/src/modules/coding/registry.ts'
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
