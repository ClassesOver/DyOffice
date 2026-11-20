import test from 'node:test'
import assert from 'node:assert/strict'
import {PDFDocument,PDFName,degrees} from 'pdf-lib'
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs'
import {createPdfTextInsertsJob,planPdfTextInserts,validatePdfTextInsertOperations} from '../server/src/pdf/text-inserts-job.mjs'
import {createIsolatedPdfTextInsertsJob,createIsolatedPdfTextInsertsQueryJob} from '../server/src/pdf/text-inserts-isolated.mjs'
import {applySaveRequest} from '../../pdf/src/main/save-pdf.ts'
const command=operations=>JSON.stringify({version:1,action:'textInserts',operations})
async function fixture({rotate=0,userUnit=1}={}){
 const doc=await PDFDocument.create(),page=doc.addPage([440,360]);page.setCropBox(20,30,400,300);page.setRotation(degrees(rotate));page.node.set(PDFName.of('UserUnit'),doc.context.obj(userUnit));page.drawText('Name: Before',{x:55,y:240,size:12})
 return Buffer.from(await doc.save())
}
async function items(bytes){const task=getDocument({data:Uint8Array.from(bytes),disableFontFace:true,useSystemFonts:true});try{return await(await(await task.promise).getPage(1)).getTextContent()}finally{await task.destroy()}}
test('new text plans anchor placement, CJK wrapping and alignment then saves real searchable content',async()=>{
 const input=await fixture(),copy=Buffer.from(input),operations=[{page:1,text:'张三预算完成',anchor_text:'Name:',placement:'below',font_size:14,max_width:45,align:'right',color:'#164A78',bold:true},{page:1,text:'New report\nSecond line',x:30,y:160,font:'times',italic:true,align:'center',max_width:150}]
 const plans=await planPdfTextInserts(input,validatePdfTextInsertOperations(operations))
 assert.equal(plans.length,2);assert.ok(plans[0].text.includes('\n'));assert.equal(plans[0].align,'right');assert.ok(plans[0].lineXOffsets.every(x=>x<0));assert.deepEqual(plans[0].color,[22,74,120]);assert.ok(plans[0].origin[1]<240)
 for(const job of [createPdfTextInsertsJob(),createIsolatedPdfTextInsertsJob()]){
  const result=await job.execute(input,command(operations)),content=await items(result.bytes),text=content.items.map(item=>item.str).join('').replace(/\s/g,'')
  assert.ok(text.includes('Name:Before'));assert.ok(text.includes('张三预算完成'));assert.ok(text.includes('NewreportSecondline'))
 }
 assert.deepEqual(input,copy)
})
test('display-space coordinates honor CropBox, quarter rotations and UserUnit for actual glyph placement',async()=>{
 for(const rotate of [0,90,180,270]){
  const input=await fixture({rotate,userUnit:2}),operations=[{page:1,text:'Inserted',x:40,y:60,font_size:20,font:'courier'}],plans=await planPdfTextInserts(input,validatePdfTextInsertOperations(operations))
  assert.equal(plans[0].fontSize,10);assert.equal(plans[0].rotate,rotate)
  const result=await createPdfTextInsertsJob().execute(input,command(operations)),task=getDocument({data:Uint8Array.from(result.bytes),disableFontFace:true,useSystemFonts:true})
  try{
   const page=await(await task.promise).getPage(1),viewport=page.getViewport({scale:1}),item=(await page.getTextContent()).items.find(item=>item.str==='Inserted')
   assert.ok(item);const [x,y]=viewport.convertToViewportPoint(item.transform[4],item.transform[5]);assert.ok(Math.abs(x-40)<0.5,`${rotate} x=${x}`);assert.ok(Math.abs(y-80)<0.5,`${rotate} y=${y}`)
  }finally{await task.destroy()}
 }
})
test('defaults center text near top; explicit fonts and flags resolve real faces rather than CSS estimates',async()=>{
 const input=await fixture(),plans=await planPdfTextInserts(input,validatePdfTextInsertOperations([{page:1,text:'Centered',font:'arial',bold:true},{page:1,text:'WWW iii',font:'courier',italic:true,x:5,y:120}]))
 assert.ok(plans[0].origin[0]>20);assert.equal(plans[0].origin[1],244);assert.equal(plans[0].bold,true);assert.equal(plans[1].italic,true)
})
test('layout query uses each draft orientation over the saved rotation and writes at the displayed coordinates',async()=>{
 const input=await fixture({rotate:270,userUnit:2})
 const operations=[{page:1,text:'Earlier',x:30,y:45,font_size:20},{page:1,text:'After rotation',x:40,y:60,font_size:20}]
 const query=rotationDeltas=>JSON.stringify({version:1,action:'textInsertsQuery',operations,rotationDeltas})
 const job=createIsolatedPdfTextInsertsQueryJob()
 const report=JSON.parse((await job.execute(input,query([0,180]))).bytes.toString())
 assert.deepEqual(report.inserts.map(insert=>insert.rotate),[270,90])
 for(const invalid of [[0],[0,45],[0,'180']])await assert.rejects(job.execute(input,query(invalid)),{code:'INVALID_PDF_TEXT_INSERT'})
 const result=await applySaveRequest(input,{formValues:[],drawings:[],markups:[],textInserts:report.inserts,rotations:[{pageIndex:0,delta:180}]})
 const task=getDocument({data:Uint8Array.from(result.bytes),disableFontFace:true,useSystemFonts:true})
 try{
  const page=await(await task.promise).getPage(1),viewport=page.getViewport({scale:1})
  const text=(await page.getTextContent()).items.find(item=>item.str==='After rotation')
  assert.ok(text)
  assert.deepEqual(viewport.convertToViewportPoint(text.transform[4],text.transform[5]).map(Math.round),[40,80])
 }finally{await task.destroy()}
})
test('missing anchors, unavailable pages and unsafe schemas reject the whole batch',async()=>{
 const input=await fixture()
 for(const operation of [{page:1,text:'Lost',anchor_text:'Missing'},{page:2,text:'Lost'}])await assert.rejects(createPdfTextInsertsJob().execute(input,command([{page:1,text:'First'},operation])),error=>['PDF_TEXT_ANCHOR_NOT_FOUND','INVALID_PDF_TEXT_INSERT'].includes(error.code))
 for(const patch of [{font_size:0},{max_width:-1},{x:Infinity},{font:'unknown'},{placement:'left'},{color:'#xx1122'},{bold:'true'},{text:'\0bad'},{origin:[0,0]},{page:0}])assert.throws(()=>validatePdfTextInsertOperations([{page:1,text:'x',...patch}]))
})
test('text insert preserves ordinary fields but refuses signed encrypted and XFA files',async()=>{
 const input=await fixture(),doc=await PDFDocument.load(input);doc.getForm().createTextField('field')
 const inserted=await createPdfTextInsertsJob().execute(Buffer.from(await doc.save()),command([{page:1,text:'x'}]));assert.equal((await PDFDocument.load(inserted.bytes)).getForm().getFields()[0].getName(),'field')
 doc.getForm().acroForm.dict.set(PDFName.of('XFA'),doc.context.stream('unsupported'))
 await assert.rejects(createPdfTextInsertsJob().execute(Buffer.from(await doc.save({updateFieldAppearances:false})),command([{page:1,text:'x'}])),{code:'PDF_EDIT_UNSUPPORTED_STRUCTURE'})
 const signed=await PDFDocument.load(input);signed.context.register(signed.context.obj({Type:'Sig',ByteRange:[0,1,2,3]}))
 await assert.rejects(createPdfTextInsertsJob().execute(Buffer.from(await signed.save()),command([{page:1,text:'x'}])),{code:'SIGNATURE_EDIT_REFUSED'})
 const encrypted=await PDFDocument.load(input);encrypted.context.trailerInfo.Encrypt=encrypted.context.register(encrypted.context.obj({Filter:'Standard',V:1,R:2,Length:40,O:'x',U:'y',P:-4}))
 await assert.rejects(createPdfTextInsertsJob().execute(Buffer.from(await encrypted.save()),command([{page:1,text:'x'}])),{code:'PASSWORD'})
})

