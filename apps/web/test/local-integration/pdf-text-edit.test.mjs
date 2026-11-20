import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {PDFDocument,StandardFonts} from 'pdf-lib'
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {createPdfService} from '../../server/src/modules/pdf/service.ts'

test('original PDF text edits commit through PostgreSQL leases and reopen as a new revision',async t=>{
 const f=await fileFixture(t,{buildApp:false}),doc=await PDFDocument.create(),font=await doc.embedFont(StandardFonts.Helvetica)
 doc.addPage([300,200]).drawText('Original report',{x:20,y:100,size:12,font})
 const initial=(await importFile(f,f.alice.token,Buffer.from(await doc.save()),'report.pdf')).file
 const leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
 const pdf=createPdfService({files:f.files,leases,revisions}),editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,initial.fileId,{editorId})
 const input={baseRevision:initial.revision,editorId,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID(),operations:[{page:1,oldText:'Original',newText:'Updated'}]}
 await assert.rejects(pdf.editTextAndCommit(f.bob.token,initial.fileId,input),error=>error.statusCode===404)
 await assert.rejects(pdf.editTextAndCommit(f.alice.token,initial.fileId,{...input,leaseEpoch:input.leaseEpoch+1}),error=>error.statusCode===409)
 const prepared=await pdf.stageTextEdit(f.alice.token,initial.fileId,input)
 assert.equal((await f.files.openFile(f.alice.token,initial.fileId)).file.revision,initial.revision)
 const saved=await revisions.commitRevision(f.alice.token,prepared.commitInput)
 assert.deepEqual(await revisions.commitRevision(f.alice.token,prepared.commitInput),saved)
 assert.notEqual(saved.revision,initial.revision)
 const current=await f.files.openFile(f.alice.token,initial.fileId)
 assert.equal(current.file.revision,saved.revision)
 const bytes=await f.files.readFile(f.alice.token,saved.fileId,saved.revision),task=getDocument({data:Uint8Array.from(bytes),disableFontFace:true,useSystemFonts:true})
 try{
  const text=(await (await (await task.promise).getPage(1)).getTextContent()).items.map(item=>item.str??'').join('')
  assert.equal(text,'Updated report')
 }finally{await task.destroy()}
 const originalTask=getDocument({data:Uint8Array.from(await f.files.readFile(f.alice.token,initial.fileId,initial.revision)),disableFontFace:true,useSystemFonts:true})
 try{
  const text=(await (await (await originalTask.promise).getPage(1)).getTextContent()).items.map(item=>item.str??'').join('')
  assert.equal(text,'Original report')
 }finally{await originalTask.destroy()}
 await assert.rejects(pdf.editTextAndCommit(f.alice.token,initial.fileId,{...input,idempotencyKey:randomUUID()}),error=>error.statusCode===409)
 const annotated=await pdf.stageAnnotate(f.alice.token,initial.fileId,{...input,baseRevision:saved.revision,idempotencyKey:randomUUID(),operations:[{page:1,text:'Updated',type:'note',contents:'Review this.'}]})
 const noteSaved=await revisions.commitRevision(f.alice.token,annotated.commitInput)
 assert.deepEqual(await revisions.commitRevision(f.alice.token,annotated.commitInput),noteSaved)
 const noteTask=getDocument({data:Uint8Array.from(await f.files.readFile(f.alice.token,noteSaved.fileId,noteSaved.revision)),disableFontFace:true,useSystemFonts:true})
 let noteId
 try{
  const annotations=await (await (await noteTask.promise).getPage(1)).getAnnotations()
  assert.equal(annotations.length,1)
  assert.equal(annotations[0].contentsObj.str,'Review this.')
  noteId=annotations[0].id
 }finally{await noteTask.destroy()}
 const deletion={...input,baseRevision:noteSaved.revision,idempotencyKey:randomUUID(),operations:[{page:1,annotationId:noteId}]}
 await assert.rejects(pdf.stageDeleteAnnotations(f.bob.token,initial.fileId,deletion),error=>error.statusCode===404)
 await assert.rejects(pdf.stageDeleteAnnotations(f.alice.token,initial.fileId,{...deletion,leaseEpoch:deletion.leaseEpoch+1}),error=>error.statusCode===409)
 const deletionPrepared=await pdf.stageDeleteAnnotations(f.alice.token,initial.fileId,deletion)
 assert.equal((await f.files.openFile(f.alice.token,initial.fileId)).file.revision,noteSaved.revision)
 const deleted=await revisions.commitRevision(f.alice.token,deletionPrepared.commitInput)
 assert.deepEqual(await revisions.commitRevision(f.alice.token,deletionPrepared.commitInput),deleted)
 for(const [revision,count]of [[deleted.revision,0],[noteSaved.revision,1]]){
  const task=getDocument({data:Uint8Array.from(await f.files.readFile(f.alice.token,initial.fileId,revision)),disableFontFace:true,useSystemFonts:true})
  try{
   const page=await (await task.promise).getPage(1)
   assert.equal((await page.getAnnotations()).length,count)
   assert.equal((await page.getTextContent()).items.map(item=>item.str??'').join(''),'Updated report')
  }finally{await task.destroy()}
 }
})

