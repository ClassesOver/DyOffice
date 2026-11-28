import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {PDFDocument,degrees} from 'pdf-lib'
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {createPdfService} from '../../server/src/modules/pdf/service.ts'
import {createWorkspaceService} from '../../server/src/modules/workspace/service.ts'

test('PDF extraction creates one replayable new file and preserves the authorized source',async t=>{
 const f=await fileFixture(t,{buildApp:false}),doc=await PDFDocument.create()
 for(const text of ['Page One','Page Two','Page Three'])doc.addPage([300,200]).drawText(text,{x:20,y:100,size:12})
 doc.getPage(2).setRotation(degrees(90))
 const initial=(await importFile(f,f.alice.token,Buffer.from(await doc.save()),'source.pdf')).file
 const leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
 const pdf=createPdfService({files:f.files,leases,revisions}),editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,initial.fileId,{editorId})
 const authority={editorId,leaseEpoch:lease.leaseEpoch}
 const note=await pdf.stageAnnotate(f.alice.token,initial.fileId,{...authority,baseRevision:initial.revision,operations:[{page:3,text:'Three',type:'note',contents:'Keep this comment.'}]})
 const source=await revisions.commitRevision(f.alice.token,note.commitInput)
 const original=await f.files.readFile(f.alice.token,initial.fileId,source.revision)
 const workspace=createWorkspaceService(f.transactions)
 const folder=await workspace.createFolder(f.alice.token,{name:'Extracted pages',parentId:null})
 const other=await workspace.createFolder(f.bob.token,{name:'Private pages',parentId:null})
 const input={...authority,baseRevision:source.revision,pages:[3,1],name:'selected.pdf',folderId:folder.id}
 await assert.rejects(pdf.stageExtractPages(f.bob.token,initial.fileId,input),error=>error.statusCode===404)
 await assert.rejects(pdf.stageExtractPages(f.alice.token,initial.fileId,{...input,leaseEpoch:lease.leaseEpoch+1}),error=>error.statusCode===409)
 await assert.rejects(pdf.stageExtractPages(f.alice.token,initial.fileId,{...input,baseRevision:initial.revision}),error=>error.statusCode===409)
 await assert.rejects(pdf.stageExtractPages(f.alice.token,initial.fileId,{...input,pages:[4]}),error=>error.statusCode===400)
 await assert.rejects(pdf.stageExtractPages(f.alice.token,initial.fileId,{...input,folderId:other.id}),{statusCode:404})
 await assert.rejects(pdf.stagePageLayout(f.alice.token,initial.fileId,{
  ...authority,baseRevision:source.revision,operation:{kind:'split',perPage:2},folderId:other.id,
 }),{statusCode:404})
 const cancelled=new AbortController();cancelled.abort()
 await assert.rejects(pdf.stageExtractPages(f.alice.token,initial.fileId,input,cancelled.signal))
 const prepared=await pdf.stageExtractPages(f.alice.token,initial.fileId,input)
 assert.notEqual(prepared.fileId,initial.fileId)
 await assert.rejects(f.files.openFile(f.alice.token,prepared.fileId),error=>error.statusCode===404)
 await assert.rejects(f.files.finishUpload(f.bob.token,prepared.uploadId),error=>error.statusCode===404)
 const created=await f.files.finishUpload(f.alice.token,prepared.uploadId)
 assert.deepEqual(await f.files.finishUpload(f.alice.token,prepared.uploadId),created)
 assert.equal(created.file.fileId,prepared.fileId)
 assert.equal(created.file.sha256,prepared.sha256)
 assert.equal(created.file.size,prepared.size)
 assert.deepEqual((await workspace.listFiles(f.alice.token,{folderId:folder.id})).files.map(file=>file.name),['selected.pdf'])
 const bytes=await f.files.readFile(f.alice.token,created.file.fileId,created.file.revision)
 const task=getDocument({data:Uint8Array.from(bytes),disableFontFace:true,useSystemFonts:true})
 try{
  const extracted=await task.promise
  assert.equal(extracted.numPages,2)
  const first=await extracted.getPage(1),second=await extracted.getPage(2)
  assert.equal(first.rotate,90)
  assert.equal((await first.getTextContent()).items.map(item=>item.str??'').join(''),'Page Three')
  assert.equal((await second.getTextContent()).items.map(item=>item.str??'').join(''),'Page One')
  assert.equal((await first.getAnnotations())[0].contentsObj.str,'Keep this comment.')
 }finally{await task.destroy()}
 assert.equal((await f.files.openFile(f.alice.token,initial.fileId)).file.revision,source.revision)
 assert.deepEqual(await f.files.readFile(f.alice.token,initial.fileId,source.revision),original)
 assert.equal((await f.files.listFiles(f.alice.token)).files.length,2)
 const abandoned=await pdf.stageExtractPages(f.alice.token,initial.fileId,{...input,pages:[2]})
 await f.files.cancelUpload(f.alice.token,abandoned.uploadId)
 await assert.rejects(f.files.finishUpload(f.alice.token,abandoned.uploadId),error=>error.statusCode===409)
 assert.equal((await f.files.listFiles(f.alice.token)).files.length,2)
})
