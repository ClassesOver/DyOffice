import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {PDFDocument,PDFHexString,PDFName,PDFRef} from 'pdf-lib'
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs'
import {createPdfNoteUpdateJob,validatePdfNoteUpdateOperations} from '../server/src/pdf/note-update-job.mjs'
import {noteAppearance} from '../../pdf/src/main/save-pdf.ts'
import {createIsolatedPdfNoteUpdateJob} from '../server/src/pdf/note-update-isolated.mjs'

const command=operations=>JSON.stringify({version:1,action:'updateNotes',operations})
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
async function fixture(){
 const doc=await PDFDocument.create(),page=doc.addPage([300,200]);page.drawText('Original report',{x:20,y:100,size:12});doc.addPage([300,200])
 const root=PDFRef.of(50,2)
 doc.context.assign(root,doc.context.obj({Type:'Annot',Subtype:'Text',Rect:[20,30,40,50],Contents:PDFHexString.fromText('Root note'),T:PDFHexString.fromText('Original author'),P:page.ref,RC:PDFHexString.fromText('<body xmlns="http://www.w3.org/1999/xhtml">Old rich text</body>'),AP:{N:doc.context.register(noteAppearance(doc,[20,30,40,50],[1,0.9,0.3]))}}))
 const reply=doc.context.register(doc.context.obj({Type:'Annot',Subtype:'Text',Rect:[20,30,40,50],Contents:PDFHexString.fromText('Existing reply'),T:PDFHexString.fromText('Reviewer'),IRT:root,RT:'R',P:page.ref}))
 const markup=doc.context.register(doc.context.obj({Type:'Annot',Subtype:'Highlight',Rect:[20,30,40,50],QuadPoints:[20,50,40,50,20,30,40,30]}))
 page.node.set(PDFName.of('Annots'),doc.context.obj([root,reply,markup]))
 return {bytes:Buffer.from(await doc.save({useObjectStreams:false})),noteId:'50R2',replyId:reply.objectNumber+'R',markupId:markup.objectNumber+'R'}
}
async function read(bytes){
 const task=getDocument({data:Uint8Array.from(bytes),disableFontFace:true,useSystemFonts:true})
 try{const page=await (await task.promise).getPage(1);return {annotations:await page.getAnnotations(),text:(await page.getTextContent()).items.map(item=>item.str??'').join('')}}finally{await task.destroy()}
}

test('PDF note edits preserve author, position and reply relationship on PDF.js reopen',async()=>{
 const f=await fixture(),original=Buffer.from(f.bytes),before=await read(f.bytes)
 const result=await createPdfNoteUpdateJob().execute(f.bytes,command([{page:1,annotationId:f.noteId,action:'edit',text:' 修改根批注 '},{page:1,annotationId:f.replyId,action:'edit',text:'修改回复'}]))
 assert.deepEqual(f.bytes,original);assert.equal(result.inputSha256,hash(original));assert.equal(result.sha256,hash(result.bytes));assert.equal(result.size,result.bytes.length)
 const after=await read(result.bytes);assert.equal(after.text,'Original report')
 for(const [id,text]of [[f.noteId,'修改根批注'],[f.replyId,'修改回复']]){
  const prior=before.annotations.find(item=>item.id===id),note=after.annotations.find(item=>item.id===id)
  assert.equal(note.contentsObj.str,text);assert.deepEqual(note.titleObj,prior.titleObj);assert.deepEqual(note.rect,prior.rect);assert.equal(note.inReplyTo,prior.inReplyTo);assert.equal(note.replyType,prior.replyType)
 }
 const doc=await PDFDocument.load(result.bytes)
 assert.equal(doc.context.lookup(PDFRef.of(50,2)).has(PDFName.of('RC')),false)
 const priorDoc=await PDFDocument.load(f.bytes)
 const appearance=document=>document.context.lookup(document.context.lookup(PDFRef.of(50,2)).lookup(PDFName.of('AP')).get(PDFName.of('N'))).getContents()
 assert.deepEqual(appearance(doc),appearance(priorDoc))
 assert.equal((await read(f.bytes)).annotations.find(item=>item.id===f.noteId).contentsObj.str,'Root note')
})

test('PDF replies create a standard AI Assistant IRT reply without changing the root or other annotations',async()=>{
 const f=await fixture(),before=await read(f.bytes)
 const result=await createPdfNoteUpdateJob().execute(f.bytes,command([{page:1,annotationId:f.noteId,action:'reply',text:'已处理，请复核。'}]))
 const after=await read(result.bytes),added=after.annotations.find(item=>!before.annotations.some(prior=>prior.id===item.id))
 assert.equal(after.annotations.length,before.annotations.length+1);assert.equal(after.text,before.text)
 assert.equal(added.subtype,'Text');assert.equal(added.contentsObj.str,'已处理，请复核。');assert.equal(added.titleObj.str,'AI Assistant');assert.equal(added.inReplyTo,f.noteId);assert.equal(added.replyType,'R')
 for(const prior of before.annotations)assert.deepEqual(after.annotations.find(item=>item.id===prior.id),prior)
 const doc=await PDFDocument.load(result.bytes),reply=doc.context.lookup(doc.getPage(0).node.Annots().get(3))
 assert.equal(String(reply.get(PDFName.of('IRT'))),'50 2 R');assert.equal(String(reply.get(PDFName.of('RT'))),'/R');assert.ok(reply.has(PDFName.of('AP')))
 assert.deepEqual(added.rect,before.annotations.find(item=>item.id===f.noteId).rect)
})

