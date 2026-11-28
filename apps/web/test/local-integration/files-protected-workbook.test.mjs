import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createHash,randomUUID} from 'node:crypto'
import officeCrypto from 'officecrypto-tool'
import JSZip from 'jszip'
import {docxBytes,fileFixture} from '../helpers/files.mjs'
import {restrictedOrigin} from '../helpers/restricted.mjs'
import {password as accountPassword} from '../helpers/identity.mjs'
import {createCsrfService} from '../../server/src/modules/auth/csrf.ts'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'

const password='测试 workbook password'
const mime='application/vnd.dyoffice.encrypted-xlsx'
const sample=(name='sheets/acceptance.xlsx')=>readFile(new URL('../fixtures/'+name,import.meta.url))
const framed=(bytes,secret)=>{
 const text=Buffer.from(secret,'utf8'),size=Buffer.alloc(2);size.writeUInt16BE(text.length)
 return Buffer.concat([size,text,bytes])
}
function headers(f,token=f.alice.token){
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey})
 return {origin:restrictedOrigin,cookie:'__Host-dyoffice-session='+token,'x-csrf-token':csrf.sessionToken(token)}
}
const path=upload=>`/api/v1/uploads/${upload.uploadId}`

test('encrypted DOCX import and unlock retain ciphertext and fence edits',async t=>{
 const f=await fileFixture(t),plain=await docxBytes(),encrypted=officeCrypto.encrypt(plain,{password}),auth=headers(f)
 const stage=await f.files.stageUpload(f.alice.token,{name:'protected.docx',size:encrypted.length})
 const contentType='application/vnd.dyoffice.encrypted-docx'
 const put=(secret,type=contentType)=>f.app.inject({method:'PUT',url:path(stage)+'/content',headers:{...auth,'content-type':type},payload:framed(encrypted,secret)})
 assert.equal((await put(password,mime)).statusCode,415)
 assert.equal((await put(password)).statusCode,200)
 const published=await f.app.inject({method:'POST',url:path(stage)+'/finish',headers:auth})
 assert.equal(published.statusCode,200)
 const {file,documentPasswordProtected,downloadEndpoint}=published.json()
 assert.equal(documentPasswordProtected,true)
 const unlock=(secret,headers=auth,revision=file.revision)=>f.app.inject({method:'POST',url:`/api/v1/files/${file.fileId}/docx/unlock`,headers,payload:{revision,password:secret}})
 assert.equal((await unlock(password,headers(f,f.bob.token))).statusCode,404)
 assert.equal((await unlock(password,{...auth,'x-csrf-token':'wrong'})).statusCode,403)
 assert.equal((await unlock(password,auth,randomUUID())).statusCode,409)
 assert.equal((await unlock('wrong')).statusCode,422)
 const opened=await unlock(password)
 assert.equal(opened.statusCode,200)
 assert.equal(opened.headers['cache-control'],'private, no-store')
 assert.deepEqual(opened.rawPayload,plain)
 const download=await f.app.inject({method:'GET',url:downloadEndpoint,headers:auth})
 assert.deepEqual(download.rawPayload,Buffer.from(encrypted))
 const edit=await f.app.inject({method:'POST',url:`/api/v1/files/${file.fileId}/lease`,headers:auth,payload:{editorId:randomUUID()}})
 assert.equal(edit.statusCode,423)
 const copy=f.files.prepareDuplicate(f.alice.token,file.fileId)
 const {uploadId,revision}=await copy
 const duplicated=await f.files.finishDuplicate(f.alice.token,file.fileId,uploadId,revision,'en')
 assert.equal(duplicated.documentPasswordProtected,true)
 assert.deepEqual(await f.files.readFile(f.alice.token,duplicated.file.fileId,duplicated.file.revision),Buffer.from(encrypted))
})

