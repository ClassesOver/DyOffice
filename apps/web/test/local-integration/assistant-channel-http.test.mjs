import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import {randomUUID} from 'node:crypto'
import {fileFixture,docxBytes,importFile} from '../helpers/files.mjs'
import {restrictedOrigin} from '../helpers/restricted.mjs'
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