test('PDF note updates reject stale IDs, wrong pages, non-notes and replies as thread roots atomically',async()=>{
 const f=await fixture(),original=Buffer.from(f.bytes),job=createPdfNoteUpdateJob()
 for(const operation of [{page:2,annotationId:f.noteId},{page:1,annotationId:'999R'}])await assert.rejects(job.execute(f.bytes,command([{...operation,action:'edit',text:'New'}])),{code:'PDF_ANNOTATION_NOT_FOUND'})
 for(const operation of [{annotationId:f.markupId,action:'edit'},{annotationId:f.markupId,action:'reply'},{annotationId:f.replyId,action:'reply'}])await assert.rejects(job.execute(f.bytes,command([{page:1,...operation,text:'New'}])),{code:'PDF_EDIT_UNSUPPORTED_STRUCTURE'})
 await assert.rejects(job.execute(f.bytes,command([{page:1,annotationId:f.noteId,action:'edit',text:'New'},{page:1,annotationId:'999R',action:'reply',text:'Bad'}])),{code:'PDF_ANNOTATION_NOT_FOUND'})
 assert.deepEqual(f.bytes,original)
})

test('PDF note replies refuse zero or inverted icon rectangles',async()=>{
 const f=await fixture(),raw=command([{page:1,annotationId:f.noteId,action:'reply',text:'Done'}])
 for(const rect of [[20,30,20,50],[20,30,40,30],[40,30,20,50],[20,50,40,30]]){
  const doc=await PDFDocument.load(f.bytes)
  doc.context.lookup(PDFRef.of(50,2)).set(PDFName.of('Rect'),doc.context.obj(rect))
  await assert.rejects(createPdfNoteUpdateJob().execute(Buffer.from(await doc.save()),raw),{code:'PDF_EDIT_UNSUPPORTED_STRUCTURE'})
 }
})

test('PDF note schema strictly bounds identities and nonempty text',()=>{
 const input=[{page:1,annotationId:'7R',action:'edit',text:' New '}],out=validatePdfNoteUpdateOperations(input);input[0].text='Changed'
 assert.equal(out[0].text,'New');assert.ok(Object.isFrozen(out[0]))
 for(const operations of [[],[{page:1,annotationId:'annot_p0_1',action:'edit',text:'x'}],[{page:0,annotationId:'7R',action:'edit',text:'x'}],[{page:1,annotationId:'7R',action:'delete',text:'x'}],[{page:1,annotationId:'7R',action:'edit',text:' '}],[{page:1,annotationId:'7R',action:'edit',text:'x'.repeat(4001)}],[{page:1,annotationId:'7R',action:'edit',text:'x',author:'Imposter'}],[input[0],input[0]]])assert.throws(()=>validatePdfNoteUpdateOperations(operations),{code:'INVALID_PDF_NOTE_UPDATE'})
})

test('PDF note updates refuse signed, encrypted and form documents',async()=>{
 const f=await fixture(),raw=command([{page:1,annotationId:f.noteId,action:'edit',text:'New'}]),job=createPdfNoteUpdateJob()
 const signed=await PDFDocument.load(f.bytes);signed.context.register(signed.context.obj({Type:'Sig',ByteRange:[0,1,2,3]}))
 await assert.rejects(job.execute(Buffer.from(await signed.save()),raw),{code:'SIGNATURE_EDIT_REFUSED'})
 const form=await PDFDocument.load(f.bytes);form.getForm().createTextField('x')
 await assert.rejects(job.execute(Buffer.from(await form.save()),raw),{code:'PDF_EDIT_UNSUPPORTED_STRUCTURE'})
 const encrypted=await PDFDocument.load(f.bytes);encrypted.context.trailerInfo.Encrypt=encrypted.context.register(encrypted.context.obj({Filter:'Standard',V:1,R:2,Length:40,O:'x',U:'y',P:-4}))
 await assert.rejects(job.execute(Buffer.from(await encrypted.save()),raw),{code:'PASSWORD'})
})

test('isolated PDF note updates return verifiable bytes and cancel pending work',async()=>{
 const f=await fixture(),raw=command([{page:1,annotationId:f.noteId,action:'reply',text:'Done'}]),job=createIsolatedPdfNoteUpdateJob()
 const result=await job.execute(f.bytes,raw);assert.equal(result.inputSha256,hash(f.bytes));assert.equal((await read(result.bytes)).annotations.length,4)
 const controller=new AbortController(),pending=job.execute(f.bytes,raw,controller.signal);controller.abort();await assert.rejects(pending,{code:'ABORTED'})
})