test('the DOCX import receipt grants one read of the published revision to the uploading login',async t=>{
 const f=await fileFixture(t),plain=await docxBytes(),encrypted=officeCrypto.encrypt(plain,{password}),auth=headers(f)
 async function upload(name){
  const stage=await f.files.stageUpload(f.alice.token,{name,size:encrypted.length})
  const ready=await f.app.inject({method:'PUT',url:path(stage)+'/content',headers:{...auth,'content-type':'application/vnd.dyoffice.encrypted-docx','x-dyoffice-open-after-import':'1'},payload:framed(encrypted,password)})
  assert.equal(ready.statusCode,200)
  const {unlockId}=ready.json()
  assert.match(unlockId,/^[\da-f-]{36}$/)
  return {stage,unlockId}
 }
 const {stage,unlockId}=await upload('handoff.docx')
 const base=`/api/v1/files/${stage.fileId}/docx/import-unlock`
 const claim=(credential,revision)=>f.app.inject({method:'POST',url:base,headers:credential,payload:{revision,unlockId}})
 assert.equal((await claim(auth,randomUUID())).statusCode,404)
 const {file}=await f.files.finishUpload(f.alice.token,stage.uploadId)
 const otherLogin=(await f.sessions.login('alice',accountPassword)).token
 assert.equal((await claim(headers(f,otherLogin),file.revision)).statusCode,404)
 assert.equal((await claim(headers(f,f.bob.token),file.revision)).statusCode,404)
 assert.equal((await claim({...auth,'x-csrf-token':'wrong'},file.revision)).statusCode,403)
 assert.equal((await claim(auth,randomUUID())).statusCode,409)
 const abandoned=await upload('abandoned-handoff.docx')
 const other=await f.files.finishUpload(f.alice.token,abandoned.stage.uploadId)
 const otherUrl=`/api/v1/files/${other.file.fileId}/docx/import-unlock`
 const requestOther=(method,token,grant)=>f.app.inject({method,url:otherUrl,headers:headers(f,token),payload:{revision:other.file.revision,unlockId:grant}})
 assert.equal((await requestOther('POST',f.alice.token,unlockId)).statusCode,404)
 assert.equal((await requestOther('DELETE',otherLogin,abandoned.unlockId)).statusCode,404)
 assert.equal((await requestOther('DELETE',f.alice.token,abandoned.unlockId)).statusCode,204)
 assert.equal((await requestOther('POST',f.alice.token,abandoned.unlockId)).statusCode,404)
 assert.deepEqual(await f.files.readFile(f.alice.token,other.file.fileId,other.file.revision),Buffer.from(encrypted))
 const results=await Promise.all([claim(auth,file.revision),claim(auth,file.revision)])
 assert.deepEqual(results.map(result=>result.statusCode).sort(),[200,404])
 const opened=results.find(result=>result.statusCode===200)
 assert.deepEqual(opened.rawPayload,plain)
 assert.equal(opened.headers['cache-control'],'private, no-store')
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),Buffer.from(encrypted))
})

