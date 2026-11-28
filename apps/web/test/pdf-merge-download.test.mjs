import test from 'node:test'
import assert from 'node:assert/strict'
import {PDFArray,PDFDict,PDFDocument,PDFName,PDFString} from 'pdf-lib'
import {preparePdfMerge,validatePdfMergeFiles} from '../src/editors/pdf-merge-download.ts'
import {createPdfStampsJob,assertPdfManagedStamps} from '../server/src/pdf/stamps-job.mjs'
import {createPdfPageOpsJob} from '../server/src/pdf/page-ops-job.mjs'
import {readPdfLeafObjects} from '../../pdf/src/main/text-edit.ts'
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs'

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

test('PDF merge resolves named links for each appended source even when the names collide',async()=>{
 const create=async()=>{
  const doc=await PDFDocument.create(),first=doc.addPage(),destination=doc.addPage()
  const name=PDFString.of('Local chapter')
  doc.catalog.set(PDFName.of('Names'),doc.context.obj({Dests:{Names:[name,[destination.ref,'Fit']]}}))
  first.node.addAnnot(doc.context.register(doc.context.obj({
   Type:'Annot',Subtype:'Link',Rect:[20,20,100,40],Dest:name,
  })))
  return await doc.save()
 }
 const base=await create()
 const sources=await Promise.all([create(),create()])
 const {merged}=await preparePdfMerge(base.buffer,sources.map(bytes=>new File([bytes],'chapter.pdf')),new AbortController().signal)
 const output=await PDFDocument.load(merged)
 for(const from of [2,4]){
  const annotation=output.getPage(from).node.Annots().lookup(0,PDFDict)
  assert.equal(String(annotation.lookup(PDFName.of('Dest'),PDFArray).get(0)),String(output.getPage(from+1).ref))
 }
 const original=output.getPage(0).node.Annots().lookup(0,PDFDict)
 assert.equal(original.lookup(PDFName.of('Dest'),PDFString).decodeText(),'Local chapter')
})

test('PDF merge keeps each source form editable and gives colliding fields independent names',async()=>{
 async function formPdf(value){
  const doc=await PDFDocument.create(),page=doc.addPage(),form=doc.getForm()
  const field=form.createTextField('customer')
  field.addToPage(page,{x:20,y:30,width:125,height:20});field.setText(value)
  form.createTextField('private.note').setText('Note for '+value)
  return await doc.save()
 }
 const base=await formPdf('Base'),sources=await Promise.all([formPdf('First'),formPdf('Second')])
 const {merged,appended}=await preparePdfMerge(base.buffer,sources.map(bytes=>new File([bytes],'form.pdf')),new AbortController().signal)
 assert.equal(appended,2)
 const doc=await PDFDocument.load(merged),form=doc.getForm(),fields=['customer','customer_2','customer_3'].map(name=>form.getTextField(name))
 assert.deepEqual(fields.map(field=>field.getText()),['Base','First','Second'])
 assert.deepEqual(['private.note','private_2.note','private_3.note'].map(name=>form.getTextField(name).getText()),['Note for Base','Note for First','Note for Second'])
 assert.deepEqual(fields.map(field=>String(field.acroField.getWidgets()[0].P())),doc.getPages().map(page=>String(page.ref)))
 fields[1].setText('Changed')
 const reopened=(await PDFDocument.load(await doc.save())).getForm()
 assert.deepEqual(fields.map(field=>reopened.getTextField(field.getName()).getText()),['Base','Changed','Second'])
 assert.equal((await PDFDocument.load(base)).getForm().getTextField('customer').getText(),'Base')
})

