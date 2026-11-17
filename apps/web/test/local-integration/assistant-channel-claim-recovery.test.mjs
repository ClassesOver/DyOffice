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


async function expireFixtureTask(f,taskId){
 // Test-only time boundary setup through the migration owner; runtime roles
 // intentionally cannot alter deadlines. Do not broaden runtime privileges.
 const c=await f.ownerPool.connect()
 try{await c.query('BEGIN');await c.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true)",[f.deploymentId,f.alice.user.id]);await c.query("UPDATE assistant_tasks SET deadline_at=clock_timestamp()-interval '1 second' WHERE task_id=$1",[taskId]);await c.query('COMMIT')}catch(error){await c.query('ROLLBACK');throw error}finally{c.release()}
}
test('lost claim receipt can be retrieved with the same request ID only while its live claim remains current',async t=>{
 const f=await fixture(t),id=f.channel.conversationId,m=await f.join(),connectionId=randomUUID()
 const connected=await f.service.connect(m.credential,id,{connectionId})
 const receipt=await f.submit(m.member.membershipId,{kind:'delegate',instruction:'Read only'})
 const input={requestId:randomUUID(),taskId:receipt.taskId,connectionId,...connected}
 const claims=await Promise.all([f.service.claim(m.credential,id,input),f.service.claim(m.credential,id,input)])
 assert.equal(claims[0].claimId,claims[1].claimId)
 const restored=createAssistantChannelService({transactions:f.transactions,credentialKey:f.csrfKey})
 assert.deepEqual(await restored.claim(m.credential,id,input),claims[0])
 await assert.rejects(restored.claim(m.credential,id,{...input,taskId:randomUUID()}),{statusCode:409})
 await assert.rejects(restored.claim(m.credential,id,{...input,requestId:randomUUID()}),{statusCode:409})
 await f.submit('office',{kind:'result',taskId:receipt.taskId,claimId:claims[0].claimId,connectionEpoch:claims[0].connectionEpoch,summary:'Actually completed once',outcome:'succeeded'},m.credential)
 await assert.rejects(restored.claim(m.credential,id,input),{statusCode:409})
})

test('disconnect, revoked membership and stale epoch never turn claim recovery into task replay',async t=>{
 const f=await fixture(t),id=f.channel.conversationId,m=await f.join(),connectionId=randomUUID()
 const connected=await f.service.connect(m.credential,id,{connectionId})
 const receipt=await f.submit(m.member.membershipId,{kind:'delegate',instruction:'Uncertain task'})
 const input={requestId:randomUUID(),taskId:receipt.taskId,connectionId,...connected}
 await f.service.claim(m.credential,id,input)
 await f.service.disconnect(m.credential,id,{connectionId,...connected})
 assert.equal((await f.service.snapshot(f.alice.token,id)).tasks.find(t=>t.taskId===receipt.taskId).state,'unknown_outcome')
 await assert.rejects(f.service.claim(m.credential,id,input),{statusCode:409})
 const nextConnection=randomUUID(),next=await f.service.connect(m.credential,id,{connectionId:nextConnection})
 await assert.rejects(f.service.claim(m.credential,id,{...input,connectionId:nextConnection,...next}),{statusCode:409})
 await f.service.revoke(f.alice.token,id,m.member.membershipId)
 await assert.rejects(f.service.claim(m.credential,id,input),{statusCode:401})
})

test('claim receipts cannot collide with actions or survive pause',async t=>{
 const f=await fixture(t),id=f.channel.conversationId,m=await f.join(),connectionId=randomUUID()
 const connected=await f.service.connect(m.credential,id,{connectionId})
 const receipt=await f.submit(m.member.membershipId,{kind:'delegate',instruction:'Limited task'})
 const collision=randomUUID()
 await f.submit('office',{kind:'message',content:'A separate request'},m.credential,collision)
 const input={taskId:receipt.taskId,connectionId,...connected}
 await assert.rejects(f.service.claim(m.credential,id,{...input,requestId:collision}),{statusCode:409})
 const requestId=randomUUID(),claimed=await f.service.claim(m.credential,id,{...input,requestId})
 const sequence=(await f.service.snapshot(f.alice.token,id)).sequence
 assert.equal((await f.service.claim(m.credential,id,{...input,requestId})).claimId,claimed.claimId)
 assert.equal((await f.service.snapshot(f.alice.token,id)).sequence,sequence,'receipt replay must not emit another task event')
 await f.service.setPaused(f.alice.token,id,true)
 await assert.rejects(f.service.claim(m.credential,id,{...input,requestId}),{statusCode:409})
 await f.service.setPaused(f.alice.token,id,false)
})