test('PDF note edits and replies preserve authors and threads through real revision commits',async t=>{
 const f=await fileFixture(t,{buildApp:false}),doc=await PDFDocument.create()
 doc.addPage([300,200]).drawText('Report body',{x:20,y:100,size:12})
 const initial=(await importFile(f,f.alice.token,Buffer.from(await doc.save()),'comments.pdf')).file
 const leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
 const pdf=createPdfService({files:f.files,leases,revisions}),editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,initial.fileId,{editorId})
 const authority={editorId,leaseEpoch:lease.leaseEpoch}
 async function annotations(revision){
  const task=getDocument({data:Uint8Array.from(await f.files.readFile(f.alice.token,initial.fileId,revision)),disableFontFace:true,useSystemFonts:true})
  try{return await (await (await task.promise).getPage(1)).getAnnotations()}
  finally{await task.destroy()}
 }
 const prepared=await pdf.stageAnnotate(f.alice.token,initial.fileId,{...authority,baseRevision:initial.revision,idempotencyKey:randomUUID(),operations:[{page:1,text:'Report',type:'note',contents:'Check this.'}]})
 const noteSaved=await revisions.commitRevision(f.alice.token,prepared.commitInput)
 const [root]=await annotations(noteSaved.revision)
 const update={...authority,baseRevision:noteSaved.revision,idempotencyKey:randomUUID(),operations:[{page:1,annotationId:root.id,action:'reply',text:'Verified the figures.'}]}
 await assert.rejects(pdf.stageUpdateNotes(f.bob.token,initial.fileId,update),error=>error.statusCode===404)
 await assert.rejects(pdf.stageUpdateNotes(f.alice.token,initial.fileId,{...update,leaseEpoch:lease.leaseEpoch+1}),error=>error.statusCode===409)
 const replyPrepared=await pdf.stageUpdateNotes(f.alice.token,initial.fileId,update)
 assert.equal((await f.files.openFile(f.alice.token,initial.fileId)).file.revision,noteSaved.revision)
 const replied=await revisions.commitRevision(f.alice.token,replyPrepared.commitInput)
 assert.deepEqual(await revisions.commitRevision(f.alice.token,replyPrepared.commitInput),replied)
 const comments=await annotations(replied.revision)
 assert.equal(comments.filter(note=>note.subtype==='Text').length,2)
 const reply=comments.find(note=>note.inReplyTo===root.id)
 assert.ok(reply)
 assert.equal(reply.titleObj.str,'AI Assistant')
 assert.equal(reply.contentsObj.str,'Verified the figures.')
 const editedPrepared=await pdf.stageUpdateNotes(f.alice.token,initial.fileId,{...authority,baseRevision:replied.revision,idempotencyKey:randomUUID(),operations:[{page:1,annotationId:reply.id,action:'edit',text:'Verified the revised figures.'}]})
 const edited=await revisions.commitRevision(f.alice.token,editedPrepared.commitInput)
 const editedReply=(await annotations(edited.revision)).find(note=>note.id===reply.id)
 assert.equal(editedReply.contentsObj.str,'Verified the revised figures.')
 assert.equal(editedReply.titleObj.str,reply.titleObj.str)
 assert.equal(editedReply.inReplyTo,root.id)
 assert.deepEqual(editedReply.rect,reply.rect)
 assert.equal((await annotations(replied.revision)).find(note=>note.id===reply.id).contentsObj.str,'Verified the figures.')
 assert.equal((await annotations(noteSaved.revision)).length,1)
})