test('whole PDF merge preserves nested embedded attachments, their bytes and descriptions',async()=>{
 const n=PDFName.of
 async function attached(label,extraName){
  const doc=await PDFDocument.create();doc.addPage()
  await doc.attach(Buffer.from(label),'report.txt',{mimeType:'text/plain',description:'Description for '+label})
  await doc.attach(Buffer.alloc(0),extraName,{mimeType:'application/octet-stream'})
  await doc.flush()
  const tree=doc.catalog.lookup(n('Names'),PDFDict).lookup(n('EmbeddedFiles'),PDFDict)
  const entries=tree.lookup(n('Names'),PDFArray).asArray()
  const kids=[]
  for(let i=0;i<entries.length;i+=2){
   kids.push(doc.context.register(doc.context.obj({Limits:[entries[i],entries[i]],Names:entries.slice(i,i+2)})))
  }
  tree.delete(n('Names'));tree.set(n('Kids'),doc.context.obj(kids))
  return await doc.save()
 }
 const base=await attached('Base','base-empty.bin'),first=await attached('First','first-empty.bin'),last=await attached('Last','last-empty.bin')
 const {merged}=await preparePdfMerge(base.buffer,[new File([first],'first.pdf'),new File([last],'last.pdf')],new AbortController().signal)
 async function inspect(bytes){
  const task=getDocument({data:Uint8Array.from(bytes)})
  try{
   const doc=await task.promise,result=new Map()
   for(const [name,file] of await doc.getAttachments()??[]){
    const content=file.content??await doc.getAttachmentContent(name)
    result.set(name,[Buffer.from(content).toString(),file.description])
   }
   return result
  }finally{await task.destroy()}
 }
 const output=await inspect(merged)
 for(const [name,label] of [['report.txt','Base'],['report (2).txt','First'],['report (3).txt','Last']]){
  assert.deepEqual(output.get(name),[label,'Description for '+label])
 }
 for(const name of ['base-empty.bin','first-empty.bin','last-empty.bin'])assert.equal(output.get(name)[0],'')
 assert.equal(output.size,6)
 assert.equal((await inspect(base)).size,2)
})

test('PDF merge refuses signed or XFA documents in either position',async()=>{
 const ordinary=await makePdf(1),signal=new AbortController().signal
 const sign=await PDFDocument.load(ordinary)
 sign.context.register(sign.context.obj({Type:'Sig',ByteRange:[0,1,2,3]}))
 const xfa=await PDFDocument.load(ordinary)
 xfa.getForm().acroForm.dict.set(PDFName.of('XFA'),xfa.context.register(xfa.context.flateStream('<xdp/>')))
 for(const [doc,message] of [[sign,/signatures/i],[xfa,/XFA/i]]){
  const bytes=await doc.save({updateFieldAppearances:false})
  await assert.rejects(preparePdfMerge(ordinary,[new File([bytes],'protected.pdf')],signal),message)
  await assert.rejects(preparePdfMerge(bytes.buffer,[new File([ordinary],'plain.pdf')],signal),message)
 }
})

test('PDF merge keeps visible stamps from each input and the copy accepts later edits',async()=>{
 const stamp=async(bytes,operation)=>(await createPdfStampsJob().execute(bytes,JSON.stringify({version:1,action:'stamps',operation}))).bytes
 const base=await stamp(Buffer.from(await makePdf(1)),{op:'set_header_footer',header_left:'Base header',page_number:true})
 const donor=await stamp(Buffer.from(await makePdf(1)),{op:'set_watermark',text:'Donor watermark'})
 const view=base.buffer.slice(base.byteOffset,base.byteOffset+base.byteLength)
 const {merged}=await preparePdfMerge(view,[new File([donor],'stamped.pdf')],new AbortController().signal)
 assertPdfManagedStamps(await PDFDocument.load(merged))
 const edit=await createPdfPageOpsJob().execute(Buffer.from(merged),JSON.stringify({
  version:1,action:'pageOps',operations:[{op:'rotatePages',pages:[2],dir:90}],
 }))
 const stamped=await stamp(edit.bytes,{op:'set_header_footer',footer_left:'New footer'})
 assertPdfManagedStamps(await PDFDocument.load(stamped))
 const text=(await readPdfLeafObjects(stamped)).filter(item=>item.type===1).map(item=>item.text).join('|')
 assert.match(text,/Base header/)
 assert.match(text,/1 \/ 1/)
 assert.match(text,/Donor watermark/)
 assert.equal(text.match(/New footer/g).length,2)
 assertPdfManagedStamps(await PDFDocument.load(base))
 assertPdfManagedStamps(await PDFDocument.load(donor))
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
