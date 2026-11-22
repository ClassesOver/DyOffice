import test from 'node:test'
import assert from 'node:assert/strict'
import {createAssistantChannelClient} from '../../../../packages/browser-host/src/assistant-channel.ts'

const tick=()=>new Promise(resolve=>setImmediate(resolve))
const deferred=()=>{let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail});return {promise,resolve,reject}}
const task=(id,state='queued')=>({taskId:id,conversationId:'channel-1',from:'peer-1',to:'office',instruction:'Read the document',state,claimId:'claim-'+id,connectionEpoch:1})
function fixture(t,extra={}){
 const intervals=[],calls=[],executions=[],yieldRequests=[],continuations=[],continuationTokens=[],cancellations=[]
 const originalSetInterval=globalThis.setInterval,originalClearInterval=globalThis.clearInterval
 globalThis.setInterval=(callback)=>{intervals.push(callback);return intervals.length}
 globalThis.clearInterval=()=>{}
 t.after(()=>{globalThis.setInterval=originalSetInterval;globalThis.clearInterval=originalClearInterval})
 let claimFailures=[]
 let claimGate,createGate,actionGate,connectGate,refreshGate,yieldGate,cancelGate
 let next={conversationId:'channel-1',fileId:'file-1',paused:false,sequence:1,members:[],applications:[],tasks:[]}
 const request=async(path,method,body)=>{
  calls.push({path,method,body})
  if(path.endsWith('/channels')&&method==='POST'&&createGate)return createGate.promise
  if(path.endsWith('/channels')&&method==='POST')return {conversationId:next.conversationId,fileId:'file-1',paused:false}
  if(path.endsWith('/connect')&&connectGate)return connectGate.promise
  if(path.endsWith('/connect'))return {connectionEpoch:1}
  if(path.endsWith('/yield')&&yieldGate)return yieldGate.promise
  if(path.endsWith('/office-task')){const parent={...task('native-parent','running'),from:'office',instruction:body.instruction};next={...next,tasks:[...next.tasks,parent]};return parent}
  if(path.endsWith('/claim')&&claimFailures.length)throw claimFailures.shift()
  if(path.endsWith('/claim')&&claimGate)return claimGate.promise
  if(path.endsWith('/claim')){const claimed=next.tasks.find(value=>value.taskId===body.taskId);next={...next,tasks:next.tasks.map(value=>value.taskId===body.taskId?{...value,state:'running'}:value)};return {...claimed,state:'running'}}
  if(path.endsWith('/actions')){
   const action=body.action
   if(action.kind==='cancel'&&cancelGate)return cancelGate.promise
   if(action.kind==='delegate'&&actionGate)return actionGate.promise
   if(action.kind==='delegate'){const taskId='outgoing-'+calls.length;next={...next,tasks:[...next.tasks,{taskId,conversationId:body.conversationId,from:'office',to:body.to,instruction:action.instruction,state:'queued'}]};return {messageId:'message-'+calls.length,taskId}}
   if(action.kind==='result')next={...next,tasks:next.tasks.map(value=>value.taskId===action.taskId?{...value,state:action.outcome}:value)}
   return {messageId:'message-1',taskId:action.taskId}
  }
  if(method===undefined&&refreshGate){const gate=refreshGate;refreshGate=undefined;return gate.promise}
  return structuredClone(next)
 }
 const client=createAssistantChannelClient({request,fileId:'file-1',editorId:'editor-1',generation:()=>1,...extra})
 t.after(()=>client.dispose())
 return {client,calls,intervals,executions,yieldRequests,continuations,continuationTokens,cancellations,failClaims(...errors){claimFailures=errors},holdCancel(){cancelGate=deferred();return cancelGate},holdYield(){yieldGate=deferred();return yieldGate},holdRefresh(){refreshGate=deferred();return refreshGate},holdConnect(){connectGate=deferred();return connectGate},holdAction(){actionGate=deferred();return actionGate},holdClaim(){claimGate=deferred();return claimGate},holdCreate(){createGate=deferred();return createGate},setSnapshot(value){next={...next,...value}},register(execute=async()=>({text:'Findings',cancelled:false})){
  return client.control.register({isBusy:()=>false,cancelRun(token){cancellations.push(token)},requestYield(taskIds){yieldRequests.push([...taskIds])},continue(instruction,token){continuations.push(instruction);continuationTokens.push(token);return true},execute(instruction,signal){executions.push({instruction,signal});return execute(instruction,signal)}})
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

test('the listed agentId is the channel recipient, even when the harness has a different agentId',async t=>{
 const f=fixture(t)
 f.setSnapshot({members:[
  {membershipId:'peer-1',agentId:'harness-1',harnessSessionId:'session-1',displayName:'DSH',kind:'dsh',online:true,revoked:false},
  {membershipId:'revoked-peer',agentId:'harness-2',displayName:'Revoked',kind:'dsh',online:false,revoked:true},
 ]})
 f.register();await f.client.start()
 const listed=await f.client.skill.executeTool({id:'list',name:'list_channel_agents',input:{}})
 const {agents}=JSON.parse(listed.output)
 assert.deepEqual(agents,[{agentId:'peer-1',displayName:'DSH',kind:'dsh',online:true}])
 const delegated=await f.client.skill.executeTool({id:'delegate',name:'delegate_channel_task',input:{agentId:agents[0].agentId,instruction:'Return a finding'}})
 assert.equal(delegated.isError,undefined)
 assert.equal(f.calls.find(call=>call.path.endsWith('/actions')).body.to,'peer-1')
})

test('a snapshot for another document cannot replace the bound document or execute work',async t=>{
 const f=fixture(t);f.register();await f.client.start()
 f.setSnapshot({fileId:'another-file',tasks:[task('foreign-task')]})
 await f.client.refresh();await tick()
 assert.equal(f.client.snapshot().fileId,'file-1')
 assert.ok(f.client.error())
 assert.equal(f.executions.length,0)
})

test('removing the channel from realtime notifications clears the deleted channel snapshot',async t=>{
 const f=fixture(t);await f.client.start()
 const response=f.holdRefresh()
 f.client.observe([])
 response.reject(Object.assign(Error('Not found'),{status:404}))
 await tick()
 assert.equal(f.client.snapshot(),null)
 assert.equal(f.client.connected(),false)
 assert.ok(f.client.error())
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

test('a peer read that hits a model or step limit is not posted as a successful finding',async t=>{
 const f=fixture(t)
 f.setSnapshot({tasks:[task('token-limit'),task('step-limit')]})
 f.register(async()=>({text:'Partial finding',cancelled:false,...(f.executions.length===1?{truncated:true}:{turnLimit:true})}))
 await f.client.start()
 for(let n=0;n<4;n++){await tick();await f.client.refresh()}
 const receipts=f.calls.filter(call=>call.path.endsWith('/actions')&&call.body.action.kind==='result').map(call=>call.body.action)
 assert.deepEqual(receipts.map(({taskId,outcome})=>[taskId,outcome]),[['token-limit','failed'],['step-limit','failed']])
 for(const receipt of receipts){assert.match(receipt.summary,/limit/i);assert.doesNotMatch(receipt.summary,/Partial finding/)}
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

test('native run tokens attach delegation to a durable parent and settle only the matching run',async t=>{
 const f=fixture(t),agentId='peer-1'
 f.setSnapshot({members:[{membershipId:agentId,revoked:false}]});await f.client.start();f.register()
 const token=f.client.control.beginRun('Original native goal')
 const receipt=await f.client.skill.executeTool({name:'delegate_channel_task',input:{agentId,instruction:'Delegate detail'}})
 assert.notEqual(receipt.isError,true)
 const parent=f.calls.find(c=>c.path.endsWith('/office-task'))
 assert.equal(parent.body.instruction,'Original native goal')
 const delegation=f.calls.find(c=>c.path.endsWith('/actions')&&c.body.action.kind==='delegate')
 assert.equal(delegation.body.action.parentTaskId,'native-parent')
 f.client.control.endRun('wrong-token',{text:'Wrong task',cancelled:false})
 assert.equal(f.calls.some(c=>c.body?.action?.kind==='result'),false)
 f.client.control.endRun(token,{text:'',cancelled:false,yielded:{taskIds:[JSON.parse(receipt.output).taskId]}})
 await tick();await tick()
 assert.equal(f.calls.find(c=>c.path.endsWith('/yield')).body.taskId,'native-parent')
})


test('parent continuation token survives interleaved native run without completing the wrong task',async t=>{
 const f=fixture(t);f.register();await f.client.start()
 const parent={...task('parent'),from:'office',parentTaskId:null,continuation:{parentTaskId:'parent',untrusted:true,children:[]}}
 f.setSnapshot({tasks:[parent]});await f.client.refresh();await tick()
 assert.equal(f.executions.length,0)
 assert.equal(f.continuationTokens.length,1)
 const userToken=f.client.control.beginRun('Unrelated native question')
 f.client.control.endRun(f.continuationTokens[0],{text:'Wrong token',cancelled:false})
 assert.equal(f.client.control.beginRun('Try to replace active user run'),undefined)
 f.client.control.endRun(userToken,{text:'Native answer',cancelled:false});await tick()
 assert.equal(f.calls.some(c=>c.body?.action?.kind==='result'),false)
 const token=f.client.control.beginRun(f.continuations[0],f.continuationTokens[0])
 assert.ok(token)
 f.client.control.endRun(token,{text:'Parent final answer',cancelled:false});await tick();await tick()
 const result=f.calls.find(c=>c.body?.action?.kind==='result')
 assert.equal(result.body.action.taskId,'parent');assert.equal(result.body.action.summary,'Parent final answer')
})

test('paused or reset continuation token cannot launch another model run',async t=>{
 const f=fixture(t);f.register();await f.client.start()
 f.setSnapshot({tasks:[{...task('parent'),from:'office',parentTaskId:null,continuation:{parentTaskId:'parent',untrusted:true,children:[]}}]})
 await f.client.refresh();await tick()
 const token=f.continuationTokens[0]
 f.setSnapshot({paused:true,tasks:[]});await f.client.refresh()
 assert.equal(f.client.control.beginRun('Do not run',token),undefined)
 f.client.control.resetConversation()
 assert.equal(f.client.control.beginRun('Do not reuse',token),undefined)
})


test('reverse Office reads wait until parent yield receipt releases the durable run slot',async t=>{
 const f=fixture(t),agentId='peer-1';f.register()
 f.setSnapshot({members:[{membershipId:agentId,revoked:false}]});await f.client.start()
 const token=f.client.control.beginRun('Goal')
 const receipt=await f.client.skill.executeTool({name:'delegate_channel_task',input:{agentId,instruction:'Delegate'}})
 const gate=f.holdYield()
 f.client.control.endRun(token,{text:'',cancelled:false,yielded:{taskIds:[JSON.parse(receipt.output).taskId]}})
 await tick();f.setSnapshot({tasks:[task('reverse')]});await f.client.refresh();await tick()
 assert.equal(f.calls.some(c=>c.path.endsWith('/claim')),false)
 gate.resolve({state:'waiting_peer'});await tick();await tick()
 assert.equal(f.executions.length,1)
})


test('reset during parent cancellation never posts its completion into a replacement channel',async t=>{
 const f=fixture(t),agentId='peer-1';f.register();f.setSnapshot({members:[{membershipId:agentId,revoked:false}]});await f.client.start()
 const token=f.client.control.beginRun('Old goal')
 await f.client.skill.executeTool({name:'delegate_channel_task',input:{agentId,instruction:'Delegate'}})
 const gate=f.holdCancel();f.client.control.endRun(token,{text:'Stopped',cancelled:true});await tick()
 f.client.control.resetConversation();f.setSnapshot({conversationId:'channel-2',tasks:[]});await f.client.start()
 gate.resolve({messageId:'cancel-receipt'});await tick();await tick()
 assert.equal(f.calls.some(c=>c.body?.action?.kind==='result'),false)
})


for(const failure of ['cancel_requested','unauthorized'])test(`related parent native run is cancelled on ${failure} without stopping unrelated native work`,async t=>{
 const f=fixture(t);f.register();await f.client.start()
 f.setSnapshot({tasks:[{...task('parent'),from:'office',parentTaskId:null,continuation:{parentTaskId:'parent',untrusted:true,children:[]}}]})
 await f.client.refresh();await tick()
 const token=f.client.control.beginRun(f.continuations[0],f.continuationTokens[0]);assert.ok(token)
 if(failure==='cancel_requested'){f.setSnapshot({tasks:[{...task('parent','cancel_requested'),from:'office'}]});await f.client.refresh()}
 else {const gate=f.holdRefresh(),refresh=f.client.refresh();gate.reject(Object.assign(Error('Session revoked'),{status:401}));await refresh}
 assert.deepEqual(f.cancellations,[token])
 f.client.control.endRun(token,{text:'Stopped',cancelled:true});await tick();await tick()
 const unrelated=f.client.control.beginRun('Unrelated user work');assert.ok(unrelated)
 const gate=f.holdRefresh(),refresh=f.client.refresh();gate.reject(Error('Channel unavailable'));await refresh
 assert.deepEqual(f.cancellations,[token])
})


test('lost claim acknowledgement retries once with the same key and executes only once',async t=>{
 const f=fixture(t);f.failClaims(new TypeError('Connection lost'));f.setSnapshot({tasks:[task('read')]});f.register()
 await f.client.start();await tick();await tick()
 const claims=f.calls.filter(c=>c.path.endsWith('/claim'))
 assert.equal(claims.length,2);assert.equal(typeof claims[0].body.requestId,'string');assert.equal(claims[0].body.requestId,claims[1].body.requestId)
 assert.equal(f.executions.length,1)
 await f.client.refresh();await tick();assert.equal(f.executions.length,1)
})

test('two lost claim replies leave an uncertain task unexecuted rather than replaying it',async t=>{
 const f=fixture(t);f.failClaims(new TypeError('Lost'),new TypeError('Still lost'));f.setSnapshot({tasks:[task('read')]});f.register()
 await f.client.start();await tick();await f.client.refresh();await tick()
 assert.equal(f.calls.filter(c=>c.path.endsWith('/claim')).length,2);assert.equal(f.executions.length,0)
})

for(const failure of [Object.assign(Error('Denied'),{statusCode:403}),Object.assign(Error('Conflict'),{status:409}),new SyntaxError('Malformed JSON'),Error('Session binding changed')])test(`claim failure ${failure.message} is not retried`,async t=>{
 const f=fixture(t);f.failClaims(failure);f.setSnapshot({tasks:[task('read')]});f.register()
 await f.client.start();await tick();assert.equal(f.calls.filter(c=>c.path.endsWith('/claim')).length,1);assert.equal(f.executions.length,0)
})

test('reset while a claim response is failing prevents retry into the next generation',async t=>{
 const f=fixture(t),gate=f.holdClaim();f.setSnapshot({tasks:[task('old')]});f.register()
 await f.client.start();await tick();f.client.control.resetConversation();gate.reject(new TypeError('Response lost'));await tick()
 assert.equal(f.calls.filter(c=>c.path.endsWith('/claim')).length,1);assert.equal(f.executions.length,0)
})

test('paused collaboration blocks acknowledgement retry while preserving native work',async t=>{
 const f=fixture(t),gate=f.holdClaim();f.setSnapshot({tasks:[task('waiting')]});f.register()
 await f.client.start();await tick();f.setSnapshot({paused:true});await f.client.refresh()
 gate.reject(new TypeError('Response lost'));await tick()
 assert.equal(f.calls.filter(c=>c.path.endsWith('/claim')).length,1);assert.equal(f.executions.length,0)
 assert.equal(f.cancellations.length,0)
})

test('a definitive invalid claim reply is never retried or executed',async t=>{
 const f=fixture(t),gate=f.holdClaim();f.setSnapshot({tasks:[task('expected')]});f.register()
 await f.client.start();await tick();gate.resolve(task('wrong-task','running'));await tick();await tick()
 assert.equal(f.calls.filter(c=>c.path.endsWith('/claim')).length,1);assert.equal(f.executions.length,0)
})


test('explicit HTTP 503 claim failure recovers with one same-key attempt',async t=>{
 const f=fixture(t);f.failClaims(Object.assign(Error('Service unavailable'),{status:503}));f.setSnapshot({tasks:[task('read')]});f.register()
 await f.client.start();await tick();await tick()
 const claims=f.calls.filter(c=>c.path.endsWith('/claim'));assert.equal(claims.length,2);assert.equal(claims[0].body.requestId,claims[1].body.requestId);assert.equal(f.executions.length,1)
})

test('a transient refresh failure keeps the running Office task; persistent failure stops it',async t=>{
 const f=fixture(t),completion=deferred()
 f.setSnapshot({tasks:[task('task-1')]})
 f.register(()=>completion.promise)
 await f.client.start();await tick()
 const signal=f.executions[0].signal
 for(const failure of [new TypeError('Failed to fetch'),Object.assign(Error('Bad gateway'),{status:502})]){
  const gate=f.holdRefresh(),refresh=f.client.refresh();gate.reject(failure);await refresh
 }
 assert.equal(signal.aborted,false)
 assert.equal(f.client.error(),'Collaboration unavailable')
 const realNow=Date.now;t.after(()=>{Date.now=realNow})
 Date.now=()=>realNow()+26_000
 const gate=f.holdRefresh(),refresh=f.client.refresh();gate.reject(new TypeError('Failed to fetch'));await refresh
 assert.equal(signal.aborted,true)
 completion.resolve({text:'',cancelled:true});await tick();await tick()
})

test('a refresh failure followed by success clears the failure window',async t=>{
 const f=fixture(t),completion=deferred()
 f.setSnapshot({tasks:[task('task-1')]})
 f.register(()=>completion.promise)
 await f.client.start();await tick()
 const signal=f.executions[0].signal,realNow=Date.now;t.after(()=>{Date.now=realNow})
 let gate=f.holdRefresh(),refresh=f.client.refresh();gate.reject(new TypeError('Failed to fetch'));await refresh
 f.setSnapshot({tasks:[task('task-1','running')]});await f.client.refresh()
 assert.equal(f.client.error(),'')
 Date.now=()=>realNow()+26_000
 gate=f.holdRefresh();refresh=f.client.refresh();gate.reject(new TypeError('Failed to fetch'));await refresh
 assert.equal(signal.aborted,false)
 completion.resolve({text:'done',cancelled:false});await tick();await tick()
})

test('a change notified while a refresh is in flight is read by one follow-up refresh',async t=>{
 const f=fixture(t);f.register();await f.client.start();await tick()
 const reads=()=>f.calls.filter(call=>call.path.endsWith('/channels/channel-1')&&call.method===undefined).length
 const before=reads()
 const gate=f.holdRefresh(),first=f.client.refresh()
 f.setSnapshot({sequence:5})
 f.client.observe([{conversationId:'channel-1',sequence:5}])
 f.client.observe([{conversationId:'channel-1',sequence:5}])
 gate.resolve({conversationId:'channel-1',fileId:'file-1',paused:false,sequence:1,members:[],applications:[],tasks:[]})
 await first;await tick();await tick()
 assert.equal(reads(),before+2)
 assert.equal(f.client.snapshot().sequence,5)
})

const continuationTask=(id,origin)=>({...task(id),from:'office',parentTaskId:null,continuationOrigin:origin,continuation:{parentTaskId:id,untrusted:true,children:[]}})

test('a queued continuation for an older document revision is cancelled with a visible notice, not left waiting',async t=>{
 let revision='rev-2'
 const f=fixture(t,{continuationRevision:()=>revision,selectedModel:()=>'model-a'})
 f.register()
 f.setSnapshot({tasks:[continuationTask('parent',{revision:'rev-1',modelId:'model-a',callId:'call-1'})]})
 await f.client.start();await tick();await tick()
 const cancels=f.calls.filter(call=>call.body?.action?.kind==='cancel')
 assert.equal(cancels.length,1);assert.equal(cancels[0].body.action.taskId,'parent')
 assert.equal(f.calls.some(call=>call.path.endsWith('/claim')),false)
 assert.match(f.client.error(),/document changed/)
 // The notice survives the refresh that follows the cancellation.
 await f.client.refresh();await tick()
 assert.match(f.client.error(),/document changed/)
 assert.equal(f.calls.filter(call=>call.body?.action?.kind==='cancel').length,1)
})

test('a queued continuation for another model waits with a hint and resumes once the model matches',async t=>{
 let model='model-b'
 const f=fixture(t,{continuationRevision:()=>'rev-1',selectedModel:()=>model})
 f.register()
 f.setSnapshot({tasks:[continuationTask('parent',{revision:'rev-1',modelId:'model-a',callId:'call-1'})]})
 await f.client.start();await tick()
 assert.equal(f.calls.some(call=>call.body?.action?.kind==='cancel'),false)
 assert.match(f.client.error(),/Select the model/)
 model='model-a'
 await f.client.refresh();await tick();await tick()
 assert.equal(f.calls.filter(call=>call.path.endsWith('/claim')).length,1)
})

test('a queued Office task is picked up as soon as a plain native run finishes settling',async t=>{
 let busy=true
 const f=fixture(t)
 f.client.control.register({isBusy:()=>busy,cancelRun(){},requestYield(){},continue(){return true},execute(instruction,signal){f.executions.push({instruction,signal});return Promise.resolve({text:'done',cancelled:false})}})
 await f.client.start();await tick()
 const token=f.client.control.beginRun('User question')
 f.setSnapshot({tasks:[task('peer-read')]})
 await f.client.refresh();await tick()
 assert.equal(f.executions.length,0)
 busy=false
 f.client.control.endRun(token,{text:'answer',cancelled:false})
 await tick();await tick();await tick()
 assert.equal(f.executions.length,1)
})
