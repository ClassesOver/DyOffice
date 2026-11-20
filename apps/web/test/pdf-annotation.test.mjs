import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {PDFArray,PDFDocument,PDFName,StandardFonts,degrees} from 'pdf-lib'
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs'
import {createPdfAnnotationJob,parsePdfAnnotationRequest,validatePdfAnnotationOperations} from '../server/src/pdf/annotation-job.mjs'
import {createIsolatedPdfAnnotationJob} from '../server/src/pdf/annotation-isolated.mjs'

const command=operations=>JSON.stringify({version:1,action:'annotateText',operations})
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
async function fixture(){
 const doc=await PDFDocument.create(),font=await doc.embedFont(StandardFonts.Helvetica)
 const page=doc.addPage([400,200])
 page.drawText('Quarterly revenue revenue',{x:30,y:140,size:14,font})
 page.drawText('Expenses stable',{x:30,y:100,size:14,font})
 doc.addPage([400,200]).drawText('Untouched',{x:30,y:140,size:14,font})
 return Buffer.from(await doc.save())
}

test('PDF annotations serialize as standard markups and notes and reopen independently',async()=>{
 const input=await fixture(),before=Buffer.from(input)
 const result=await createPdfAnnotationJob().execute(input,command([
  {page:1,text:'revenue',type:'highlight',occurrence:2},
  {page:1,text:'Quarterly',type:'underline'},
  {page:1,text:'Expenses stable',type:'strikeout'},
  {page:1,text:'revenue',type:'note',contents:'请核实收入。'},
 ]))
 assert.deepEqual(input,before)
 assert.equal(result.inputSha256,hash(before));assert.equal(result.sha256,hash(result.bytes));assert.equal(result.size,result.bytes.length)
 const reopened=await PDFDocument.load(result.bytes),annots=reopened.getPage(0).node.lookup(PDFName.of('Annots'),PDFArray)
 assert.equal(annots.size(),4)
 const dictionaries=annots.asArray().map(ref=>reopened.context.lookup(ref))
 assert.deepEqual(dictionaries.map(dict=>String(dict.get(PDFName.of('Subtype')))),['/Highlight','/Underline','/StrikeOut','/Text'])
 for(const dict of dictionaries){assert.ok(dict.has(PDFName.of('AP')));assert.equal(dict.get(PDFName.of('T')).decodeText(),'AI Assistant')}
 assert.equal(dictionaries[3].get(PDFName.of('Contents')).decodeText(),'请核实收入。')
 assert.equal(reopened.getPage(1).node.Annots()?.size()??0,0)
 const task=getDocument({data:Uint8Array.from(result.bytes),useSystemFonts:true})
 try{
  const doc=await task.promise,page=await doc.getPage(1),annotations=await page.getAnnotations()
  assert.equal(annotations.length,4)
  assert.equal(annotations.find(value=>value.subtype==='Text').contentsObj.str,'请核实收入。')
  assert.equal((await page.getTextContent()).items.map(item=>'str'in item?item.str:'').join(''),'Quarterly revenue revenueExpenses stable')
  assert.equal((await (await doc.getPage(2)).getAnnotations()).length,0)
 }finally{await task.destroy()}
 const firstRevenue=await createPdfAnnotationJob().execute(input,command([{page:1,text:'revenue',type:'highlight'}]))
 const firstDoc=await PDFDocument.load(firstRevenue.bytes)
 const firstX=firstDoc.context.lookup(firstDoc.getPage(0).node.Annots().get(0)).lookup(PDFName.of('Rect'),PDFArray).get(0).asNumber()
 const secondX=dictionaries[0].lookup(PDFName.of('Rect'),PDFArray).get(0).asNumber()
 assert.ok(secondX>firstX)
})

test('annotation validation captures bounded data and rejects malformed or ambiguous input',()=>{
 const input=[{page:1,text:'Revenue',type:'note',contents:'Check'}],captured=validatePdfAnnotationOperations(input)
 input[0].contents='Changed'
 assert.equal(captured[0].contents,'Check');assert.equal(Object.isFrozen(captured[0]),true)
 for(const value of [[],[{page:0,text:'x',type:'highlight'}],[{page:1,text:'',type:'underline'}],[{page:1,text:'x',type:'redact'}],[{page:1,text:'x',type:'note'}],[{page:1,text:'x',type:'note',contents:''}],[{page:1,text:'x',type:'highlight',contents:'ignored'}],[{page:1,text:'x',type:'highlight',path:'/tmp/file'}],[{page:1,text:'x',type:'highlight',occurrence:0}]])assert.throws(()=>validatePdfAnnotationOperations(value),{code:'INVALID_PDF_ANNOTATION'})
 let getterCalled=false
 assert.throws(()=>validatePdfAnnotationOperations([{page:1,get text(){getterCalled=true;return 'x'},type:'highlight'}]),{code:'INVALID_PDF_ANNOTATION'})
 assert.equal(getterCalled,false)
 assert.throws(()=>parsePdfAnnotationRequest(JSON.stringify({version:1,action:'annotateText',operations:input,path:'/tmp/file'})),{code:'INVALID_REQUEST'})
 assert.throws(()=>parsePdfAnnotationRequest('x'.repeat(65537)),{code:'REQUEST_LIMIT'})
})

