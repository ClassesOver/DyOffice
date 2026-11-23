import test from 'node:test'
import assert from 'node:assert/strict'
import {PDFDocument,PDFName} from 'pdf-lib'
import {createPdfStampsJob} from '../server/src/pdf/stamps-job.mjs'
import {createPdfPageOpsJob} from '../server/src/pdf/page-ops-job.mjs'
import {createPdfExtractPagesJob} from '../server/src/pdf/extract-pages-job.mjs'
import {createPdfSplitJob} from '../server/src/pdf/split-job.mjs'
import {createPdfPageLayoutJob} from '../server/src/pdf/page-layout-job.mjs'
import {readPdfLeafObjects} from '../../pdf/src/main/text-edit.ts'
const stamp=async(bytes,operation)=>(await createPdfStampsJob().execute(bytes,JSON.stringify({version:1,action:'stamps',operation}))).bytes
const text=async bytes=>(await readPdfLeafObjects(bytes)).filter(o=>o.type===1).map(o=>o.text).join('|')
async function fixture(){const d=await PDFDocument.create();for(let i=1;i<=3;i++)d.addPage([400,400]).drawText('Body '+i,{x:30,y:200,size:12});let bytes=Buffer.from(await d.save());bytes=await stamp(bytes,{op:'set_watermark',text:'Draft'});return stamp(bytes,{op:'set_header_footer',page_number:true})}
const scenarios=[
 ['resize',()=>createPdfPageOpsJob(),{action:'pageOps',operations:[{op:'setPageSize',width:500,height:600}]},['Body 1','Body 2','Body 3']],
 ['crop',()=>createPdfPageOpsJob(),{action:'pageOps',operations:[{op:'cropPages',pages:[1,2,3],left:.02,top:.02,right:.98,bottom:.98}]},['Body 1','Body 2','Body 3']],
 ['rotate',()=>createPdfPageOpsJob(),{action:'pageOps',operations:[{op:'rotatePages',pages:[1,2],dir:90}]},['Body 1','Body 2','Body 3']],
 ['delete',()=>createPdfPageOpsJob(),{action:'pageOps',operations:[{op:'deletePage',page:1}]},['Body 2','Body 3']],
 ['reorder',()=>createPdfPageOpsJob(),{action:'pageOps',operations:[{op:'setPageOrder',order:[3,1,2]}]},['Body 3','Body 1','Body 2']],
 ['blank',()=>createPdfPageOpsJob(),{action:'pageOps',operations:[{op:'insertBlankPage',afterPage:1}]},['Body 1',null,'Body 2','Body 3']],
 ['extract',()=>createPdfExtractPagesJob(),{action:'extractPages',pages:[2,3]},['Body 2','Body 3']],
 ['split files',()=>createPdfSplitJob(),{action:'splitPdf',pagesPerFile:2},null],
 ['merge layout',()=>createPdfPageLayoutJob(),{action:'pageLayout',operation:{kind:'merge',perSheet:2,direction:'horizontal',separator:false}},null],
 ['split layout',()=>createPdfPageLayoutJob(),{action:'pageLayout',operation:{kind:'split',perPage:2}},null],
]
for(const [label,job,command,bodies] of scenarios)test(`managed stamps survive ${label} with current page numbers and remain removable`,async()=>{
 const result=await job().execute(await fixture(),JSON.stringify({version:1,...command})),outputs=result.files?.map(f=>f.bytes)??[result.bytes]
 for(const bytes of outputs){
  const d=await PDFDocument.load(bytes),count=d.getPageCount(),items=await readPdfLeafObjects(bytes)
  for(let index=0;index<count;index++){
   const strings=items.filter(o=>o.type===1&&o.page===index).map(o=>o.text).join('|')
   assert.match(strings,/Draft/,`watermark ${label} page ${index+1}`)
   assert.ok(strings.includes(`${index+1} / ${count}`),`page number ${label}: ${strings}`)
   if(bodies?.[index])assert.ok(strings.includes(bodies[index]),`retained body ${index+1}`)
  }
  let clean=await stamp(bytes,{op:'set_watermark',text:'Updated'});assert.doesNotMatch(await text(clean),/Draft/)
  clean=await stamp(clean,{op:'set_watermark',text:''});clean=await stamp(clean,{op:'set_header_footer'})
  assert.doesNotMatch(await text(clean),/Draft|Updated|\d \/ \d/)
  for(const page of (await PDFDocument.load(clean)).getPages())assert.equal(page.node.has(PDFName.of('DyOfficeStamps')),false)
 }
})
