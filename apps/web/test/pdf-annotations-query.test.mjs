import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {PDFDocument,PDFArray,PDFName,StandardFonts,degrees} from 'pdf-lib'
import {createPdfAnnotationsQueryJob,parsePdfAnnotationsQueryRequest} from '../server/src/pdf/annotations-query-job.mjs'
import {createIsolatedPdfAnnotationsQueryJob} from '../server/src/pdf/annotations-query-isolated.mjs'
import {createPdfAnnotationJob,planPdfAnnotations} from '../server/src/pdf/annotation-job.mjs'
const hash=b=>createHash('sha256').update(b).digest('hex'),n=PDFName.of
const command=operations=>JSON.stringify({version:1,action:'annotationsQuery',operations})
async function fixture(rotation=0){const d=await PDFDocument.create(),font=await d.embedFont(StandardFonts.Helvetica),p=d.addPage([400,300]);p.setCropBox(20,30,350,250);p.setRotation(degrees(rotation));p.drawText('Revenue revenue',{x:40,y:210,size:14,font});p.drawText('Second line',{x:40,y:180,size:14,font});d.addPage([400,300]);return Buffer.from(await d.save())}
const ops=[{page:1,text:'revenue',occurrence:1,type:'highlight'},{page:1,text:'Revenue',type:'note',contents:'Check this'}]
function verify(result,input){assert.equal(result.inputSha256,hash(input));assert.equal(result.size,result.bytes.length);assert.equal(result.sha256,hash(result.bytes));const report=JSON.parse(result.bytes.toString());assert.equal(report.markups.length,1);assert.equal(report.notes.length,1);assert.equal(report.markups[0].pageIndex,0);assert.equal(report.notes[0].pageIndex,0);assert.equal(report.notes[0].contents,'Check this');assert.equal(report.notes[0].kind,'note');assert.equal(Object.hasOwn(report.markups[0],'id'),false);assert.equal(Object.hasOwn(report.notes[0],'id'),false);return report}
test('query returns raw PDF coordinates and bound JSON without modifying or writing source PDF',async()=>{
 for(const rotation of [0,90,180,270]){
  const bytes=await fixture(rotation),before=Buffer.from(bytes),result=await createPdfAnnotationsQueryJob().execute(bytes,command(ops)),report=verify(result,bytes)
  assert.deepEqual(bytes,before);assert.ok(report.markups[0].quads[0][0]>40);assert.equal(report.markups[0].quads[0][1],224);assert.deepEqual(report.notes[0].at,[40,224]);assert.deepEqual(report.markups[0].color,[1,0.9,0.3]);assert.equal((await PDFDocument.load(bytes)).getPage(0).node.Annots()?.size()??0,0)
 }
})
test('query and standalone writer share exact planning for multiple quads and selected occurrence',async()=>{
 const bytes=await fixture(),operations=[{page:1,text:'revenue\nSecond line',type:'underline'}]
 const query=JSON.parse((await createPdfAnnotationsQueryJob().execute(bytes,command(operations))).bytes.toString()),written=await createPdfAnnotationJob().execute(bytes,JSON.stringify({version:1,action:'annotateText',operations})),doc=await PDFDocument.load(written.bytes),dict=doc.context.lookup(doc.getPage(0).node.Annots().get(0))
 assert.equal(query.markups[0].quads.length,2);assert.deepEqual(dict.lookup(n('QuadPoints'),PDFArray).asArray().map(v=>v.asNumber()),query.markups[0].quads.flat())
})
test('strict query request rejects unknown keys raw coordinates malformed arrays and accessors',async()=>{
 for(const raw of [JSON.stringify({version:1,action:'annotateText',operations:ops}),JSON.stringify({version:1,action:'annotationsQuery',operations:ops,quads:[]}),command([{...ops[0],quads:[[0,1,2,3]]}]),command([]),'x'.repeat(65537)])assert.throws(()=>parsePdfAnnotationsQueryRequest(raw))
 let called=false;const op={...ops[0]};Object.defineProperty(op,'text',{enumerable:true,get(){called=true;return 'Revenue'}})
 // Shared planner validates direct calls too; JSON-only IPC cannot carry accessors.
 await assert.rejects(planPdfAnnotations(await fixture(),[op]),{code:'INVALID_PDF_ANNOTATION'});assert.equal(called,false)
})
test('missing text and protected malformed PDFs reject without any partial report',async()=>{
 const input=await fixture(),job=createPdfAnnotationsQueryJob()
 await assert.rejects(job.execute(input,command([...ops,{page:2,text:'missing',type:'highlight'}])),{code:'PDF_ANNOTATION_TEXT_NOT_FOUND'})
 const d=await PDFDocument.load(input);d.getForm().createTextField('form')
 d.catalog.lookup(n('AcroForm')).set(n('XFA'),d.context.obj('unsupported'))
 await assert.rejects(job.execute(Buffer.from(await d.save({updateFieldAppearances:false})),command(ops)),{code:'PDF_EDIT_UNSUPPORTED_STRUCTURE'})
 const signed=await PDFDocument.load(input);signed.context.register(signed.context.obj({Type:'Sig',ByteRange:[0,1,2,3]}))
 await assert.rejects(job.execute(Buffer.from(await signed.save()),command(ops)),{code:'SIGNATURE_EDIT_REFUSED'})
 await assert.rejects(job.execute(Buffer.from('%PDF-private detail'),command(ops)),e=>e.code==='UNREADABLE'&&!e.message.includes('private detail'))
})
test('pending annotation queries support ordinary forms without changing field values or appearances',async()=>{
 const source=await PDFDocument.load(await fixture()),field=source.getForm().createTextField('Name')
 field.setText('Keep');field.addToPage(source.getPage(0),{x:30,y:50,width:100,height:20});field.enableReadOnly()
 const bytes=Buffer.from(await source.save()),original=Buffer.from(bytes)
 const report=verify(await createPdfAnnotationsQueryJob().execute(bytes,command(ops)),bytes)
 assert.equal(report.notes[0].contents,'Check this');assert.deepEqual(bytes,original)
 const reopened=await PDFDocument.load(bytes);assert.equal(reopened.getForm().getTextField('Name').getText(),'Keep');assert.equal(reopened.getForm().getTextField('Name').isReadOnly(),true)
 // The old immediate writer retains its original AcroForm guard.
 await assert.rejects(createPdfAnnotationJob().execute(bytes,JSON.stringify({version:1,action:'annotateText',operations:ops})),{code:'PDF_EDIT_UNSUPPORTED_STRUCTURE'})
})
test('direct query cancels before and during parsing and rejects overlapping work',async()=>{
 const bytes=await fixture(),job=createPdfAnnotationsQueryJob(),before=new AbortController();before.abort()
 await assert.rejects(job.execute(bytes,command(ops),before.signal),{code:'ABORTED'})
 const c=new AbortController(),pending=job.execute(bytes,command(ops),c.signal)
 await assert.rejects(job.execute(bytes,command(ops)),{code:'BUSY'});c.abort();await assert.rejects(pending,{code:'ABORTED'})
 verify(await job.execute(bytes,command(ops)),bytes)
})
test('isolated query dispatch returns hash-bound geometry and cancellation terminates work',async()=>{
 const bytes=await fixture(),before=Buffer.from(bytes),job=createIsolatedPdfAnnotationsQueryJob()
 verify(await job.execute(bytes,command(ops)),bytes);assert.deepEqual(bytes,before)
 const c=new AbortController(),pending=job.execute(bytes,command(ops),c.signal);c.abort();await assert.rejects(pending,{code:'ABORTED'})
 await assert.rejects(job.execute(bytes,command([{page:1,text:'missing',type:'note',contents:'x'}])),{code:'PDF_ANNOTATION_TEXT_NOT_FOUND'})
})
