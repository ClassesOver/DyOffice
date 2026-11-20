import {test} from 'node:test'
import assert from 'node:assert/strict'
import {PDFDocument,PDFHexString,PDFName,degrees} from 'pdf-lib'
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs'
import {createPdfSplitJob} from '../server/src/pdf/split-job.mjs'
import {createIsolatedPdfSplitJob} from '../server/src/pdf/split-isolated.mjs'
const command=pagesPerFile=>JSON.stringify({version:1,action:'splitPdf',pagesPerFile})
async function fixture(){
 const doc=await PDFDocument.create()
 for(let index=1;index<=5;index++){
  const page=doc.addPage([300,200]);page.drawText('Page '+index,{x:20,y:100,size:12});if(index===3)page.setRotation(degrees(90))
  const ref=doc.context.register(doc.context.obj({Type:'Annot',Subtype:'Text',Rect:[20,20,40,40],P:page.ref,Contents:PDFHexString.fromText('Note '+index)}));page.node.set(PDFName.of('Annots'),doc.context.obj([ref]))
 }
 return Buffer.from(await doc.save())
}
async function read(bytes){const task=getDocument({data:Uint8Array.from(bytes),disableFontFace:true,useSystemFonts:true});try{const doc=await task.promise,out=[];for(let i=1;i<=doc.numPages;i++){const page=await doc.getPage(i);out.push({text:(await page.getTextContent()).items.map(item=>item.str??'').join(''),rotation:page.rotate,notes:(await page.getAnnotations()).map(note=>note.contentsObj.str)})}return out}finally{await task.destroy()}}
test('PDF split produces ordered real PDF chunks including the short tail and preserves the source',async()=>{
 const bytes=await fixture(),before=Buffer.from(bytes),result=await createPdfSplitJob().execute(bytes,command(2))
 assert.deepEqual(bytes,before);assert.equal(result.files.length,3)
 assert.deepEqual(await Promise.all(result.files.map(file=>read(file.bytes))),[
  [{text:'Page 1',rotation:0,notes:['Note 1']},{text:'Page 2',rotation:0,notes:['Note 2']}],
  [{text:'Page 3',rotation:90,notes:['Note 3']},{text:'Page 4',rotation:0,notes:['Note 4']}],
  [{text:'Page 5',rotation:0,notes:['Note 5']}],
 ])
})
test('PDF split refuses invalid chunk sizes and a request yielding fewer than two outputs',async()=>{
 const bytes=await fixture(),job=createPdfSplitJob()
 for(const size of [0,-1,1.5,101,'2',5,6])await assert.rejects(job.execute(bytes,command(size)),{code:'INVALID_PDF_SPLIT'})
})
test('isolated PDF split delivers all verified outputs and cancels work',async()=>{
 const bytes=await fixture(),result=await createIsolatedPdfSplitJob().execute(bytes,command(2));assert.equal(result.files.length,3)
 const controller=new AbortController(),pending=createIsolatedPdfSplitJob().execute(bytes,command(1),controller.signal);controller.abort();await assert.rejects(pending,{code:'ABORTED'})
})

test('PDF split refuses protected documents and aggregate output over 64 MiB',async()=>{
 const bytes=await fixture(),job=createPdfSplitJob()
 const signed=await PDFDocument.load(bytes);signed.context.register(signed.context.obj({Type:'Sig',ByteRange:[0,1,2,3]}))
 await assert.rejects(job.execute(Buffer.from(await signed.save()),command(2)),{code:'SIGNATURE_EDIT_REFUSED'})
 const form=await PDFDocument.load(bytes);form.getForm().createTextField('x')
 await assert.rejects(job.execute(Buffer.from(await form.save()),command(2)),{code:'PDF_EDIT_UNSUPPORTED_STRUCTURE'})
 const encrypted=await PDFDocument.load(bytes);encrypted.context.trailerInfo.Encrypt=encrypted.context.register(encrypted.context.obj({Filter:'Standard',V:1,R:2,Length:40,O:'x',U:'y',P:-4}))
 await assert.rejects(job.execute(Buffer.from(await encrypted.save()),command(2)),{code:'PASSWORD'})
 const source=await PDFDocument.create(),shared=source.context.register(source.context.stream('q\n'+' '.repeat(680000)+'\nQ\n'))
 for(let i=0;i<100;i++)source.addPage([300,200]).node.set(PDFName.of('Contents'),shared)
 const original=Buffer.from(await source.save())
 assert.ok(original.length<1024*1024)
 await assert.rejects(job.execute(original,command(1)),{code:'OUTPUT_LIMIT'})
})