test('blank anchor follows PC unanchored defaults; cancel suppresses process results',async()=>{
 const input=await fixture(),[plan]=await planPdfTextInserts(input,validatePdfTextInsertOperations([{page:1,text:'Blank anchor',anchor_text:'  '}]))
 assert.equal(plan.origin[1],244)
 const job=createIsolatedPdfTextInsertsJob(),controller=new AbortController(),pending=job.execute(input,command([{page:1,text:'Cancelled'}]),controller.signal)
 controller.abort();await assert.rejects(pending,{code:'ABORTED'})
})

test('shared mixed-script face grouping measures the same advances written by PDFium for aligned lines',async()=>{
 const input=await fixture(),operations=[{page:1,text:'Wide WWW line\nsmall',font:'arial',font_size:16,bold:true,max_width:180,align:'right',x:30,y:100},{page:1,text:'预算完成',font:'arial',font_size:16,bold:true,x:30,y:180}],plans=await planPdfTextInserts(input,validatePdfTextInsertOperations(operations))
 const result=await createPdfTextInsertsJob().execute(input,command(operations)),content=await items(result.bytes)
 for(const [index,line]of plans[0].text.split('\n').entries()){
  const item=content.items.find(item=>item.str===line)
  assert.ok(item)
  assert.ok(Math.abs(item.width+plans[0].lineXOffsets[index])<0.2,`${line} actual=${item.width} planned=${-plans[0].lineXOffsets[index]}`)
  assert.ok(Math.abs(item.transform[4]-(plans[0].origin[0]+plans[0].lineXOffsets[index]))<0.2)
 }
})
