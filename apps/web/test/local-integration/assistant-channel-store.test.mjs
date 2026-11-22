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
test('atomic single-use invitation, approval and one-time redemption remain isolated after reconstruction',async t=>{
 const f=await fixture(t),id=f.channel.conversationId
 const invite=await f.service.invite(f.alice.token,id)
 const attempts=await Promise.allSettled([1,2].map(()=>f.service.apply(invite.inviteToken,{displayName:'Test',kind:'codex'})))
 assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1)
 const app=attempts.find(r=>r.status==='fulfilled').value
 assert.equal((await f.service.applicationStatus(app.applicationToken)).state,'pending')
 await assert.rejects(f.service.memberSnapshot(app.applicationToken),{statusCode:401})
 await assert.rejects(f.service.snapshot(f.bob.token,id),{statusCode:404})
 await f.service.approve(f.alice.token,id,app.applicationId,{approved:true})
 const redeemed=await f.service.redeem(app.applicationToken)
 await assert.rejects(f.service.redeem(app.applicationToken),{statusCode:409})
 const restored=createAssistantChannelService({transactions:f.transactions,credentialKey:f.csrfKey})
 assert.equal((await restored.memberSnapshot(redeemed.memberToken)).member.displayName,'Test')
 assert.equal((await f.businessPool.query('SELECT * FROM assistant_members')).rowCount,0)
 await assert.rejects(f.businessPool.query("UPDATE assistant_members SET display_name='forged'"),{code:'42501'})
 await f.service.revoke(f.alice.token,id,redeemed.member.membershipId)
 await assert.rejects(restored.memberSnapshot(redeemed.memberToken),{statusCode:401})
})
test('request replay is exact, claims fence stale connections and lost running tasks never rerun',async t=>{
 const f=await fixture(t),m=await f.join(),id=f.channel.conversationId,connectionId=randomUUID()
 const requestId=randomUUID(),action={kind:'delegate',instruction:'Inspect document'}
 const receipt=await f.submit(m.member.membershipId,action,f.owner,requestId)
 assert.deepEqual(await f.submit(m.member.membershipId,action,f.owner,requestId),receipt)
 await assert.rejects(f.submit(m.member.membershipId,{...action,instruction:'Different'},f.owner,requestId),{statusCode:409})
 const connected=await f.service.connect(m.credential,id,{connectionId})
 const claim=await f.service.claim(m.credential,id,{taskId:receipt.taskId,connectionId,...connected})
 await f.service.connect(m.credential,id,{connectionId:randomUUID()})
 assert.equal((await f.service.memberSnapshot(m.memberToken)).tasks[0].state,'unknown_outcome')
 await assert.rejects(f.submit('office',{kind:'result',taskId:claim.taskId,claimId:claim.claimId,connectionEpoch:claim.connectionEpoch,summary:'late',outcome:'succeeded'},m.credential),{statusCode:409})
 await assert.rejects(f.service.claim(m.credential,id,{taskId:receipt.taskId,connectionId,...connected}),{statusCode:409})
 await f.service.reconcile(m.credential,id,{taskId:claim.taskId,claimId:claim.claimId,connectionEpoch:claim.connectionEpoch,outcome:'succeeded',summary:'Verified execution'})
 assert.equal((await f.service.snapshot(f.alice.token,id)).tasks[0].state,'succeeded')
 await f.files.trashFile(f.alice.token,f.file.fileId)
 await assert.rejects(f.service.memberSnapshot(m.memberToken),{statusCode:404})
 await f.files.restoreFile(f.alice.token,f.file.fileId)
 await f.sessions.logout(f.alice.token)
 await assert.rejects(f.service.memberSnapshot(m.memberToken))
})
test('nested Office question, early child completion and yielding resume without deadlock; cancellation records execution',async t=>{
 const f=await fixture(t),m=await f.join(),id=f.channel.conversationId
 const memberConnection=randomUUID(),officeConnection=randomUUID()
 const mc=await f.service.connect(m.credential,id,{connectionId:memberConnection})
 const oc=await f.service.connect(f.owner,id,{connectionId:officeConnection,editorId:randomUUID(),editorGeneration:1})
 const parent=await f.submit(m.member.membershipId,{kind:'delegate',instruction:'Analyze'})
 const pc=await f.service.claim(m.credential,id,{taskId:parent.taskId,connectionId:memberConnection,...mc})
 const child=await f.submit('office',{kind:'delegate',instruction:'Read current document',parentTaskId:parent.taskId},m.credential)
 const cc=await f.service.claim(f.owner,id,{taskId:child.taskId,connectionId:officeConnection,...oc})
 await f.submit('office',{kind:'result',taskId:cc.taskId,claimId:cc.claimId,connectionEpoch:cc.connectionEpoch,summary:'Read document',outcome:'succeeded'})
 const yielded=await f.service.yieldTask(m.credential,id,{taskId:pc.taskId,claimId:pc.claimId,connectionEpoch:pc.connectionEpoch,childTaskIds:[child.taskId]})
 assert.equal(yielded.state,'queued')
 const resumed=await f.service.claim(m.credential,id,{taskId:parent.taskId,connectionId:memberConnection,...mc})
 await f.submit(m.member.membershipId,{kind:'cancel',taskId:parent.taskId})
 await f.submit('office',{kind:'result',taskId:resumed.taskId,claimId:resumed.claimId,connectionEpoch:resumed.connectionEpoch,summary:'Completed before cancellation',outcome:'succeeded'},m.credential)
 const result=(await f.service.snapshot(f.alice.token,id)).tasks.find(r=>r.taskId===parent.taskId)
 assert.equal(result.state,'cancelled');assert.equal(result.outcome,'succeeded')
})
test('member visibility is restricted and four-member admission cap is atomic',async t=>{
 const f=await fixture(t),a=await f.join('A'),b=await f.join('B')
 const privateTask=await f.submit(a.member.membershipId,{kind:'message',content:'Only A'})
 assert.equal((await f.service.memberSnapshot(b.memberToken)).tasks.length,0)
 assert.equal((await f.service.events(b.credential,f.channel.conversationId)).events.some(e=>e.taskId===privateTask.taskId),false)
 await f.join('C');await f.join('D')
 await assert.rejects(f.join('E'),{statusCode:429})
 await f.service.setPaused(f.alice.token,f.channel.conversationId,true)
 await assert.rejects(f.submit(a.member.membershipId,{kind:'message',content:'Paused'}),{statusCode:409})
})
test('task admission has a ten-minute root deadline, sixteen-child budget and 32-active-task budget',async t=>{
 const f=await fixture(t),m=await f.join(),id=f.channel.conversationId,connectionId=randomUUID()
 const mc=await f.service.connect(m.credential,id,{connectionId})
 const root=await f.submit(m.member.membershipId,{kind:'delegate',instruction:'Root'})
 const claim=await f.service.claim(m.credential,id,{taskId:root.taskId,connectionId,...mc})
 const remaining=new Date(claim.deadlineAt).getTime()-Date.now()
 assert.ok(remaining>590000&&remaining<=600000)
 for(let i=0;i<16;i++)await f.submit('office',{kind:'delegate',instruction:'Child '+i,parentTaskId:root.taskId},m.credential)
 await assert.rejects(f.submit('office',{kind:'delegate',instruction:'Child 17',parentTaskId:root.taskId},m.credential),{statusCode:429})
 const snapshot=await f.service.snapshot(f.alice.token,id)
 assert.ok(snapshot.tasks.every(r=>r.deadlineAt===claim.deadlineAt))
 for(let i=0;i<15;i++)await f.submit(m.member.membershipId,{kind:'message',content:'Additional root '+i})
 await assert.rejects(f.submit(m.member.membershipId,{kind:'message',content:'Over active budget'}),{statusCode:429})
 await assert.rejects(f.service.claim(m.credential,id,{taskId:snapshot.tasks[1].taskId,connectionId,...mc}),{statusCode:409})
})
test('a cancelled executor losing its connection keeps cancellation when execution is later reconciled',async t=>{
 const f=await fixture(t),m=await f.join(),id=f.channel.conversationId,connectionId=randomUUID()
 const connected=await f.service.connect(m.credential,id,{connectionId})
 const receipt=await f.submit(m.member.membershipId,{kind:'message',content:'Run'})
 const claim=await f.service.claim(m.credential,id,{taskId:receipt.taskId,connectionId,...connected})
 await f.submit(m.member.membershipId,{kind:'cancel',taskId:receipt.taskId})
 await f.service.disconnect(m.credential,id,{connectionId,...connected})
 assert.equal((await f.service.memberSnapshot(m.memberToken)).tasks[0].state,'unknown_outcome')
 const reconciled=await f.service.reconcile(m.credential,id,{taskId:claim.taskId,claimId:claim.claimId,connectionEpoch:claim.connectionEpoch,outcome:'succeeded',summary:'Verified completion while cancelling'})
 assert.equal(reconciled.state,'cancelled');assert.equal(reconciled.outcome,'succeeded')
})
test('member heartbeat expires presence and running claims without replay; pause advances notifications',async t=>{
 const f=await fixture(t),m=await f.join(),id=f.channel.conversationId,connectionId=randomUUID()
 const connected=await f.service.connect(m.credential,id,{connectionId})
 assert.equal((await f.service.snapshot(f.alice.token,id)).members[0].online,true)
 const receipt=await f.submit(m.member.membershipId,{kind:'message',content:'Heartbeat-sensitive work'})
 const claim=await f.service.claim(m.credential,id,{taskId:receipt.taskId,connectionId,...connected})
 const age=()=>f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},c=>c.query("UPDATE assistant_members SET last_seen_at=clock_timestamp()-interval '46 seconds' WHERE membership_id=$1",[m.member.membershipId]))
 await age()
 const notices=await f.service.notifications(f.alice.token,f.file.fileId)
 const expired=await f.service.snapshot(f.alice.token,id)
 assert.equal(expired.members[0].online,false)
 assert.equal(expired.tasks[0].state,'unknown_outcome')
 assert.equal(expired.members[0].connectionEpoch,connected.connectionEpoch+1)
 assert.equal(notices[0].sequence,expired.sequence)
 // An authenticated status request renews liveness without resurrecting an
 // expired connection or automatically replaying its running task.
 const memberSnapshot=await f.service.memberSnapshot(m.memberToken)
 assert.equal(memberSnapshot.member.online,false)
 assert.equal(memberSnapshot.tasks[0].state,'unknown_outcome')
 await assert.rejects(f.service.claim(m.credential,id,{taskId:receipt.taskId,connectionId,...connected}),{statusCode:409})
 const reconciled=await f.service.reconcile(m.credential,id,{taskId:claim.taskId,claimId:claim.claimId,connectionEpoch:claim.connectionEpoch,outcome:'succeeded',summary:'Confirmed previous execution'})
 assert.equal(reconciled.state,'succeeded')
 const reconnected=await f.service.connect(m.credential,id,{connectionId:randomUUID()})
 assert.ok(reconnected.connectionEpoch>connected.connectionEpoch)
 await f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},c=>c.query("UPDATE assistant_members SET last_seen_at=clock_timestamp()-interval '30 seconds' WHERE membership_id=$1",[m.member.membershipId]))
 await f.service.memberSnapshot(m.memberToken)
 const timestamp=await f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async c=>(await c.query('SELECT last_seen_at FROM assistant_members WHERE membership_id=$1',[m.member.membershipId])).rows[0].last_seen_at)
 assert.ok(Date.now()-timestamp.getTime()<2000)
 const beforePause=(await f.service.notifications(f.alice.token,f.file.fileId))[0].sequence
 await f.service.setPaused(f.alice.token,id,true)
 const paused=(await f.service.notifications(f.alice.token,f.file.fileId))[0].sequence
 assert.ok(paused>beforePause)
 await f.service.setPaused(f.alice.token,id,false)
 assert.ok((await f.service.notifications(f.alice.token,f.file.fileId))[0].sequence>paused)
})
test('long task history returns bounded previews with active tasks first and authorized full detail',async t=>{
 const f=await fixture(t),m=await f.join(),other=await f.join('Other'),id=f.channel.conversationId
 const instruction='📄'.repeat(8000),summary='\u0001'.repeat(10000)
 // Seed terminal history through the same restricted principal/RLS transaction;
 // avoid 70 irrelevant model/claim runs while testing the real list queries.
 let firstId
 await f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async c=>{
  for(let i=0;i<70;i++) {
   const taskId=randomUUID();firstId??=taskId
   await c.query("INSERT INTO assistant_tasks(task_id,deployment_id,owner_id,conversation_id,root_task_id,depth,sender,recipient,instruction,summary,state,deadline_at) VALUES($1,$2,$3,$4,$1,0,'office',$5,$6,$7,'succeeded',clock_timestamp()+interval '10 minutes')",[taskId,f.deploymentId,f.alice.user.id,id,m.member.membershipId,instruction,summary])
  }
 })
 const active=await f.submit(m.member.membershipId,{kind:'delegate',instruction})
 const owner=await f.service.snapshot(f.alice.token,id),member=await f.service.memberSnapshot(m.memberToken)
 for(const snapshot of [owner,member]) {
  assert.equal(snapshot.tasks.length,64)
  assert.equal(snapshot.tasks[0].taskId,active.taskId)
  assert.ok(snapshot.tasks.every(task=>task.instruction.length<=256&&(task.summary?.length??0)<=512))
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot))<256*1024)
 }
 const detail=await f.service.memberTask(m.memberToken,firstId)
 assert.equal(detail.instruction,instruction);assert.equal(detail.summary,summary)
 await assert.rejects(f.service.memberTask(other.memberToken,firstId),{statusCode:404})
 const connectionId=randomUUID(),connected=await f.service.connect(m.credential,id,{connectionId})
 const claimed=await f.service.claim(m.credential,id,{taskId:active.taskId,connectionId,...connected})
 assert.equal(claimed.instruction,instruction)
})

