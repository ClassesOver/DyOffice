import test from 'node:test'
import assert from 'node:assert/strict'
import {PDFDocument,PDFName,PDFDict,PDFStream,StandardFonts} from 'pdf-lib'
import {createHash} from 'node:crypto'
import {PNG} from 'pngjs'
import {createPdfDraftInsertsJob} from '../server/src/pdf/draft-inserts-job.mjs'
import {createIsolatedPdfImageInsertsQueryJob} from '../server/src/pdf/draft-inserts-isolated.mjs'
import {createPdfTextInsertsJob,createPdfTextInsertsQueryJob} from '../server/src/pdf/text-inserts-job.mjs'
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const raw=(action,operation)=>JSON.stringify({version:1,action,operation})
async function fixture(){
 const doc=await PDFDocument.create(),page=doc.addPage([400,500]),font=await doc.embedFont(StandardFonts.Helvetica),form=doc.getForm()
 page.drawText('Original form',{x:30,y:460,size:14,font})
 const check=form.createCheckBox('approved');check.addToPage(page,{x:30,y:400,width:20,height:20});check.check()
 const locked=form.createCheckBox('locked');locked.addToPage(page,{x:80,y:400,width:20,height:20});locked.check();locked.enableReadOnly()
 const text=form.createTextField('name');text.addToPage(page,{x:30,y:340,width:220,height:28});text.setText('Existing value')
 const choice=form.createDropdown('option');choice.addOptions(['Alpha','Beta']);choice.select('Beta');choice.addToPage(page,{x:30,y:290,width:160,height:25})
 form.updateFieldAppearances(font)
 return Buffer.from(await doc.save({useObjectStreams:false}))
}
async function fields(bytes){const d=await PDFDocument.load(bytes,{updateMetadata:false});return d.getForm().getFields().map(f=>({name:f.getName(),type:f.constructor.name,readOnly:f.isReadOnly(),value:f.getText?.()??f.isChecked?.()??f.getSelected?.(),widgets:f.acroField.getWidgets().map(w=>{const n=w.dict.lookup(PDFName.of('AP'),PDFDict)?.lookup(PDFName.of('N'));return {rect:w.getRectangle(),state:String(w.dict.get(PDFName.of('AS'))),appearance:n instanceof PDFDict?[...n.entries()].map(([key,ref])=>[String(key),hash(d.context.lookup(ref).getContents())]).sort(([a],[b])=>a.localeCompare(b)):n instanceof PDFStream?hash(n.getContents()):String(n)}})}))}
function image(){const png=new PNG({width:2,height:2});png.data.fill(255);return {mime:'image/png',base64:PNG.sync.write(png).toString('base64')}}
const operation=()=>({texts:[{page:1,text:'Added text',x:260,y:250}],images:[{page:1,image:image(),x:300,y:80,width:16,height:16}]})

test('isolated image placement uses pending displayed orientation and emits a native rectangle',async()=>{
 const original=await fixture(),job=createIsolatedPdfImageInsertsQueryJob()
 const query=rotationDelta=>JSON.stringify({version:1,action:'imageInsertsQuery',operation:{page:1,image:image(),x:135,y:245,width:80,height:45},rotationDelta})
 const {image:preview,edit}=JSON.parse((await job.execute(original,query(90))).bytes)
 assert.deepEqual([preview.x,preview.y,preview.width,preview.height],[135,245,80,45])
 assert.equal(edit.rotate,90)
 assert.deepEqual(edit.rect,[245,135,290,215])
 await assert.rejects(job.execute(original,query(45)),{code:'INVALID_PDF_IMAGE_CONTENT'})
})

