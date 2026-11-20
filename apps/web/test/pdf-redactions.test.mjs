import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {PDFDocument,PDFName,degrees} from 'pdf-lib'
import {PNG} from 'pngjs'
import {createPdfRedactionsJob} from '../server/src/pdf/redactions-job.mjs'
import {createIsolatedPdfRedactionsQueryJob,createIsolatedPdfRedactedCopyJob} from '../server/src/pdf/redactions-isolated.mjs'
import {createPdfStampsJob} from '../server/src/pdf/stamps-job.mjs'
import {readPdfLeafObjects} from '../../pdf/src/main/text-edit.ts'
import {applySaveRequest} from '../../pdf/src/main/save-pdf.ts'
const revision=randomUUID(),request=(action,extra={})=>JSON.stringify({version:1,action,revision,patterns:['email'],...extra})
async function fixture(){const d=await PDFDocument.create();for(const rotation of [0,90,180,270]){const p=d.addPage([500,600]);p.setCropBox(20,30,450,540);p.setRotation(degrees(rotation));p.node.set(PDFName.of('UserUnit'),d.context.obj(2));p.drawText('Keep a@example.com and a@example.com tail',{x:40,y:220,size:12})}return Buffer.from(await d.save())}
const query=async(bytes,extra={})=>JSON.parse((await createPdfRedactionsJob('redactionsQuery').execute(bytes,request('redactionsQuery',extra))).bytes)
const text=async bytes=>(await readPdfLeafObjects(bytes)).filter(item=>item.type===1).map(item=>item.text).join('|')
test('automatic redaction rejects invisible OCR locations but still offers visible matches',async()=>{
 const doc=await PDFDocument.create(),page=doc.addPage([400,400])
 page.drawText('public@example.com',{x:30,y:320,size:12})
 const {bytes}=await applySaveRequest(Buffer.from(await doc.save()),{
  formValues:[],markups:[],drawings:[],rotations:[],
  textInserts:[{pageIndex:0,origin:[30,250],text:'scan@example.com',fontSize:12,color:[0,0,0],invisible:true}],
 })
 const report=await query(Buffer.from(bytes))
 assert.deepEqual(report.candidates.map(candidate=>candidate.text),['public@example.com'])
 assert.deepEqual(report.unsupportedPages,[1])
})
test('query uses true native character boxes with rotation/UserUnit display geometry and stable revision bound IDs',async()=>{
 const bytes=await fixture(),report=await query(bytes),again=await query(bytes,{patterns:['email','email']});assert.deepEqual(report,again);assert.equal(report.candidates.length,8);assert.equal(report.truncated,false);assert.deepEqual(report.unsupportedPages,[]);assert.deepEqual(report.scannedPages,[1,2,3,4])
 for(const candidate of report.candidates){assert.equal(candidate.text,'a@example.com');assert.ok(candidate.displayRect.width>0);assert.ok(candidate.displayRect.height>0);assert.ok(candidate.displayRect.left>=0);assert.ok(candidate.displayRect.top>=0)}
 assert.notEqual((await query(bytes,{revision:randomUUID()})).candidates[0].id,report.candidates[0].id)
 assert.deepEqual(JSON.parse((await createIsolatedPdfRedactionsQueryJob().execute(bytes,request('redactionsQuery'))).bytes),report)
})
test('redacted copy permanently removes only selected repeated occurrences and retains unselected source text',async()=>{
 const bytes=await fixture(),report=await query(bytes),ids=report.candidates.filter((_,i)=>i%2===0).map(candidate=>candidate.id)
 for(const job of [createPdfRedactionsJob('redactedCopy'),createIsolatedPdfRedactedCopyJob()]){
  const result=await job.execute(bytes,request('redactedCopy',{ids})),contents=await text(result.bytes);assert.equal(contents.match(/a@example.com/g).length,4);assert.equal(contents.match(/Keep/g).length,4);assert.equal(contents.match(/tail/g).length,4);assert.equal((await PDFDocument.load(result.bytes)).getPageCount(),4)
 }
 await assert.rejects(createPdfRedactionsJob('redactedCopy').execute(bytes,request('redactedCopy',{ids,revision:randomUUID()})),{code:'PDF_REDACTION_STALE_SELECTION'})
})
test('manual rectangle permanently removes content from the chosen page only',async()=>{
 const doc=await PDFDocument.create()
 for(let i=0;i<2;i++){
  const page=doc.addPage([500,600])
  page.drawText('Manual secret',{x:40,y:350,size:14})
  page.drawText('Public text',{x:40,y:270,size:14})
 }
 const bytes=Buffer.from(await doc.save()),regions=[{pageIndex:0,rect:[35,340,170,375]}]
 const copy=extra=>createIsolatedPdfRedactedCopyJob().execute(bytes,request('redactedCopy',{patterns:undefined,regions,...extra}))
 const output=await text((await copy()).bytes)
 assert.equal(output.match(/Manual secret/g)?.length,1)
 assert.equal(output.match(/Public text/g)?.length,2)
 await assert.rejects(copy({regions:[{pageIndex:0,rect:[-10,340,170,375]}]}),{code:'INVALID_PDF_REDACTION'})
 await assert.rejects(copy({ids:['0'.repeat(64)]}),{code:'INVALID_PDF_REDACTION'})
})
test('redacting managed watermark detaches management before cleanup without restoring secret content',async()=>{
 const source=await fixture(),wm=(await createPdfStampsJob().execute(source,JSON.stringify({version:1,action:'stamps',operation:{op:'set_watermark',text:'hidden@example.com',angle:0,size:.04}}))).bytes,report=await query(wm),ids=report.candidates.filter(item=>item.text==='hidden@example.com').map(item=>item.id);assert.equal(ids.length,4)
 const result=await createPdfRedactionsJob('redactedCopy').execute(wm,request('redactedCopy',{ids}));assert.doesNotMatch(await text(result.bytes),/hidden@example.com/);const doc=await PDFDocument.load(result.bytes);for(const page of doc.getPages())assert.equal(page.node.has(PDFName.of('DyOfficeStamps')),false)
})
test('query discloses unsupported rotated text and truncation; copy refuses incomplete reports and unsafe inputs',async()=>{
 const d=await PDFDocument.create();d.addPage([500,600]).drawText('tilted@example.com',{x:80,y:200,size:12,rotate:degrees(25)});const report=await query(Buffer.from(await d.save()));assert.equal(report.candidates.length,0);assert.deepEqual(report.unsupportedPages,[1])
 const many=await PDFDocument.create();for(let p=0;p<10;p++){const page=many.addPage([500,800]);for(let i=0;i<60;i++)page.drawText('a@example.com',{x:20,y:20+i*12,size:10})}const bytes=Buffer.from(await many.save()),truncated=await query(bytes);assert.equal(truncated.candidates.length,500);assert.equal(truncated.truncated,true)
 await assert.rejects(createPdfRedactionsJob('redactedCopy').execute(bytes,request('redactedCopy',{ids:[truncated.candidates[0].id]})),{code:'PDF_REDACTION_TRUNCATED'})
 const controller=new AbortController(),pending=createIsolatedPdfRedactionsQueryJob().execute(await fixture(),request('redactionsQuery'),controller.signal);controller.abort();await assert.rejects(pending,{code:'ABORTED'})
})

