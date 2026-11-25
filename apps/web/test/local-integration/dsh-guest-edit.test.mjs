import test from 'node:test'
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import assert from 'node:assert/strict'
import {createCsrfService} from '../../server/src/modules/auth/csrf.ts'
import {createAssistantChannelService} from '../../server/src/modules/assistant-channel/service.ts'
import {fileFixture,docxBytes,importFile} from '../helpers/files.mjs'
import {restrictedOrigin as origin} from '../helpers/restricted.mjs'

test('DSH guest authorization is explicit and bound to the channel document',async t=>{
 const nativeDocsDirectory=await mkdtemp(join(tmpdir(),'dsh-guest-editor-'))
 t.after(()=>rm(nativeDocsDirectory,{recursive:true,force:true}))
 await mkdir(join(nativeDocsDirectory,'.vite'))
 await mkdir(join(nativeDocsDirectory,'assets'))
 await writeFile(join(nativeDocsDirectory,'assets/editor.js'),'void 0')
 await writeFile(join(nativeDocsDirectory,'index.html'),'<title>Editor</title>')
 await writeFile(join(nativeDocsDirectory,'.vite/manifest.json'),'{"entry":{"file":"assets/editor.js"}}')
 await writeFile(join(nativeDocsDirectory,'.vite/native-assets.json'),'[]')
 const f=await fileFixture(t,{assistantChannels:true,nativeDocsDirectory})
 const {file}=await importFile(f,f.alice.token,await docxBytes())
 const {file:other}=await importFile(f,f.alice.token,await docxBytes(),'other.docx')
 const service=createAssistantChannelService({transactions:f.transactions,credentialKey:f.csrfKey})
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin,key:f.csrfKey})
 const {conversationId}=await service.createConversation(f.alice.token,{fileId:file.fileId})
 const legacy=await service.issueDshToken(f.alice.token,conversationId,60,true)
 const issue=()=>f.app.inject({method:'POST',url:'/api/v1/assistant-channels/channels/'+conversationId+'/dsh-token',
  headers:{origin,cookie:'__Host-dyoffice-session='+f.alice.token,'x-csrf-token':csrf.sessionToken(f.alice.token)},
  payload:{expiresInMinutes:60,allowEdit:true}})
 const open=(token,id,proof)=>f.app.inject({method:'POST',url:'/api/v1/assistant-channels/member/documents/'+id+'/edit-ticket',
  headers:{authorization:'Bearer '+token,...(proof?{'x-dyoffice-document-preview':proof}:{})},payload:{}})
 const authorized=await issue()
 assert.equal(authorized.statusCode,200,authorized.body)
 const {memberToken,membershipId}=authorized.json()
 assert.equal((await open(legacy.memberToken,file.fileId)).statusCode,403)
 assert.equal((await open(memberToken,other.fileId)).statusCode,403)
 await assert.rejects(service.createMemberDocument(memberToken,f.files,{format:'docx',title:'disabled'}),{statusCode:403})
 const creator=await service.issueDshToken(f.alice.token,conversationId,60,true,true)
 const created=await service.createMemberDocument(creator.memberToken,f.files,{format:'docx',title:'created'})
 assert.equal((await open(creator.memberToken,created.fileId)).statusCode,403)
 const createdGrant=await open(creator.memberToken,created.fileId,created.previewProof)
 assert.equal(createdGrant.statusCode,200,createdGrant.body)
 assert.equal((await open(memberToken,created.fileId,created.previewProof)).statusCode,403)
 const issued=await open(memberToken,file.fileId)
 assert.equal(issued.statusCode,200,issued.body)
 const redeem=ticket=>f.app.inject({method:'POST',url:'/dsh-edit/redeem',headers:{origin},payload:{ticket}})
 const {ticket}=issued.json()
 const redeemed=await redeem(ticket)
 assert.equal(redeemed.statusCode,200,redeemed.body)
 assert.equal((await redeem(ticket)).statusCode,401)
 const otherTab=await redeem((await open(memberToken,file.fileId)).json().ticket)
 const expiredEditor=new URL(otherTab.json().url,origin).searchParams.get('editorId')
 const expiredCookie=otherTab.headers['set-cookie'].split(';')[0]
 await f.ownerPool.query("UPDATE dsh_edit_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[expiredEditor])
 assert.equal((await f.app.inject({url:otherTab.json().url,headers:{cookie:expiredCookie}})).statusCode,401)
 const cookie=redeemed.headers['set-cookie'].split(';')[0]
 const {url}=redeemed.json()
 const editorId=new URL(url,origin).searchParams.get('editorId')
 assert.equal((await f.app.inject({url,headers:{cookie}})).statusCode,200)
 assert.equal((await f.app.inject({url:url.replace(file.fileId,other.fileId),headers:{cookie}})).statusCode,404)
 const headers={cookie,referer:origin+url}
 const route='/api/v1/files/'+file.fileId
 const get=(path)=>f.app.inject({url:path,headers})
 assert.equal((await get(route)).statusCode,200)
 assert.equal((await get('/api/v1/files/'+other.fileId)).statusCode,404)
 assert.equal((await get('/api/v1/files')).statusCode,404)
 assert.equal((await get('/api/v1/auth/me')).statusCode,404)
 assert.equal((await f.app.inject({url:'/api/v1/auth/me',headers:{cookie}})).statusCode,401)
 assert.equal((await get('/api/v1/ai/catalog')).statusCode,404)
 const proof=await get('/api/v1/auth/csrf')
 const write=(method,url,payload,extra={})=>f.app.inject({method,url,payload,headers:{...headers,origin,'x-csrf-token':proof.json().csrfToken,...extra}})
 assert.equal((await write('POST',route+'/lease',{editorId:crypto.randomUUID()})).statusCode,404)
 assert.equal((await write('POST',route+'/lease',{editorId},{'x-csrf-token':'x'.repeat(43)})).statusCode,403)
 const lease=await write('POST',route+'/lease',{editorId})
 assert.equal(lease.statusCode,200,lease.body)
 const bytes=await docxBytes()
 const staged=await write('POST',route+'/uploads',{size:bytes.length,baseRevision:file.revision,leaseEpoch:lease.json().leaseEpoch,editorId})
 assert.equal(staged.statusCode,201,staged.body)
 const ownerUpload=await f.files.stageUpload(f.alice.token,{name:'owner.docx',size:bytes.length})
 const put=id=>write('PUT','/api/v1/uploads/'+id+'/content',bytes,{'content-type':'application/octet-stream'})
 assert.equal((await put(ownerUpload.uploadId)).statusCode,404)
 const uploaded=await put(staged.json().uploadId)
 assert.equal(uploaded.statusCode,200,uploaded.body)
 const saved=await write('POST',route+'/commits',{fileId:file.fileId,uploadId:staged.json().uploadId,baseRevision:file.revision,leaseEpoch:lease.json().leaseEpoch,idempotencyKey:crypto.randomUUID()})
 assert.equal(saved.statusCode,200,saved.body)
 assert.notEqual((await get(route)).json().file.revision,file.revision)
 await service.revoke(f.alice.token,conversationId,membershipId)
 assert.equal((await get(route)).statusCode,401)
})
