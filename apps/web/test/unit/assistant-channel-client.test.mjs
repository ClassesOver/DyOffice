import test from 'node:test'
import assert from 'node:assert/strict'
import {createAssistantChannelClient} from '../../../../packages/browser-host/src/assistant-channel.ts'

const tick=()=>new Promise(resolve=>setImmediate(resolve))
const deferred=()=>{let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail});return {promise,resolve,reject}}
const task=(id,state='queued')=>({taskId:id,conversationId:'channel-1',from:'peer-1',to:'office',instruction:'Read the document',state,claimId:'claim-'+id,connectionEpoch:1})
function fixture(t){
 const intervals=[],calls=[],executions=[],yieldRequests=[],continuations=[]
 const originalSetInterval=globalThis.setInterval,originalClearInterval=globalThis.clearInterval
 globalThis.setInterval=(callback)=>{intervals.push(callback);return intervals.length}
 globalThis.clearInterval=()=>{}
 t.after(()=>{globalThis.setInterval=originalSetInterval;globalThis.clearInterval=originalClearInterval})
 let claimGate,createGate,actionGate,connectGate,refreshGate
 let next={conversationId:'channel-1',fileId:'file-1',paused:false,sequence:1,members:[],applications:[],tasks:[]}
 const request=async(path,method,body)=>{
  calls.push({path,method,body})
  if(path.endsWith('/channels')&&method==='POST'&&createGate)return createGate.promise
  if(path.endsWith('/channels')&&method==='POST')return {conversationId:next.conversationId,fileId:'file-1',paused:false}
  if(path.endsWith('/connect')&&connectGate)return connectGate.promise
  if(path.endsWith('/connect'))return {connectionEpoch:1}
  if(path.endsWith('/claim')&&claimGate)return claimGate.promise
  if(path.endsWith('/claim')){const claimed=next.tasks.find(value=>value.taskId===body.taskId);return {...claimed,state:'running'}}
  if(path.endsWith('/actions')){
   const action=body.action
   if(action.kind==='delegate'&&actionGate)return actionGate.promise
   if(action.kind==='delegate'){const taskId='outgoing-'+calls.length;next={...next,tasks:[...next.tasks,{taskId,conversationId:body.conversationId,from:'office',to:body.to,instruction:action.instruction,state:'queued'}]};return {messageId:'message-'+calls.length,taskId}}
   if(action.kind==='result')next={...next,tasks:next.tasks.map(value=>value.taskId===action.taskId?{...value,state:action.outcome}:value)}
   return {messageId:'message-1',taskId:action.taskId}
  }
  if(method===undefined&&refreshGate){const gate=refreshGate;refreshGate=undefined;return gate.promise}
  return structuredClone(next)
 }
 const client=createAssistantChannelClient({request,fileId:'file-1',editorId:'editor-1',generation:()=>1})
 t.after(()=>client.dispose())
 return {client,calls,intervals,executions,yieldRequests,continuations,holdRefresh(){refreshGate=deferred();return refreshGate},holdConnect(){connectGate=deferred();return connectGate},holdAction(){actionGate=deferred();return actionGate},holdClaim(){claimGate=deferred();return claimGate},holdCreate(){createGate=deferred();return createGate},setSnapshot(value){next={...next,...value}},register(execute=async()=>({text:'Findings',cancelled:false})){
  return client.control.register({isBusy:()=>false,requestYield(taskIds){yieldRequests.push([...taskIds])},continue(instruction){continuations.push(instruction);return true},execute(instruction,signal){executions.push({instruction,signal});return execute(instruction,signal)}})
 }}
}

test('an unstarted channel makes no HTTP requests and creates no scheduler',async t=>{
 const f=fixture(t)
 f.register()
 f.client.observe([{conversationId:'channel-1',sequence:9}])
 await f.client.refresh()
 await tick()
 assert.equal(f.calls.length,0)
 assert.equal(f.intervals.length,0)
})

test('a snapshot for another document cannot replace the bound document or execute work',async t=>{
 const f=fixture(t);f.register();await f.client.start()
 f.setSnapshot({fileId:'another-file',tasks:[task('foreign-task')]})
 await f.client.refresh();await tick()
 assert.equal(f.client.snapshot().fileId,'file-1')
 assert.ok(f.client.error())
 assert.equal(f.executions.length,0)
})