test('space-separated phone, credit-card and IBAN candidates redact real characters while preserving neighbors',async()=>{
 const d=await PDFDocument.create(),page=d.addPage([500,600]),values=['Phone +1 415 555 2671 tail','Card 4111 1111 1111 1111 tail','IBAN GB82 WEST 1234 5698 7654 32 tail']
 for(const [index,value]of values.entries())page.drawText(value,{x:30,y:200+index*40,size:12})
 const bytes=Buffer.from(await d.save()),report=await query(bytes,{patterns:['phone','credit-card','iban']});assert.deepEqual(report.unsupportedPages,[]);assert.equal(report.candidates.length,3)
 const result=await createPdfRedactionsJob('redactedCopy').execute(bytes,request('redactedCopy',{patterns:['phone','credit-card','iban'],ids:report.candidates.map(item=>item.id)})),contents=await text(result.bytes)
 assert.doesNotMatch(contents,/2671|4111|GB82/);assert.match(contents,/Phone/);assert.match(contents,/Card/);assert.match(contents,/IBAN/);assert.equal(contents.match(/tail/g).length,3)
})

test('redaction copy retains PC shared-image protection and refuses signatures before mutation',async()=>{
 const d=await PDFDocument.create(),p=d.addPage([500,600]),pixel=new PNG({width:1,height:1});pixel.data.set([180,200,220,255]);const image=await d.embedPng(PNG.sync.write(pixel));p.drawImage(image,{x:20,y:180,width:250,height:60});p.drawImage(image,{x:20,y:350,width:250,height:60});p.drawText('a@example.com',{x:30,y:200,size:12});const bytes=Buffer.from(await d.save()),report=await query(bytes)
 await assert.rejects(createPdfRedactionsJob('redactedCopy').execute(bytes,request('redactedCopy',{ids:[report.candidates[0].id]})),{code:'PDF_REDACTION_REFUSED'})
 assert.match(await text(bytes),/a@example.com/)
 const signed=await PDFDocument.load(await fixture());signed.context.register(signed.context.obj({Type:'Sig',ByteRange:[0,1,2,3]}));await assert.rejects(query(Buffer.from(await signed.save())),{code:'SIGNATURE_EDIT_REFUSED'})
})
