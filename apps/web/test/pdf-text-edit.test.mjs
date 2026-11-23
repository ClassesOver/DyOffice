import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {PDFDocument, StandardFonts} from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs'
import {createPdfTextEditJob,validatePdfTextEditOperations} from '../server/src/pdf/text-edit-job.mjs'
import {createIsolatedPdfTextEditJob} from '../server/src/pdf/text-edit-isolated.mjs'

const command=operations=>JSON.stringify({version:1,action:'editText',operations})
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
async function fixture(text='Revenue 1500 and revenue 1500'){
 const doc=await PDFDocument.create(),font=await doc.embedFont(StandardFonts.Helvetica)
 doc.addPage([400,200]).drawText(text,{x:30,y:140,size:14,font})
 doc.addPage([400,200]).drawText('Untouched second page',{x:30,y:140,size:14,font})
 return Buffer.from(await doc.save())
}
async function texts(bytes){
 const task=getDocument({data:Uint8Array.from(bytes),useSystemFonts:true})
 try{const doc=await task.promise,pages=[];for(let page=1;page<=doc.numPages;page++)pages.push((await (await doc.getPage(page)).getTextContent()).items.map(item=>'str'in item?item.str:'').join(''));return pages}
 finally{await task.destroy()}
}

test('text edit rewrites the requested occurrence and independently reopens without the replaced original',async()=>{
 const input=await fixture(),before=Buffer.from(input),job=createPdfTextEditJob()
 const result=await job.execute(input,command([{page:1,oldText:'1500',newText:'5100',occurrence:2}]))
 assert.deepEqual(input,before)
 assert.equal(result.inputSha256,hash(before));assert.equal(result.sha256,hash(result.bytes));assert.equal(result.size,result.bytes.length)
 assert.deepEqual(await texts(result.bytes),['Revenue 1500 and revenue 5100','Untouched second page'])
 const deleted=await job.execute(result.bytes,command([{page:1,oldText:'1500',newText:''}]))
 assert.deepEqual((await texts(deleted.bytes)).map(text=>text.replace(/\s+/g,' ')),['Revenue and revenue 5100','Untouched second page'])
})

test('Chinese text replacement survives PDFium write and independent PDF.js reopen',async()=>{
 const doc=await PDFDocument.create();doc.registerFontkit(fontkit)
 const font=await doc.embedFont(await readFile(new URL('../../docs/src/renderer/fonts/NotoSansCJKsc-Regular-subset.woff2',import.meta.url)),{subset:true})
 doc.addPage([400,200]).drawText('季度报告：收入增长。年度',{x:30,y:140,size:14,font})
 const input=Buffer.from(await doc.save()),before=Buffer.from(input)
 const result=await createPdfTextEditJob().execute(input,command([{page:1,oldText:'季度报告',newText:'年度报告'}]))
 assert.deepEqual(input,before)
 assert.deepEqual(await texts(result.bytes),['年度报告：收入增长。年度'])
})

test('stale text or nonexistent occurrence rejects the entire export without changing input',async()=>{
 const bytes=await fixture(),original=Buffer.from(bytes),job=createPdfTextEditJob()
 for(const operations of [[{page:1,oldText:'missing',newText:'x'}],[{page:1,oldText:'1500',newText:'x',occurrence:3}],[{page:1,oldText:'1500',newText:'5100'},{page:2,oldText:'missing',newText:'x'}]])await assert.rejects(job.execute(bytes,command(operations)),{code:'PDF_TEXT_NOT_FOUND'})
 assert.deepEqual(bytes,original)
})

test('text edit schema strictly captures bounded data and refuses paths and unregistered fields',()=>{
 const input=[{page:1,oldText:'old',newText:'new'}],out=validatePdfTextEditOperations(input)
 input[0].oldText='changed'
 assert.equal(out[0].oldText,'old');assert.equal(Object.isFrozen(out[0]),true)
 for(const value of [[],[{page:0,oldText:'x',newText:'y'}],[{page:1,oldText:'',newText:'y'}],[{page:1,oldText:'x',newText:'y',path:'/tmp/x'}],[{page:1,oldText:'x',newText:'y',occurrence:0}],[{page:1,oldText:'x',newText:'x'.repeat(12001)}]])assert.throws(()=>validatePdfTextEditOperations(value),{code:'INVALID_PDF_TEXT_EDIT'})
})

test('text edit refuses signed, encrypted, form and oversized input before content editing',async()=>{
 const input=await fixture(),job=createPdfTextEditJob(),request=command([{page:1,oldText:'1500',newText:'5100'}])
 const signed=await PDFDocument.load(input);signed.context.register(signed.context.obj({Type:'Sig',ByteRange:[0,1,2,3]}))
 const signedBytes=Buffer.from(await signed.save()),signedBefore=Buffer.from(signedBytes)
 await assert.rejects(job.execute(signedBytes,request),{code:'SIGNATURE_EDIT_REFUSED'})
 assert.deepEqual(signedBytes,signedBefore)
 const form=await PDFDocument.load(input);form.getForm().createTextField('x')
 await assert.rejects(job.execute(Buffer.from(await form.save()),request),{code:'PDF_EDIT_UNSUPPORTED_STRUCTURE'})
 const encrypted=await PDFDocument.load(input);encrypted.context.trailerInfo.Encrypt=encrypted.context.register(encrypted.context.obj({Filter:'Standard',V:1,R:2,Length:40,O:'x',U:'y',P:-4}))
 await assert.rejects(job.execute(Buffer.from(await encrypted.save()),request),{code:'PASSWORD'})
 await assert.rejects(job.execute(Buffer.alloc(64*1024*1024+1),request),{code:'INPUT_LIMIT'})
 const malformed=Buffer.from('%PDF-private secret'),malformedBefore=Buffer.from(malformed)
 await assert.rejects(job.execute(malformed,request),error=>error.code==='UNREADABLE'&&!error.message.includes('private secret'))
 assert.deepEqual(malformed,malformedBefore)
})

test('text edit job rejects overlapping work and suppresses results after cancellation',async()=>{
 const bytes=await fixture(),request=command([{page:1,oldText:'1500',newText:'5100'}]),job=createPdfTextEditJob(),controller=new AbortController()
 const pending=job.execute(bytes,request,controller.signal)
 await assert.rejects(job.execute(bytes,request),{code:'BUSY'})
 controller.abort();await assert.rejects(pending,{code:'ABORTED'})
 assert.ok((await job.execute(bytes,request)).size)
})

test('isolated text edit processor returns bound bytes and terminates canceled work',async()=>{
 const bytes=await fixture(),request=command([{page:1,oldText:'1500',newText:'5100'}]),job=createIsolatedPdfTextEditJob()
 const result=await job.execute(bytes,request)
 assert.equal(result.inputSha256,hash(bytes))
 assert.deepEqual(await texts(result.bytes),['Revenue 5100 and revenue 1500','Untouched second page'])
 const controller=new AbortController(),pending=job.execute(bytes,request,controller.signal)
 controller.abort()
 await assert.rejects(pending,{code:'ABORTED'})
})
