import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {PDFDocument,PDFHexString,PDFName,degrees} from 'pdf-lib'
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs'
import {createPdfAnnotationJob} from '../server/src/pdf/annotation-job.mjs'
import {noteAppearance} from '../../pdf/src/main/save-pdf.ts'
import {createPdfPageOpsJob,validatePdfPageOperations} from '../server/src/pdf/page-ops-job.mjs'
import {createIsolatedPdfPageOpsJob} from '../server/src/pdf/page-ops-isolated.mjs'
const command=operations=>JSON.stringify({version:1,action:'pageOps',operations})
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
test('PDF metadata patches merge, clear and reset atomically while preserving page content',async()=>{
 const doc=await PDFDocument.load(await fixture());doc.setTitle('Original');doc.setAuthor('Author');doc.setSubject('Subject');doc.setKeywords(['one','two'])
 const bytes=Buffer.from(await doc.save()),before=await read(bytes)
 const result=await createPdfPageOpsJob().execute(bytes,command([{op:'setMetadata',metadata:{title:'Changed',author:''}},{op:'setMetadata',metadata:null},{op:'setMetadata',metadata:{title:' 最终标题 ',keywords:''}},{op:'rotatePages',pages:[1],dir:90}]))
 const after=await PDFDocument.load(result.bytes)
 assert.equal(after.getTitle(),'最终标题');assert.equal(after.getAuthor(),'Author');assert.equal(after.getSubject(),'Subject');assert.equal(after.getKeywords(),'')
 const pages=await read(result.bytes);assert.deepEqual(pages.map(page=>page.text),before.map(page=>page.text));assert.equal(pages[0].rotation,90)
 assert.equal(pages[0].annotations[0].contentsObj.str,before[0].annotations[0].contentsObj.str)
 assert.equal((await PDFDocument.load(bytes)).getTitle(),'Original')
 for(const metadata of [{title:42},{title:'x',producer:'bad'},{title:'x\u0000y'},[],{title:'x'.repeat(4001)}])assert.throws(()=>validatePdfPageOperations([{op:'setMetadata',metadata}],3),{code:'INVALID_PDF_PAGE_OPS'})
})
async function fixture(){
 const doc=await PDFDocument.create()
 for(let index=1;index<=3;index++){
  const page=doc.addPage([300+index*10,200+index*10]);page.drawText('Page '+index,{x:20,y:100,size:12});page.setRotation(degrees(index===3?90:0))
  const note=doc.context.register(doc.context.obj({Type:'Annot',Subtype:'Text',Rect:[20,20,40,40],Contents:PDFHexString.fromText('Note '+index),T:PDFHexString.fromText('Author '+index),P:page.ref,AP:{N:doc.context.register(noteAppearance(doc,[20,20,40,40],[1,0.9,0.3]))}}))
  page.node.set(PDFName.of('Annots'),doc.context.obj([note]))
 }
 return Buffer.from(await doc.save())
}
async function read(bytes){
 const task=getDocument({data:Uint8Array.from(bytes),disableFontFace:true,useSystemFonts:true})
 try{
  const pdf=await task.promise,pages=[]
  for(let i=1;i<=pdf.numPages;i++){const page=await pdf.getPage(i);pages.push({text:(await page.getTextContent()).items.map(item=>item.str??'').join(''),rotation:page.rotate,annotations:await page.getAnnotations()})}
  return pages
 }finally{await task.destroy()}
}

test('PDF page batch rotates, deletes and reorders original revision pages without moving their annotations',async()=>{
 const bytes=await fixture(),original=Buffer.from(bytes),before=await read(bytes)
 const result=await createPdfPageOpsJob().execute(bytes,command([{op:'rotatePages',pages:[1,3],dir:90},{op:'deletePage',page:2},{op:'setPageOrder',order:[3,1]}]))
 assert.deepEqual(bytes,original);assert.equal(result.inputSha256,hash(bytes));assert.equal(result.sha256,hash(result.bytes));assert.equal(result.size,result.bytes.length)
 const after=await read(result.bytes)
 assert.deepEqual(after.map(page=>page.text),['Page 3','Page 1']);assert.deepEqual(after.map(page=>page.rotation),[180,90])
 for(const [index,source]of [[0,2],[1,0]]){
  assert.equal(after[index].annotations[0].id,before[source].annotations[0].id)
  assert.equal(after[index].annotations[0].contentsObj.str,before[source].annotations[0].contentsObj.str)
  assert.equal(after[index].annotations[0].titleObj.str,before[source].annotations[0].titleObj.str)
 }
 assert.deepEqual((await read(bytes)).map(page=>page.text),['Page 1','Page 2','Page 3'])
})