test('claiming a queued task executes once despite repeated notification and refresh',async t=>{
 const f=fixture(t),completion=deferred()
 f.setSnapshot({tasks:[task('task-1')]})
 f.register(()=>completion.promise)
 await f.client.start();await tick()
 for(let n=0;n<3;n++){f.client.observe([{conversationId:'channel-1',sequence:9}]);for(const pump of f.intervals)pump();await tick()}
 assert.equal(f.executions.length,1)
 completion.resolve({text:'Result',cancelled:false});await tick();await tick()
 await f.client.refresh();for(const pump of f.intervals)pump();await tick()
 assert.equal(f.executions.length,1)
 assert.equal(f.calls.filter(call=>call.path.endsWith('/claim')).length,1)
 assert.equal(f.calls.filter(call=>call.path.endsWith('/actions')&&call.body.action.kind==='result').length,1)
})

test('cancel state refresh aborts only the active scoped task',async t=>{
 const f=fixture(t),completion=deferred()
 f.setSnapshot({tasks:[task('task-1')]})
 f.register(()=>completion.promise)
 await f.client.start();await tick()
 const scopedSignal=f.executions[0].signal,nativeController=new AbortController()
 assert.equal(scopedSignal.aborted,false)
 f.setSnapshot({tasks:[task('task-1','cancel_requested'),task('task-2','queued')]})
 await f.client.refresh();await tick()
 assert.equal(scopedSignal.aborted,true)
 assert.equal(nativeController.signal.aborted,false)
 assert.equal(f.executions.length,1)
 completion.resolve({text:'',cancelled:true});await tick();await tick()
})

test('a failed peer read retains the registered executor for later work',async t=>{
 const f=fixture(t)
 f.setSnapshot({tasks:[task('failed-task')]})
 f.register(async instruction=>{if(f.executions.length===1)throw Error('Peer failure');return {text:instruction,cancelled:false}})
 await f.client.start();await tick();await tick()
 assert.equal(f.executions.length,1)
 const failure=f.calls.find(call=>call.path.endsWith('/actions')&&call.body.action.taskId==='failed-task')
 assert.equal(failure.body.action.outcome,'failed')
 f.setSnapshot({tasks:[task('failed-task','failed'),task('next-task')]})
 await f.client.refresh();await tick();await tick()
 assert.equal(f.executions.length,2)
 assert.ok(f.calls.some(call=>call.path.endsWith('/actions')&&call.body.action.taskId==='next-task'&&call.body.action.outcome==='succeeded'))
})


test('disposing while start waits prevents connection and scheduler creation',async t=>{
 const f=fixture(t),creation=f.holdCreate()
 const starting=f.client.start()
 f.client.dispose()
 creation.resolve({conversationId:'channel-1',fileId:'file-1',paused:false})
 await assert.rejects(starting,/disposed/)
 assert.equal(f.calls.some(call=>call.path.endsWith('/connect')),false)
 assert.equal(f.intervals.length,0)
})

test('a wrong-document create reply is rejected before connecting',async t=>{
 const f=fixture(t),creation=f.holdCreate()
 const starting=f.client.start()
 creation.resolve({conversationId:'other-channel',fileId:'other-file',paused:false})
 await assert.rejects(starting,/file changed/)
 assert.equal(f.client.snapshot(),null)
 assert.equal(f.calls.some(call=>call.path.endsWith('/connect')),false)
})

test('pausing while a claim is pending prevents task execution',async t=>{
 const f=fixture(t),claim=f.holdClaim()
 f.setSnapshot({tasks:[task('task-1')]});f.register()
 await f.client.start();await tick()
 f.setSnapshot({paused:true,tasks:[task('task-1','running')]})
 await f.client.refresh()
 claim.resolve(task('task-1','running'));await tick();await tick()
 assert.equal(f.executions.length,0)
})

test('a claim for a different task is never executed',async t=>{
 const f=fixture(t),claim=f.holdClaim()
 f.setSnapshot({tasks:[task('task-1')]});f.register()
 await f.client.start();await tick()
 claim.resolve(task('wrong-task','running'));await tick();await tick()
 assert.equal(f.executions.length,0)
})

test('new chat aborts its old task and never posts a late result into the new channel',async t=>{
 const f=fixture(t),completion=deferred()
 f.setSnapshot({tasks:[task('old-task')]});f.register(()=>completion.promise)
 await f.client.start();await tick()
 const signal=f.executions[0].signal
 f.client.control.resetConversation()
 assert.equal(signal.aborted,true)
 assert.equal(f.client.snapshot(),null)
 f.setSnapshot({tasks:[]})
 await f.client.start()
 completion.resolve({text:'Old findings',cancelled:false});await tick();await tick()
 assert.equal(f.calls.some(call=>call.path.endsWith('/actions')&&call.body.action.kind==='result'),false)
 assert.equal(f.client.snapshot().tasks.length,0)
})

