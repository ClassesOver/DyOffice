import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {PDFDocument,degrees} from 'pdf-lib'
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {createWorkspaceService} from '../../server/src/modules/workspace/service.ts'
import {createPdfService} from '../../server/src/modules/pdf/service.ts'

test('PDF split publishes each original upload exactly once and keeps its source intact',async t=>{
 const f=await fileFixture(t,{buildApp:false}),doc=await PDFDocument.create()
 for(let i=1;i<=5;i++)doc.addPage([300,200]).drawText(`Page ${i}`,{x:20,y:100,size:12})
 doc.getPage(2).setRotation(degrees(90))
 const original=Buffer.from(await doc.save()),source=(await importFile(f,f.alice.token,original,'source.pdf')).file
 const leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
 const pdf=createPdfService({files:f.files,leases,revisions}),editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,source.fileId,{editorId})
 const input={baseRevision:source.revision,editorId,leaseEpoch:lease.leaseEpoch,pagesPerFile:2}
 await assert.rejects(pdf.stageSplit(f.bob.token,source.fileId,input),error=>error.statusCode===404)
 await assert.rejects(pdf.stageSplit(f.alice.token,source.fileId,{...input,leaseEpoch:lease.leaseEpoch+1}),error=>error.statusCode===409)
 for(const pagesPerFile of [0,1.5,5,6])await assert.rejects(pdf.stageSplit(f.alice.token,source.fileId,{...input,pagesPerFile}),error=>error.statusCode===400)
 const workspace=createWorkspaceService(f.transactions)
 const folder=await workspace.createFolder(f.alice.token,{name:'Parts',parentId:null})
 const other=await workspace.createFolder(f.bob.token,{name:'Private parts',parentId:null})
 await assert.rejects(pdf.stageSplit(f.alice.token,source.fileId,{...input,name:'Selected.pdf',folderId:other.id}),{statusCode:404})
 const prepared=await pdf.stageSplit(f.alice.token,source.fileId,{...input,name:'Selected.pdf',folderId:folder.id})
 assert.equal(prepared.files.length,3)
 assert.equal(new Set(prepared.files.map(file=>file.fileId)).size,3)
 assert.equal((await f.files.listFiles(f.alice.token)).files.length,1)
 const first=await f.files.finishUpload(f.alice.token,prepared.files[0].uploadId)
 assert.equal((await f.files.listFiles(f.alice.token)).files.length,2)
 assert.deepEqual(await f.files.finishUpload(f.alice.token,prepared.files[0].uploadId),first)
 await assert.rejects(f.files.finishUpload(f.bob.token,prepared.files[1].uploadId),error=>error.statusCode===404)
 for(const [index,part]of prepared.files.entries()){
  const saved=await f.files.finishUpload(f.alice.token,part.uploadId)
  assert.equal(saved.name,`Selected-${index+1}.pdf`)
  assert.equal(saved.file.fileId,part.fileId);assert.equal(saved.file.sha256,part.sha256);assert.equal(saved.file.size,part.size)
  const bytes=await f.files.readFile(f.alice.token,part.fileId,saved.file.revision)
  const task=getDocument({data:Uint8Array.from(bytes),disableFontFace:true,useSystemFonts:true})
  try{
   const pdf=await task.promise
   assert.equal(pdf.numPages,index===2?1:2)
   for(let pageNumber=1;pageNumber<=pdf.numPages;pageNumber++){
    const page=await pdf.getPage(pageNumber),sourcePage=index*2+pageNumber
    assert.equal((await page.getTextContent()).items.map(item=>item.str??'').join(''),`Page ${sourcePage}`)
    assert.equal(page.rotate,sourcePage===3?90:0)
   }
  }finally{await task.destroy()}
 }
 assert.deepEqual((await workspace.listFiles(f.alice.token,{folderId:folder.id})).files.map(file=>file.name).sort(),['Selected-1.pdf','Selected-2.pdf','Selected-3.pdf'])
 assert.equal((await f.files.listFiles(f.alice.token)).files.length,4)
 assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,source.revision)
 assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),original)
 // A 409 is not evidence of non-publication: committed uploads also fence auth versions.
 await f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async c=>{
  await c.query('UPDATE uploads SET auth_version=auth_version+1 WHERE id=$1',[prepared.files[0].uploadId])
 })
 await assert.rejects(f.files.finishUpload(f.alice.token,prepared.files[0].uploadId),error=>error.statusCode===409)
 assert.equal((await f.files.openFile(f.alice.token,prepared.files[0].fileId)).file.fileId,prepared.files[0].fileId)
 const abandoned=await pdf.stageSplit(f.alice.token,source.fileId,input)
 await f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async c=>{
  await c.query("UPDATE uploads SET created_at=clock_timestamp()-interval '2 seconds',expires_at=clock_timestamp()-interval '1 second' WHERE id=ANY($1::uuid[])",[abandoned.files.map(part=>part.uploadId).concat(prepared.files[1].uploadId)])
 })
 for(const part of abandoned.files)await assert.rejects(f.files.finishUpload(f.alice.token,part.uploadId),error=>error.statusCode===410)
 // The same expiry cannot invalidate an already published receipt.
 assert.equal((await f.files.finishUpload(f.alice.token,prepared.files[1].uploadId)).file.fileId,prepared.files[1].fileId)
 assert.equal((await f.files.listFiles(f.alice.token)).files.length,4)
})
