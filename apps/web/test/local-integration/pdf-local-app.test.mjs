import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {PDFDocument} from 'pdf-lib'
import {fileFixture} from '../helpers/files.mjs'
import {restrictedOrigin} from '../helpers/restricted.mjs'
import {SESSION_COOKIE} from '../../server/src/modules/auth/csrf.ts'

async function fixture(t){
 const f=await fileFixture(t) // Real buildLocalApp, not optional route-only assembly.
 const address=await f.app.listen({host:'127.0.0.1',port:0})
 async function request(path,{token=f.alice.token,method='GET',body,headers={}}={}){
  const base={cookie:`${SESSION_COOKIE}=${token}`,origin:restrictedOrigin}
  if(method!=='GET'){
   const response=await fetch(address+'/api/v1/auth/csrf',{headers:base})
   assert.equal(response.status,200)
   base['x-csrf-token']=(await response.json()).csrfToken
  }
  return fetch(address+path,{method,headers:{...base,...headers},body})
 }
 async function importPdf(token=f.alice.token){
  const doc=await PDFDocument.create();doc.addPage([200,100]);const bytes=Buffer.from(await doc.save())
  const stage=await request('/api/v1/files/uploads',{token,method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'合成.pdf',size:bytes.length})})
  assert.equal(stage.status,201);const upload=await stage.json()
  const put=await request(`/api/v1/uploads/${upload.uploadId}/content`,{token,method:'PUT',headers:{'content-type':'application/octet-stream'},body:bytes});assert.equal(put.status,200)
  const finish=await request(`/api/v1/uploads/${upload.uploadId}/finish`,{token,method:'POST'});assert.equal(finish.status,200)
  return {bytes,opened:await finish.json()}
 }
 return {...f,request,importPdf}
}
test('real local app imports PDF and serves exact revision bytes as attachment without enabling editing',async t=>{
 const f=await fixture(t),{bytes,opened}=await f.importPdf()
 const response=await f.request(`/api/v1/files/${opened.file.fileId}`);assert.equal(response.status,200)
 const file=await response.json();assert.equal(file.format,'pdf');assert.equal(file.capabilities.pdf,'unsupported')
 assert.equal(file.downloadEndpoint,`/api/v1/files/${file.file.fileId}/content?revision=${file.file.revision}`)
 const tracked=await f.request(`/api/v1/workspace/files/${file.file.fileId}/open`,{method:'POST'});assert.equal(tracked.status,204)
 const download=await f.request(file.downloadEndpoint);assert.equal(download.status,200)
 assert.equal(download.headers.get('content-type'),'application/octet-stream')
 assert.match(download.headers.get('content-disposition'),/^attachment;/)
 assert.equal(download.headers.get('content-security-policy'),"sandbox; default-src 'none'")
 assert.equal(download.headers.get('cache-control'),'private, no-store')
 const actual=Buffer.from(await download.arrayBuffer());assert.deepEqual(actual,bytes)
 assert.equal(createHash('sha256').update(actual).digest('hex'),file.file.sha256)
 for(const path of [`/api/v1/files/${file.file.fileId}/content`,`/api/v1/files/${file.file.fileId}/content?revision=${randomUUID()}`])assert.ok([400,404].includes((await f.request(path)).status))
 // Optional recovery is still unmounted: no implication of a trusted save ticket.
 assert.equal((await f.request('/api/v1/pdf-recovery/lookup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({fileId:file.file.fileId,idempotencyKey:'unavailable-ticket'})})).status,501)
})
test('real local PDF routes refuse cross-owner download and revoked or trashed access',async t=>{
 const f=await fixture(t),{opened}=await f.importPdf(),file=opened.file
 const path=`/api/v1/files/${file.fileId}/content?revision=${file.revision}`
 for(const token of [f.bob.token,f.adminSigned.token]){
  assert.equal((await f.request(`/api/v1/files/${file.fileId}`,{token})).status,404)
  assert.equal((await f.request(path,{token})).status,404)
 }
 const ownOther=await f.importPdf()
 assert.equal((await f.request(`/api/v1/files/${file.fileId}/content?revision=${ownOther.opened.file.revision}`)).status,404)
 const other=await f.importPdf(f.bob.token)
 assert.equal((await f.request(`/api/v1/files/${file.fileId}/content?revision=${other.opened.file.revision}`)).status,404)
 assert.equal((await f.request(`/api/v1/files/${file.fileId}`,{method:'DELETE'})).status,204)
 assert.equal((await f.request(path)).status,404)
 await f.sessions.logout(f.alice.token)
 assert.equal((await f.request(path)).status,401)
})
