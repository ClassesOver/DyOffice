import test from 'node:test'
import assert from 'node:assert/strict'
import {PDFDocument} from 'pdf-lib'
import {preparePdfMerge,validatePdfMergeFiles} from '../src/editors/pdf-merge-download.ts'

async function makePdf(pageCount) {
 const doc=await PDFDocument.create()
 for(let index=0;index<pageCount;index++)doc.addPage([200+index,300])
 return (await doc.save()).buffer
}

test('PDF merge preserves order and rejects a later invalid source',async()=>{
 const signal=new AbortController().signal
 const base=await makePdf(1)
 const source=new File([await makePdf(2)],'source.pdf')
 const {merged,appended}=await preparePdfMerge(base,[source],signal)
 assert.equal(appended,2)
 assert.deepEqual((await PDFDocument.load(merged)).getPages().map(page=>page.getWidth()),[200,200,201])
 await assert.rejects(preparePdfMerge(base,[source,new File(['not a PDF'],'invalid.pdf')],signal))
})

test('PDF merge bounds all source bytes and the total page count',async()=>{
 const signal=new AbortController().signal
 const source=new File([await makePdf(500)],'big.pdf')
 assert.throws(()=>validatePdfMergeFiles(Array.from({length:33},()=>source)),/up to 32/)
 assert.throws(()=>validatePdfMergeFiles([new File([],'empty.pdf')]),/nonempty PDFs/)
 const oversized=new File(['fixture'],'oversized.pdf')
 Object.defineProperty(oversized,'size',{value:64*1024*1024})
 assert.throws(()=>validatePdfMergeFiles([oversized]),/64 MiB/)
 await assert.rejects(preparePdfMerge(await makePdf(1),[source],signal),/merge page limit/)
})

test('PDF merge stops before opening sources when canceled',async()=>{
 const controller=new AbortController()
 controller.abort()
 const source=new File(['fixture'],'unread.pdf')
 source.arrayBuffer=()=>assert.fail('a canceled merge read its source')
 await assert.rejects(preparePdfMerge(await makePdf(1),[source],controller.signal),{name:'AbortError'})
})