test('an unlocked DOCX editor publishes encrypted revisions with its original password',async t=>{
 const f=await fileFixture(t,{wordCollaboration:true}),auth=headers(f),plain=await docxBytes(),encrypted=officeCrypto.encrypt(plain,{password})
 const stage=await f.files.stageUpload(f.alice.token,{name:'editable.docx',size:encrypted.length})
 await f.files.receiveUpload(f.alice.token,stage.uploadId,encrypted,{password,format:'docx'})
 const {file}=await f.files.finishUpload(f.alice.token,stage.uploadId),url=`/api/v1/files/${file.fileId}`
 const post=(suffix,payload,credential=auth)=>f.app.inject({method:'POST',url:url+suffix,headers:credential,payload})
 const editorId=randomUUID(),opened=await post('/docx/unlock',{revision:file.revision,password,editorId})
 assert.equal(opened.statusCode,200)
 const unlockId=opened.headers['x-dyoffice-docx-unlock']
 assert.match(unlockId,/^[\da-f-]{36}$/)
 const leaseInput={editorId,docxUnlockId:unlockId}
 assert.equal((await post('/docx/unlock',{revision:file.revision,password,editorId})).headers['x-dyoffice-docx-unlock'],unlockId)
 assert.equal((await post('/word-collab',{revision:file.revision,clientId:editorId})).statusCode,423)
 const other=(await f.sessions.login('alice',accountPassword)).token
 assert.equal((await post('/lease',leaseInput,headers(f,other))).statusCode,423)
 assert.equal((await post('/lease',{...leaseInput,editorId:randomUUID()})).statusCode,423)
 const lease=await post('/lease',leaseInput)
 assert.equal(lease.statusCode,200)
 const {leaseEpoch}=lease.json()
 const base={baseRevision:file.revision,editorId,leaseEpoch}
 assert.equal((await post('/uploads',{...base,size:plain.length})).statusCode,423)
 const edited=await JSZip.loadAsync(plain),entry=edited.file('word/document.xml')
 edited.file(entry.name,(await entry.async('string')).replace('A filler 1','Encrypted Word revision'))
 const draft=await edited.generateAsync({type:'nodebuffer'})
 const prepare=(input,grant=unlockId)=>post('/docx/uploads?'+new URLSearchParams({...input,leaseEpoch:String(leaseEpoch)}),draft,{...auth,'content-type':'application/octet-stream','x-dyoffice-docx-unlock':grant})
 assert.equal((await prepare(base,randomUUID())).statusCode,423)
 const ready=await prepare(base)
 assert.equal(ready.statusCode,200,ready.body)
 const commit={fileId:file.fileId,uploadId:ready.json().uploadId,baseRevision:file.revision,leaseEpoch,idempotencyKey:randomUUID()}
 const saved=await post('/commits',commit)
 assert.equal(saved.statusCode,200,saved.body)
 assert.deepEqual((await post('/commits',commit)).json(),saved.json())
 const current=await f.files.openFile(f.alice.token,file.fileId)
 assert.equal(current.documentPasswordProtected,true)
 const updated=await f.files.readFile(f.alice.token,file.fileId,current.file.revision)
 assert.deepEqual(Buffer.from(await officeCrypto.decrypt(updated,{password})),draft)
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),Buffer.from(encrypted))
 assert.equal((await post('/lease/renew',{...leaseInput,leaseEpoch})).statusCode,200)
 assert.equal((await prepare(base)).statusCode,409)
 const staged=await prepare({...base,baseRevision:current.file.revision})
 assert.equal(staged.statusCode,200)
 assert.equal((await f.app.inject({method:'DELETE',url:url+'/docx/unlock',headers:auth,payload:{unlockId}})).statusCode,204)
 assert.equal((await post('/commits',{...commit,uploadId:staged.json().uploadId,baseRevision:current.file.revision,idempotencyKey:randomUUID()})).statusCode,423)
 assert.deepEqual((await post('/commits',commit)).json(),saved.json())
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,current.file.revision)
})

test('a DOCX recovery export keeps the saved password and requires the editor grant without a lease',async t=>{
 const f=await fileFixture(t),auth=headers(f),plain=await docxBytes(),encrypted=Buffer.from(officeCrypto.encrypt(plain,{password}))
 const upload=await f.files.stageUpload(f.alice.token,{name:'encrypted recovery.docx',size:encrypted.length})
 await f.files.receiveUpload(f.alice.token,upload.uploadId,encrypted,{password,format:'docx'})
 const {file}=await f.files.finishUpload(f.alice.token,upload.uploadId),editorId=randomUUID(),base='/api/v1/files/'+file.fileId
 const unlock=await f.app.inject({method:'POST',url:base+'/docx/unlock',headers:auth,payload:{revision:file.revision,password,editorId}})
 assert.equal(unlock.statusCode,200)
 const id=unlock.headers['x-dyoffice-docx-unlock']
 const draftZip=await JSZip.loadAsync(plain),entry=draftZip.file('word/document.xml')
 draftZip.file(entry.name,(await entry.async('string')).replace('A filler 1','Never saved recovery text'))
 const draft=await draftZip.generateAsync({type:'nodebuffer'})
 const exportDraft=(editor=editorId,credential=auth)=>f.app.inject({method:'POST',url:base+'/docx/recovery-draft?'+new URLSearchParams({editorId:editor}),
  headers:{...credential,'content-type':'application/octet-stream','x-dyoffice-docx-unlock':id},payload:draft})
 assert.equal((await exportDraft(randomUUID())).statusCode,423)
 const other=(await f.sessions.login('alice',accountPassword)).token
 assert.equal((await exportDraft(editorId,headers(f,other))).statusCode,423)
 const before=await f.files.usage(f.alice.token)
 const recovery=await exportDraft()
 assert.equal(recovery.statusCode,200,recovery.body)
 assert.equal(recovery.headers['cache-control'],'private, no-store')
 assert.deepEqual(Buffer.from(await officeCrypto.decrypt(recovery.rawPayload,{password})),draft)
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
 assert.deepEqual(await f.files.usage(f.alice.token),before)
 assert.equal((await f.app.inject({method:'DELETE',url:base+'/docx/unlock',headers:auth,payload:{unlockId:id}})).statusCode,204)
 assert.equal((await exportDraft()).statusCode,423)
})

