import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import Fastify from 'fastify'
import JSZip from 'jszip'
import {fileFixture,docxBytes,importFile} from '../helpers/files.mjs'
import {backgroundDocumentBytes} from '../helpers/background-documents.mjs'
import {restrictedOrigin} from '../helpers/restricted.mjs'
import {createAssistantChannelService} from '../../server/src/modules/assistant-channel/service.ts'
import {createCodingTaskRecoveryStore} from '../../server/src/modules/coding/task-recovery-store.ts'
import {createCsrfService} from '../../server/src/modules/auth/csrf.ts'
import {registerAssistantChannelRoutes} from '../../server/src/modules/assistant-channel/routes.ts'

async function budgetBytes(amount=42){
 const zip=await JSZip.loadAsync(await docxBytes())
 zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>预算总额：'+amount+' 万元</w:t></w:r></w:p></w:body></w:document>')
 return zip.generateAsync({type:'nodebuffer'})
}
async function setup(t){
 const f=await fileFixture(t,{worker:true})
 const service=createAssistantChannelService({transactions:f.transactions,credentialKey:f.csrfKey,backgroundEnabled:true})
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey})
 const api=Fastify();registerAssistantChannelRoutes(api,service,csrf,undefined,f.objects,f.files);t.after(()=>api.close())
 const headers=token=>({origin:restrictedOrigin,cookie:'__Host-dyoffice-session='+token,'x-csrf-token':csrf.sessionToken(token)})
 const post=(path,payload,token=f.alice.token)=>api.inject({method:'POST',url:'/api/v1/assistant-channels'+path,payload,headers:headers(token)})
 return {...f,service,api,headers,post}
}
async function pair(f,id){
 const invitation=await f.service.invite(f.alice.token,id)
 const a=await f.service.apply(invitation.inviteToken,{displayName:'DSH',kind:'dsh'})
 await f.service.approve(f.alice.token,id,a.applicationId,{approved:true})
 const m=await f.service.redeem(a.applicationToken)
 return {kind:'member',token:m.memberToken}
}
test('DSH creation requires a creation grant and saves real Office files',async t=>{
 const f=await setup(t)
 const {conversationId}=await f.service.createConversation(f.alice.token,{})
 const issue='/channels/'+conversationId+'/dsh-token'
 const response=await f.post(issue,{allowCreate:true})
 assert.equal(response.statusCode,200,response.body)
 const create=(token,format,title='demo')=>f.api.inject({method:'POST',url:'/api/v1/assistant-channels/member/documents',headers:{authorization:'Bearer '+token},payload:{format,title}})
 const token=response.json().memberToken
 const reader=await pair(f,conversationId)
 const preview=(token,fileId,proof,after='')=>f.api.inject({
  url:'/api/v1/assistant-channels/member/documents/'+fileId+'/preview'+after,
  headers:{authorization:'Bearer '+token,...(proof?{'x-dyoffice-document-preview':proof}:{})},
 })
 const channelMember=async()=>(await f.service.snapshot(f.alice.token,conversationId)).members.find(member=>member.displayName==='DSH DyOffice')
 assert.equal((await channelMember()).previewActive,false)
 assert.equal((await f.service.memberSnapshot(token)).canCreate,true)
 assert.equal((await channelMember()).previewActive,true)
 assert.equal((await channelMember()).online,false)
 assert.equal((await f.service.memberSnapshot(reader.token)).canCreate,false)
 await f.service.setPaused(f.alice.token,conversationId,true)
 assert.equal((await f.service.memberSnapshot(token)).canCreate,false)
 assert.equal((await channelMember()).previewActive,false)
 assert.equal((await create(token,'docx')).statusCode,403)
 await f.service.setPaused(f.alice.token,conversationId,false)
 assert.equal((await create(reader.token,'docx')).statusCode,403)
 assert.equal((await create(token,'csv')).statusCode,400)
 let createdPreview
 for(const format of ['docx','xlsx','pptx','pdf']){
  const result=await create(token,format)
  assert.equal(result.statusCode,200,result.body)
  const {fileId,name}=result.json()
  assert.equal(name,'demo.'+format)
  assert.equal((await f.files.openFile(f.alice.token,fileId)).format,format)
  const snapshot=(revision,proof=result.json().previewProof,target=fileId,memberToken=token)=>f.api.inject({
   url:'/api/v1/assistant-channels/member/documents/'+target+'/snapshot-source?revision='+revision,
   headers:{authorization:'Bearer '+memberToken,'x-dyoffice-document-preview':proof},
  })
  const source=await snapshot(result.json().baseRevision)
  assert.equal(source.statusCode,200)
  assert.equal(source.headers['content-type'],'application/octet-stream')
  assert.equal(source.headers['cache-control'],'private, no-store')
  assert.ok(source.rawPayload.subarray(0,format==='pdf'?4:2).equals(Buffer.from(format==='pdf'?'%PDF':'PK')))
  assert.equal((await snapshot(result.json().baseRevision,'a'.repeat(64))).statusCode,403)
  assert.equal((await snapshot(result.json().baseRevision,undefined,randomUUID())).statusCode,403)
  assert.equal((await snapshot(result.json().baseRevision,undefined,fileId,reader.token)).statusCode,403)
  if(format!=='docx'){
   const origin='http://127.0.0.1:3080',url='/api/v1/assistant-channels/member/documents/'+fileId+'/draft-sync'
   const headers={authorization:'Bearer '+token,'x-dyoffice-document-preview':result.json().previewProof}
   const issue=await f.api.inject({method:'POST',url,headers,payload:{origin,write:true}})
   assert.equal(issue.statusCode,200)
   assert.equal((await f.post('/documents/'+fileId+'/draft-sync',{origin,ticket:issue.json().ticket})).json().write,true)
  }
  if(format==='docx'){
   const {previewProof}=result.json()
   createdPreview={fileId,previewProof}
   const origin='http://127.0.0.1:3080'
   const issueDraft=(proof=previewProof,write=false)=>f.api.inject({method:'POST',url:'/api/v1/assistant-channels/member/documents/'+fileId+'/draft-sync',
    headers:{authorization:'Bearer '+token,'x-dyoffice-document-preview':proof},payload:{origin,write}})
   const grant=await issueDraft()
   assert.equal(grant.statusCode,200,grant.body)
   assert.equal((await issueDraft('a'.repeat(64))).statusCode,403)
   const {ticket}=grant.json()
   const verifyDraft=(actualOrigin,ownerToken=f.alice.token,signedTicket=ticket)=>f.post('/documents/'+fileId+'/draft-sync',{origin:actualOrigin,ticket:signedTicket},ownerToken)
   const verified=await verifyDraft(origin)
   assert.equal(verified.statusCode,200)
   assert.equal(verified.json().write,undefined)
   const writeGrant=await issueDraft(previewProof,true)
   assert.equal(writeGrant.statusCode,200,writeGrant.body)
   assert.equal((await verifyDraft(origin,f.alice.token,writeGrant.json().ticket)).json().write,true)
   assert.equal((await issueDraft('a'.repeat(64),true)).statusCode,403)
   assert.equal((await verifyDraft('https://other.example')).statusCode,403)
   assert.equal((await verifyDraft(origin,f.bob.token)).statusCode,403)
   const saved=await preview(token,fileId,previewProof)
   assert.equal(saved.statusCode,200,saved.body)
   assert.equal(saved.json().fileId,fileId)
   assert.equal(saved.json().activity,'saved')
   assert.equal(typeof saved.json().text,'string')
   const unchanged=await preview(token,fileId,previewProof,'?after='+saved.json().revision)
   assert.equal(unchanged.statusCode,200)
   assert.equal(Object.hasOwn(unchanged.json(),'text'),false)
   assert.equal((await preview(token,fileId)).statusCode,403)
   assert.equal((await preview(token,randomUUID(),previewProof)).statusCode,403)
   assert.equal((await preview(reader.token,fileId,previewProof)).statusCode,403)
   await f.service.setPaused(f.alice.token,conversationId,true)
   assert.equal((await preview(token,fileId,previewProof)).statusCode,403)
   assert.equal((await issueDraft()).statusCode,403)
   await f.service.setPaused(f.alice.token,conversationId,false)
   const baseRevision=saved.json().revision,bytes=await budgetBytes(99),editorId=randomUUID()
   const {createLeaseService}=await import('../../server/src/modules/leases/service.ts')
   const {createRevisionService}=await import('../../server/src/modules/revisions/service.ts')
   const revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
   const {leaseEpoch}=await createLeaseService({transactions:f.transactions}).acquireLease(f.alice.token,fileId,{editorId})
   assert.equal((await preview(token,fileId,previewProof,'?after='+baseRevision)).json().activity,'editing')
   const {uploadId}=await revisions.stageUpload(f.alice.token,fileId,{size:bytes.length,baseRevision,editorId,leaseEpoch})
   await f.files.receiveUpload(f.alice.token,uploadId,bytes)
   const updated=await revisions.commitRevision(f.alice.token,{fileId,uploadId,baseRevision,leaseEpoch,idempotencyKey:randomUUID()})
   const latest=await preview(token,fileId,previewProof,'?after='+baseRevision)
   assert.equal(latest.statusCode,200,latest.body)
   assert.equal(latest.json().revision,updated.revision)
   assert.match(latest.json().text,/99 万元/)
   assert.equal((await snapshot(baseRevision)).statusCode,409)
   assert.deepEqual((await snapshot(updated.revision)).rawPayload,Buffer.from(bytes))
   assert.equal(latest.json().activity,'editing')
  }
 }
 assert.equal((await f.service.snapshot(f.alice.token,conversationId)).fileId,null)
 const {member}=await f.service.memberSnapshot(token)
 await f.service.revoke(f.alice.token,conversationId,member.membershipId)
 assert.equal((await create(token,'docx')).statusCode,401)
 assert.equal((await preview(token,createdPreview.fileId,createdPreview.previewProof)).statusCode,401)
})
test('an owner-issued DSH token connects directly without an application or redemption step',async t=>{
 const f=await setup(t)
 const {file}=await importFile(f,f.alice.token,await budgetBytes())
 const {conversationId}=await f.service.createConversation(f.alice.token,{fileId:file.fileId})
 const route='/channels/'+conversationId+'/dsh-token'
 assert.equal((await f.post(route,{})).statusCode,403)
 await f.service.configureBackground(f.alice.token,conversationId,{enabled:true})
 assert.equal((await f.post(route,{},f.bob.token)).statusCode,404)
 for(const expiresInMinutes of [0,43201,'1440',null])assert.equal((await f.post(route,{expiresInMinutes})).statusCode,400)
 const started=Date.now()
 const issued=await f.post(route,{expiresInMinutes:43200})
 assert.equal(issued.statusCode,200,issued.body)
 assert.ok(Math.abs(Date.parse(issued.json().expiresAt)-started-30*24*60*60000)<10000)
 assert.equal(typeof issued.json().memberToken,'string')
 assert.equal(issued.json().inviteToken,undefined)
 const defaultToken=await f.post(route,{})
 assert.equal(defaultToken.statusCode,200,defaultToken.body)
 assert.ok(Math.abs(Date.parse(defaultToken.json().expiresAt)-started-24*60*60000)<10000)
 const memberToken=issued.json().memberToken
 const self=await f.api.inject({url:'/api/v1/assistant-channels/member',headers:{authorization:'Bearer '+memberToken}})
 assert.equal(self.statusCode,200,self.body)
 const member={memberToken,memberId:self.json().member.membershipId,conversationId:self.json().conversationId}
 const owner=await f.service.snapshot(f.alice.token,conversationId)
 assert.equal(owner.applications.length,0)
 assert.ok(owner.members.some(value=>value.membershipId===member.memberId))
 assert.ok(Math.abs(Date.parse(self.json().member.expiresAt)-started-30*24*60*60000)<10000)
 const preview=await f.api.inject({url:'/api/v1/assistant-channels/members/'+member.memberId+'/preview',headers:{authorization:'Bearer '+member.memberToken}})
 assert.equal(preview.statusCode,200,preview.body)
 assert.match(preview.json().text,/42 万元/)
})
test('empty workspace creates and shares durable channels without opening an editor',async t=>{
 const f=await setup(t),conversationId=randomUUID()
 const created=await f.post('/channels',{conversationId})
 assert.equal(created.statusCode,200,created.body)
 assert.equal(created.json().fileId,null)
 assert.deepEqual((await f.post('/channels',{conversationId})).json(),created.json())
 const second=(await f.post('/channels',{})).json()
 assert.notEqual(second.conversationId,conversationId)
 const list=await f.api.inject({url:'/api/v1/assistant-channels/channels',headers:f.headers(f.alice.token)})
 assert.equal(list.statusCode,200,list.body);assert.equal(list.json().items.length,2)
 const member=await pair(f,conversationId)
 assert.equal((await f.service.memberSnapshot(member.token)).fileId,null)
 assert.equal((await f.post('/channels/'+conversationId+'/background',{enabled:true},f.bob.token)).statusCode,404)
 const file=(await importFile(f,f.alice.token,await docxBytes())).file
 assert.equal((await f.post('/channels/'+conversationId+'/background',{enabled:true,fileId:file.fileId})).statusCode,200)
 assert.equal((await f.service.snapshot(f.alice.token,conversationId)).fileId,file.fileId)
 const filtered=await f.api.inject({url:'/api/v1/assistant-channels/channels?fileId='+file.fileId,headers:f.headers(f.alice.token)})
 assert.equal(filtered.statusCode,200,filtered.body);assert.deepEqual(filtered.json().items.map(c=>c.conversationId),[conversationId])
 assert.deepEqual((await f.service.listChannels(f.bob.token)).items,[])
 await assert.rejects(f.service.snapshot(f.bob.token,conversationId),{statusCode:404})
 await assert.rejects(f.service.invite(f.bob.token,conversationId),{statusCode:404})
 await assert.rejects(f.service.approve(f.bob.token,conversationId,randomUUID(),{approved:true}),{statusCode:404})
})
test('background delegation freezes one saved revision and cannot be claimed by a browser',async t=>{
 const f=await setup(t),file=(await importFile(f,f.alice.token,await docxBytes())).file
 const channel=await f.service.createConversation(f.alice.token,{fileId:file.fileId}),id=channel.conversationId
 const member=await pair(f,id)
 const input={requestId:randomUUID(),conversationId:id,to:'office',action:{kind:'delegate',instruction:'Read the budget',execution:'saved-revision'}}
 await assert.rejects(f.service.submit(member,input))
 assert.equal((await f.post('/channels/'+id+'/background',{enabled:true})).statusCode,200)
 const [first,again]=await Promise.all([f.service.submit(member,input),f.service.submit(member,input)])
 assert.deepEqual(first,again)
 assert.equal((await f.ownerPool.query('SELECT 1 FROM assistant_background_queue WHERE task_id=$1',[first.taskId])).rowCount,1)
 const task=await f.service.memberTask(member.token,first.taskId)
 assert.equal(task.execution,'saved-revision');assert.equal(task.savedRevision,file.revision)
 const connectionId=randomUUID(),connected=await f.service.connect({kind:'owner',token:f.alice.token},id,{connectionId,editorId:randomUUID(),editorGeneration:1})
 await assert.rejects(f.service.claim({kind:'owner',token:f.alice.token},id,{taskId:first.taskId,connectionId,connectionEpoch:connected.connectionEpoch}))
 const list=await f.api.inject({url:'/api/v1/assistant-channels/background-tasks',headers:f.headers(f.alice.token)})
 assert.equal(list.statusCode,200,list.body);assert.equal(list.json().items[0].taskId,first.taskId)
 const other=await f.api.inject({url:'/api/v1/assistant-channels/background-tasks/'+first.taskId,headers:f.headers(f.bob.token)})
 assert.equal(other.statusCode,404)
})
test('server executes a saved document without an editor and persists one verified result',async t=>{
 const f=await setup(t),file=(await importFile(f,f.alice.token,await docxBytes())).file
 const {conversationId}=await f.service.createConversation(f.alice.token,{fileId:file.fileId})
 await f.service.configureBackground(f.alice.token,conversationId,{enabled:true})
 const member=await pair(f,conversationId)
 const {taskId}=await f.service.submit(member,{requestId:randomUUID(),conversationId,to:'office',action:{kind:'delegate',instruction:'Read saved text',execution:'saved-revision'}})
 const {createAssistantBackgroundStore}=await import('../../server/src/modules/assistant-channel/background-store.ts')
 const {createAssistantBackgroundRunner}=await import('../../server/src/modules/assistant-channel/background-runner.ts')
 const store=createAssistantBackgroundStore({pool:f.workerPool,deploymentId:f.deploymentId})
 let calls=0
 const runner=createAssistantBackgroundRunner({store,service:f.service,objects:f.objects,async answer(input){
  calls++;assert.equal(input.tools.length,0);assert.ok(input.text.length>0);assert.equal(input.revision,file.revision)
  return 'Verified saved document text'
 }})
 assert.equal(await runner.runOnce(),true)
 assert.equal(await runner.runOnce(),false)
 const result=await f.service.memberTask(member.token,taskId)
 assert.equal(result.state,'succeeded');assert.equal(result.summary,'Verified saved document text');assert.equal(calls,1)
 const row=(await f.ownerPool.query('SELECT credential FROM assistant_background_queue WHERE task_id=$1',[taskId])).rows[0]
 assert.equal(row.credential,null)
})

