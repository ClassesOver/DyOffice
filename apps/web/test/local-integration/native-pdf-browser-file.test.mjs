import test from 'node:test'
import assert from 'node:assert/strict'
import {PDFDocument} from 'pdf-lib'
import {createSessionFileHost} from '../../../../packages/browser-host/src/files.ts'
import {readFileBytes} from '../../../pdf/src/renderer/file-bytes.ts'
import {openNativePdfBrowserFile} from '../../src/editors/native-pdf-browser-file.ts'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {restrictedOrigin} from '../helpers/restricted.mjs'

async function pdf(text) {
 const doc=await PDFDocument.create()
 doc.addPage([300,240]).drawText(text)
 return await doc.save()
}

test('native PDF reader pins revision, validates bytes and denies stale or foreign sessions',async t=>{
 const f=await fileFixture(t),original=await pdf('First version')
 const {file}=await importFile(f,f.alice.token,Buffer.from(original),'Project notes.pdf')
 const address=await f.app.listen({port:0,host:'127.0.0.1'})
 let actor=f.alice.token,corrupt=false
 const downloads=[]
 const fetchImpl=async(path,init={})=>{
  const response=await fetch(address+path,{...init,headers:{...Object.fromEntries(new Headers(init.headers)),origin:restrictedOrigin,...(actor?{cookie:'__Host-dyoffice-session='+actor}:{})}})
  if(path.includes('/content?')){
   downloads.push(path)
   if(corrupt&&response.ok){const bytes=new Uint8Array(await response.arrayBuffer());bytes[0]^=1;return new Response(bytes,{headers:{'content-type':'application/octet-stream'}})}
  }
  return response
 }
 actor=undefined
 await assert.rejects(openNativePdfBrowserFile({fileId:file.fileId,fetchImpl}))
 actor=f.bob.token
 await assert.rejects(openNativePdfBrowserFile({fileId:file.fileId,fetchImpl}))
 actor=f.alice.token
 const opened=await openNativePdfBrowserFile({fileId:file.fileId,fetchImpl})
 t.after(()=>opened.dispose())
 const path=await opened.api.consumePending()
 assert.equal(path.split('/').at(-1),'Project notes.pdf')
 assert.equal(await opened.api.consumePending(),null)
 assert.deepEqual(opened.revision,file)
 await assert.rejects(opened.api.readFile('/ungranted.pdf'))
 await assert.rejects(opened.api.readFileChunk(path,5,4))
 assert.equal(downloads.length,0)
 const writer=createSessionFileHost({fetchImpl})
 t.after(()=>writer.dispose())
 await writer.open(file.fileId);await writer.acquireLease(file.fileId)
 const saved=await writer.save(file.fileId,await pdf('Changed head'))
 assert.notEqual(saved.revision,file.revision)
 assert.deepEqual(await readFileBytes(opened.api,path,40),original)
 assert.deepEqual(downloads,[`/api/v1/files/${file.fileId}/content?revision=${file.revision}`])
 corrupt=true
 await assert.rejects(opened.api.readFile(path),{code:'INVALID_RESPONSE'})
 corrupt=false
 const first=await opened.api.readFileChunk(path,0,40)
 assert.deepEqual(first.data,original.slice(0,40))
 actor=f.bob.token
 await assert.rejects(opened.api.readFileChunk(path,40,80),{code:'stale_session'})
 opened.dispose()
 actor=f.alice.token
 await assert.rejects(opened.api.readFile(path))
})