test('Save As stages an encrypted DOCX copy without changing the source revision',async t=>{
 const f=await fileFixture(t),auth=headers(f),plain=await docxBytes(),ciphertext=Buffer.from(officeCrypto.encrypt(plain,{password}))
 const upload=await f.files.stageUpload(f.alice.token,{name:'source.docx',size:ciphertext.length})
 await f.files.receiveUpload(f.alice.token,upload.uploadId,ciphertext,{password,format:'docx'})
 const {file}=await f.files.finishUpload(f.alice.token,upload.uploadId)
 const source='/api/v1/files/'+file.fileId,editorId=randomUUID()
 const post=(url,payload,credential=auth)=>f.app.inject({method:'POST',url,headers:credential,payload})
 const opened=await post(source+'/docx/unlock',{revision:file.revision,password,editorId})
 assert.equal(opened.statusCode,200)
 const docxUnlockId=opened.headers['x-dyoffice-docx-unlock']
 const lease=await post(source+'/lease',{editorId,docxUnlockId})
 assert.equal(lease.statusCode,200)
 const {leaseEpoch}=lease.json()
 const modified=await JSZip.loadAsync(plain),document=modified.file('word/document.xml')
 modified.file(document.name,(await document.async('string')).replace('A filler 1','Unsaved copy content'))
 const draft=await modified.generateAsync({type:'nodebuffer'})
 const prepare=(options={},credential=auth,grant=docxUnlockId,secret)=>post(
  source+'/docx/copy/uploads?'+new URLSearchParams({name:'加密副本.docx',baseRevision:file.revision,editorId,leaseEpoch,...options}),
  secret===undefined?draft:framed(draft,secret),{...credential,'content-type':secret===undefined?'application/octet-stream':'application/vnd.dyoffice.docx-password-change','x-dyoffice-docx-unlock':grant})
 const other=(await f.sessions.login('alice',accountPassword)).token
 assert.equal((await prepare({},headers(f,other))).statusCode,423)
 assert.equal((await prepare({baseRevision:randomUUID()})).statusCode,409)
 assert.equal((await prepare({leaseEpoch:leaseEpoch+1})).statusCode,409)
 assert.equal((await prepare({},auth,randomUUID())).statusCode,423)
 const staged=await prepare()
 assert.equal(staged.statusCode,201,staged.body)
 assert.equal((await f.files.listFiles(f.alice.token)).files.length,1)
 const finish=()=>post(path(staged.json())+'/finish',undefined)
 const published=await finish()
 assert.equal(published.statusCode,200,published.body)
 assert.deepEqual((await finish()).json(),published.json())
 const copy=published.json()
 assert.equal(copy.name,'加密副本.docx')
 assert.equal(copy.documentPasswordProtected,true)
 assert.notEqual(copy.file.fileId,file.fileId)
 const copyBytes=await f.files.readFile(f.alice.token,copy.file.fileId,copy.file.revision)
 assert.deepEqual(Buffer.from(await officeCrypto.decrypt(copyBytes,{password})),draft)
 const selected='copy only 文档'
 assert.equal((await prepare({},auth,randomUUID(),'')).statusCode,423)
 for (const [name,secret] of [['Rotated copy.docx',selected],['Unprotected copy.docx','']]){
  const next=await prepare({name},auth,docxUnlockId,secret)
  assert.equal(next.statusCode,201,next.body)
  const done=await post(path(next.json())+'/finish')
  assert.equal(done.statusCode,200,done.body)
  const ready=done.json()
  assert.equal(ready.documentPasswordProtected,secret?true:undefined)
  const bytes=await f.files.readFile(f.alice.token,ready.file.fileId,ready.file.revision)
  assert.deepEqual(secret?Buffer.from(await officeCrypto.decrypt(bytes,{password:secret})):bytes,draft)
 }
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),ciphertext)
})