async function queued(t){
 const f=await setup(t),file=(await importFile(f,f.alice.token,await budgetBytes())).file
 const {conversationId}=await f.service.createConversation(f.alice.token,{fileId:file.fileId})
 await f.service.configureBackground(f.alice.token,conversationId,{enabled:true})
 const member=await pair(f,conversationId)
 const {taskId}=await f.service.submit(member,{requestId:randomUUID(),conversationId,to:'office',action:{kind:'delegate',instruction:'Read saved text',execution:'saved-revision'}})
 const {createAssistantBackgroundStore}=await import('../../server/src/modules/assistant-channel/background-store.ts')
 const {createAssistantBackgroundRunner}=await import('../../server/src/modules/assistant-channel/background-runner.ts')
 const store=()=>createAssistantBackgroundStore({pool:f.workerPool,deploymentId:f.deploymentId})
 const runner=answer=>createAssistantBackgroundRunner({store:store(),service:f.service,objects:f.objects,answer})
 return {...f,file,conversationId,member,taskId,store,runner}
}
test('task runtime status distinguishes executors with colliding IDs and enforces owner visibility',async t=>{
 const f=await queued(t)
 const coding=createCodingTaskRecoveryStore(f.transactions)
 await coding.start(f.alice.token,f.file.fileId,f.taskId,{modelId:'fixture'},undefined)
 const channel=await f.service.submit(f.member,{requestId:randomUUID(),conversationId:f.conversationId,to:'office',action:{kind:'delegate',instruction:'Read the active document'}})
 const query=token=>f.transactions.withPrincipalTransaction({kind:'session',token},async c=>
  (await c.query('SELECT executor,task_id,state FROM task_runtime_status ORDER BY executor')).rows)
 assert.deepEqual(await query(f.alice.token),[
  {executor:'background',task_id:f.taskId,state:'queued'},
  {executor:'channel',task_id:channel.taskId,state:'queued'},
  {executor:'codex',task_id:f.taskId,state:'running'},
 ])
 assert.deepEqual(await query(f.bob.token),[])
 await assert.rejects(f.workerPool.query('SELECT * FROM task_runtime_status'),{code:'42501'})
 await f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},c=>
  c.query("UPDATE task_runtime_codex SET lease_until=clock_timestamp()-interval '1 second' WHERE turn_id=$1",[f.taskId]))
 assert.equal((await coding.events(f.alice.token,f.file.fileId,f.taskId,0)).state,'unknown_outcome')
 assert.equal((await query(f.alice.token))[0].state,'queued')
})
test('two server instances execute a durable queued task once',async t=>{
 const f=await queued(t);let calls=0
 const answer=async()=>{calls++;return 'one result'}
 await Promise.all([f.runner(answer).runOnce(),f.runner(answer).runOnce()])
 assert.equal(calls,1);assert.equal((await f.service.memberTask(f.member.token,f.taskId)).state,'succeeded')
 await assert.rejects(f.workerPool.query('SELECT * FROM assistant_background_queue'))
 await assert.rejects(f.workerPool.query('SELECT * FROM files'))
})
test('expired running claim is never rerun and survives loss of the cleanup response',async t=>{
 const f=await queued(t),store=f.store(),claim=await store.take()
 await f.service.backgroundStep(claim,'begin')
 const expire=()=>f.ownerPool.query("UPDATE task_runtime_channel SET lease_until=clock_timestamp()-interval '1 second' WHERE task_id=$1",[f.taskId])
 await expire()
 const lost=await store.take();assert.equal(lost.expired,true)
 // Simulate a process exiting after take() but before it can settle the task.
 await expire()
 let calls=0;await f.runner(async()=>{calls++;return 'must not run'}).runOnce()
 assert.equal(calls,0)
 assert.equal((await f.service.memberTask(f.member.token,f.taskId)).state,'unknown_outcome')
 await assert.rejects(f.service.backgroundStep(claim,'finish',{summary:'late',outcome:'succeeded'}))
 assert.equal((await f.ownerPool.query('SELECT credential FROM assistant_background_queue WHERE task_id=$1',[f.taskId])).rows[0].credential,null)
})
for(const reason of ['cancel','disable','pause','revoke','trash','logout'])test(reason+' during model execution prevents publishing a late answer',async t=>{
 const f=await queued(t)
 let entered,release
 const started=new Promise(resolve=>{entered=resolve}),wait=new Promise(resolve=>{release=resolve})
 const running=f.runner(async()=>{entered();await wait;return 'PRIVATE LATE ANSWER'}).runOnce()
 await started
 try{
  if(reason==='cancel')await f.service.submit({kind:'owner',token:f.alice.token},{requestId:randomUUID(),conversationId:f.conversationId,to:'office',action:{kind:'cancel',taskId:f.taskId}})
  if(reason==='disable')await f.service.configureBackground(f.alice.token,f.conversationId,{enabled:false})
  if(reason==='pause')await f.service.setPaused(f.alice.token,f.conversationId,true)
  if(reason==='revoke'){
   const snapshot=await f.service.snapshot(f.alice.token,f.conversationId)
   await f.service.revoke(f.alice.token,f.conversationId,snapshot.members[0].membershipId)
  }
  if(reason==='trash')await f.files.trashFile(f.alice.token,f.file.fileId)
  if(reason==='logout')await f.sessions.logout(f.alice.token)
 }finally{release()}
 await running
 const row=(await f.ownerPool.query('SELECT t.state,t.summary,q.credential FROM assistant_tasks t JOIN assistant_background_queue q USING(task_id) WHERE task_id=$1',[f.taskId])).rows[0]
 assert.equal(row.summary,null);assert.equal(row.credential,null)
 assert.ok(['cancelled','unknown_outcome'].includes(row.state),row.state)
 assert.equal((await f.ownerPool.query("SELECT 1 FROM assistant_events WHERE task_id=$1 AND payload::text LIKE '%PRIVATE LATE ANSWER%'",[f.taskId])).rowCount,0)
})
test('saving a new revision after enqueue preserves the exact old document input',async t=>{
 const f=await queued(t),bytes=await budgetBytes(99)
 const {member:{membershipId}}=await f.service.memberSnapshot(f.member.token)
 const previewUrl='/api/v1/assistant-channels/members/'+membershipId+'/preview'
 const getPreview=(url=previewUrl)=>f.api.inject({url,headers:{authorization:'Bearer '+f.member.token}})
 const original=await getPreview()
 assert.equal(original.statusCode,200,original.body)
 assert.match(original.json().text,/42 万元/)
 assert.equal((await getPreview(previewUrl.replace(membershipId,randomUUID()))).statusCode,403)
 const {docxToText}=await import('../../../../packages/file-parse/src/docx.ts')
 const expected=await docxToText(await budgetBytes(),{maxChars:24000})
 assert.match(expected,/42 万元/)
 const {createLeaseService}=await import('../../server/src/modules/leases/service.ts')
 const {createRevisionService}=await import('../../server/src/modules/revisions/service.ts')
 const revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
 const editorId=randomUUID(),lease=await createLeaseService({transactions:f.transactions}).acquireLease(f.alice.token,f.file.fileId,{editorId})
 const upload=await revisions.stageUpload(f.alice.token,f.file.fileId,{size:bytes.length,baseRevision:f.file.revision,editorId,leaseEpoch:lease.leaseEpoch})
 await f.files.receiveUpload(f.alice.token,upload.uploadId,bytes)
 const saved=await revisions.commitRevision(f.alice.token,{fileId:f.file.fileId,uploadId:upload.uploadId,baseRevision:f.file.revision,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID()})
 assert.notEqual(saved.revision,f.file.revision)
 const preview=await getPreview(previewUrl+'?after='+f.file.revision)
 assert.equal(preview.statusCode,200,preview.body)
 assert.equal(preview.json().revision,saved.revision)
 assert.match(preview.json().text,/99 万元/)
 await f.runner(async input=>{assert.equal(input.revision,f.file.revision);assert.equal(input.text,expected);assert.ok(!input.text.includes('99 万元'));return 'old revision verified'}).runOnce()
 const result=await f.service.memberTask(f.member.token,f.taskId)
 assert.equal(result.savedRevision,f.file.revision);assert.equal(result.state,'succeeded')
 await f.service.setPaused(f.alice.token,f.conversationId,true)
 assert.equal((await getPreview()).statusCode,403)
})
test('busy Office execution leaves a background task queued for later',async t=>{
 const f=await queued(t)
 const other=await f.service.submit(f.member,{requestId:randomUUID(),conversationId:f.conversationId,to:'office',action:{kind:'delegate',instruction:'browser task'}})
 const connectionId=randomUUID(),connected=await f.service.connect({kind:'owner',token:f.alice.token},f.conversationId,{connectionId,editorId:randomUUID(),editorGeneration:1})
 await f.service.claim({kind:'owner',token:f.alice.token},f.conversationId,{taskId:other.taskId,connectionId,connectionEpoch:connected.connectionEpoch})
 let calls=0
 await f.runner(async()=>{calls++;return 'later'}).runOnce()
 assert.equal(calls,0);assert.equal((await f.service.memberTask(f.member.token,f.taskId)).state,'queued')
 // A disconnected browser must not block the queue after its task deadline.
 await f.ownerPool.query("UPDATE task_runtime_channel SET deadline_at=clock_timestamp()-interval '1 second' WHERE task_id=$1",[other.taskId])
 await f.runner(async()=>{calls++;return 'later'}).runOnce()
 assert.equal(calls,1)
})
for(const limited of [false,true])test('application bootstrap '+(limited?'records a model length limit as a failed HTTP background task':'runs HTTP background tasks through the real shared model gateway without an editor'),async t=>{
 const {mockProviderNetwork}=await import('../helpers/provider-network.mjs')
 const {createGlobalConfigService}=await import('../../server/src/modules/admin/service.ts')
 const {buildLocalApp}=await import('../../server/src/app.ts')
 const text=limited?'这是被截断的预算结论':'已保存版本预算为42万元'
 const frame={choices:[{delta:{content:text},finish_reason:limited?'length':'stop'}]}
 const network=mockProviderNetwork(t,[Buffer.from('data: '+JSON.stringify(frame)+'\n\ndata: [DONE]\n\n')])
 const f=await setup(t),file=(await importFile(f,f.alice.token,await budgetBytes())).file
 const {conversationId}=await f.service.createConversation(f.alice.token,{fileId:file.fileId})
 await f.service.configureBackground(f.alice.token,conversationId,{enabled:true})
 const member=await pair(f,conversationId),snapshot=await f.service.memberSnapshot(member.token),memberId=snapshot.member.membershipId
 const keyring={activeKeyId:'background-test',keys:{'background-test':new Uint8Array(32).fill(29)}}
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[{id:'shared-chat',kind:'chat',providerId:'deepseek',label:'Shared model',model:'synthetic-model',baseUrl:'https://provider.example/v1/chat/completions',enabled:true,apiKey:'synthetic-key'}],defaults:{chat:'shared-chat'}})
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin:restrictedOrigin,csrfKey:f.csrfKey,objectStore:f.objects,globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false,assistantChannels:true,assistantBackground:{pool:f.workerPool}})
 t.after(()=>app.close())
 const response=await app.inject({method:'POST',url:'/api/v1/assistant-channels/members/'+memberId+'/actions',headers:{authorization:'Bearer '+member.token},payload:{requestId:randomUUID(),conversationId,to:'office',action:{kind:'delegate',instruction:'预算总额是多少？',execution:'saved-revision'}}})
 assert.equal(response.statusCode,200,response.body)
 const {taskId}=response.json()
 let result
 for(let attempt=0;attempt<100;attempt++){
  const reply=await app.inject({url:'/api/v1/assistant-channels/members/'+memberId+'/tasks/'+taskId,headers:{authorization:'Bearer '+member.token}})
  assert.equal(reply.statusCode,200,reply.body);result=reply.json()
  if(['succeeded','failed','unknown_outcome','cancelled'].includes(result.state))break
  await new Promise(resolve=>setTimeout(resolve,100))
 }
 assert.equal(result.state,limited?'failed':'succeeded',JSON.stringify(result));assert.equal(result.savedRevision,file.revision)
 if(limited){assert.match(result.summary,/后台读取未完成/);assert.ok(!result.summary.includes(text))}
 else assert.equal(result.summary,text)
 assert.equal(network.writes,1)
 const wire=JSON.parse(network.wire.toString())
 assert.match(JSON.stringify(wire),/42 万元/)
 assert.ok(!wire.tools||wire.tools.length===0)
 assert.equal((await f.ownerPool.query('SELECT state FROM shared_provider_dispatches')).rows[0].state,'settled')
})
for(const finish of ['success','expired-queued'])test('background child '+finish+' wakes its waiting external parent',async t=>{
 const f=await queued(t),owner={kind:'owner',token:f.alice.token},memberId=(await f.service.memberSnapshot(f.member.token)).member.membershipId
 // Settle the independent initial task before testing a parent/child chain.
 await f.runner(async()=> 'initial').runOnce()
 const parent=await f.service.submit(owner,{requestId:randomUUID(),conversationId:f.conversationId,to:memberId,action:{kind:'delegate',instruction:'Parent request'}})
 const connectionId=randomUUID(),connected=await f.service.connect(f.member,f.conversationId,{connectionId})
 const claimed=await f.service.claim(f.member,f.conversationId,{taskId:parent.taskId,connectionId,connectionEpoch:connected.connectionEpoch})
 const child=await f.service.submit(f.member,{requestId:randomUUID(),conversationId:f.conversationId,to:'office',action:{kind:'delegate',instruction:'Read child',parentTaskId:parent.taskId,execution:'saved-revision'}})
 await f.service.yieldTask(f.member,f.conversationId,{taskId:parent.taskId,claimId:claimed.claimId,connectionEpoch:connected.connectionEpoch,childTaskIds:[child.taskId]})
 if(finish==='success')await f.runner(async()=> 'child result').runOnce()
 else{
  await f.store().take()
  await f.ownerPool.query("UPDATE task_runtime_channel SET lease_until=clock_timestamp()-interval '1 second' WHERE task_id=$1",[child.taskId])
  await f.runner(async()=>{assert.fail('expired claim must never execute')}).runOnce()
 }
 assert.equal((await f.service.memberTask(f.member.token,parent.taskId)).state,'queued')
 const resumed=await f.service.claim(f.member,f.conversationId,{taskId:parent.taskId,connectionId,connectionEpoch:connected.connectionEpoch})
 assert.equal(resumed.continuation.children[0].taskId,child.taskId)
 assert.equal(resumed.continuation.children[0].state,finish==='success'?'succeeded':'cancelled')
})
test('background opt-in rejects missing documents and disabled deployments',async t=>{
 const f=await setup(t),{conversationId}=await f.service.createConversation(f.alice.token,{})
 await assert.rejects(f.service.configureBackground(f.alice.token,conversationId,{enabled:true}))
 const member=await pair(f,conversationId)
 await assert.rejects(f.service.submit(member,{requestId:randomUUID(),conversationId,to:'office',action:{kind:'delegate',instruction:'Read',execution:'saved-revision'}}))
 const disabled=createAssistantChannelService({transactions:f.transactions,credentialKey:f.csrfKey})
 const file=(await importFile(f,f.alice.token,await budgetBytes())).file
 await assert.rejects(disabled.configureBackground(f.alice.token,conversationId,{enabled:true,fileId:file.fileId}))
 assert.equal((await disabled.snapshot(f.alice.token,conversationId)).backgroundAvailable,false)
 await f.service.configureBackground(f.alice.token,conversationId,{enabled:true,fileId:file.fileId})
 const membership=(await f.service.memberSnapshot(member.token)).member.membershipId
 await f.service.revoke(f.alice.token,conversationId,membership)
 await assert.rejects(f.service.submit(member,{requestId:randomUUID(),conversationId,to:'office',action:{kind:'delegate',instruction:'Revoked read',execution:'saved-revision'}}))
 assert.equal((await f.ownerPool.query('SELECT 1 FROM assistant_background_queue')).rowCount,0)
})