test('PDF inserts blank pages at original anchors after reorder, preserving neighboring size and rotation',async()=>{
 const bytes=await fixture(),result=await createPdfPageOpsJob().execute(bytes,command([{op:'rotatePages',pages:[3],dir:90},{op:'setPageOrder',order:[3,1,2]},{op:'insertBlankPage',afterPage:0},{op:'insertBlankPage',afterPage:3},{op:'insertBlankPage',afterPage:3}]))
 const pages=await read(result.bytes)
 assert.deepEqual(pages.map(page=>page.text),['','Page 3','','','Page 1','Page 2'])
 assert.deepEqual(pages.map(page=>page.rotation),[180,180,180,180,0,0])
 const doc=await PDFDocument.load(result.bytes)
 for(const index of [0,2,3]){assert.equal(doc.getPage(index).getWidth(),330);assert.equal(doc.getPage(index).getHeight(),230);assert.equal(pages[index].annotations.length,0)}
 assert.equal(pages[1].annotations[0].contentsObj.str,'Note 3')
})

test('PDF page order null resets to file order and rotations accumulate',async()=>{
 const bytes=await fixture(),result=await createPdfPageOpsJob().execute(bytes,command([{op:'setPageOrder',order:[3,2,1]},{op:'setPageOrder',order:null},{op:'rotatePages',pages:[1],dir:-90},{op:'rotatePages',pages:[1],dir:180}]))
 const pages=await read(result.bytes);assert.deepEqual(pages.map(page=>page.text),['Page 1','Page 2','Page 3']);assert.equal(pages[0].rotation,90)
})

test('PDF page order before a later deletion filters the deleted original page',async()=>{
 const bytes=await fixture(),operations=[{op:'setPageOrder',order:[3,2,1]},{op:'deletePage',page:2}]
 validatePdfPageOperations(operations,3)
 const result=await createPdfPageOpsJob().execute(bytes,command(operations))
 assert.deepEqual((await read(result.bytes)).map(page=>page.text),['Page 3','Page 1'])
})

test('PDF page layout validator atomically rejects stale, duplicate, missing and entirely deleted pages',async()=>{
 const bytes=await fixture(),job=createPdfPageOpsJob()
 const invalid=[
  [{op:'rotatePages',pages:[4],dir:90}],
  [{op:'deletePage',page:2},{op:'deletePage',page:2}],
  [{op:'deletePage',page:2},{op:'rotatePages',pages:[2],dir:90}],
  [1,2,3].map(page=>({op:'deletePage',page})),
  [{op:'deletePage',page:2},{op:'setPageOrder',order:[3,2,1]}],
  [{op:'setPageOrder',order:[3,1]}],
  [{op:'setPageOrder',order:[3,1]},{op:'setPageOrder',order:[1,2,3]}],
  [{op:'deletePage',page:2},{op:'setPageOrder',order:[3,2,1]},{op:'setPageOrder',order:[3,1]}],
  [{op:'deletePage',page:2},{op:'insertBlankPage',afterPage:2}],
  [{op:'insertBlankPage',afterPage:4}],
 ]
 for(const operations of invalid){assert.throws(()=>validatePdfPageOperations(operations,3),{code:'INVALID_PDF_PAGE_OPS'});await assert.rejects(job.execute(bytes,command(operations)),{code:'INVALID_PDF_PAGE_OPS'})}
 assert.deepEqual((await read(bytes)).map(page=>page.text),['Page 1','Page 2','Page 3'])
 const input=[{op:'rotatePages',pages:[1],dir:90}],captured=validatePdfPageOperations(input,3);input[0].pages[0]=2;assert.deepEqual(captured[0].pages,[1]);assert.ok(Object.isFrozen(captured[0].pages))
 for(const operations of [[],[{op:'deletePage',page:0}],[{op:'rotatePages',pages:[1,1],dir:90}],[{op:'rotatePages',pages:[1],dir:45}],[{op:'setPageOrder',order:[1,1,2]}],[{op:'deletePage',page:1,path:'/tmp/x'}]])assert.throws(()=>validatePdfPageOperations(operations),{code:'INVALID_PDF_PAGE_OPS'})
 assert.throws(()=>validatePdfPageOperations([{op:'insertBlankPage',afterPage:0}],100),{code:'PDF_EDIT_LIMIT'})
})

