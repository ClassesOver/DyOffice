import test from 'node:test'
import assert from 'node:assert/strict'
import {PDFDocument,PDFName} from 'pdf-lib'
import {createHash,randomBytes} from 'node:crypto'
import {createPdfReplacePagesJob,framePdfReplacePages} from '../server/src/pdf/replace-pages-job.mjs'
import {createIsolatedPdfReplacePagesJob} from '../server/src/pdf/replace-pages-isolated.mjs'
import {createPdfStampsJob} from '../server/src/pdf/stamps-job.mjs'
import {readPdfLeafObjects} from '../../pdf/src/main/text-edit.ts'
const command=pages=>JSON.stringify({version:1,action:'replacePages',pages}),hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const insertCommand=afterPageIndex=>JSON.stringify({version:1,action:'insertPages',afterPageIndex})
async function fixture(labels){const d=await PDFDocument.create();for(const label of labels)d.addPage([500,600]).drawText(label,{x:30,y:200,size:14});return Buffer.from(await d.save())}
const text=async bytes=>(await readPdfLeafObjects(bytes)).filter(item=>item.type===1).map(item=>item.text).join('|')
const stamp=async(bytes,operation)=>(await createPdfStampsJob().execute(bytes,JSON.stringify({version:1,action:'stamps',operation}))).bytes
test('replace pages follows PC sorted unique target semantics and binds both PDF snapshots',async()=>{
 const target=await fixture(['Target 1','Target 2','Target 3','Target 4']),source=await fixture(['Imported A','Imported B']),frame=framePdfReplacePages(target,source)
 for(const job of [createPdfReplacePagesJob(),createIsolatedPdfReplacePagesJob()]){
  const result=await job.execute(frame,command([4,2,2]));assert.equal(await text(result.bytes),'Target 1|Imported A|Imported B|Target 3');assert.equal(result.inputSha256,hash(target));assert.equal(result.sourceSha256,hash(source));assert.equal(result.sha256,hash(result.bytes));assert.equal(result.size,result.bytes.length)
 }
 const all=await createPdfReplacePagesJob().execute(frame,command([1,2,3,4]));assert.equal(await text(all.bytes),'Imported A|Imported B')
})
test('insert pages uses the requested after-page position through the isolated worker',async()=>{
 const target=await fixture(['Target 1','Target 2','Target 3']),source=await fixture(['Imported A','Imported B']),job=createIsolatedPdfReplacePagesJob()
 const result=await job.execute(framePdfReplacePages(target,source),insertCommand(0))
 assert.equal(await text(result.bytes),'Target 1|Imported A|Imported B|Target 2|Target 3')
 assert.equal(result.inputSha256,hash(target));assert.equal(result.sourceSha256,hash(source));assert.equal(result.sha256,hash(result.bytes))
 await assert.rejects(job.execute(framePdfReplacePages(target,source),insertCommand(3)),{code:'INVALID_PDF_INSERT_PAGES'})
})
test('target global stamps recompute page numbers while source managed stamps remain visible imported content',async()=>{
 const target=await stamp(await fixture(['Target 1','Target 2','Target 3']),{op:'set_header_footer',page_number:true}),source=await stamp(await fixture(['Imported A','Imported B']),{op:'set_watermark',text:'Source watermark'}),result=await createPdfReplacePagesJob().execute(framePdfReplacePages(target,source),command([2]))
 const contents=await text(result.bytes);assert.match(contents,/Source watermark/);assert.match(contents,/4 \/ 4/)
 const removed=await stamp(result.bytes,{op:'set_header_footer'});assert.doesNotMatch(await text(removed),/1 \/ 4/);assert.equal((await text(removed)).match(/Source watermark/g).length,2);assert.match(await text(removed),/Target 1.*Imported A.*Imported B.*Target 3/)
})
test('replace refuses invalid pages, malformed frames, protected PDFs, oversized page result and cancellation',async()=>{
 const target=await fixture(['Target']),source=await fixture(['Source']),job=createPdfReplacePagesJob(),frame=framePdfReplacePages(target,source)
 for(const pages of [[],[0],[2],[1.5]])await assert.rejects(job.execute(frame,command(pages)),{code:'INVALID_PDF_REPLACE_PAGES'})
 await assert.rejects(job.execute(Buffer.from([0,0,0,250,1,2]),command([1])),{code:'INPUT_LIMIT'})
 const signed=await PDFDocument.load(source);signed.context.register(signed.context.obj({Type:'Sig',ByteRange:[0,1,2,3]}));await assert.rejects(job.execute(framePdfReplacePages(target,Buffer.from(await signed.save())),command([1])),{code:'SIGNATURE_EDIT_REFUSED'})
 const many=await fixture(Array.from({length:100},(_,i)=>'P'+i));const atLimit=await job.execute(framePdfReplacePages(many,source),command([1]));assert.equal((await PDFDocument.load(atLimit.bytes)).getPageCount(),100)
 const two=await fixture(['A','B']);await assert.rejects(job.execute(framePdfReplacePages(many,two),command([1])),{code:'PDF_EDIT_LIMIT'})
 const controller=new AbortController(),pending=createIsolatedPdfReplacePagesJob().execute(frame,command([1]),controller.signal);controller.abort();await assert.rejects(pending,{code:'ABORTED'})
})

test('isolated binary frame accepts source PDFs above raw-request limits without base64 expansion',async()=>{
 const target=await fixture(['Target']),d=await PDFDocument.load(await fixture(['Large source']));d.context.register(d.context.stream(randomBytes(1100000)));const source=Buffer.from(await d.save({useObjectStreams:false}));assert.ok(source.length>1024*1024)
 const result=await createIsolatedPdfReplacePagesJob().execute(framePdfReplacePages(target,source),command([1]));assert.equal(result.sourceSha256,hash(source));assert.equal(await text(result.bytes),'Large source')
})
