import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {PDFArray,PDFDocument,PDFHexString,PDFName,PDFString,PDFRef} from 'pdf-lib'
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs'
import {createPdfAnnotationJob} from '../server/src/pdf/annotation-job.mjs'
import {createPdfAnnotationDeleteJob,validatePdfAnnotationDeleteOperations} from '../server/src/pdf/annotation-delete-job.mjs'
import {createIsolatedPdfAnnotationDeleteJob} from '../server/src/pdf/annotation-delete-isolated.mjs'

const command=operations=>JSON.stringify({version:1,action:'deleteAnnotations',operations})
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
async function fixture(){
 const doc=await PDFDocument.create();doc.addPage([300,200]).drawText('Original report',{x:20,y:100,size:12});doc.addPage([300,200]).drawText('Retained page',{x:20,y:100,size:12})
 const result=await createPdfAnnotationJob().execute(Buffer.from(await doc.save()),JSON.stringify({version:1,action:'annotateText',operations:[{page:1,text:'Original',type:'highlight'},{page:1,text:'report',type:'note',contents:'Root note'},{page:2,text:'Retained',type:'note',contents:'Keep me'}]}))
 const saved=await PDFDocument.load(result.bytes),first=saved.getPage(0),annots=first.node.Annots(),rootRef=annots.get(1),root=saved.context.lookup(rootRef)
 const popup=saved.context.register(saved.context.obj({Type:'Annot',Subtype:'Popup',Rect:[20,20,80,80],Parent:rootRef,P:first.ref}))
 root.set(PDFName.of('Popup'),popup);annots.push(popup)
 const reply=saved.context.register(saved.context.obj({Type:'Annot',Subtype:'Text',Rect:[20,20,40,40],Contents:PDFHexString.fromText('Reply note'),IRT:rootRef,P:first.ref}))
 annots.push(reply)
 const link=saved.context.register(saved.context.obj({Type:'Annot',Subtype:'Link',Rect:[20,20,40,40],A:{S:'URI',URI:PDFString.of('https://example.com')}}))
 annots.push(link)
 const id=ref=>ref.objectNumber+'R'+(ref.generationNumber||'')
 return {bytes:Buffer.from(await saved.save()),highlightId:id(annots.get(0)),noteId:id(rootRef),replyId:id(reply),linkId:id(link)}
}
async function annotations(bytes,page){
 const task=getDocument({data:Uint8Array.from(bytes),disableFontFace:true,useSystemFonts:true})
 try{return await (await (await task.promise).getPage(page)).getAnnotations()}
 finally{await task.destroy()}
}

test('precise PDF annotation deletion removes only requested markup and preserves other annotations',async()=>{
 const f=await fixture(),before=Buffer.from(f.bytes)
 const result=await createPdfAnnotationDeleteJob().execute(f.bytes,command([{page:1,annotationId:f.highlightId}]))
 assert.deepEqual(f.bytes,before);assert.equal(result.inputSha256,hash(before));assert.equal(result.sha256,hash(result.bytes));assert.equal(result.size,result.bytes.length)
 const remaining=await annotations(result.bytes,1)
 assert.ok(!remaining.some(annotation=>annotation.subtype==='Highlight'))
 assert.ok(remaining.some(annotation=>annotation.id===f.noteId));assert.ok(remaining.some(annotation=>annotation.id===f.linkId))
 assert.equal((await annotations(result.bytes,2))[0].contentsObj.str,'Keep me')
 const doc=await PDFDocument.load(result.bytes)
 assert.equal(doc.context.lookup(doc.getPage(0).node.Annots().get(0)).get(PDFName.of('Contents')).decodeText(),'Root note')
 const task=getDocument({data:Uint8Array.from(result.bytes),disableFontFace:true,useSystemFonts:true})
 try{
  const pdf=await task.promise
  for(const [page,text]of [[1,'Original report'],[2,'Retained page']])assert.equal((await (await pdf.getPage(page)).getTextContent()).items.map(item=>item.str??'').join(''),text)
 }finally{await task.destroy()}
})

test('annotation deletion accepts exact PDF.js identities with nonzero object generations',async()=>{
 const doc=await PDFDocument.create(),page=doc.addPage([300,200]),ref=PDFRef.of(50,2)
 doc.context.assign(ref,doc.context.obj({Type:'Annot',Subtype:'Text',Rect:[20,20,40,40],Contents:PDFString.of('Generation two'),P:page.ref}))
 page.node.set(PDFName.of('Annots'),doc.context.obj([ref]))
 const bytes=Buffer.from(await doc.save({useObjectStreams:false})),before=await annotations(bytes,1)
 assert.equal(before[0].id,'50R2')
 const result=await createPdfAnnotationDeleteJob().execute(bytes,command([{page:1,annotationId:'50R2'}]))
 assert.equal((await annotations(result.bytes,1)).length,0)
})