test('PDF page operations refuse signed, encrypted and form documents',async()=>{
 const bytes=await fixture(),raw=command([{op:'deletePage',page:2}]),job=createPdfPageOpsJob()
 const signed=await PDFDocument.load(bytes);signed.context.register(signed.context.obj({Type:'Sig',ByteRange:[0,1,2,3]}))
 await assert.rejects(job.execute(Buffer.from(await signed.save()),raw),{code:'SIGNATURE_EDIT_REFUSED'})
 const form=await PDFDocument.load(bytes);form.getForm().createTextField('x')
 await assert.rejects(job.execute(Buffer.from(await form.save()),raw),{code:'PDF_EDIT_UNSUPPORTED_STRUCTURE'})
 const encrypted=await PDFDocument.load(bytes);encrypted.context.trailerInfo.Encrypt=encrypted.context.register(encrypted.context.obj({Filter:'Standard',V:1,R:2,Length:40,O:'x',U:'y',P:-4}))
 await assert.rejects(job.execute(Buffer.from(await encrypted.save()),raw),{code:'PASSWORD'})
})

test('isolated PDF page ops return bound real bytes and terminate cancelled work',async()=>{
 const bytes=await fixture(),raw=command([{op:'deletePage',page:2}]),job=createIsolatedPdfPageOpsJob()
 const result=await job.execute(bytes,raw);assert.equal(result.inputSha256,hash(bytes));assert.deepEqual((await read(result.bytes)).map(page=>page.text),['Page 1','Page 3'])
 const controller=new AbortController(),pending=job.execute(bytes,raw,controller.signal);controller.abort();await assert.rejects(pending,{code:'ABORTED'})
})

test('PDF resize uniformly scales original text and annotations while preserving rotated displayed paper size',async()=>{
 const bytes=await fixture(),before=await read(bytes),result=await createPdfPageOpsJob().execute(bytes,command([{op:'setPageSize',width:600,height:800}]))
 const doc=await PDFDocument.load(result.bytes),pages=await read(result.bytes)
 assert.deepEqual(pages.map(page=>page.text),before.map(page=>page.text))
 for(let index=0;index<3;index++){
  const page=doc.getPage(index),rotated=index===2,k=Math.min((rotated?800:600)/(310+index*10),(rotated?600:800)/(210+index*10))
  assert.equal(page.getWidth(),rotated?800:600);assert.equal(page.getHeight(),rotated?600:800);assert.equal(page.getRotation().angle,rotated?90:0)
  const note=pages[index].annotations[0]
  assert.equal(note.id,before[index].annotations[0].id);assert.equal(note.contentsObj.str,'Note '+(index+1));assert.equal(note.titleObj.str,'Author '+(index+1))
  for(let coordinate=0;coordinate<4;coordinate++)assert.ok(Math.abs(note.rect[coordinate]-before[index].annotations[0].rect[coordinate]*k)<1e-7)
 }
})

test('PDF crop maps displayed fractions through rotation and retains hidden text and annotation bytes',async()=>{
 const bytes=await fixture(),before=await PDFDocument.load(bytes)
 const result=await createPdfPageOpsJob().execute(bytes,command([{op:'cropPages',pages:[1,3],left:0.1,top:0.2,right:0.8,bottom:0.9}]))
 const doc=await PDFDocument.load(result.bytes)
 const expected=[{x:31,y:21,width:217,height:147},before.getPage(1).getCropBox(),{x:66,y:23,width:231,height:161}]
 for(let index=0;index<3;index++){
  const actual=doc.getPage(index).getCropBox()
  for(const key of ['x','y','width','height'])assert.ok(Math.abs(actual[key]-expected[index][key])<1e-7,`${index} ${key}: ${actual[key]} != ${expected[index][key]}`)
  assert.deepEqual(doc.getPage(index).getMediaBox(),before.getPage(index).getMediaBox())
  const refs=before.getPage(index).node.Annots().asArray()
  for(const ref of refs)assert.equal(String(doc.context.lookup(ref)),String(before.context.lookup(ref)))
  assert.equal(String(doc.getPage(index).node.get(PDFName.of('Contents'))),String(before.getPage(index).node.get(PDFName.of('Contents'))))
 }
 // Crop is not redaction: reopening and resetting the view still exposes all original text.
 for(const page of doc.getPages()){const box=page.getMediaBox();page.setCropBox(box.x,box.y,box.width,box.height)}
 assert.deepEqual((await read(Buffer.from(await doc.save()))).map(page=>page.text),['Page 1','Page 2','Page 3'])
})