test('Office delegates explicit data references to a peer without sending rows or widening malformed scopes',async t=>{
 const f=fixture(t),agentId='10000000-0000-4000-8000-000000000001',resultId='20000000-0000-4000-8000-000000000001'
 f.setSnapshot({members:[{membershipId:agentId,displayName:'Analyst',kind:'custom',online:true,revoked:false}]});await f.client.start()
 const dataInputs={sourceIds:['sales'],resultIds:[resultId]}
 const result=await f.client.skill.executeTool({name:'delegate_channel_task',input:{agentId,instruction:'Compute from frozen data',dataInputs}})
 assert.notEqual(result.isError,true)
 assert.deepEqual(f.calls.find(call=>call.path.endsWith('/actions')).body.action,{kind:'delegate',instruction:'Compute from frozen data',dataInputs})
 const count=f.calls.filter(call=>call.path.endsWith('/actions')).length
 const denied=await f.client.skill.executeTool({name:'delegate_channel_task',input:{agentId,instruction:'Analyze',dataInputs:{...dataInputs,rows:[{secret:1}]}}})
 assert.equal(denied.isError,true);assert.equal(f.calls.filter(call=>call.path.endsWith('/actions')).length,count)
})


test('a successful Office delegation requests a safe AgentLoop yield for its durable task',async t=>{
 const f=fixture(t),agentId='10000000-0000-4000-8000-000000000001'
 f.setSnapshot({members:[{membershipId:agentId,displayName:'Analyst',kind:'custom',online:true,revoked:false}]})
 await f.client.start();f.register()
 const receipt=await f.client.skill.executeTool({name:'delegate_channel_task',input:{agentId,instruction:'Analyze this request'}})
 assert.notEqual(receipt.isError,true)
 const taskId=JSON.parse(receipt.output).taskId
 assert.equal(typeof taskId,'string')
 assert.deepEqual(f.yieldRequests,[[taskId]])
})


test('a yielded Office run resumes once with terminal peer output',async t=>{
 const f=fixture(t),agentId='10000000-0000-4000-8000-000000000001'
 f.setSnapshot({members:[{membershipId:agentId,displayName:'Analyst',kind:'custom',online:true,revoked:false}]})
 await f.client.start();f.register()
 const receipt=await f.client.skill.executeTool({name:'delegate_channel_task',input:{agentId,instruction:'Analyze sales'}})
 const taskId=JSON.parse(receipt.output).taskId
 f.setSnapshot({tasks:[{taskId,conversationId:'channel-1',from:'office',to:agentId,instruction:'Analyze sales',state:'succeeded',summary:'Revenue rose 12%'}]})
 await f.client.refresh()
 assert.equal(f.continuations.length,0)
 f.client.control.reportYield([taskId]);await f.client.refresh();f.client.control.reportYield([taskId])
 assert.equal(f.continuations.length,1)
 assert.match(f.continuations[0],/Analyze sales/)
 assert.match(f.continuations[0],/Revenue rose 12%/)
})


test('paused collaboration holds completed continuations until resumed',async t=>{
 const f=fixture(t),agentId='peer-1'
 f.setSnapshot({members:[{membershipId:agentId,revoked:false}]});await f.client.start();f.register()
 const receipt=await f.client.skill.executeTool({name:'delegate_channel_task',input:{agentId,instruction:'Analyze'}})
 const taskId=JSON.parse(receipt.output).taskId
 f.setSnapshot({paused:true,tasks:[{taskId,state:'succeeded',instruction:'Analyze',summary:'Done'}]})
 await f.client.refresh();f.client.control.reportYield([taskId])
 assert.equal(f.continuations.length,0)
 f.setSnapshot({paused:false});await f.client.refresh()
 assert.equal(f.continuations.length,1)
})

test('new chat invalidates pending channel creation',async t=>{
 const f=fixture(t),creation=f.holdCreate(),starting=f.client.start()
 f.client.control.resetConversation()
 creation.resolve({conversationId:'channel-1',fileId:'file-1',paused:false})
 await assert.rejects(starting,/changed/)
 assert.equal(f.client.snapshot(),null)
 assert.equal(f.calls.some(call=>call.path.endsWith('/connect')),false)
})


