import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {PDFDocument,degrees} from 'pdf-lib'
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {createPdfService} from '../../server/src/modules/pdf/service.ts'

test('PDF grid splitting and imposition publish new files from the visible source pages',async t=>{
 const f=await fileFixture(t,{buildApp:false}),doc=await PDFDocument.create()
 for(let i=1;i<=3;i++){
  const page=doc.addPage([300,200]);page.setCropBox(50,20,200,160)
  if(i<3)page.drawText(`Page ${i}`,{x:70,y:90,size:12})
 }
 doc.getPage(0).setRotation(degrees(90))
 const original=Buffer.from(await doc.save()),source=(await importFile(f,f.alice.token,original,'layout.pdf')).file
 const leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
 const pdf=createPdfService({files:f.files,leases,revisions}),editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,source.fileId,{editorId})
 const authority={baseRevision:source.revision,editorId,leaseEpoch:lease.leaseEpoch}
 for(const operation of [{kind:'split',perPage:2},{kind:'merge',perSheet:2,direction:'horizontal',separator:true}]){
  const input={...authority,operation}
  await assert.rejects(pdf.stagePageLayout(f.bob.token,source.fileId,input),error=>error.statusCode===404)
  await assert.rejects(pdf.stagePageLayout(f.alice.token,source.fileId,{...input,leaseEpoch:lease.leaseEpoch+1}),error=>error.statusCode===409)
  await assert.rejects(pdf.stagePageLayout(f.alice.token,source.fileId,{...input,baseRevision:randomUUID()}),error=>error.statusCode===409)
  const prepared=await pdf.stagePageLayout(f.alice.token,source.fileId,input)
  await assert.rejects(f.files.openFile(f.alice.token,prepared.fileId),error=>error.statusCode===404)
  const saved=await f.files.finishUpload(f.alice.token,prepared.uploadId)
  assert.deepEqual(await f.files.finishUpload(f.alice.token,prepared.uploadId),saved)
  assert.equal(saved.file.fileId,prepared.fileId);assert.equal(saved.file.sha256,prepared.sha256)
  const bytes=await f.files.readFile(f.alice.token,prepared.fileId,saved.file.revision),output=await PDFDocument.load(bytes)
  assert.equal(output.getPageCount(),operation.kind==='split'?6:2)
  assert.deepEqual(output.getPage(0).getSize(),operation.kind==='split'?{width:200,height:80}:{width:200,height:160})
  assert.equal(output.getPage(0).getRotation().angle,operation.kind==='split'?90:0)
  if(operation.kind==='merge'){
   const task=getDocument({data:Uint8Array.from(bytes),disableFontFace:true,useSystemFonts:true})
   try{
    const result=await task.promise,first=await result.getPage(1)
    const text=(await first.getTextContent()).items.map(item=>item.str??'').join(' ')
    assert.match(text,/Page 1/);assert.match(text,/Page 2/)
    assert.equal((await (await result.getPage(2)).getTextContent()).items.length,0)
   }finally{await task.destroy()}
  }
  assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,source.revision)
  assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),original)
 }
 assert.equal((await f.files.listFiles(f.alice.token)).files.length,3)
})