async function backgroundProcess(f,{hold=false}={}){
 const {fork}=await import('node:child_process')
 const child=fork(new URL('../helpers/assistant-background-process.mjs',import.meta.url),[],{execArgv:['--import','tsx'],stdio:['ignore','ignore','pipe','ipc']})
 const messages=[],waiters=new Set()
 child.on('message',message=>{messages.push(message);for(const wake of waiters)wake()})
 const exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})))
 const wait=phase=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{waiters.delete(check);reject(Error('Child process did not reach '+phase))},15000)
  function check(){const message=messages.find(m=>m.phase===phase);if(message){clearTimeout(timer);waiters.delete(check);resolve(message)}}
  waiters.add(check);check()
 })
 f.cleanup.push(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exit})
 child.send({business:f.urls.business,worker:f.urls.worker,deploymentId:f.deploymentId,key:f.csrfKey,directory:f.directory,hold})
 return {child,messages,wait,exit}
}
test('separate processes compete once and recover a killed executor without repeating model work',async t=>{
 const f=await queued(t)
 const first=await backgroundProcess(f,{hold:true})
 const started=await first.wait('answer')
 assert.match(started.text,/42 万元/);assert.equal(started.revision,f.file.revision)
 const second=await backgroundProcess(f)
 assert.equal((await second.wait('done')).worked,false)
 assert.equal((await second.exit).code,0);assert.equal(second.messages.filter(m=>m.phase==='answer').length,0)
 first.child.kill('SIGKILL');assert.equal((await first.exit).signal,'SIGKILL')
 await f.ownerPool.query("UPDATE task_runtime_channel SET lease_until=clock_timestamp()-interval '1 second' WHERE task_id=$1",[f.taskId])
 const restarted=await backgroundProcess(f)
 assert.equal((await restarted.wait('done')).worked,true);assert.equal((await restarted.exit).code,0)
 assert.equal(restarted.messages.filter(m=>m.phase==='answer').length,0)
 assert.equal((await f.service.memberTask(f.member.token,f.taskId)).state,'unknown_outcome')
 assert.equal((await f.ownerPool.query('SELECT credential FROM assistant_background_queue WHERE task_id=$1',[f.taskId])).rows[0].credential,null)
 // A fresh task enqueued while no execution process exists survives to a new process.
 const next=await f.service.submit(f.member,{requestId:randomUUID(),conversationId:f.conversationId,to:'office',action:{kind:'delegate',instruction:'Read after restart',execution:'saved-revision'}})
 const final=await backgroundProcess(f)
 await final.wait('done');assert.equal((await final.exit).code,0)
 assert.equal(final.messages.filter(m=>m.phase==='answer').length,1)
 assert.equal((await f.service.memberTask(f.member.token,next.taskId)).state,'succeeded')
})
test('execution process shuts down cleanly and drains disabled queued work without calling the model',async t=>{
 const f=await queued(t),running=await backgroundProcess(f,{hold:true})
 await running.wait('answer')
 running.child.send('stop')
 await running.wait('done');assert.equal((await running.exit).code,0)
 assert.equal((await f.service.memberTask(f.member.token,f.taskId)).state,'failed')
 assert.equal((await f.ownerPool.query('SELECT credential FROM assistant_background_queue WHERE task_id=$1',[f.taskId])).rows[0].credential,null)
 const next=await f.service.submit(f.member,{requestId:randomUUID(),conversationId:f.conversationId,to:'office',action:{kind:'delegate',instruction:'Queued before disable',execution:'saved-revision'}})
 await f.service.configureBackground(f.alice.token,f.conversationId,{enabled:false})
 const draining=await backgroundProcess(f)
 await draining.wait('done');assert.equal((await draining.exit).code,0)
 assert.equal(draining.messages.filter(m=>m.phase==='answer').length,0)
 assert.equal((await f.service.memberTask(f.member.token,next.taskId)).state,'cancelled')
 assert.equal((await f.ownerPool.query('SELECT credential FROM assistant_background_queue WHERE task_id=$1',[next.taskId])).rows[0].credential,null)
})
test('opening, replacing and closing editors does not fence a running background task',async t=>{
 const f=await queued(t),owner={kind:'owner',token:f.alice.token}
 let entered,release
 const started=new Promise(resolve=>{entered=resolve}),gate=new Promise(resolve=>{release=resolve})
 const running=f.runner(async()=>{entered();await gate;return 'Background survived editor lifecycle'}).runOnce()
 await started
 try{
  const firstId=randomUUID(),first=await f.service.connect(owner,f.conversationId,{connectionId:firstId,editorId:randomUUID(),editorGeneration:1})
  assert.equal((await f.service.memberTask(f.member.token,f.taskId)).state,'running')
  const secondId=randomUUID(),second=await f.service.connect(owner,f.conversationId,{connectionId:secondId,editorId:randomUUID(),editorGeneration:1})
  assert.ok(second.connectionEpoch>first.connectionEpoch)
  assert.equal((await f.service.memberTask(f.member.token,f.taskId)).state,'running')
  await f.service.disconnect(owner,f.conversationId,{connectionId:secondId,connectionEpoch:second.connectionEpoch})
  assert.equal((await f.service.memberTask(f.member.token,f.taskId)).state,'running')
 }finally{release();await running}
 const result=await f.service.memberTask(f.member.token,f.taskId)
 assert.equal(result.state,'succeeded');assert.equal(result.summary,'Background survived editor lifecycle')
})