test('PDF geometry operations reject invalid rectangles, sizes and mixed coordinate batches',async()=>{
 const bytes=await fixture(),job=createPdfPageOpsJob()
 const validCrop={op:'cropPages',pages:[1],left:0.1,top:0.2,right:0.9,bottom:0.8}
 for(const operations of [
  [{op:'setPageSize',width:71,height:800}],
  [{op:'setPageSize',width:600,height:14401}],
  [{...validCrop,left:-0.1}],
  [{...validCrop,left:0,top:0,right:1,bottom:1}],
  [{...validCrop,right:0.1}],
  [{...validCrop,bottom:0.1}],
  [{...validCrop,pages:[4]}],
  [{op:'setPageSize',width:600,height:800},{op:'deletePage',page:2}],
  [validCrop,{op:'insertBlankPage',afterPage:0}],
  [validCrop,{op:'setPageSize',width:600,height:800}],
 ]){
  assert.throws(()=>validatePdfPageOperations(operations,3),{code:'INVALID_PDF_PAGE_OPS'})
  await assert.rejects(job.execute(bytes,command(operations)),{code:'INVALID_PDF_PAGE_OPS'})
 }
})


test('isolated PDF geometry executes the PC helpers behind the same process boundary',async()=>{
 const bytes=await fixture(),job=createIsolatedPdfPageOpsJob()
 for(const operation of [{op:'setPageSize',width:600,height:800},{op:'cropPages',pages:[3],left:0.1,top:0.2,right:0.8,bottom:0.9}]){
  const result=await job.execute(bytes,command([operation]))
  assert.equal(result.inputSha256,hash(bytes));assert.equal((await read(result.bytes)).length,3)
 }
})


test('PDF geometry refuses degenerate source boxes before PC transformation',async()=>{
 const bytes=await fixture()
 for(const size of [[0,200],[300,0],[0,0],[-300,200]]){
  const doc=await PDFDocument.load(bytes);doc.getPage(0).setMediaBox(0,0,...size)
  const source=Buffer.from(await doc.save()),original=Buffer.from(source)
  for(const operation of [{op:'setPageSize',width:600,height:800},{op:'cropPages',pages:[1],left:0.1,top:0.2,right:0.8,bottom:0.9}])await assert.rejects(createPdfPageOpsJob().execute(source,command([operation])),{code:'PDF_EDIT_UNSUPPORTED_STRUCTURE'})
  assert.deepEqual(source,original)
 }
})


test('PDF real note then rotate-delete-order-insert-resize-crop accepts normalized blank annotations',async()=>{
 const doc=await PDFDocument.create()
 for(const text of ['Page One','Page Two','Page Three'])doc.addPage([300,200]).drawText(text,{x:20,y:100,size:12})
 let bytes=Buffer.from(await doc.save())
 bytes=(await createPdfAnnotationJob().execute(bytes,JSON.stringify({version:1,action:'annotateText',operations:[{page:3,text:'Three',type:'note',contents:'Keep with third page.'}]}))).bytes
 const job=createPdfPageOpsJob(),apply=async operations=>{bytes=(await job.execute(bytes,command(operations))).bytes}
 await apply([{op:'rotatePages',pages:[3],dir:90},{op:'deletePage',page:2},{op:'setPageOrder',order:[3,1]}])
 await apply([{op:'insertBlankPage',afterPage:1}])
 const inserted=await PDFDocument.load(bytes)
 assert.equal(inserted.getPage(1).node.Annots(),undefined)
 await apply([{op:'setPageSize',width:612,height:792}])
 const sized=await PDFDocument.load(bytes)
 assert.deepEqual(sized.getPage(0).getSize(),{width:792,height:612})
 assert.deepEqual(sized.getPage(1).getSize(),{width:792,height:612})
 assert.deepEqual(sized.getPage(2).getSize(),{width:612,height:792})
 assert.equal(sized.getPage(1).node.Annots().size(),0)
 assert.deepEqual((await read(bytes)).map(page=>page.text),['Page Three','','Page One'])
 assert.equal((await read(bytes))[0].annotations[0].contentsObj.str,'Keep with third page.')
 await apply([{op:'cropPages',pages:[1],left:0.1,top:0.2,right:0.9,bottom:0.8}])
 const cropped=await PDFDocument.load(bytes)
 assert.ok(Math.abs(cropped.getPage(0).getCropBox().width-792*0.6)<1e-7)
 assert.ok(Math.abs(cropped.getPage(0).getCropBox().height-612*0.8)<1e-7)
 assert.deepEqual(cropped.getPage(0).getMediaBox(),sized.getPage(0).getMediaBox())
 assert.deepEqual(cropped.getPage(1).getCropBox(),sized.getPage(1).getCropBox())
 assert.equal((await read(bytes))[0].annotations[0].contentsObj.str,'Keep with third page.')
})
