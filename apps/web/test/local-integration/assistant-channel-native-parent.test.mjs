import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import Fastify from 'fastify'
import {fileFixture,docxBytes,importFile} from '../helpers/files.mjs'
import {restrictedOrigin} from '../helpers/restricted.mjs'
import {createCsrfService} from '../../server/src/modules/auth/csrf.ts'
import {createAssistantChannelService} from '../../server/src/modules/assistant-channel/service.ts'
import {registerAssistantChannelRoutes} from '../../server/src/modules/assistant-channel/routes.ts'
import {createAssistantChannelClient} from '../../../../packages/browser-host/src/assistant-channel.ts'
import {AgentLoop} from '../../../../packages/agent-core/src/loop.ts'
const wait=async(fn,predicate)=>{for(let i=0;i<100;i++){const value=await fn();if(predicate(value))return value;await new Promise(r=>setTimeout(r,20))}assert.fail('Durable state not reached')}

test('real native AgentLoop yields durable Office parent, handles reverse read, and resumes with correlated token',async t=>{
 const f=await fileFixture(t),file=(await importFile(f,f.alice.token,await docxBytes())).file
 const service=createAssistantChannelService({transactions:f.transactions,credentialKey:f.csrfKey})
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey})
 const api=Fastify();registerAssistantChannelRoutes(api,service,csrf);t.after(()=>api.close())
 let parentClaimLost=false;const recoveredParentKeys=[]
 const request=async(url,method='GET',payload)=>{
  const reply=await api.inject({url,method,payload,headers:{origin:restrictedOrigin,cookie:'__Host-dyoffice-session='+f.alice.token,'x-csrf-token':csrf.sessionToken(f.alice.token)}})
  if(reply.statusCode!==200)throw Object.assign(Error('HTTP '+reply.statusCode),{statusCode:reply.statusCode})
  const value=reply.json()
  if(url.endsWith('/claim')&&value.from==='office'&&value.continuation){
   if(recoveredParentKeys.length<2)recoveredParentKeys.push({requestId:payload.requestId,claimId:value.claimId})
   if(!parentClaimLost){parentClaimLost=true;throw new TypeError('Parent claim response lost after commit')}
  }
  return value
 }
 const browser=createAssistantChannelClient({request,fileId:file.fileId,editorId:randomUUID(),generation:()=>1});t.after(()=>browser.dispose())
 await browser.start();const id=browser.snapshot().conversationId,owner={kind:'owner',token:f.alice.token}
 const invitation=await service.invite(f.alice.token,id),application=await service.apply(invitation.inviteToken,{displayName:'Deterministic peer',kind:'fixture'})
 await service.approve(f.alice.token,id,application.applicationId,{approved:true})
 const member=await service.redeem(application.applicationToken),credential={kind:'member',token:member.memberToken},connectionId=randomUUID()
 const mc=await service.connect(credential,id,{connectionId});await browser.refresh()
 let token,phase='delegate',scopedReads=0,modelCalls=0,nativeCancellations=0
 const continuations=[]
 const loop=new AgentLoop({allowDelegationYield:true,skill:browser.skill,transport:{stream(_input,callbacks){
  modelCalls++;if(phase!=='hold')queueMicrotask(()=>{if(phase==='delegate'||phase==='redelegate')callbacks.onToolCall({id:'delegate-1',name:'delegate_channel_task',input:{agentId:member.member.membershipId,instruction:'Analyze current paragraph'}});else callbacks.onDelta(phase==='native'?'Independent user answer':'Final verified answer');callbacks.onDone()});return {cancel(){nativeCancellations++;callbacks.onDone()}}
 }},events:{onDone(result){const finished=token;token=undefined;if(finished)browser.control.endRun(finished,result)},onError:assert.fail}})
 browser.control.register({isBusy:()=>loop.busy,cancelRun(runToken){if(runToken===token)loop.cancel()},requestYield:ids=>loop.requestYield(ids),continue(instruction,continuationToken){continuations.push({instruction,continuationToken});return true},async execute(){scopedReads++;return {text:'Paragraph revenue is 42',cancelled:false}}})
 token=browser.control.beginRun('Original Office analysis goal');loop.run('Original Office analysis goal')
 const waiting=await wait(()=>service.snapshot(f.alice.token,id),s=>s.tasks.some(t=>t.from==='office'&&t.to==='office'&&t.state==='waiting_peer'))
 const parent=waiting.tasks.find(t=>t.from==='office'&&t.to==='office'),child=waiting.tasks.find(t=>t.parentTaskId===parent.taskId)
 assert.equal(loop.busy,false);assert.equal(parent.instruction,'Original Office analysis goal')
 const claimed=await service.claim(credential,id,{taskId:child.taskId,connectionId,...mc})
 const question=await service.submit(credential,{requestId:randomUUID(),conversationId:id,to:'office',action:{kind:'delegate',instruction:'Read paragraph',parentTaskId:child.taskId}})
 await browser.refresh()
 await wait(()=>service.snapshot(f.alice.token,id),s=>s.tasks.some(t=>t.taskId===question.taskId&&t.state==='succeeded'))
 assert.equal(scopedReads,1)
 await service.submit(credential,{requestId:randomUUID(),conversationId:id,to:'office',action:{kind:'result',taskId:child.taskId,claimId:claimed.claimId,connectionEpoch:claimed.connectionEpoch,summary:'Analysis verified revenue 42',outcome:'succeeded'}})
 await browser.refresh();await wait(async()=>continuations,v=>v.length===1)
 phase='native';token=browser.control.beginRun('Unrelated user request');loop.run('Unrelated user request');await wait(async()=>loop.busy,b=>!b)
 assert.equal((await service.snapshot(f.alice.token,id)).tasks.find(t=>t.taskId===parent.taskId).state,'running','unrelated native completion cannot complete parent')
 phase='redelegate';const firstContinuation=continuations[0]
 token=browser.control.beginRun(firstContinuation.instruction,firstContinuation.continuationToken);assert.ok(token);loop.run(firstContinuation.instruction)
 const secondWaiting=await wait(()=>service.snapshot(f.alice.token,id),s=>s.tasks.some(t=>t.taskId===parent.taskId&&t.state==='waiting_peer'))
 const secondChild=secondWaiting.tasks.find(t=>t.parentTaskId===parent.taskId&&t.taskId!==child.taskId)
 const secondClaim=await service.claim(credential,id,{taskId:secondChild.taskId,connectionId,...mc})
 await service.submit(credential,{requestId:randomUUID(),conversationId:id,to:'office',action:{kind:'result',taskId:secondChild.taskId,claimId:secondClaim.claimId,connectionEpoch:secondClaim.connectionEpoch,summary:'Second analysis verified',outcome:'succeeded'}})
 await browser.refresh();await wait(async()=>continuations,v=>v.length===2)
 phase='resume';const continuation=continuations[1]
 token=browser.control.beginRun(continuation.instruction,continuation.continuationToken);assert.ok(token);loop.run(continuation.instruction)
 const complete=await wait(()=>service.snapshot(f.alice.token,id),s=>s.tasks.some(t=>t.taskId===parent.taskId&&t.state==='succeeded'))
 assert.equal(complete.tasks.find(t=>t.taskId===parent.taskId).summary,'Final verified answer')
 assert.equal(modelCalls,4);assert.match(continuation.instruction,/untrusted/);assert.match(continuation.instruction,/Original Office analysis goal/)
 phase='delegate';token=browser.control.beginRun('Cancelable parent');loop.run('Cancelable parent')
 const secondParentSnapshot=await wait(()=>service.snapshot(f.alice.token,id),s=>s.tasks.some(t=>t.from==='office'&&t.to==='office'&&t.instruction==='Cancelable parent'&&t.state==='waiting_peer'))
 const cancelParent=secondParentSnapshot.tasks.find(t=>t.instruction==='Cancelable parent')
 const cancelChild=secondParentSnapshot.tasks.find(t=>t.parentTaskId===cancelParent.taskId)
 const cancelClaim=await service.claim(credential,id,{taskId:cancelChild.taskId,connectionId,...mc})
 await service.submit(credential,{requestId:randomUUID(),conversationId:id,to:'office',action:{kind:'result',taskId:cancelChild.taskId,claimId:cancelClaim.claimId,connectionEpoch:cancelClaim.connectionEpoch,summary:'Ready',outcome:'succeeded'}})
 await browser.refresh();await wait(async()=>continuations,v=>v.length===3)
 phase='hold';const toCancel=continuations[2];token=browser.control.beginRun(toCancel.instruction,toCancel.continuationToken);loop.run(toCancel.instruction)
 await wait(async()=>loop.busy,b=>b)
 await service.submit(owner,{requestId:randomUUID(),conversationId:id,to:'office',action:{kind:'cancel',taskId:cancelParent.taskId}})
 await browser.refresh()
 await wait(()=>service.snapshot(f.alice.token,id),s=>s.tasks.some(t=>t.taskId===cancelParent.taskId&&t.state==='cancelled'))
 assert.equal(nativeCancellations,1);assert.equal(loop.busy,false)
 assert.equal(parentClaimLost,true);assert.deepEqual(recoveredParentKeys[0],recoveredParentKeys[1])

})