test('only Office can attach data scope; live recipient claims fence task data access',async t=>{
 const f=await fixture(t),a=await f.join('Analyst'),b=await f.join('Other'),id=f.channel.conversationId
 const dataInputs={sourceIds:['sales'],resultIds:[randomUUID()]}
 const action={kind:'delegate',instruction:'Analyze authorized data',dataInputs}
 await assert.rejects(f.submit('office',action,a.credential),{statusCode:403})
 await assert.rejects(f.submit(b.member.membershipId,action,a.credential),{statusCode:403})
 const receipt=await f.submit(a.member.membershipId,action),connectionId=randomUUID()
 const connected=await f.service.connect(a.credential,id,{connectionId})
 const claim=await f.service.claim(a.credential,id,{taskId:receipt.taskId,connectionId,...connected})
 assert.deepEqual(claim.dataInputs,dataInputs)
 const input={taskId:claim.taskId,claimId:claim.claimId,connectionEpoch:claim.connectionEpoch}
 const check=()=>f.service.authorizeDataClaim(a.memberToken,input)
 const binding=await check()
 assert.deepEqual(binding.inputs,dataInputs);assert.equal(binding.ownerToken,f.alice.token)
 assert.equal(binding.agentId,a.member.agentId)
 await assert.rejects(f.service.authorizeDataClaim(b.memberToken,input))
 await assert.rejects(f.service.authorizeDataClaim(a.memberToken,{...input,claimId:randomUUID()}))
 await f.service.setPaused(f.alice.token,id,true);await assert.rejects(check())
 await f.service.setPaused(f.alice.token,id,false);await assert.rejects(check())
 await f.submit(a.member.membershipId,{kind:'cancel',taskId:claim.taskId});await assert.rejects(check())
 await f.service.connect(a.credential,id,{connectionId:randomUUID()});await assert.rejects(check())
 await f.service.revoke(f.alice.token,id,a.member.membershipId);await assert.rejects(check())
})

test('a second API reads only durable channel event metadata after the snapshot cursor',async t=>{
 const f=await fixture(t),id=f.channel.conversationId,m=await f.join()
 const {sequence}=await f.service.snapshot(f.alice.token,id)
 const task=await f.submit(m.member.membershipId,{kind:'delegate',instruction:'Private review instruction'})
 const second=createAssistantChannelService({transactions:f.transactions,credentialKey:f.csrfKey})
 const page=await second.ownerEventPage(f.alice.token,id,sequence)
 assert.ok(page.events.some(event=>event.taskId===task.taskId))
 for(const event of page.events){
  assert.ok(event.sequence>sequence)
  assert.deepEqual(Object.keys(event).sort(),['kind','sequence','taskId'])
 }
 assert.deepEqual(await second.ownerEventPage(f.alice.token,id,page.events.at(-1).sequence),{events:[]})
 await assert.rejects(second.ownerEventPage(f.bob.token,id,0),{statusCode:404})
 await f.files.trashFile(f.alice.token,f.file.fileId)
 await assert.rejects(second.ownerEventPage(f.alice.token,id,0),{statusCode:404})
})
