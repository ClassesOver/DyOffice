import {test} from 'node:test'
import assert from 'node:assert/strict'
import {PDFDict,PDFDocument,PDFHexString,PDFName,PDFPageLeaf,PDFString,degrees} from 'pdf-lib'
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs'
import {createPdfExtractPagesJob} from '../server/src/pdf/extract-pages-job.mjs'
import {createIsolatedPdfExtractPagesJob} from '../server/src/pdf/extract-pages-isolated.mjs'
const command=pages=>JSON.stringify({version:1,action:'extractPages',pages})
async function fixture(){
 const doc=await PDFDocument.create()
 for(let index=1;index<=3;index++){
  const page=doc.addPage([300+index*10,200]);page.drawText('Page '+index,{x:20,y:100,size:12});page.setRotation(degrees(index===3?90:0))
  const ref=doc.context.register(doc.context.obj({Type:'Annot',Subtype:'Text',Rect:[20,20,40,40],P:page.ref,Contents:PDFHexString.fromText('Note '+index),T:PDFHexString.fromText('Author')}))
  page.node.set(PDFName.of('Annots'),doc.context.obj([ref]))
 }
 return Buffer.from(await doc.save())
}
async function read(bytes){
 const task=getDocument({data:Uint8Array.from(bytes),disableFontFace:true,useSystemFonts:true})
 try{const doc=await task.promise,pages=[];for(let i=1;i<=doc.numPages;i++){const page=await doc.getPage(i);pages.push({text:(await page.getTextContent()).items.map(item=>item.str??'').join(''),rotation:page.rotate,notes:(await page.getAnnotations()).map(note=>note.contentsObj.str)})}return pages}finally{await task.destroy()}
}
test('PDF extraction writes a separate PDF in requested order and retains text, notes and rotation',async()=>{
 const bytes=await fixture(),original=Buffer.from(bytes),result=await createPdfExtractPagesJob().execute(bytes,command([3,1]))
 assert.deepEqual(bytes,original)
 assert.deepEqual(await read(result.bytes),[{text:'Page 3',rotation:90,notes:['Note 3']},{text:'Page 1',rotation:0,notes:['Note 1']}])
 assert.equal((await read(bytes)).length,3)
})
test('PDF extraction remaps retained named links and leaves omitted pages out of the file',async()=>{
 const doc=await PDFDocument.load(await fixture()),[first,omitted,last]=doc.getPages()
 const name=PDFName.of
 const addLink=extra=>first.node.addAnnot(doc.context.register(doc.context.obj({
  Type:'Annot',Subtype:'Link',Rect:[20,20,100,40],...extra,
 })))
 const retained=PDFString.of('Last page')
 doc.catalog.set(name('Names'),doc.context.obj({Dests:{Names:[retained,[last.ref,'Fit']]}}))
 addLink({Dest:retained})
 addLink({A:{S:'GoTo',D:[omitted.ref,'Fit']}})
 const result=await createIsolatedPdfExtractPagesJob().execute(Buffer.from(await doc.save()),command([3,1]))
 const task=getDocument({data:Uint8Array.from(result.bytes),disableFontFace:true,useSystemFonts:true})
 try{
  const output=await task.promise
  const links=(await (await output.getPage(2)).getAnnotations()).filter(annotation=>annotation.subtype==='Link')
  assert.equal(await output.getPageIndex(links[0].dest[0]),0)
  assert.equal(links[1].dest,undefined)
 }finally{await task.destroy()}
 const output=await PDFDocument.load(result.bytes)
 assert.equal(output.context.enumerateIndirectObjects().filter(([,object])=>object instanceof PDFPageLeaf).length,2)
 assert.equal(output.getPage(1).node.Annots().lookup(2,PDFDict).has(name('A')),false)
})
test('PDF extraction strictly rejects empty, duplicate, stale and unbounded page selections',async()=>{
 const bytes=await fixture(),job=createPdfExtractPagesJob()
 for(const pages of [[],[1,1],[0],[4],['1'],Array.from({length:101},(_,i)=>i+1)])await assert.rejects(job.execute(bytes,command(pages)),{code:'INVALID_PDF_EXTRACT_PAGES'})
})
test('PDF extraction refuses protected sources and executes through the isolated boundary',async()=>{
 const bytes=await fixture(),signed=await PDFDocument.load(bytes);signed.context.register(signed.context.obj({Type:'Sig',ByteRange:[0,1,2,3]}))
 await assert.rejects(createPdfExtractPagesJob().execute(Buffer.from(await signed.save()),command([1])),{code:'SIGNATURE_EDIT_REFUSED'})
 const result=await createIsolatedPdfExtractPagesJob().execute(bytes,command([2]))
 assert.equal((await read(result.bytes))[0].text,'Page 2')
 const controller=new AbortController(),pending=createIsolatedPdfExtractPagesJob().execute(bytes,command([1]),controller.signal);controller.abort();await assert.rejects(pending,{code:'ABORTED'})
})

test('PDF extraction keeps note reply identities connected inside the new page',async()=>{
 const bytes=await fixture(),doc=await PDFDocument.load(bytes),page=doc.getPage(0),root=page.node.Annots().get(0)
 const reply=doc.context.register(doc.context.obj({Type:'Annot',Subtype:'Text',Rect:[20,20,40,40],P:page.ref,IRT:root,RT:'R',Contents:PDFHexString.fromText('Reply'),T:PDFHexString.fromText('AI Assistant')}))
 page.node.Annots().push(reply)
 const result=await createPdfExtractPagesJob().execute(Buffer.from(await doc.save()),command([1]))
 const task=getDocument({data:Uint8Array.from(result.bytes),disableFontFace:true,useSystemFonts:true})
 try{
  const output=await task.promise,notes=await (await output.getPage(1)).getAnnotations()
  assert.equal(output.numPages,1);assert.equal(notes.length,2);assert.equal(notes[1].inReplyTo,notes[0].id);assert.equal(notes[1].replyType,'R');assert.equal(notes[1].titleObj.str,'AI Assistant')
 }finally{await task.destroy()}
})

test('PDF extraction rejects encrypted and XFA sources before export',async()=>{
 const bytes=await fixture(),form=await PDFDocument.load(bytes)
 form.getForm().acroForm.dict.set(PDFName.of('XFA'),form.context.register(form.context.flateStream('<xdp/>')))
 await assert.rejects(createPdfExtractPagesJob().execute(Buffer.from(await form.save({updateFieldAppearances:false})),command([1])),{code:'PDF_EDIT_UNSUPPORTED_STRUCTURE'})
 const encrypted=await PDFDocument.load(bytes);encrypted.context.trailerInfo.Encrypt=encrypted.context.register(encrypted.context.obj({Filter:'Standard',V:1,R:2,Length:40,O:'x',U:'y',P:-4}))
 await assert.rejects(createPdfExtractPagesJob().execute(Buffer.from(await encrypted.save()),command([1])),{code:'PASSWORD'})
})