test('AcroForm static image and text insert query preview save preserve fields and widget appearances',async()=>{
 const original=await fixture(),expected=await fields(original),digest=hash(original),op=operation()
 const query=JSON.parse((await createPdfDraftInsertsJob('imageInsertsQuery').execute(original,raw('imageInsertsQuery',op.images[0]))).bytes)
 assert.equal(query.image.width,16)
 const textQuery=await createPdfTextInsertsQueryJob().execute(original,JSON.stringify({version:1,action:'textInsertsQuery',operations:op.texts}))
 assert.equal(JSON.parse(textQuery.bytes).blocks[0].text,'Added text')
 const preview=JSON.parse((await createPdfDraftInsertsJob('draftInsertsQuery').execute(original,raw('draftInsertsQuery',op))).bytes)
 assert.equal(preview.pages.length,1)
 const saved=await createPdfDraftInsertsJob('draftInserts').execute(original,raw('draftInserts',op))
 assert.deepEqual(await fields(saved.bytes),expected);assert.equal(hash(original),digest)
 const textSaved=await createPdfTextInsertsJob().execute(original,JSON.stringify({version:1,action:'textInserts',operations:op.texts}))
 assert.deepEqual(await fields(textSaved.bytes),expected)
 const {readPdfLeafObjects}=await import('../../pdf/src/main/text-edit.ts'),leaves=await readPdfLeafObjects(saved.bytes)
 assert.ok(leaves.some(item=>item.type===1&&item.text?.trim()==='Added text'));assert.equal(leaves.filter(item=>item.type===3).length,1)
})

test('AcroForm drafts refuse an edit targeting an image that does not exist',async()=>{
 await assert.rejects(createPdfDraftInsertsJob('draftInserts').execute(await fixture(),raw('draftInserts',{...operation(),imageEdits:[{op:'delete_image',page:1,image_number:1}]})),{code:'PDF_IMAGE_NOT_FOUND'})
})

test('AcroForm inserts still refuse signatures XFA and managed stamps',async()=>{
 const original=await fixture(),op=operation()
 for(const kind of ['signature','xfa','managed']){
  const doc=await PDFDocument.load(original),acro=doc.catalog.lookup(PDFName.of('AcroForm'),PDFDict)
  if(kind==='signature'){const field=doc.context.register(doc.context.obj({FT:'Sig',T:doc.context.obj('Unsigned')}));acro.lookup(PDFName.of('Fields')).push(field)}
  if(kind==='xfa')acro.set(PDFName.of('XFA'),doc.context.stream('unsupported'))
  if(kind==='managed')doc.getPage(0).node.set(PDFName.of('DyOfficeStamps'),doc.context.obj({}))
  const bytes=Buffer.from(await doc.save({useObjectStreams:false}))
  await assert.rejects(createPdfDraftInsertsJob('draftInserts').execute(bytes,raw('draftInserts',op)),error=>error.code===(kind==='signature'?'SIGNATURE_EDIT_REFUSED':'PDF_EDIT_UNSUPPORTED_STRUCTURE'))
 }
})


test('canonical form integrity rejects changed values flags widget page and appearance',async()=>{
 const {openPdfForInserts,assertPdfInsertFormPreserved}=await import('../server/src/pdf/insert-form-integrity.mjs'),original=await fixture(),before=await openPdfForInserts(original)
 assert.doesNotThrow(()=>assertPdfInsertFormPreserved(before,before))
 for(const change of ['text','checkbox','readonly','choice','appearance','page','parent']){
  const doc=await openPdfForInserts(original),form=doc.getForm(),widget=form.getCheckBox('approved').acroField.getWidgets()[0]
  if(change==='text')form.getTextField('name').setText('Changed')
  if(change==='checkbox')form.getCheckBox('approved').uncheck()
  if(change==='readonly')form.getCheckBox('locked').disableReadOnly()
  if(change==='choice')form.getDropdown('option').select('Alpha')
  if(change==='appearance')widget.dict.lookup(PDFName.of('AP'),PDFDict).set(PDFName.of('N'),doc.context.stream('changed'))
  if(change==='parent')widget.dict.set(PDFName.of('Parent'),form.getTextField('name').ref)
  if(change==='page')widget.dict.set(PDFName.of('P'),doc.addPage([400,500]).ref)
  assert.throws(()=>assertPdfInsertFormPreserved(before,doc),{code:'PDF_FORM_INSERT_INTEGRITY_FAILED'},change)
 }
})


test('insert guard refuses an unsigned signature with an indirect FT name',async()=>{
 const {openPdfForInserts}=await import('../server/src/pdf/insert-form-integrity.mjs'),doc=await PDFDocument.load(await fixture()),acro=doc.catalog.lookup(PDFName.of('AcroForm'),PDFDict)
 const signature=doc.context.register(doc.context.obj({FT:doc.context.register(PDFName.of('Sig')),T:doc.context.obj('Unsigned')}));acro.lookup(PDFName.of('Fields')).push(signature)
 await assert.rejects(openPdfForInserts(Buffer.from(await doc.save({updateFieldAppearances:false}))),{code:'SIGNATURE_EDIT_REFUSED'})
})
