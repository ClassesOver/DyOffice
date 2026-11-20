import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {PDFDocument,PDFName,degrees} from 'pdf-lib'
import {createPdfService} from '../server/src/modules/pdf/service.ts'
import {createPdfTextInsertsJob} from '../server/src/pdf/text-inserts-job.mjs'
import {readPdfLeafObjects} from '../../pdf/src/main/text-edit.ts'
import {pdfRectToCss} from '../../pdf/src/renderer/annotations.ts'
const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
async function fixture(){const d=await PDFDocument.create();for(const rotation of [0,90,180,270]){const p=d.addPage([500,600]);p.setCropBox(20,30,450,540);p.setRotation(degrees(rotation));p.node.set(PDFName.of('UserUnit'),d.context.obj(2));p.drawText('Anchor',{x:40,y:220,size:14})}return Buffer.from(await d.save())}
test('text insert preview is isolated, read-only, revision-bound and matches actual native save on rotated CropBox/UserUnit pages',async()=>{
 const bytes=await fixture(),revision=randomUUID(),fileId=randomUUID(),head=digest(bytes),calls=[]
 const files={async openFile(token){if(token!=='owner')throw Object.assign(Error('forbidden'),{statusCode:404});calls.push('open');return {format:'pdf',file:{revision,sha256:head}}},async download(){calls.push('download');return {format:'pdf',bytes}}},leases={async getLease(){throw Error('query must not acquire lease')}},revisions={async stageUpload(){throw Error('query must not stage')}}
 const service=createPdfService({files,leases,revisions}),operations=[1,2,3,4].map(page=>({page,text:'Preview wrapping text',x:-10,y:50,font_size:16,max_width:85,align:'center',color:'123456',bold:true})),report=await service.queryTextInserts('owner',fileId,{revision,operations})
 assert.equal(report.revision,revision);assert.equal(report.blocks.length,4);assert.equal(digest(bytes),head);assert.ok(calls.includes('download'))
 const saved=await createPdfTextInsertsJob().execute(bytes,JSON.stringify({version:1,action:'textInserts',operations})),leaves=await readPdfLeafObjects(saved.bytes)
 for(const [index,block]of report.blocks.entries()){
  assert.equal(block.page,index+1);assert.equal(block.x,0);assert.equal(block.y,50);assert.equal(block.width,85);assert.equal(block.font_size,16);assert.equal(block.color,'#123456');assert.equal(block.align,'center');assert.equal(block.bold,true);assert.match(block.text,/\n/);assert.equal(block.height,block.text.split('\n').length*19.2)
  const objects=leaves.filter(item=>item.page===index&&item.type===1&&item.text?.trim()!=='Anchor');assert.equal(objects.length,block.text.split('\n').length)
  const geom={pw:900,ph:1080,x0:20,y0:30,userUnit:2,rot:index*90},boxes=objects.map(item=>pdfRectToCss(geom,item.bounds,1));assert.ok(Math.min(...boxes.map(box=>box.left))>=block.x-.1);assert.ok(Math.max(...boxes.map(box=>box.left+box.width))<=block.x+block.width+.1)
 }
 await assert.rejects(service.queryTextInserts('other',fileId,{revision,operations}),error=>error.statusCode===404)
 await assert.rejects(service.queryTextInserts('owner',fileId,{revision:randomUUID(),operations}),error=>error.statusCode===409)
})


test('native text query exposes raw writer inserts with unchanged preview blocks and source bytes',async()=>{
 const {createPdfTextInsertsQueryJob,planPdfTextInserts}=await import('../server/src/pdf/text-inserts-job.mjs'),{applySaveRequest}=await import('../../pdf/src/main/save-pdf.ts'),{viewToPdf}=await import('../../pdf/src/renderer/annotations.ts'),bytes=await fixture(),head=digest(bytes),operations=[1,2,3,4].map(page=>({page,text:'Raw writer layout',x:30,y:50,font_size:16,max_width:85,align:'right',color:'123456',bold:true})),query=await createPdfTextInsertsQueryJob().execute(bytes,JSON.stringify({version:1,action:'textInsertsQuery',operations})),report=JSON.parse(query.bytes)
 assert.equal(report.inserts.length,4);assert.equal(report.blocks.length,4);assert.equal(digest(bytes),head);assert.equal(query.inputSha256,head);assert.deepEqual(report.inserts,JSON.parse(JSON.stringify(await planPdfTextInserts(bytes,operations))))
 for(const [index,insert]of report.inserts.entries()){const block=report.blocks[index],geom={pw:900,ph:1080,x0:20,y0:30,userUnit:2,rot:index*90};assert.equal(insert.pageIndex,index);assert.deepEqual(insert.origin,viewToPdf(geom,block.x+block.width,block.y+block.font_size));assert.equal(insert.fontSize,8);assert.equal(insert.lineLeading,9.6);assert.equal(insert.rotate,index*90);assert.deepEqual(insert.color,[18,52,86]);assert.equal(insert.text,block.text);assert.deepEqual(insert.lineXOffsets,block.line_widths.map(width=>-width/2))}
 const applied=await applySaveRequest(bytes,{formValues:[],markups:[],drawings:[],rotations:[],textInserts:report.inserts}),saved=await createPdfTextInsertsJob().execute(bytes,JSON.stringify({version:1,action:'textInserts',operations}))
 assert.deepEqual(await readPdfLeafObjects(applied.bytes),await readPdfLeafObjects(saved.bytes));assert.equal(digest(bytes),head)
})