test('DOCX password changes publish one revision with the selected protection',async t=>{
 const f=await fileFixture(t,{wordCollaboration:true}),auth=headers(f),draft=await docxBytes()
 const upload=await f.files.stageUpload(f.alice.token,{name:'managed.docx',size:draft.length})
 await f.files.receiveUpload(f.alice.token,upload.uploadId,draft)
 const {file}=await f.files.finishUpload(f.alice.token,upload.uploadId)
 const editorId=randomUUID(),url='/api/v1/files/'+file.fileId
 const post=(suffix,payload,credential=auth)=>f.app.inject({method:'POST',url:url+suffix,headers:credential,payload})
 const lease=await post('/lease',{editorId})
 assert.equal(lease.statusCode,200)
 const {leaseEpoch}=lease.json()
 const prepare=(baseRevision,secret,unlockId)=>post(
  '/docx/password/uploads?'+new URLSearchParams({baseRevision,editorId,leaseEpoch}),
  framed(draft,secret),{...auth,'content-type':'application/vnd.dyoffice.docx-password-change',...(unlockId&&{'x-dyoffice-docx-unlock':unlockId})})
 const first=await prepare(file.revision,password)
 assert.equal(first.statusCode,200,first.body)
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
 const input=(stage,baseRevision)=>({fileId:file.fileId,uploadId:stage.json().uploadId,baseRevision,leaseEpoch,idempotencyKey:randomUUID()})
 const set=input(first,file.revision)
 const setResult=await post('/commits',set)
 assert.equal(setResult.statusCode,200,setResult.body)
 assert.deepEqual((await post('/commits',set)).json(),setResult.json())
 const protectedRevision=setResult.json().revision
 const read=r=>f.files.readFile(f.alice.token,file.fileId,r)
 const setBytes=await read(protectedRevision)
 assert.deepEqual(Buffer.from(await officeCrypto.decrypt(setBytes,{password})),draft)
 assert.equal((await post('/word-collab',{revision:protectedRevision,clientId:editorId})).statusCode,423)
 assert.equal((await prepare(protectedRevision,'new secret')).statusCode,423)
 const unlock=(revision,password)=>post('/docx/unlock',{revision,password,editorId})
 const oldGrant=(await unlock(protectedRevision,password)).headers['x-dyoffice-docx-unlock']
 assert.match(oldGrant,/^[\da-f-]{36}$/)
 const nextPassword='new 文档 🔑'
 const nextStage=await prepare(protectedRevision,nextPassword,oldGrant)
 assert.equal(nextStage.statusCode,200,nextStage.body)
 const changed=await post('/commits',input(nextStage,protectedRevision))
 assert.equal(changed.statusCode,200,changed.body)
 const changedRevision=changed.json().revision,changedBytes=await read(changedRevision)
 assert.equal((await post('/lease/renew',{editorId,leaseEpoch,docxUnlockId:oldGrant})).statusCode,423)
 assert.equal((await unlock(changedRevision,password)).statusCode,422)
 assert.deepEqual(Buffer.from(await officeCrypto.decrypt(changedBytes,{password:nextPassword})),draft)
 const newGrant=(await unlock(changedRevision,nextPassword)).headers['x-dyoffice-docx-unlock']
 assert.match(newGrant,/^[\da-f-]{36}$/)
 const revoked=await prepare(changedRevision,'',newGrant)
 assert.equal(revoked.statusCode,200,revoked.body)
 assert.equal((await f.app.inject({method:'DELETE',url:url+'/docx/unlock',headers:auth,payload:{unlockId:newGrant}})).statusCode,204)
 assert.equal((await post('/commits',input(revoked,changedRevision))).statusCode,423)
 const renewedGrant=(await unlock(changedRevision,nextPassword)).headers['x-dyoffice-docx-unlock']
 const remove=await prepare(changedRevision,'',renewedGrant)
 assert.equal(remove.statusCode,200,remove.body)
 const removed=await post('/commits',input(remove,changedRevision))
 assert.equal(removed.statusCode,200,removed.body)
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).documentPasswordProtected,undefined)
 assert.deepEqual(await read(removed.json().revision),draft)
 assert.deepEqual(await read(file.revision),draft)
 assert.deepEqual(await read(protectedRevision),setBytes)
 assert.deepEqual(await read(changedRevision),changedBytes)
 assert.equal((await post('/word-collab',{revision:file.revision,clientId:editorId})).statusCode,409)
 assert.equal((await post('/word-collab',{revision:removed.json().revision,clientId:editorId})).statusCode,200)
})