for(const lostResponses of [1,2])test(`real HTTP drops ${lostResponses} committed claim response(s) without duplicate execution`,async t=>{
 const {default:Fastify}=await import('fastify')
 const {createCsrfService}=await import('../../server/src/modules/auth/csrf.ts')
 const {registerAssistantChannelRoutes}=await import('../../server/src/modules/assistant-channel/routes.ts')
 const {createAssistantChannelClient}=await import('../../../../packages/browser-host/src/assistant-channel.ts')
 const {restrictedOrigin}=await import('../helpers/restricted.mjs')
 const f=await fixture(t),id=f.channel.conversationId,m=await f.join()
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey}),api=Fastify()
 registerAssistantChannelRoutes(api,f.service,csrf);t.after(()=>api.close())
 let lost=0,executed=0;const claims=[]
 const request=async(url,method='GET',payload)=>{
  if(url.endsWith('/channels')&&method==='POST')payload={...payload,conversationId:id}
  const reply=await api.inject({url,method,payload,headers:{origin:restrictedOrigin,cookie:'__Host-dyoffice-session='+f.alice.token,'x-csrf-token':csrf.sessionToken(f.alice.token)}})
  if(reply.statusCode!==200)throw Object.assign(Error('HTTP '+reply.statusCode),{statusCode:reply.statusCode})
  if(url.endsWith('/claim')){claims.push({input:payload,result:reply.json()});if(lost++<lostResponses)throw new TypeError('Simulated response loss after committed HTTP transaction')}
  return reply.json()
 }
 const browser=createAssistantChannelClient({request,fileId:f.file.fileId,editorId:randomUUID(),generation:()=>1});t.after(()=>browser.dispose())
 browser.control.register({isBusy:()=>false,requestYield(){},continue(){assert.fail('Not a native parent')},async execute(){executed++;return {text:'Read once',cancelled:false}}})
 await browser.start()
 const task=await f.submit('office',{kind:'delegate',instruction:'Read scoped paragraph'},m.credential)
 await browser.refresh()
 for(let i=0;i<100&&claims.length<2;i++)await new Promise(r=>setTimeout(r,10))
 for(let i=0;i<20;i++){await browser.refresh();await new Promise(r=>setTimeout(r,5))}
 assert.equal(claims.length,2)
 assert.equal(claims[0].input.requestId,claims[1].input.requestId)
 assert.equal(claims[0].result.claimId,claims[1].result.claimId)
 assert.equal(executed,lostResponses===1?1:0)
 const durable=(await f.service.snapshot(f.alice.token,id)).tasks.find(t=>t.taskId===task.taskId)
 assert.equal(durable.state,lostResponses===1?'succeeded':'running')
 browser.dispose()
 if(lostResponses===2){
  for(let i=0;i<30;i++){const snapshot=await f.service.snapshot(f.alice.token,id);if(snapshot.tasks.find(t=>t.taskId===task.taskId).state==='unknown_outcome')break;await new Promise(r=>setTimeout(r,10))}
  assert.equal((await f.service.snapshot(f.alice.token,id)).tasks.find(t=>t.taskId===task.taskId).state,'unknown_outcome')
 }
})

test('a running claim acknowledgement cannot be recovered after its task deadline',async t=>{
 const f=await fixture(t),id=f.channel.conversationId,m=await f.join(),connectionId=randomUUID()
 const connected=await f.service.connect(m.credential,id,{connectionId})
 const receipt=await f.submit(m.member.membershipId,{kind:'delegate',instruction:'Deadline bound'})
 const input={requestId:randomUUID(),taskId:receipt.taskId,connectionId,...connected}
 await f.service.claim(m.credential,id,input)
 await expireFixtureTask(f,receipt.taskId)
 await assert.rejects(f.service.claim(m.credential,id,input),{statusCode:409})
})
