import test from 'node:test'
import assert from 'node:assert/strict'
import {PDFDocument,PDFName,StandardFonts,degrees,rgb} from 'pdf-lib'
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs'
import {createPdfBlockMovesJob,planPdfBlockMoves,validatePdfBlockMoveOperations} from '../server/src/pdf/block-moves-job.mjs'
import {createIsolatedPdfBlockMovesJob} from '../server/src/pdf/block-moves-isolated.mjs'
const command=operations=>JSON.stringify({version:1,action:'blockMoves',operations})
async function fixture(rotate=0,userUnit=1){
 const doc=await PDFDocument.create(),page=doc.addPage([500,500]),font=await doc.embedFont(StandardFonts.CourierBold)
 page.setCropBox(20,30,450,430);page.setRotation(degrees(rotate));page.node.set(PDFName.of('UserUnit'),doc.context.obj(userUnit))
 page.drawText('Move this paragraph with its original font.',{x:45,y:400,size:12,font,color:rgb(.2,.4,.7)})
 page.drawText('Second line keeps its original spacing.',{x:45,y:384,size:12,font,color:rgb(.2,.4,.7)})
 page.drawText('Unrelated footer stays put.',{x:45,y:100,size:10})
 page.drawRectangle({x:300,y:120,width:60,height:50,color:rgb(.9,.5,.2)})
 const image=await doc.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOD8AAAAASUVORK5CYII=','base64'));page.drawImage(image,{x:300,y:210,width:25,height:25})
 return Buffer.from(await doc.save())
}
async function read(bytes){const task=getDocument({data:Uint8Array.from(bytes),disableFontFace:true,useSystemFonts:true});try{const page=await(await task.promise).getPage(1);return {viewport:page.getViewport({scale:1}),content:await page.getTextContent()}}finally{await task.destroy()}}
test('block move translates original objects and leaves text, font, image and shape neighbors intact',async()=>{
 const input=await fixture(),copy=Buffer.from(input),operations=[{page:1,paragraph_text:'Move this paragraph',dx:30,dy:55}],before=await read(input)
 for(const job of [createPdfBlockMovesJob(),createIsolatedPdfBlockMovesJob()]){
  const result=await job.execute(input,command(operations)),after=await read(result.bytes)
  assert.equal(after.content.items.map(item=>item.str).join('').replace(/\s/g,''),before.content.items.map(item=>item.str).join('').replace(/\s/g,''))
  for(const prefix of ['Move','Second','Unrelated']){
   const old=before.content.items.find(item=>item.str.startsWith(prefix)),current=after.content.items.find(item=>item.str.startsWith(prefix));assert.ok(current)
   const moved=prefix!=='Unrelated'
   assert.ok(Math.abs(current.transform[4]-old.transform[4]-(moved?30:0))<.1)
   assert.ok(Math.abs(current.transform[5]-old.transform[5]+(moved?55:0))<.1)
   assert.equal(current.height,old.height)
   assert.equal(after.content.styles[current.fontName].fontFamily,before.content.styles[old.fontName].fontFamily)
  }
 }
 assert.deepEqual(input,copy)
})
test('move uses display offsets through all page rotations, nonzero CropBox and UserUnit',async()=>{
 for(const rotate of [0,90,180,270]){
  const input=await fixture(rotate,2),operations=[{page:1,paragraph_text:'Move this paragraph',dx:26,dy:42}],before=await read(input),result=await createPdfBlockMovesJob().execute(input,command(operations)),after=await read(result.bytes)
  const first=content=>content.items.find(item=>item.str.startsWith('Move'));assert.ok(first(after.content),JSON.stringify({rotate,items:after.content.items.map(item=>item.str)}))
  const a=first(before.content),b=first(after.content),[ax,ay]=before.viewport.convertToViewportPoint(a.transform[4],a.transform[5]),[bx,by]=after.viewport.convertToViewportPoint(b.transform[4],b.transform[5])
  assert.ok(Math.abs(bx-ax-26)<.1,`${rotate} dx=${bx-ax}`);assert.ok(Math.abs(by-ay-42)<.1,`${rotate} dy=${by-ay}`)
 }
})
test('move keeps PC free translation semantics without clamping or avoiding occupied space',async()=>{
 const input=await fixture(),[plan]=await planPdfBlockMoves(input,validatePdfBlockMoveOperations([{page:1,paragraph_text:'Move this',dx:-1000,dy:500}]))
 assert.deepEqual(plan.translate,[-1000,-500])
 await createPdfBlockMovesJob().execute(input,command([{page:1,paragraph_text:'Move this',dx:-1000,dy:500}]))
})
test('move refuses invalid, ambiguous and overlapping targets before writing, and cancels isolated work',async()=>{
 const input=await fixture()
 for(const patch of [{dx:0,dy:0},{dx:Infinity},{dy:'1'},{paragraph_text:''},{x:1},{page:0}])assert.throws(()=>validatePdfBlockMoveOperations([{page:1,paragraph_text:'Move this',dx:1,dy:1,...patch}]))
 await assert.rejects(createPdfBlockMovesJob().execute(input,command([{page:1,paragraph_text:'Move this',dx:1,dy:1},{page:1,paragraph_text:'Second line',dx:1,dy:1}])),{code:'PDF_BLOCK_OVERLAP'})
 const doc=await PDFDocument.load(input);doc.getPage(0).drawText('Move this other block',{x:40,y:180,size:10})
 await assert.rejects(createPdfBlockMovesJob().execute(Buffer.from(await doc.save()),command([{page:1,paragraph_text:'Move this',dx:1,dy:1}])),{code:'PDF_BLOCK_AMBIGUOUS'})
 const controller=new AbortController(),pending=createIsolatedPdfBlockMovesJob().execute(input,command([{page:1,paragraph_text:'Move this',dx:1,dy:1}]),controller.signal);controller.abort();await assert.rejects(pending,{code:'ABORTED'})
})