test('PDF page batches preserve original numbering until commit and insert a matching blank page',async t=>{
 const f=await fileFixture(t,{buildApp:false}),doc=await PDFDocument.create()
 for(const text of ['Page One','Page Two','Page Three'])doc.addPage([300,200]).drawText(text,{x:20,y:100,size:12})
 const initial=(await importFile(f,f.alice.token,Buffer.from(await doc.save()),'pages.pdf')).file
 const leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
 const pdf=createPdfService({files:f.files,leases,revisions}),editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,initial.fileId,{editorId}),authority={editorId,leaseEpoch:lease.leaseEpoch}
 const notePrepared=await pdf.stageAnnotate(f.alice.token,initial.fileId,{...authority,baseRevision:initial.revision,idempotencyKey:randomUUID(),operations:[{page:3,text:'Three',type:'note',contents:'Keep with third page.'}]})
 const annotated=await revisions.commitRevision(f.alice.token,notePrepared.commitInput)
 const input={...authority,baseRevision:annotated.revision,idempotencyKey:randomUUID(),operations:[{op:'setMetadata',metadata:{title:'季度报告',author:'Office',keywords:'finance；review, 2026'}},{op:'rotatePages',pages:[3],dir:90},{op:'deletePage',page:2},{op:'setPageOrder',order:[3,1]}]}
 await assert.rejects(pdf.stagePageOps(f.bob.token,initial.fileId,input),error=>error.statusCode===404)
 await assert.rejects(pdf.stagePageOps(f.alice.token,initial.fileId,{...input,leaseEpoch:lease.leaseEpoch+1}),error=>error.statusCode===409)
 const prepared=await pdf.stagePageOps(f.alice.token,initial.fileId,input)
 assert.equal((await f.files.openFile(f.alice.token,initial.fileId)).file.revision,annotated.revision)
 const saved=await revisions.commitRevision(f.alice.token,prepared.commitInput)
 assert.deepEqual(await revisions.commitRevision(f.alice.token,prepared.commitInput),saved)
 const task=getDocument({data:Uint8Array.from(await f.files.readFile(f.alice.token,initial.fileId,saved.revision)),disableFontFace:true,useSystemFonts:true})
 try{
  const result=await task.promise;assert.equal(result.numPages,2)
  const first=await result.getPage(1),second=await result.getPage(2)
  assert.equal(first.rotate,90)
  assert.equal((await first.getTextContent()).items.map(item=>item.str??'').join(''),'Page Three')
  assert.equal((await first.getAnnotations())[0].contentsObj.str,'Keep with third page.')
  assert.equal((await second.getTextContent()).items.map(item=>item.str??'').join(''),'Page One')
 }finally{await task.destroy()}
 const blank=await pdf.stagePageOps(f.alice.token,initial.fileId,{...authority,baseRevision:saved.revision,idempotencyKey:randomUUID(),operations:[{op:'insertBlankPage',afterPage:1}]})
 const inserted=await revisions.commitRevision(f.alice.token,blank.commitInput)
 const reopened=await PDFDocument.load(await f.files.readFile(f.alice.token,initial.fileId,inserted.revision))
 assert.equal(reopened.getPageCount(),3)
 assert.equal(reopened.getTitle(),'季度报告');assert.equal(reopened.getAuthor(),'Office');assert.equal(reopened.getKeywords(),'finance review 2026')
 assert.notEqual((await PDFDocument.load(await f.files.readFile(f.alice.token,initial.fileId,annotated.revision))).getTitle(),'季度报告')
 assert.equal(reopened.getPage(1).getRotation().angle,90)
 assert.deepEqual(reopened.getPage(1).getSize(),reopened.getPage(0).getSize())
 assert.equal((await PDFDocument.load(await f.files.readFile(f.alice.token,initial.fileId,annotated.revision))).getPageCount(),3)
 const resizePrepared=await pdf.stagePageOps(f.alice.token,initial.fileId,{...authority,baseRevision:inserted.revision,idempotencyKey:randomUUID(),operations:[{op:'setPageSize',width:612,height:792}]})
 assert.equal((await f.files.openFile(f.alice.token,initial.fileId)).file.revision,inserted.revision)
 const resized=await revisions.commitRevision(f.alice.token,resizePrepared.commitInput)
 assert.deepEqual(await revisions.commitRevision(f.alice.token,resizePrepared.commitInput),resized)
 const sized=await PDFDocument.load(await f.files.readFile(f.alice.token,initial.fileId,resized.revision))
 assert.deepEqual(sized.getPage(0).getSize(),{width:792,height:612})
 assert.deepEqual(sized.getPage(1).getSize(),{width:792,height:612})
 assert.deepEqual(sized.getPage(2).getSize(),{width:612,height:792})
 const cropPrepared=await pdf.stagePageOps(f.alice.token,initial.fileId,{...authority,baseRevision:resized.revision,idempotencyKey:randomUUID(),operations:[{op:'cropPages',pages:[1],left:0.1,top:0.2,right:0.9,bottom:0.8}]})
 const cropped=await revisions.commitRevision(f.alice.token,cropPrepared.commitInput)
 assert.deepEqual(await revisions.commitRevision(f.alice.token,cropPrepared.commitInput),cropped)
 const croppedDoc=await PDFDocument.load(await f.files.readFile(f.alice.token,initial.fileId,cropped.revision))
 assert.ok(Math.abs(croppedDoc.getPage(0).getCropBox().width-792*0.6)<1e-7)
 assert.ok(Math.abs(croppedDoc.getPage(0).getCropBox().height-612*0.8)<1e-7)
 assert.deepEqual(croppedDoc.getPage(0).getMediaBox(),sized.getPage(0).getMediaBox())
 assert.deepEqual(croppedDoc.getPage(2).getCropBox(),sized.getPage(2).getCropBox())
 const prior=await PDFDocument.load(await f.files.readFile(f.alice.token,initial.fileId,resized.revision))
 assert.deepEqual(prior.getPage(0).getCropBox(),sized.getPage(0).getCropBox())
 const cropTask=getDocument({data:Uint8Array.from(await f.files.readFile(f.alice.token,initial.fileId,cropped.revision)),disableFontFace:true,useSystemFonts:true})
 try{
  const page=await (await cropTask.promise).getPage(1)
  assert.equal((await page.getAnnotations())[0].contentsObj.str,'Keep with third page.')
 }finally{await cropTask.destroy()}
})
