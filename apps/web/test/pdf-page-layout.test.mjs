import {test} from 'node:test'
import assert from 'node:assert/strict'
import {PDFDocument,PDFHexString,PDFName,degrees} from 'pdf-lib'
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs'
import {createPdfPageLayoutJob} from '../server/src/pdf/page-layout-job.mjs'
import {createIsolatedPdfPageLayoutJob} from '../server/src/pdf/page-layout-isolated.mjs'
const command=operation=>JSON.stringify({version:1,action:'pageLayout',operation})
async function fixture(){
 const doc=await PDFDocument.create()
 for(let index=0;index<2;index++){
  const page=doc.addPage([400,300]);page.setCropBox(100,50,200,200);page.drawText('Visible '+index,{x:130,y:150,size:12});page.drawText('Outside '+index,{x:10,y:20,size:12});page.setRotation(degrees(index*90))
  const ref=doc.context.register(doc.context.obj({Type:'Annot',Subtype:'Text',Rect:[130,130,150,150],P:page.ref,Contents:PDFHexString.fromText('Note '+index)}));page.node.set(PDFName.of('Annots'),doc.context.obj([ref]))
 }
 doc.addPage([400,300])
 return Buffer.from(await doc.save())
}
async function inspect(bytes){const task=getDocument({data:Uint8Array.from(bytes),disableFontFace:true,useSystemFonts:true});try{const pdf=await task.promise,out=[];for(let i=1;i<=pdf.numPages;i++){const page=await pdf.getPage(i);out.push({view:page.view,rotation:page.rotate,notes:(await page.getAnnotations()).map(note=>note.contentsObj.str)})}return out}finally{await task.destroy()}}
test('PDF split layout uses displayed crop cells, retains copied annotations and leaves source bytes unchanged',async()=>{
 const bytes=await fixture(),before=Buffer.from(bytes),result=await createPdfPageLayoutJob().execute(bytes,command({kind:'split',perPage:2}))
 assert.deepEqual(bytes,before);const pages=await inspect(result.bytes)
 assert.equal(pages.length,6);assert.deepEqual(pages.slice(0,2).map(page=>page.view),[[100,50,200,250],[200,50,300,250]])
 assert.deepEqual(pages.slice(2,4).map(page=>page.view),[[100,50,300,150],[100,150,300,250]])
 assert.deepEqual(pages.slice(0,4).map(page=>page.notes),[['Note 0'],['Note 0'],['Note 1'],['Note 1']]);assert.deepEqual(pages.map(page=>page.rotation),[0,0,90,90,0,0])
})
test('PDF merge layout embeds cropped visible page regions and blank cells without interactive annotations',async()=>{
 const bytes=await fixture(),result=await createPdfPageLayoutJob().execute(bytes,command({kind:'merge',perSheet:2,direction:'horizontal',separator:true})),doc=await PDFDocument.load(result.bytes)
 const pages=await inspect(result.bytes);assert.equal(pages.length,2);assert.deepEqual(pages.map(page=>page.notes),[[],[]]);assert.deepEqual(doc.getPage(0).getSize(),{width:200,height:200})
 // Embedded XObjects must clip to CropBox, not full MediaBox (crop is a view boundary).
 const forms=doc.context.enumerateIndirectObjects().map(([,object])=>object).filter(object=>String(object?.dict?.get(PDFName.of('Subtype')))==='/Form')
 assert.ok(forms.some(form=>String(form.dict.get(PDFName.of('BBox')))==='[ 100 50 300 250 ]'))
})
test('PDF layout rejects malformed options, invalid source boxes and outputs exceeding the Web page limit',async()=>{
 const bytes=await fixture(),job=createPdfPageLayoutJob()
 for(const operation of [{kind:'split',perPage:3},{kind:'merge',perSheet:1,direction:'horizontal',separator:false},{kind:'merge',perSheet:2,direction:'diagonal',separator:false},{kind:'merge',perSheet:2,direction:'horizontal',separator:1},{kind:'split',perPage:2,path:'/tmp/x'}])await assert.rejects(job.execute(bytes,command(operation)),{code:'INVALID_PDF_PAGE_LAYOUT'})
 const large=await PDFDocument.create();for(let i=0;i<12;i++)large.addPage([300,200])
 await assert.rejects(job.execute(Buffer.from(await large.save()),command({kind:'split',perPage:9})),{code:'PDF_EDIT_LIMIT'})
 const invalid=await PDFDocument.load(bytes);invalid.getPage(0).setCropBox(0,0,0,200)
 await assert.rejects(job.execute(Buffer.from(await invalid.save()),command({kind:'merge',perSheet:2,direction:'horizontal',separator:false})),{code:'PDF_EDIT_UNSUPPORTED_STRUCTURE'})
})
test('PDF page layout isolated processing yields bound bytes and honors cancellation',async()=>{
 const bytes=await fixture(),job=createIsolatedPdfPageLayoutJob(),result=await job.execute(bytes,command({kind:'split',perPage:2}));assert.equal((await inspect(result.bytes)).length,6)
 const controller=new AbortController(),pending=job.execute(bytes,command({kind:'split',perPage:4}),controller.signal);controller.abort();await assert.rejects(pending,{code:'ABORTED'})
})

