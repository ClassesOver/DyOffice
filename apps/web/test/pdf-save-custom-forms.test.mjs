import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {PDFDocument,PDFName,PDFDict,PDFStream,StandardFonts} from 'pdf-lib'
import {applySaveRequest,applyFormFields} from '../../pdf/src/main/save-pdf.ts'
const n=PDFName.of,hash=value=>createHash('sha256').update(value).digest('hex')
const request=extra=>({formValues:[],markups:[],drawings:[],rotations:[],...extra})
async function fixture(){
 const doc=await PDFDocument.create(),page=doc.addPage([500,650]),form=doc.getForm(),font=await doc.embedFont(StandardFonts.Helvetica)
 for(const name of ['untouched','changed']){const f=form.createTextField(name);f.addToPage(page,{x:30,y:name==='untouched'?500:450,width:160,height:30});f.setText(name==='untouched'?'Keep':'Before')}
 form.updateFieldAppearances(font)
 // Preserve an existing appearance even when the file requests viewer regeneration.
 form.getTextField('untouched').acroField.dict.lookup(n('Kids')).lookup(0).delete(n('DA'))
 form.acroForm.dict.set(n('NeedAppearances'),doc.context.obj(true))
 return Buffer.from(await doc.save({useObjectStreams:false,updateFieldAppearances:false}))
}
function appearance(doc,name){const widget=doc.getForm().getTextField(name).acroField.getWidgets()[0],stream=widget.dict.lookup(n('AP'),PDFDict).lookup(n('N'));return {bytes:hash(stream.getContents()),dict:String(stream.dict)}}

test('internal form callbacks share one document at existing stages and preserve untouched appearance bytes',async()=>{
 const original=await fixture(),digest=hash(original),before=await PDFDocument.load(original),expected=appearance(before,'untouched'),seen=[],docs=[]
 const result=await applySaveRequest(original,request({formValues:[{name:'changed',kind:'text',value:'ignored default'}],formFields:[{name:'ignoredField',kind:'text',pageIndex:0,rect:[30,100,190,130]}],rotations:[{pageIndex:0,delta:90}],metadata:{title:'One write'}}),{
  applyFormValues:async doc=>{seen.push(['values',doc.getPage(0).getRotation().angle]);docs.push(doc);doc.getForm().getTextField('changed').setText('After')},
  applyFormFields:async doc=>{seen.push(['fields',doc.getPage(0).getRotation().angle]);docs.push(doc);applyFormFields(doc,[{name:'new',kind:'checkbox',pageIndex:0,rect:[220,100,240,120],checked:true}])},
  updateFieldAppearances:async doc=>{seen.push(['appearance',doc.getTitle()]);docs.push(doc);doc.getForm().getTextField('changed').defaultUpdateAppearances(await doc.embedFont(StandardFonts.Helvetica))},
 })
 assert.deepEqual(seen,[['values',0],['fields',90],['appearance','One write']]);assert.ok(docs.every(doc=>doc===docs[0]));assert.equal(hash(original),digest)
 const out=await PDFDocument.load(result.bytes);assert.equal(out.getTitle(),'One write');assert.equal(out.getPage(0).getRotation().angle,90);assert.equal(out.getForm().getTextField('changed').getText(),'After');assert.equal(out.getForm().getCheckBox('new').isChecked(),true);assert.equal(out.getForm().getFieldMaybe('ignoredField'),undefined);assert.deepEqual(appearance(out,'untouched'),expected)
})

test('internal form callback can create Chinese choice with targeted concrete appearances in one save',async()=>{
 const {planPdfFormFields,updatePdfFormFieldAppearances}=await import('../server/src/pdf/form-fields-job.mjs'),original=await fixture(),before=await PDFDocument.load(original),operations=[{op:'addFormField',field:{name:'选择',kind:'choice',page:1,x:30,y:120,width:160,height:30,options:['中文','日本語','한국어'],value:'中文'}}],planned=planPdfFormFields(before,operations)
 const result=await applySaveRequest(original,request({metadata:{subject:'Chinese choice'}}),{
  applyFormFields:doc=>applyFormFields(doc,planned.map(field=>({...field,options:[],value:undefined}))),
  updateFieldAppearances:doc=>updatePdfFormFieldAppearances(doc,planned),
 })
 const out=await PDFDocument.load(result.bytes),field=out.getForm().getDropdown('选择');assert.deepEqual(field.getOptions(),['中文','日本語','한국어']);assert.deepEqual(field.getSelected(),['中文']);assert.equal(out.getSubject(),'Chinese choice');const ap=field.acroField.getWidgets()[0].dict.lookup(n('AP'),PDFDict).lookup(n('N'));assert.ok(ap instanceof PDFStream);assert.ok(ap.getContents().length>20);assert.deepEqual(appearance(out,'untouched'),appearance(before,'untouched'))
})

test('callback exceptions reject without returning output or mutating source bytes',async()=>{
 for(const stage of ['applyFormValues','applyFormFields','updateFieldAppearances']){
  const original=await fixture(),digest=hash(original),error=new Error('synthetic '+stage);let output
  await assert.rejects(async()=>{output=await applySaveRequest(original,request(),{[stage]:async doc=>{doc.getForm().getTextField('changed').setText('Never output');throw error}})},e=>e===error)
  assert.equal(output,undefined);assert.equal(hash(original),digest)
 }
})

test('default PC writer still fills creates and refreshes when no internal hooks are supplied',async()=>{
 const original=await fixture(),result=await applySaveRequest(original,request({formValues:[{name:'changed',kind:'text',value:'Default works'}],formFields:[{name:'normal',kind:'text',pageIndex:0,rect:[220,100,380,130],value:'New default'}]})),out=await PDFDocument.load(result.bytes)
 assert.equal(out.getForm().getTextField('changed').getText(),'Default works');assert.equal(out.getForm().getTextField('normal').getText(),'New default');assert.ok(out.getForm().getTextField('normal').acroField.getWidgets()[0].dict.lookup(n('AP'),PDFDict))
})
