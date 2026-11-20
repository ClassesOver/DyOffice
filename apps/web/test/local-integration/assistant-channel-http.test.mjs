import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import {randomUUID} from 'node:crypto'
import {fileFixture,docxBytes,importFile} from '../helpers/files.mjs'
import {restrictedOrigin} from '../helpers/restricted.mjs'
import {password} from '../helpers/identity.mjs'
import {createCsrfService} from '../../server/src/modules/auth/csrf.ts'
import {createAssistantChannelService} from '../../server/src/modules/assistant-channel/service.ts'
import {registerAssistantChannelRoutes} from '../../server/src/modules/assistant-channel/routes.ts'

test('real HTTP pairing limits credentials to their application/channel/member and revokes immediately',async t=>{
 const f=await fileFixture(t),file=(await importFile(f,f.alice.token,await docxBytes())).file
 const service=createAssistantChannelService({transactions:f.transactions,credentialKey:f.csrfKey})
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey})
 const api=Fastify();registerAssistantChannelRoutes(api,service,csrf);t.after(()=>api.close())
 const base='/api/v1/assistant-channels'
 const ownerHeaders=token=>({origin:restrictedOrigin,cookie:'__Host-dyoffice-session='+token,'x-csrf-token':csrf.sessionToken(token)})
 const post=(url,payload,headers={})=>api.inject({method:'POST',url:base+url,payload,headers})
 const alice=ownerHeaders(f.alice.token),bob=ownerHeaders(f.bob.token)
 const channel=(await post('/channels',{fileId:file.fileId},alice)).json()
 const id=channel.conversationId
 assert.equal((await post('/channels/'+id+'/invitations',{},bob)).statusCode,404)
 assert.equal((await post('/channels/'+id+'/invitations',{},{})).statusCode,403)
 const invite=(await post('/channels/'+id+'/invitations',{},alice)).json()
 assert.equal((await post('/applications',{inviteToken:invite.inviteToken,name:'Unsafe',kind:'custom',avatarUrl:'https://tracker.invalid'})).statusCode,400)
 const application=(await post('/applications',{inviteToken:invite.inviteToken,name:'External',kind:'custom'})).json()
 const appHeaders={authorization:'Bearer '+application.applicationToken}
 assert.equal((await api.inject({url:base+'/channels/'+id,headers:appHeaders})).statusCode,401)
 assert.equal((await post('/applications/'+application.applicationId+'/redeem',{},appHeaders)).statusCode,409)
 assert.equal((await post('/channels/'+id+'/applications/'+application.applicationId+'/approve',{approved:true},alice)).statusCode,200)
 const redeemed=(await post('/applications/'+application.applicationId+'/redeem',{},appHeaders)).json()
 const memberId=redeemed.memberId,memberHeaders={authorization:'Bearer '+redeemed.memberToken}
 assert.equal((await post('/applications/'+application.applicationId+'/redeem',{},appHeaders)).statusCode,409)
 assert.equal((await api.inject({url:base+'/members/'+randomUUID()+'/tasks',headers:memberHeaders})).statusCode,403)
 assert.equal((await api.inject({url:base+'/members/'+memberId+'/tasks',headers:{...memberHeaders,cookie:alice.cookie}})).statusCode,401)
 const tasks=await api.inject({url:base+'/members/'+memberId+'/tasks',headers:memberHeaders})
 assert.equal(tasks.statusCode,200);assert.deepEqual(tasks.json().tasks,[])
 assert.equal(tasks.headers['cache-control'],'private, no-store')
 const forged={requestId:randomUUID(),conversationId:id,to:'office',from:'office',action:{kind:'delegate',instruction:'Read'}}
 assert.equal((await post('/members/'+memberId+'/actions',forged,memberHeaders)).statusCode,400)
 assert.equal((await post('/channels/'+id+'/members/'+memberId+'/revoke',{},alice)).statusCode,200)
 assert.equal((await api.inject({url:base+'/members/'+memberId+'/tasks',headers:memberHeaders})).statusCode,401)
 // Revocation never upgrades the sealed token to a generic owner credential.
 assert.equal((await f.app.inject({url:'/api/v1/files/'+file.fileId,headers:memberHeaders})).statusCode,401)
})

