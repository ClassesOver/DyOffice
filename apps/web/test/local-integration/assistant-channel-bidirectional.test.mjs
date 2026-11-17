import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import {randomUUID} from 'node:crypto'
import {fileFixture,docxBytes,importFile} from '../helpers/files.mjs'
import {restrictedOrigin} from '../helpers/restricted.mjs'
import {createCsrfService} from '../../server/src/modules/auth/csrf.ts'
import {createAssistantChannelService} from '../../server/src/modules/assistant-channel/service.ts'
import {registerAssistantChannelRoutes} from '../../server/src/modules/assistant-channel/routes.ts'
import {createAssistantChannelClient} from '../../../../packages/browser-host/src/assistant-channel.ts'
import {ChannelClient} from '../../../../packages/cli/src/agent-channel/client.ts'
import {AgentLoop} from '../../../../packages/agent-core/src/loop.ts'

async function eventually(operation,predicate) {
 const until=Date.now()+8000
 while(Date.now()<until) {
  const result=await operation()
  if(predicate(result))return result
  await new Promise(resolve=>setTimeout(resolve,20))
 }
 assert.fail('Expected durable task state was not observed')
}

test('Office browser client and external CLI complete a bidirectional read through real HTTP and PostgreSQL',async t=>{
 const f=await fileFixture(t),file=(await importFile(f,f.alice.token,await docxBytes())).file
 const service=createAssistantChannelService({transactions:f.transactions,credentialKey:f.csrfKey})
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey})
 const api=Fastify();registerAssistantChannelRoutes(api,service,csrf)
 const origin=await api.listen({host:'127.0.0.1',port:0});t.after(()=>api.close())
 const ownerHeaders={origin:restrictedOrigin,cookie:'__Host-dyoffice-session='+f.alice.token,'x-csrf-token':csrf.sessionToken(f.alice.token)}
 const requests=[]
 const request=async(path,method='GET',body)=>{
  requests.push({path,method,body})
  const response=await fetch(origin+path,{method,headers:{...ownerHeaders,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)})
  const result=await response.json()
  if(!response.ok)throw Object.assign(Error('Owner HTTP '+response.status),{statusCode:response.status})
  return result
 }
 const browser=createAssistantChannelClient({request,fileId:file.fileId,editorId:randomUUID(),generation:()=>1})
 t.after(()=>browser.dispose())
 const nativeDraft={text:'Private unsent draft',attachments:['private-unshared-attachment']}
 const beforeDraft=structuredClone(nativeDraft),modelRequests=[]
 const documentText='Quarterly revenue is 42. All amounts are in USD.'
 let rounds=0,reads=0,writes=0,nativeEvents=0,scopedExecutions=0,contexts=0
 const loop=new AgentLoop({
  transport:{stream(modelRequest,callbacks){
   modelRequests.push(structuredClone(modelRequest))
   queueMicrotask(()=>{
    if(rounds++===0) {
     // Even an unoffered write hallucinated by the model must not reach the
     // document executor. Both calls are handled by the real AgentLoop.
     callbacks.onToolCall({id:'forbidden-write',name:'write_document',input:{text:'Overwrite document'}})
     callbacks.onToolCall({id:'read-current-document',name:'read_blocks',input:{}})
    }else callbacks.onDelta('The document reports quarterly revenue of 42 USD.')
    callbacks.onDone()
   })
   return {cancel(){queueMicrotask(()=>callbacks.onDone())}}
  }},
  skill:{id:'native-editor',systemPrompt:'Private native assistant prompt',
   tools:[{name:'read_blocks',description:'Read document blocks',inputSchema:{type:'object',properties:{},additionalProperties:false}},{name:'write_document',description:'Write document',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}],
   buildContext(){contexts++;return nativeDraft.text},
   executeTool(call){
    if(call.name==='write_document'){writes++;return {output:'Written',summary:'Write',mutated:true}}
    assert.equal(call.name,'read_blocks');reads++;return {output:documentText,summary:'Read current document'}
   }},
  events:{onText(){nativeEvents++},onToolStart(){nativeEvents++},onDone(){nativeEvents++}},
 })
 loop.restore([{role:'user',text:'Private native history'},{role:'assistant',text:'Native assistant answer'}])
 const beforeHistory=structuredClone(loop.messages)
 browser.control.register({isBusy:()=>loop.busy,execute(instruction,signal){scopedExecutions++;return loop.runScoped(instruction,{signal,allowedTools:browser.control.allowedTools})}})
 await browser.start()
 const conversationId=browser.snapshot().conversationId,external=new ChannelClient(origin)
 async function pair(name) {
  const invite=await browser.invite()
  const app=await external.request('POST','/applications',undefined,{inviteToken:invite.inviteToken,name,kind:'custom'})
  assert.equal((await external.request('GET','/applications/'+app.applicationId,app.applicationToken)).state,'pending')
  await browser.approve(app.applicationId,true)
  return external.request('POST','/applications/'+app.applicationId+'/redeem',app.applicationToken,{})
 }
 const member=await pair('External harness'),other=await pair('Other external harness')
 const prefix='/members/'+member.memberId,connectionId=randomUUID()
 const connected=await external.request('POST',prefix+'/connect',member.memberToken,{connectionId})
 const parent=await browser.send(member.memberId,'Analyze the current document; ask Office for the relevant paragraph.')
 const parentClaim=await external.request('POST',prefix+'/claim',member.memberToken,{taskId:parent.taskId,connectionId,connectionEpoch:connected.connectionEpoch})
 const reverseRequestId=randomUUID(),reverseAction={requestId:reverseRequestId,conversationId,to:'office',action:{kind:'delegate',instruction:'Read the paragraph reporting quarterly revenue.',parentTaskId:parent.taskId}}
 const child=await external.request('POST',prefix+'/actions',member.memberToken,reverseAction)
 assert.deepEqual(await external.request('POST',prefix+'/actions',member.memberToken,reverseAction),child)
 // Membership B cannot observe or impersonate the executor for A's question.
 await assert.rejects(external.request('GET','/members/'+other.memberId+'/tasks/'+child.taskId,other.memberToken),/rejected \(404\)/)
 await assert.rejects(external.request('GET',prefix+'/tasks/'+child.taskId,other.memberToken),/rejected \(403\)/)
 browser.observe(await service.notifications(f.alice.token,file.fileId))
 const childResult=await eventually(()=>external.request('GET',prefix+'/tasks/'+child.taskId,member.memberToken),task=>task.state==='succeeded')
 assert.equal(childResult.parentTaskId,parent.taskId)
 assert.match(childResult.summary,/42 USD/)
 assert.equal(reads,1);assert.equal(writes,0);assert.equal(scopedExecutions,1)
 assert.equal(contexts,0);assert.equal(nativeEvents,0)
 assert.deepEqual(loop.messages,beforeHistory);assert.deepEqual(nativeDraft,beforeDraft)
 assert.deepEqual(modelRequests[0].tools.map(tool=>tool.name),['read_blocks'])
 const serializedRequests=JSON.stringify(modelRequests)
 for(const secret of ['Private native history','Private unsent draft','private-unshared-attachment','Private native assistant prompt'])assert.equal(serializedRequests.includes(secret),false)
 assert.ok(modelRequests[1].messages.some(message=>message.role==='tool'&&message.results.some(result=>result.id==='forbidden-write'&&result.isError)))
 assert.ok(modelRequests[1].messages.some(message=>message.role==='tool'&&message.results.some(result=>result.output===documentText)))
 const completed={requestId:randomUUID(),conversationId,to:'office',action:{kind:'result',taskId:parent.taskId,claimId:parentClaim.claimId,connectionEpoch:parentClaim.connectionEpoch,summary:'Analysis complete: revenue is 42 USD, verified with the document.',outcome:'succeeded'}}
 // Even knowledge of a claim ID does not authorize another channel member.
 await assert.rejects(external.request('POST','/members/'+other.memberId+'/actions',other.memberToken,completed),/rejected \(409\)/)
 await external.request('POST',prefix+'/actions',member.memberToken,completed)
 await browser.refresh()
 assert.equal(browser.snapshot().tasks.find(task=>task.taskId===parent.taskId).state,'succeeded')
 for(let n=0;n<3;n++){browser.observe(await service.notifications(f.alice.token,file.fileId));await browser.refresh()}
 assert.equal(scopedExecutions,1)
 assert.deepEqual(loop.messages,beforeHistory);assert.deepEqual(nativeDraft,beforeDraft)
 assert.equal(JSON.stringify(requests).includes(nativeDraft.text),false)
 // Reconstructing the service observes durable running work without running
 // it. A new connection marks its uncertain result rather than replaying it.
 const uncertain=await browser.send(member.memberId,'A second task with an intentionally lost executor')
 const uncertainClaim=await external.request('POST',prefix+'/claim',member.memberToken,{taskId:uncertain.taskId,connectionId,connectionEpoch:connected.connectionEpoch})
 const restored=createAssistantChannelService({transactions:f.transactions,credentialKey:f.csrfKey})
 assert.equal((await restored.snapshot(f.alice.token,conversationId)).tasks.find(task=>task.taskId===uncertain.taskId).state,'running')
 assert.equal(scopedExecutions,1)
 const reconnect=await external.request('POST',prefix+'/connect',member.memberToken,{connectionId:randomUUID()})
 assert.ok(reconnect.connectionEpoch>connected.connectionEpoch)
 assert.equal((await restored.memberSnapshot(member.memberToken)).tasks.find(task=>task.taskId===uncertain.taskId).state,'unknown_outcome')
 await assert.rejects(external.request('POST',prefix+'/actions',member.memberToken,{requestId:randomUUID(),conversationId,to:'office',action:{kind:'result',taskId:uncertain.taskId,claimId:uncertainClaim.claimId,connectionEpoch:uncertainClaim.connectionEpoch,summary:'Stale executor result',outcome:'succeeded'}}),/rejected \(409\)/)
 assert.equal(scopedExecutions,1);assert.equal(writes,0)
})