test('PDF layout supports all split grids and non-square rotated cropped merge sheets',async()=>{
 const bytes=await fixture(),job=createPdfPageLayoutJob()
 for(const perPage of [4,9]){
  const result=await job.execute(bytes,command({kind:'split',perPage}));assert.equal((await inspect(result.bytes)).length,3*perPage)
 }
 const doc=await PDFDocument.create(),first=doc.addPage([500,300]);first.setCropBox(100,50,300,150);first.setRotation(degrees(90));first.drawText('Visible',{x:130,y:100});doc.addPage([300,200])
 const input=Buffer.from(await doc.save())
 for(const [perSheet,direction]of [[2,'horizontal'],[3,'vertical'],[16,'horizontal']]){
  const result=await job.execute(input,command({kind:'merge',perSheet,direction,separator:true})),output=await PDFDocument.load(result.bytes)
  assert.equal(output.getPageCount(),1);assert.deepEqual(output.getPage(0).getSize(),perSheet===2?{width:300,height:150}:{width:150,height:300})
 }
})

test('PDF layouts refuse signed, encrypted and form sources without output',async()=>{
 const bytes=await fixture(),job=createPdfPageLayoutJob(),raw=command({kind:'split',perPage:2})
 const signed=await PDFDocument.load(bytes);signed.context.register(signed.context.obj({Type:'Sig',ByteRange:[0,1,2,3]}))
 await assert.rejects(job.execute(Buffer.from(await signed.save()),raw),{code:'SIGNATURE_EDIT_REFUSED'})
 const form=await PDFDocument.load(bytes);form.getForm().createTextField('x')
 await assert.rejects(job.execute(Buffer.from(await form.save()),raw),{code:'PDF_EDIT_UNSUPPORTED_STRUCTURE'})
 const encrypted=await PDFDocument.load(bytes);encrypted.context.trailerInfo.Encrypt=encrypted.context.register(encrypted.context.obj({Filter:'Standard',V:1,R:2,Length:40,O:'x',U:'y',P:-4}))
 await assert.rejects(job.execute(Buffer.from(await encrypted.save()),raw),{code:'PASSWORD'})
})


test('PDF split layout intersects off-media crop boxes and falls back to MediaBox for disjoint crops',async()=>{
 const doc=await PDFDocument.create()
 const overlapping=doc.addPage([400,300]);overlapping.setCropBox(-100,50,600,300);overlapping.drawText('Visible overlap',{x:100,y:100})
 const disjoint=doc.addPage([400,300]);disjoint.setCropBox(500,500,100,100);disjoint.drawText('Visible fallback',{x:100,y:100});disjoint.setRotation(degrees(90))
 const bytes=Buffer.from(await doc.save()),original=Buffer.from(bytes),result=await createPdfPageLayoutJob().execute(bytes,command({kind:'split',perPage:2}))
 assert.deepEqual(bytes,original)
 const pages=await inspect(result.bytes)
 assert.deepEqual(pages.map(page=>page.view),[[0,50,200,300],[200,50,400,300],[0,0,400,150],[0,150,400,300]])
 assert.deepEqual(pages.map(page=>page.rotation),[0,0,90,90])
})
