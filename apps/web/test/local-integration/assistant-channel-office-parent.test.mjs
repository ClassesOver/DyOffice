import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {fileFixture,docxBytes,importFile} from '../helpers/files.mjs'
import {createAssistantChannelService} from '../../server/src/modules/assistant-channel/service.ts'
async function fixture(t) {
 const f=await fileFixture(t)
 const file=(await importFile(f,f.alice.token,await docxBytes())).file
 const service=createAssistantChannelService({transactions:f.transactions,credentialKey:f.csrfKey})
 const channel=await service.createConversation(f.alice.token,{fileId:file.fileId})
 const owner={kind:'owner',token:f.alice.token}
 async function join(name='Agent') {
  const invite=await service.invite(f.alice.token,channel.conversationId)
  const application=await service.apply(invite.inviteToken,{displayName:name,kind:'custom'})
  await service.approve(f.alice.token,channel.conversationId,application.applicationId,{approved:true})
  const redeemed=await service.redeem(application.applicationToken)
  return {...redeemed,credential:{kind:'member',token:redeemed.memberToken},application,invite}
 }
 const submit=(to,action,credential=owner,requestId=randomUUID())=>service.submit(credential,{requestId,conversationId:channel.conversationId,to,action})
 return {...f,service,file,channel,owner,join,submit}
}

test('Office parent creation is connection-bound and idempotent under concurrent requests',async t=>{
 const f=await fixture(t),id=f.channel.conversationId,connectionId=randomUUID(),editorId=randomUUID()
 const connected=await f.service.connect(f.owner,id,{connectionId,editorId,editorGeneration:1})
 const input={requestId:randomUUID(),connectionId,...connected,instruction:'Analyze current document'}
 const parents=await Promise.all([f.service.beginOfficeTask(f.alice.token,id,input),f.service.beginOfficeTask(f.alice.token,id,input)])
 assert.equal(parents[0].taskId,parents[1].taskId);assert.equal(parents[0].state,'running')
 assert.equal((await f.service.snapshot(f.alice.token,id)).tasks.length,1)
 await assert.rejects(f.service.beginOfficeTask(f.alice.token,id,{...input,instruction:'Changed'}),{statusCode:409})
 await assert.rejects(f.service.beginOfficeTask(f.bob.token,id,input),{statusCode:404})
 await assert.rejects(f.service.beginOfficeTask(f.alice.token,id,{...input,connectionId:randomUUID()}),{statusCode:409})
 await f.service.connect(f.owner,id,{connectionId:randomUUID(),editorId,editorGeneration:2})
 await assert.rejects(f.service.beginOfficeTask(f.alice.token,id,input),{statusCode:409})
})