test('late delegation acknowledgement cannot yield the new chat executor',async t=>{
 const f=fixture(t),agentId='peer-1'
 f.setSnapshot({members:[{membershipId:agentId,revoked:false}]});await f.client.start();f.register()
 const action=f.holdAction()
 const pending=f.client.skill.executeTool({name:'delegate_channel_task',input:{agentId,instruction:'Old request'}})
 f.client.control.resetConversation();f.register()
 action.resolve({messageId:'message-1',taskId:'old-child'})
 const result=await pending
 assert.equal(result.isError,true)
 assert.deepEqual(f.yieldRequests,[])
})


test('new chat invalidates pending connection without starting a scheduler',async t=>{
 const f=fixture(t),connection=f.holdConnect(),starting=f.client.start()
 await tick()
 f.client.control.resetConversation()
 connection.resolve({connectionEpoch:1})
 await assert.rejects(starting,/changed/)
 assert.equal(f.client.snapshot(),null)
 assert.equal(f.intervals.length,0)
 const connected=f.calls.find(call=>call.path.endsWith('/connect'))
 assert.ok(f.calls.some(call=>call.path.endsWith('/disconnect')&&call.body.connectionId===connected.body.connectionId))
})


for(const outcome of ['success','failure'])test(`old refresh ${outcome} cannot block or poison new chat`,async t=>{
 const f=fixture(t);await f.client.start()
 const gate=f.holdRefresh(),old=f.client.refresh()
 f.client.control.resetConversation();f.setSnapshot({conversationId:'channel-2',sequence:8})
 const starting=f.client.start();await tick()
 assert.ok(f.calls.some(call=>call.path.endsWith('/channels/channel-2')&&call.method===undefined))
 if(outcome==='failure')gate.reject(Error('old failure'));else gate.resolve({conversationId:'channel-1',fileId:'file-1',sequence:1})
 await old;await starting
 assert.equal(f.client.snapshot().sequence,8);assert.equal(f.client.error(),'')
})

test('concurrent and repeated start share one connection',async t=>{
 const f=fixture(t);await Promise.all([f.client.start(),f.client.start()]);await f.client.start()
 assert.equal(f.calls.filter(call=>call.path.endsWith('/channels')&&call.method==='POST').length,1)
 assert.equal(f.calls.filter(call=>call.path.endsWith('/connect')).length,1)
 f.client.dispose()
 assert.equal(f.calls.filter(call=>call.path.endsWith('/disconnect')).length,1)
})

test('old execution ignoring abort cannot block or clear a new conversation run',async t=>{
 const f=fixture(t),old=deferred(),newRun=deferred()
 f.setSnapshot({tasks:[task('old')]});f.register(()=>old.promise);await f.client.start();await tick()
 f.client.control.resetConversation()
 f.setSnapshot({conversationId:'channel-2',tasks:[{...task('new'),conversationId:'channel-2'}]})
 f.register(()=>newRun.promise);await f.client.start();await tick()
 assert.equal(f.executions.length,2)
 old.resolve({text:'Old',cancelled:false});await tick();await tick()
 f.setSnapshot({tasks:[{...task('new','cancel_requested'),conversationId:'channel-2'}]});await f.client.refresh()
 assert.equal(f.executions[1].signal.aborted,true)
 assert.equal(f.calls.some(call=>call.path.endsWith('/actions')&&call.body.action.taskId==='old'),false)
 newRun.resolve({text:'New',cancelled:true});await tick();await tick()
})

test('settling old refresh cannot release the new generation refresh latch',async t=>{
 const f=fixture(t);await f.client.start()
 const oldGate=f.holdRefresh(),old=f.client.refresh()
 f.client.control.resetConversation();f.setSnapshot({conversationId:'channel-2',sequence:8})
 const newGate=f.holdRefresh(),starting=f.client.start();await tick()
 oldGate.resolve({conversationId:'channel-1',fileId:'file-1',sequence:1});await old
 const also=f.client.refresh();await tick()
 assert.equal(f.calls.filter(call=>call.path.endsWith('/channels/channel-2')&&call.method===undefined).length,1)
 newGate.resolve({conversationId:'channel-2',fileId:'file-1',paused:false,sequence:8,members:[],applications:[],tasks:[]})
 await starting;await also;assert.equal(f.client.snapshot().sequence,8)
})