test('multiline marks on rotated pages retain separate standard text quads',async()=>{
 const doc=await PDFDocument.load(await fixture())
 doc.getPage(0).setRotation(degrees(90))
 const result=await createPdfAnnotationJob().execute(Buffer.from(await doc.save()),command([{page:1,text:'revenue\nExpenses stable',type:'underline',occurrence:1}]))
 const reopened=await PDFDocument.load(result.bytes),annot=reopened.context.lookup(reopened.getPage(0).node.Annots().get(0))
 assert.equal(reopened.getPage(0).getRotation().angle,90)
 assert.equal(annot.lookup(PDFName.of('QuadPoints'),PDFArray).size(),16)
})

test('missing text refuses an entire annotation export and existing annotations survive later additions',async()=>{
 const bytes=await fixture(),original=Buffer.from(bytes),job=createPdfAnnotationJob()
 await assert.rejects(job.execute(bytes,command([{page:1,text:'revenue',type:'highlight'},{page:2,text:'missing',type:'note',contents:'Check'}])),{code:'PDF_ANNOTATION_TEXT_NOT_FOUND'})
 assert.deepEqual(bytes,original)
 const first=await job.execute(bytes,command([{page:1,text:'revenue',type:'highlight'}]))
 const second=await job.execute(first.bytes,command([{page:2,text:'Untouched',type:'note',contents:'Retained'}]))
 const reopened=await PDFDocument.load(second.bytes)
 assert.equal(reopened.getPage(0).node.Annots().size(),1);assert.equal(reopened.getPage(1).node.Annots().size(),1)
})

test('annotations refuse encrypted, signed and form PDFs and sanitize parser failures',async()=>{
 const bytes=await fixture(),job=createPdfAnnotationJob(),request=command([{page:1,text:'revenue',type:'highlight'}])
 const signed=await PDFDocument.load(bytes);signed.context.register(signed.context.obj({Type:'Sig',ByteRange:[0,1,2,3]}))
 await assert.rejects(job.execute(Buffer.from(await signed.save()),request),{code:'SIGNATURE_EDIT_REFUSED'})
 const form=await PDFDocument.load(bytes);form.getForm().createTextField('x')
 await assert.rejects(job.execute(Buffer.from(await form.save()),request),{code:'PDF_EDIT_UNSUPPORTED_STRUCTURE'})
 const encrypted=await PDFDocument.load(bytes);encrypted.context.trailerInfo.Encrypt=encrypted.context.register(encrypted.context.obj({Filter:'Standard',V:1,R:2,Length:40,O:'x',U:'y',P:-4}))
 await assert.rejects(job.execute(Buffer.from(await encrypted.save()),request),{code:'PASSWORD'})
 await assert.rejects(job.execute(Buffer.alloc(64*1024*1024+1),request),{code:'INPUT_LIMIT'})
 await assert.rejects(job.execute(Buffer.from('%PDF-private secret'),request),error=>error.code==='UNREADABLE'&&!error.message.includes('private secret'))
})

test('annotation jobs reject overlapping work and suppress cancelled output',async()=>{
 const input=await fixture(),raw=command([{page:1,text:'revenue',type:'highlight'}]),job=createPdfAnnotationJob(),controller=new AbortController()
 const pending=job.execute(input,raw,controller.signal)
 await assert.rejects(job.execute(input,raw),{code:'BUSY'})
 controller.abort();await assert.rejects(pending,{code:'ABORTED'})
 assert.ok((await job.execute(input,raw)).size)
})

test('isolated annotation processor returns bound standard annotations and terminates cancelled work',async()=>{
 const bytes=await fixture(),raw=command([{page:1,text:'revenue',type:'note',contents:'Independent process'}]),job=createIsolatedPdfAnnotationJob()
 const result=await job.execute(bytes,raw),doc=await PDFDocument.load(result.bytes)
 assert.equal(result.inputSha256,hash(bytes));assert.equal(result.sha256,hash(result.bytes))
 assert.equal(doc.context.lookup(doc.getPage(0).node.Annots().get(0)).get(PDFName.of('Contents')).decodeText(),'Independent process')
 const controller=new AbortController(),pending=job.execute(bytes,raw,controller.signal)
 controller.abort();await assert.rejects(pending,{code:'ABORTED'})
 await assert.rejects(job.execute(bytes,command([{page:1,text:'missing',type:'underline'}])),{code:'PDF_ANNOTATION_TEXT_NOT_FOUND'})
})
