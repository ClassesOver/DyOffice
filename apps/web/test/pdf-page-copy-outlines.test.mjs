import test from 'node:test'
import assert from 'node:assert/strict'
import {PDFDocument,PDFName,PDFString,PDFPageLeaf} from 'pdf-lib'
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs'
import {createPdfExtractPagesJob} from '../server/src/pdf/extract-pages-job.mjs'
import {createPdfSplitJob} from '../server/src/pdf/split-job.mjs'
import {createPdfReplacePagesJob,framePdfReplacePages} from '../server/src/pdf/replace-pages-job.mjs'
import {preparePdfMerge} from '../src/editors/pdf-merge-download.ts'

const n=PDFName.of
async function fixture(label){
 const doc=await PDFDocument.create();for(let i=0;i<3;i++)doc.addPage()
 const name=PDFString.of('chapter')
 doc.catalog.set(n('Names'),doc.context.obj({Dests:{Names:[name,[doc.getPage(2).ref,'FitH',220]]}}))
 const register=fields=>doc.context.register(doc.context.obj(fields))
 const root=register({Type:'Outlines',Count:2})
 const heading=register({Title:PDFString.of(label),Parent:root,Dest:[doc.getPage(1).ref,'Fit'],Count:-2,F:2,C:[0,0.5,0]})
 const first=register({Title:PDFString.of('Numeric target'),Parent:heading,Dest:[0,'Fit']})
 const last=register({Title:PDFString.of('Named target'),Parent:heading,A:{S:'GoTo',D:name},Prev:first})
 doc.context.lookup(first).set(n('Next'),last)
 doc.context.lookup(heading).set(n('First'),first);doc.context.lookup(heading).set(n('Last'),last)
 const omitted=register({Title:PDFString.of('Middle only'),Parent:root,Dest:[doc.getPage(1).ref,'Fit'],Prev:heading})
 doc.context.lookup(heading).set(n('Next'),omitted)
 doc.context.lookup(root).set(n('First'),heading);doc.context.lookup(root).set(n('Last'),omitted)
 doc.catalog.set(n('Outlines'),root)
 return Buffer.from(await doc.save())
}

async function outline(bytes){
 const task=getDocument({data:Uint8Array.from(bytes)})
 try{
  const doc=await task.promise
  async function parse(item){
   const dest=typeof item.dest==='string'?await doc.getDestination(item.dest):item.dest
   const page=dest?(typeof dest[0]==='number'?dest[0]:await doc.getPageIndex(dest[0])):null
   return {title:item.title,page,fit:dest?.[1].name,children:await Promise.all(item.items.map(parse))}
  }
  return await Promise.all(((await doc.getOutline())??[]).map(parse))
 }finally{await task.destroy()}
}
const request=(action,parameters)=>JSON.stringify({version:1,action,...parameters})

test('extract and split retain nested bookmarks to selected pages in their new positions',async()=>{
 const bytes=await fixture('Chapter'),extracted=await createPdfExtractPagesJob().execute(bytes,request('extractPages',{pages:[3,1]}))
 const [group]=await outline(extracted.bytes)
 assert.equal(group.title,'Chapter');assert.equal(group.page,null)
 assert.deepEqual(group.children.map(({title,page,fit})=>[title,page,fit]),[['Numeric target',1,'Fit'],['Named target',0,'FitH']])
 const extractedDoc=await PDFDocument.load(extracted.bytes),root=extractedDoc.catalog.lookup(n('Outlines')),entry=root.lookup(n('First'))
 assert.equal(entry.lookup(n('Count')).asNumber(),-2)
 assert.equal(entry.lookup(n('F')).asNumber(),2)
 assert.equal(extractedDoc.context.enumerateIndirectObjects().filter(([,value])=>value instanceof PDFPageLeaf).length,2)
 const split=await createPdfSplitJob().execute(bytes,request('splitPdf',{pagesPerFile:2}))
 const parts=await Promise.all(split.files.map(part=>outline(part.bytes)))
 assert.deepEqual(parts.map(items=>items.map(x=>[x.title,x.page,x.children.map(y=>[y.title,y.page])])),[
  [['Chapter',1,[['Numeric target',0]]],['Middle only',1,[]]],
  [['Chapter',null,[['Named target',0]]]],
 ])
})

test('merge retains the existing outline and appends each donor outline with its own named destination',async()=>{
 const base=await fixture('Base'),donor=await fixture('Donor')
 const merged=await preparePdfMerge(base.buffer.slice(base.byteOffset,base.byteOffset+base.byteLength),[new File([donor],'donor.pdf')],new AbortController().signal)
 const items=await outline(merged.merged)
 assert.deepEqual(items.map(item=>[item.title,item.page]),[['Base',1],['Middle only',1],['Donor',4],['Middle only',4]])
 assert.deepEqual(items[0].children.map(item=>item.page),[0,2])
 assert.deepEqual(items[2].children.map(item=>item.page),[3,5])
})

test('inserting and replacing pages keep independent donor and target bookmarks',async()=>{
 const base=await fixture('Base'),donor=await fixture('Donor'),frame=framePdfReplacePages(base,donor),job=createPdfReplacePagesJob()
 const inserted=await job.execute(frame,request('insertPages',{afterPageIndex:0}))
 const items=await outline(inserted.bytes)
 assert.deepEqual(items.map(item=>[item.title,item.page]),[['Base',4],['Middle only',4],['Donor',2],['Middle only',2]])
 assert.deepEqual(items[0].children.map(item=>item.page),[0,5])
 assert.deepEqual(items[2].children.map(item=>item.page),[1,3])
 const replaced=await job.execute(frame,request('replacePages',{pages:[2]}))
 const rebuilt=await outline(replaced.bytes)
 assert.deepEqual(rebuilt.map(item=>[item.title,item.page]),[['Base',1],['Middle only',1],['Donor',2],['Middle only',2]])
 assert.deepEqual(rebuilt[0].children.map(item=>item.page),[0,4])
 assert.deepEqual(rebuilt[2].children.map(item=>item.page),[1,3])
})