test('owner deletes a channel, its background tasks and DSH access without deleting the document',async t=>{
 const f=await fileFixture(t),file=(await importFile(f,f.alice.token,await docxBytes())).file
 const service=createAssistantChannelService({transactions:f.transactions,credentialKey:f.csrfKey,backgroundEnabled:true})
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey})
 const api=Fastify();registerAssistantChannelRoutes(api,service,csrf);t.after(()=>api.close())
 const base='/api/v1/assistant-channels'
 const ownerHeaders=token=>({origin:restrictedOrigin,cookie:'__Host-dyoffice-session='+token,'x-csrf-token':csrf.sessionToken(token)})
 const alice=ownerHeaders(f.alice.token),bob=ownerHeaders(f.bob.token)
 const {conversationId}=await service.createConversation(f.alice.token,{fileId:file.fileId})
 const path=base+'/channels/'+conversationId
 await service.configureBackground(f.alice.token,conversationId,{enabled:true})
 const {memberToken}=await service.issueDshToken(f.alice.token,conversationId)
 const member={authorization:'Bearer '+memberToken}
 const snapshot=await service.memberSnapshot(memberToken)
 const {taskId}=await service.submit({kind:'member',token:memberToken},{requestId:randomUUID(),conversationId,to:'office',action:{kind:'delegate',instruction:'Read document',execution:'saved-revision'}})
 assert.ok(taskId)
 const remove=headers=>api.inject({method:'DELETE',url:path,headers})
 assert.equal((await remove({...alice,'x-csrf-token':'invalid'})).statusCode,403)
 assert.equal((await remove(bob)).statusCode,404)
 assert.equal((await api.inject({url:path,headers:alice})).statusCode,200)
 assert.equal((await api.inject({url:base+'/member',headers:member})).statusCode,200)
 assert.equal((await remove(alice)).statusCode,204)
 assert.equal((await api.inject({url:path,headers:alice})).statusCode,404)
 assert.deepEqual((await service.listChannels(f.alice.token)).items,[])
 assert.equal((await api.inject({url:base+'/member',headers:member})).statusCode,404)
 assert.equal((await api.inject({url:base+'/background-tasks/'+taskId,headers:alice})).statusCode,404)
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
})

test('DSH authorization history reveals only a live code from the issuing session on request',async t=>{
 const f=await fileFixture(t)
 const service=createAssistantChannelService({transactions:f.transactions,credentialKey:f.csrfKey})
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey})
 const api=Fastify();registerAssistantChannelRoutes(api,service,csrf,undefined,undefined,f.files);t.after(()=>api.close())
 const headers=token=>({origin:restrictedOrigin,cookie:'__Host-dyoffice-session='+token,'x-csrf-token':csrf.sessionToken(token)})
 const alice=headers(f.alice.token),bob=headers(f.bob.token)
 const {conversationId}=await service.createConversation(f.alice.token,{})
 const base='/api/v1/assistant-channels/channels/'+conversationId
 const issued=await service.issueDshToken(f.alice.token,conversationId,60,true)
 const {member}=await service.memberSnapshot(issued.memberToken)
 const endpoint=base+'/members/'+member.membershipId+'/dsh-token'
 const reveal=(headers=alice)=>api.inject({method:'POST',url:endpoint,headers,payload:{}})
 const history=await api.inject({url:base,headers:alice})
 assert.ok(!history.body.includes(issued.memberToken))
 assert.equal(history.json().members[0].canRevealDshToken,true)
 assert.ok(history.json().members[0].issuedAt)
 const anotherSession=headers((await f.sessions.login('alice',password)).token)
 assert.equal((await reveal(anotherSession)).statusCode,404)
 assert.equal((await api.inject({url:base,headers:anotherSession})).json().members[0].dshTokenFromOtherSession,true)
 assert.equal((await reveal(bob)).statusCode,404)
 assert.equal((await reveal({...alice,'x-csrf-token':'invalid'})).statusCode,403)
 const response=await reveal()
 assert.equal(response.statusCode,200)
 assert.equal(response.headers['cache-control'],'private, no-store')
 assert.equal(response.json().memberToken,issued.memberToken)
 const stored=(await f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},c=>c.query('SELECT dsh_token_envelope FROM assistant_members WHERE membership_id=$1',[member.membershipId]))).rows[0].dsh_token_envelope
 assert.ok(stored&&!stored.includes(issued.memberToken))
 await service.revoke(f.alice.token,conversationId,member.membershipId)
 assert.equal((await reveal()).statusCode,404)
 const after=await service.snapshot(f.alice.token,conversationId)
 assert.equal(after.members[0].canRevealDshToken,false)
 assert.equal(after.members[0].revoked,true)
})
