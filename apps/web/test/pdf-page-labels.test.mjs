import test from 'node:test'
import assert from 'node:assert/strict'
import {PDFDocument,PDFHexString,PDFName} from 'pdf-lib'
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs'
import {applySaveRequest} from '../../pdf/src/main/save-pdf.ts'
import {preparePdfMerge} from '../src/editors/pdf-merge-download.ts'
import {createPdfPageOpsJob} from '../server/src/pdf/page-ops-job.mjs'
import {createPdfExtractPagesJob} from '../server/src/pdf/extract-pages-job.mjs'
import {createPdfSplitJob} from '../server/src/pdf/split-job.mjs'
import {createPdfReplacePagesJob,framePdfReplacePages} from '../server/src/pdf/replace-pages-job.mjs'

const command=(action,parameters)=>JSON.stringify({version:1,action,...parameters})
const text=PDFHexString.fromText

async function fixture(pageCount, ranges) {
 const doc=await PDFDocument.create()
 for(let index=0;index<pageCount;index++)doc.addPage([350+index*10,500])
 if(ranges){
  const leaf=doc.context.register(doc.context.obj({Limits:[ranges[0],ranges.at(-2)],Nums:ranges}))
  doc.catalog.set(PDFName.of('PageLabels'),doc.context.obj({Kids:[leaf]}))
 }
 return Buffer.from(await doc.save())
}

async function labels(bytes) {
 const task=getDocument({data:Uint8Array.from(bytes)})
 try { return await (await task.promise).getPageLabels() }
 finally { await task.destroy() }
}

const source=()=>fixture(4,[0,{S:'r',St:2},2,{P:text('附-'),S:'D',St:7}])
const donor=()=>fixture(2,[0,{P:text('Cover')},1,{P:text('X-'),S:'R',St:4}])

test('PDF page labels follow their original pages after delete, reorder and blank-page insert',async()=>{
 const original=await source()
 const result=await createPdfPageOpsJob().execute(original,command('pageOps',{operations:[
  {op:'deletePage',page:2},{op:'setPageOrder',order:[4,1,3]},{op:'insertBlankPage',afterPage:0},
 ]}))
 assert.deepEqual(await labels(result.bytes),['1','附-8','ii','附-7'])
 assert.deepEqual(await labels(original),['ii','iii','附-7','附-8'])
})

test('PDF save numbers blank pages by output position when appending and reordering together',async()=>{
 const result=await applySaveRequest(await source(),{
  formValues:[],markups:[],blankPages:[{pageIndex:4,width:350,height:500}],pageOrder:[3,4,0,1,2],
 })
 assert.deepEqual(await labels(result.bytes),['附-8','2','ii','iii','附-7'])
})

test('PDF import and replacement retain labels from both documents',async()=>{
 const frame=framePdfReplacePages(await source(),await donor()),job=createPdfReplacePagesJob()
 const inserted=await job.execute(frame,command('insertPages',{afterPageIndex:0}))
 assert.deepEqual(await labels(inserted.bytes),['ii','Cover','X-IV','iii','附-7','附-8'])
 const replaced=await job.execute(frame,command('replacePages',{pages:[4,2]}))
 assert.deepEqual(await labels(replaced.bytes),['ii','Cover','X-IV','附-7'])
})

test('PDF extraction and splitting preserve the original labels in each output file',async()=>{
 const bytes=await source()
 const extracted=await createPdfExtractPagesJob().execute(bytes,command('extractPages',{pages:[4,2,1]}))
 assert.deepEqual(await labels(extracted.bytes),['附-8','iii','ii'])
 const split=await createPdfSplitJob().execute(bytes,command('splitPdf',{pagesPerFile:2}))
 assert.deepEqual(await Promise.all(split.files.map(file=>labels(file.bytes))),[['ii','iii'],['附-7','附-8']])
})

test('PDF merge keeps custom labels from each source and uses output positions for ordinary pages',async()=>{
 const first=await fixture(2),appended=[new File([await donor()],'labeled.pdf'),new File([await fixture(1)],'ordinary.pdf')]
 const view=first.buffer.slice(first.byteOffset,first.byteOffset+first.byteLength)
 const merged=await preparePdfMerge(view,appended,new AbortController().signal)
 assert.deepEqual(await labels(merged.merged),['1','2','Cover','X-IV','5'])
 const plain=await preparePdfMerge(view,[appended[1]],new AbortController().signal)
 assert.equal(await labels(plain.merged),null)
})