test('Office parent yields, nested question runs, and restart resumes with durable child evidence once',async t=>{
 const f=await fixture(t),id=f.channel.conversationId,m=await f.join(),officeConnection=randomUUID(),memberConnection=randomUUID()
 const oc=await f.service.connect(f.owner,id,{connectionId:officeConnection,editorId:randomUUID(),editorGeneration:1})
 const mc=await f.service.connect(m.credential,id,{connectionId:memberConnection})
 const begin={requestId:randomUUID(),connectionId:officeConnection,...oc,instruction:'Analyze current document',origin:{revision:null,modelId:'fixture',callId:'call-1'}}
 const parent=await f.service.beginOfficeTask(f.alice.token,id,begin)
 const child=await f.submit(m.member.membershipId,{kind:'delegate',instruction:'Analyze paragraph',parentTaskId:parent.taskId})
 const yielded=await f.service.yieldTask(f.owner,id,{taskId:parent.taskId,claimId:parent.claimId,connectionEpoch:parent.connectionEpoch,childTaskIds:[child.taskId]})
 assert.equal(yielded.state,'waiting_peer')
 const cc=await f.service.claim(m.credential,id,{taskId:child.taskId,connectionId:memberConnection,...mc})
 const question=await f.submit('office',{kind:'delegate',instruction:'Read paragraph',parentTaskId:child.taskId},m.credential)
 const qc=await f.service.claim(f.owner,id,{taskId:question.taskId,connectionId:officeConnection,...oc})
 await f.submit(m.member.membershipId,{kind:'result',taskId:qc.taskId,claimId:qc.claimId,connectionEpoch:qc.connectionEpoch,summary:'Paragraph facts',outcome:'succeeded'})
 await f.submit('office',{kind:'result',taskId:cc.taskId,claimId:cc.claimId,connectionEpoch:cc.connectionEpoch,summary:'Analyzed facts',outcome:'succeeded'},m.credential)
 const restored=createAssistantChannelService({transactions:f.transactions,credentialKey:f.csrfKey})
 const claim={taskId:parent.taskId,connectionId:officeConnection,...oc,requestId:randomUUID()}
 const origin=parent.continuationOrigin
 assert.deepEqual(origin,{revision:f.file.revision,modelId:'fixture',callId:'call-1'})
 for(const wrong of [undefined,{...origin,revision:randomUUID()},{...origin,modelId:'other'},{...origin,callId:'other-call'}])
  await assert.rejects(restored.claim(f.owner,id,{...claim,origin:wrong}),{statusCode:409})
 const resumed=await restored.claim(f.owner,id,{...claim,origin})
 assert.equal(resumed.continuation.parentTaskId,parent.taskId)
 assert.deepEqual(resumed.continuation.children.map(c=>[c.taskId,c.summary]),[[child.taskId,'Analyzed facts']])
 const {createLeaseService}=await import('../../server/src/modules/leases/service.ts')
 const {createRevisionService}=await import('../../server/src/modules/revisions/service.ts')
 const revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
 const editorId=randomUUID(),lease=await createLeaseService({transactions:f.transactions}).acquireLease(f.alice.token,f.file.fileId,{editorId})
 const bytes=await docxBytes()
 const upload=await revisions.stageUpload(f.alice.token,f.file.fileId,{size:bytes.length,baseRevision:origin.revision,editorId,leaseEpoch:lease.leaseEpoch})
 await f.files.receiveUpload(f.alice.token,upload.uploadId,bytes)
 const saved=await revisions.commitRevision(f.alice.token,{fileId:f.file.fileId,uploadId:upload.uploadId,baseRevision:origin.revision,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID()})
 assert.notEqual(saved.revision,origin.revision)
 // A lost reply is recovered by replaying the same request: the recorded
 // claim and task come back even though the document has been saved since.
 // (The browser re-checks the revision before it continues.)
 assert.equal((await restored.claim(f.owner,id,{...claim,origin})).claimId,resumed.claimId)
 assert.equal((await restored.beginOfficeTask(f.alice.token,id,begin)).taskId,parent.taskId)
 // A new request is still bound to the current revision.
 await assert.rejects(restored.beginOfficeTask(f.alice.token,id,{...begin,requestId:randomUUID(),origin:{revision:origin.revision,modelId:'fixture',callId:'call-2'}}),{statusCode:409})
 assert.notEqual(resumed.claimId,parent.claimId)
 await assert.rejects(restored.claim(f.owner,id,{taskId:parent.taskId,connectionId:officeConnection,...oc}),{statusCode:409})
 await f.submit('office',{kind:'result',taskId:resumed.taskId,claimId:resumed.claimId,connectionEpoch:resumed.connectionEpoch,summary:'Final answer',outcome:'succeeded'})
 assert.equal((await restored.snapshot(f.alice.token,id)).tasks.find(t=>t.taskId===parent.taskId).state,'succeeded')
})

test('early child completion and yield retries are exact; revoked session cannot resume parent',async t=>{
 const f=await fixture(t),id=f.channel.conversationId,m=await f.join(),connectionId=randomUUID(),memberConnection=randomUUID()
 const oc=await f.service.connect(f.owner,id,{connectionId,editorId:randomUUID(),editorGeneration:1})
 const mc=await f.service.connect(m.credential,id,{connectionId:memberConnection})
 const parent=await f.service.beginOfficeTask(f.alice.token,id,{requestId:randomUUID(),connectionId,...oc,instruction:'Analyze'})
 const child=await f.submit(m.member.membershipId,{kind:'delegate',instruction:'Compute',parentTaskId:parent.taskId})
 const cc=await f.service.claim(m.credential,id,{taskId:child.taskId,connectionId:memberConnection,...mc})
 await f.submit('office',{kind:'result',taskId:cc.taskId,claimId:cc.claimId,connectionEpoch:cc.connectionEpoch,summary:'Computed',outcome:'succeeded'},m.credential)
 const input={taskId:parent.taskId,claimId:parent.claimId,connectionEpoch:parent.connectionEpoch,childTaskIds:[child.taskId]}
 assert.equal((await f.service.yieldTask(f.owner,id,input)).state,'queued')
 assert.equal((await f.service.yieldTask(f.owner,id,input)).state,'queued')
 await assert.rejects(f.service.yieldTask(f.owner,id,{...input,childTaskIds:[randomUUID()]}),{statusCode:409})
 await f.sessions.logout(f.alice.token)
 await assert.rejects(f.service.claim(f.owner,id,{taskId:parent.taskId,connectionId,...oc}))
})