test('deleting a root note removes its reply thread and popup without touching unrelated markup or notes',async()=>{
 const f=await fixture(),result=await createPdfAnnotationDeleteJob().execute(f.bytes,command([{page:1,annotationId:f.noteId}]))
 const first=await annotations(result.bytes,1)
 assert.deepEqual(first.map(annotation=>annotation.subtype).sort(),['Highlight','Link'])
 assert.equal((await annotations(result.bytes,2))[0].contentsObj.str,'Keep me')
 const doc=await PDFDocument.load(result.bytes)
 assert.equal(doc.getPage(0).node.lookup(PDFName.of('Annots'),PDFArray).size(),2)
 for(const [,object]of doc.context.enumerateIndirectObjects())if(object?.get){const contents=object.get(PDFName.of('Contents'));assert.ok(!['Root note','Reply note'].includes(contents?.decodeText?.()))}
})

test('annotation deletion strictly rejects stale IDs, wrong pages, links and reply IDs without modifying input',async()=>{
 const f=await fixture(),original=Buffer.from(f.bytes),job=createPdfAnnotationDeleteJob()
 for(const operation of [{page:1,annotationId:'999999R'},{page:2,annotationId:f.noteId}])await assert.rejects(job.execute(f.bytes,command([operation])),{code:'PDF_ANNOTATION_NOT_FOUND'})
 for(const id of [f.linkId,f.replyId])await assert.rejects(job.execute(f.bytes,command([{page:1,annotationId:id}])),{code:'PDF_EDIT_UNSUPPORTED_STRUCTURE'})
 await assert.rejects(job.execute(f.bytes,command([{page:1,annotationId:f.highlightId},{page:1,annotationId:'999999R'}])),{code:'PDF_ANNOTATION_NOT_FOUND'})
 assert.deepEqual(f.bytes,original)
})

test('annotation deletion schema rejects duplicate, missing, direct and unbounded annotation identities',()=>{
 const input=[{page:1,annotationId:'7R'}],out=validatePdfAnnotationDeleteOperations(input);input[0].annotationId='8R'
 assert.equal(out[0].annotationId,'7R');assert.equal(Object.isFrozen(out[0]),true)
 for(const operations of [[],[{page:0,annotationId:'7R'}],[{page:1,annotationId:''}],[{page:1,annotationId:'annot_p0_1'}],[{page:1,annotationId:'7R',path:'/tmp/a'}],[{page:1,annotationId:'7R'},{page:1,annotationId:'7R'}]])assert.throws(()=>validatePdfAnnotationDeleteOperations(operations),{code:'INVALID_PDF_ANNOTATION_DELETE'})
})

test('annotation deletion refuses signed, encrypted and form documents',async()=>{
 const f=await fixture(),raw=command([{page:1,annotationId:f.highlightId}]),job=createPdfAnnotationDeleteJob()
 const signed=await PDFDocument.load(f.bytes);signed.context.register(signed.context.obj({Type:'Sig',ByteRange:[0,1,2,3]}))
 await assert.rejects(job.execute(Buffer.from(await signed.save()),raw),{code:'SIGNATURE_EDIT_REFUSED'})
 const form=await PDFDocument.load(f.bytes);form.getForm().createTextField('x')
 await assert.rejects(job.execute(Buffer.from(await form.save()),raw),{code:'PDF_EDIT_UNSUPPORTED_STRUCTURE'})
 const encrypted=await PDFDocument.load(f.bytes);encrypted.context.trailerInfo.Encrypt=encrypted.context.register(encrypted.context.obj({Filter:'Standard',V:1,R:2,Length:40,O:'x',U:'y',P:-4}))
 await assert.rejects(job.execute(Buffer.from(await encrypted.save()),raw),{code:'PASSWORD'})
})

test('isolated annotation deletion returns bound bytes and cancels pending work',async()=>{
 const f=await fixture(),raw=command([{page:1,annotationId:f.noteId}]),job=createIsolatedPdfAnnotationDeleteJob()
 const result=await job.execute(f.bytes,raw)
 assert.equal(result.inputSha256,hash(f.bytes));assert.equal((await annotations(result.bytes,1)).length,2)
 const controller=new AbortController(),pending=job.execute(f.bytes,raw,controller.signal)
 controller.abort();await assert.rejects(pending,{code:'ABORTED'})
})