for(const format of ['docx','xlsx','pptx','pdf'])test('background executes authorized saved '+format+' text without editing',async t=>{
 const f=await setup(t),file=(await importFile(f,f.alice.token,await backgroundDocumentBytes(format),'budget.'+format)).file
 const {conversationId}=await f.service.createConversation(f.alice.token,{fileId:file.fileId})
 await f.service.configureBackground(f.alice.token,conversationId,{enabled:true})
 const member=await pair(f,conversationId)
 const {taskId}=await f.service.submit(member,{requestId:randomUUID(),conversationId,to:'office',action:{kind:'delegate',instruction:'Read budget',execution:'saved-revision'}})
 const {createAssistantBackgroundStore}=await import('../../server/src/modules/assistant-channel/background-store.ts')
 const {createAssistantBackgroundRunner}=await import('../../server/src/modules/assistant-channel/background-runner.ts')
 let calls=0
 const runner=createAssistantBackgroundRunner({store:createAssistantBackgroundStore({pool:f.workerPool,deploymentId:f.deploymentId}),service:f.service,objects:f.objects,answer:async input=>{
  calls++;assert.equal(input.format,format);assert.equal(input.revision,file.revision);assert.match(input.text,/42 CNY/);assert.deepEqual(input.tools,[]);return '42 CNY'
 }})
 await runner.runOnce();runner.dispose();await runner.drain()
 assert.equal(calls,1);assert.equal((await f.service.memberTask(member.token,taskId)).state,'succeeded')
})
