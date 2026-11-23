import test from 'node:test'
import assert from 'node:assert/strict'
import {createAssistantBackgroundRunner} from '../../server/src/modules/assistant-channel/background-runner.ts'
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
test('shutdown waits for a pending claim and never starts work acquired after disposal',async()=>{
 const take=deferred();let abandoned=0,started=0,drained=false
 const runner=createAssistantBackgroundRunner({store:{take:()=>take.promise,abandon:async()=>{abandoned++;return true}},service:{backgroundStep:async()=>{started++;throw Error('must not start')}},objects:{},answer:async()=>{assert.fail('must not invoke model')}})
 const running=runner.runOnce()
 runner.dispose()
 const draining=runner.drain().then(()=>{drained=true})
 await new Promise(resolve=>setImmediate(resolve))
 assert.equal(drained,false)
 take.resolve({taskId:'task',conversationId:'channel',credential:'sealed',claimId:'claim',token:'token',expired:false})
 await running;await draining
 assert.equal(started,0);assert.equal(abandoned,1)
 assert.equal(await runner.runOnce(),false)
})
test('shutdown aborts an active object read and waits for task settlement',async()=>{
 const entered=deferred();let receivedSignal,settled=false,modelCalls=0
 const claim={taskId:'task',conversationId:'channel',credential:'sealed',claimId:'claim',token:'token',expired:false}
 const runner=createAssistantBackgroundRunner({store:{take:async()=>claim,abandon:async()=>true},service:{backgroundStep:async(_claim,phase)=>{
  if(phase==='finish')settled=true
  return {deadlineAt:new Date(Date.now()+60000).toISOString(),reference:{},token:'token',instruction:'read',revision:'revision'}
 }},objects:{readVerified:async(_reference,signal)=>{
  receivedSignal=signal;entered.resolve()
  return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('read aborted')),{once:true}))
 }},answer:async()=>{modelCalls++;return 'must not run'}})
 const running=runner.runOnce();await entered.promise
 runner.dispose();await runner.drain();await running
 assert.equal(receivedSignal.aborted,true);assert.equal(settled,true);assert.equal(modelCalls,0)
})