test('nested scaled Forms lift only selected text while images, paths and sibling text keep page geometry',async()=>{
 const source=await PDFDocument.load(await fixture()),middle=await PDFDocument.create(),midPage=middle.addPage([500,500]),inner=await middle.embedPage(source.getPage(0));midPage.drawPage(inner,{x:10,y:20,xScale:.9,yScale:.9})
 const doc=await PDFDocument.create(),page=doc.addPage([600,600]),outer=await doc.embedPage((await PDFDocument.load(await middle.save())).getPage(0));page.drawPage(outer,{x:55,y:70,xScale:.8,yScale:.8});page.drawText('Outside template',{x:30,y:40,size:12})
 const input=Buffer.from(await doc.save()),before=await read(input),result=await createPdfBlockMovesJob().execute(input,command([{page:1,paragraph_text:'Move this paragraph',dx:18,dy:24}])),after=await read(result.bytes)
 for(const prefix of ['Move','Unrelated','Outside']){
  const a=before.content.items.find(item=>item.str.startsWith(prefix)),b=after.content.items.find(item=>item.str.startsWith(prefix));assert.ok(a&&b)
  assert.ok(Math.abs(b.transform[4]-a.transform[4]-(prefix==='Move'?18:0))<.1);assert.ok(Math.abs(b.transform[5]-a.transform[5]+(prefix==='Move'?24:0))<.1)
 }
})

test('native position verification rejects unchanged results and any unintended neighbor translation',async()=>{
 const {verifyTextBlockMoves}=await import('../../pdf/src/main/text-edit.ts'),{applySaveRequest}=await import('../../pdf/src/main/save-pdf.ts')
 const input=await fixture(),operations=validatePdfBlockMoveOperations([{page:1,paragraph_text:'Move this',dx:20,dy:30}]),targets=await planPdfBlockMoves(input,operations)
 assert.equal(await verifyTextBlockMoves(input,input,targets),false)
 const neighbor=await planPdfBlockMoves(input,validatePdfBlockMoveOperations([{page:1,paragraph_text:'Unrelated footer',dx:5,dy:5}]))
 const extra=await applySaveRequest(input,{formValues:[],markups:[],drawings:[],rotations:[],textEdits:[...targets,...neighbor]})
 assert.equal(await verifyTextBlockMoves(input,extra.bytes,targets),false)
})

test('embedded subset font and its Chinese glyphs survive move without renaming normalization',async()=>{
 const {readFile}=await import('node:fs/promises'),{pdfFontkit}=await import('../src/editors/pdf-fontkit.ts'),doc=await PDFDocument.create();doc.registerFontkit(pdfFontkit)
 const font=await doc.embedFont(await readFile(new URL('../../docs/src/renderer/fonts/NotoSansCJKsc-Regular-subset.woff2',import.meta.url)),{subset:true}),page=doc.addPage([500,400]);page.drawText('项目计划已经完成预算复核',{x:40,y:300,size:16,font,color:rgb(.1,.4,.7)});page.drawText('Unrelated',{x:40,y:60,size:12})
 const input=Buffer.from(await doc.save()),result=await createPdfBlockMovesJob().execute(input,command([{page:1,paragraph_text:'项目计划',dx:25,dy:35}])),after=await read(result.bytes)
 assert.ok(after.content.items.some(item=>item.str.includes('项目计划已经完成预算复核')))
})