test('password-validated XLSX import publishes only original ciphertext and records its protection',async t=>{
 const f=await fileFixture(t),bytes=Buffer.from(officeCrypto.encrypt(await sample(),{password})),auth=headers(f)
 const staged=await f.app.inject({method:'POST',url:'/api/v1/files/uploads',headers:auth,payload:{name:'protected.xlsx',size:bytes.length}})
 assert.equal(staged.statusCode,201)
 const upload=staged.json(),payload=framed(bytes,password)
 const put=(auth,payload)=>f.app.inject({method:'PUT',url:path(upload)+'/content',headers:{...auth,'content-type':mime},payload})
 assert.equal((await put(headers(f,f.bob.token),payload)).statusCode,404)
 assert.equal((await put({...auth,'x-csrf-token':'invalid'},payload)).statusCode,403)
 const ready=await put(auth,payload)
 assert.equal(ready.statusCode,200,ready.body)
 assert.equal(ready.json().sha256,createHash('sha256').update(bytes).digest('hex'))
 assert.equal(JSON.stringify(ready.json()).includes(password),false)
 await assert.rejects(f.files.openFile(f.alice.token,upload.fileId),{statusCode:404})
 const finish=()=>f.app.inject({method:'POST',url:path(upload)+'/finish',headers:auth})
 const published=await finish(),opened=published.json()
 assert.equal(published.statusCode,200)
 assert.equal(opened.workbookPasswordProtected,true)
 assert.deepEqual((await finish()).json(),opened)
 assert.deepEqual(await f.files.openFile(f.alice.token,upload.fileId),opened)
 const download=await f.app.inject({method:'GET',url:opened.downloadEndpoint,headers:auth})
 assert.equal(download.statusCode,200)
 assert.deepEqual(download.rawPayload,bytes)
 assert.equal((await f.files.usage(f.alice.token)).storedBytes,bytes.length)
 const leases=createLeaseService({transactions:f.transactions}),editorId=randomUUID()
 const lease=await leases.acquireLease(f.alice.token,upload.fileId,{editorId})
 const revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
 await assert.rejects(revisions.stageUpload(f.alice.token,upload.fileId,{
  size:bytes.length,baseRevision:opened.file.revision,editorId,leaseEpoch:lease.leaseEpoch,
 }),{statusCode:423})
 const copyUpload=await f.files.prepareDuplicate(f.alice.token,opened.file.fileId)
 const copy=await f.files.finishDuplicate(f.alice.token,opened.file.fileId,copyUpload.uploadId,copyUpload.revision,'en')
 assert.equal(copy.workbookPasswordProtected,true)
 assert.deepEqual(await f.files.readFile(f.alice.token,copy.file.fileId,copy.file.revision),bytes)
})

test('wrong passwords and encrypted payloads of another Office type publish nothing',async t=>{
 const f=await fileFixture(t),auth=headers(f)
 for(const [bytes,secret,status] of [
  [officeCrypto.encrypt(await sample(),{password}),'wrong',422],
  [officeCrypto.encrypt(await sample('slides/acceptance.pptx'),{password}),password,400],
 ]){
  const upload=await f.files.stageUpload(f.alice.token,{name:'protected.xlsx',size:bytes.length})
  const received=await f.app.inject({method:'PUT',url:path(upload)+'/content',headers:{...auth,'content-type':mime},payload:framed(bytes,secret)})
  assert.equal(received.statusCode,status,received.body)
  await assert.rejects(f.files.finishUpload(f.alice.token,upload.uploadId),{statusCode:409})
  await assert.rejects(f.files.openFile(f.alice.token,upload.fileId),{statusCode:404})
 }
 const usage=await f.files.usage(f.alice.token)
 assert.equal(usage.storedBytes,0)
 assert.equal(usage.reservedBytes,0)
})