test('multiple children finish out of order; continuation claim is atomic and parent cancellation cannot wake',async t=>{
 const f=await fixture(t),id=f.channel.conversationId,m=await f.join(),connectionId=randomUUID(),memberConnection=randomUUID()
 const oc=await f.service.connect(f.owner,id,{connectionId,editorId:randomUUID(),editorGeneration:1})
 const mc=await f.service.connect(m.credential,id,{connectionId:memberConnection})
 const parent=await f.service.beginOfficeTask(f.alice.token,id,{requestId:randomUUID(),connectionId,...oc,instruction:'Compare'})
 const a=await f.submit(m.member.membershipId,{kind:'delegate',instruction:'A',parentTaskId:parent.taskId})
 const b=await f.submit(m.member.membershipId,{kind:'delegate',instruction:'B',parentTaskId:parent.taskId})
 await f.service.yieldTask(f.owner,id,{taskId:parent.taskId,claimId:parent.claimId,connectionEpoch:parent.connectionEpoch,childTaskIds:[a.taskId,b.taskId]})
 for(const child of [b,a]){
  const cc=await f.service.claim(m.credential,id,{taskId:child.taskId,connectionId:memberConnection,...mc})
  await f.submit('office',{kind:'result',taskId:cc.taskId,claimId:cc.claimId,connectionEpoch:cc.connectionEpoch,summary:'x'.repeat(2000),outcome:'succeeded'},m.credential)
  if(child===b)assert.equal((await f.service.snapshot(f.alice.token,id)).tasks.find(t=>t.taskId===parent.taskId).state,'waiting_peer')
 }
 const claims=await Promise.allSettled([1,2].map(()=>f.service.claim(f.owner,id,{taskId:parent.taskId,connectionId,...oc})))
 assert.equal(claims.filter(r=>r.status==='fulfilled').length,1)
 const resumed=claims.find(r=>r.status==='fulfilled').value
 assert.deepEqual(resumed.continuation.children.map(c=>c.taskId),[a.taskId,b.taskId])
 assert.ok(resumed.continuation.children.every(c=>c.summaryTruncated&&c.summary.length<600))
 await f.submit('office',{kind:'cancel',taskId:parent.taskId})
 await assert.rejects(f.service.yieldTask(f.owner,id,{taskId:parent.taskId,claimId:resumed.claimId,connectionEpoch:resumed.connectionEpoch,childTaskIds:[a.taskId,b.taskId]}),{statusCode:409})
})

test('owner HTTP entry enforces CSRF, identity, strict payload and current document authority',async t=>{
 const {default:Fastify}=await import('fastify')
 const {createCsrfService}=await import('../../server/src/modules/auth/csrf.ts')
 const {registerAssistantChannelRoutes}=await import('../../server/src/modules/assistant-channel/routes.ts')
 const {restrictedOrigin}=await import('../helpers/restricted.mjs')
 const f=await fixture(t),id=f.channel.conversationId,connectionId=randomUUID()
 const oc=await f.service.connect(f.owner,id,{connectionId,editorId:randomUUID(),editorGeneration:1})
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey})
 const api=Fastify();registerAssistantChannelRoutes(api,f.service,csrf);t.after(()=>api.close())
 const url='/api/v1/assistant-channels/channels/'+id+'/office-task'
 const headers={origin:restrictedOrigin,cookie:'__Host-dyoffice-session='+f.alice.token,'x-csrf-token':csrf.sessionToken(f.alice.token)}
 const payload={requestId:randomUUID(),connectionId,...oc,instruction:'Only this document'}
 assert.equal((await api.inject({method:'POST',url,headers,payload:{...payload,ownerId:f.alice.user.id}})).statusCode,400)
 assert.notEqual((await api.inject({method:'POST',url,headers:{origin:restrictedOrigin,cookie:headers.cookie},payload})).statusCode,200)
 const reply=await api.inject({method:'POST',url,headers,payload});assert.equal(reply.statusCode,200);assert.equal(reply.json().state,'running')
 await f.files.trashFile(f.alice.token,f.file.fileId)
 assert.equal((await api.inject({method:'POST',url,headers,payload})).statusCode,404)
})

test('waiting parent retries are fenced by reconnect and revoked member cannot claim child',async t=>{
 const f=await fixture(t),id=f.channel.conversationId,m=await f.join(),connectionId=randomUUID(),memberConnection=randomUUID(),editorId=randomUUID()
 const oc=await f.service.connect(f.owner,id,{connectionId,editorId,editorGeneration:1})
 const mc=await f.service.connect(m.credential,id,{connectionId:memberConnection})
 const parent=await f.service.beginOfficeTask(f.alice.token,id,{requestId:randomUUID(),connectionId,...oc,instruction:'Wait for scoped analysis'})
 const child=await f.submit(m.member.membershipId,{kind:'delegate',instruction:'Analyze',parentTaskId:parent.taskId})
 const yieldInput={taskId:parent.taskId,claimId:parent.claimId,connectionEpoch:parent.connectionEpoch,childTaskIds:[child.taskId]}
 assert.equal((await f.service.yieldTask(f.owner,id,yieldInput)).state,'waiting_peer')
 assert.equal((await f.service.yieldTask(f.owner,id,yieldInput)).state,'waiting_peer')
 await f.service.connect(f.owner,id,{connectionId:randomUUID(),editorId,editorGeneration:2})
 await assert.rejects(f.service.yieldTask(f.owner,id,yieldInput),{statusCode:409})
 await f.service.revoke(f.alice.token,id,m.member.membershipId)
 await assert.rejects(f.service.claim(m.credential,id,{taskId:child.taskId,connectionId:memberConnection,...mc}),{statusCode:401})
})
