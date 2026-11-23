import test from 'node:test'
import assert from 'node:assert/strict'
import {PDFDocument,PDFName,PDFDict,PDFHexString,PDFBool} from 'pdf-lib'
import {createPdfFormValuesJob,validatePdfFormValueOperations} from '../server/src/pdf/form-values-job.mjs'
import {createIsolatedPdfFormValuesJob} from '../server/src/pdf/form-values-isolated.mjs'
const command=values=>JSON.stringify({version:1,action:'formValues',operations:values.map(value=>({op:'setFormValue',value}))})
async function fixture(){
 const doc=await PDFDocument.create(),page=doc.addPage([400,300]),form=doc.getForm()
 const text=form.createTextField('Name');text.setText('Before');text.setMaxLength(10);text.addToPage(page,{x:20,y:200,width:220,height:30})
 const locked=form.createTextField('Locked');locked.enableReadOnly();locked.addToPage(page,{x:20,y:160,width:100,height:25})
 const check=form.createCheckBox('Check');check.addToPage(page,{x:20,y:120,width:20,height:20})
 const radio=form.createRadioGroup('Radio');radio.addOptionToPage('Yes',page,{x:60,y:120,width:20,height:20})
 const choice=form.createDropdown('Choice');choice.addOptions(['One','Two']);choice.addToPage(page,{x:20,y:60,width:120,height:25})
 return Buffer.from(await doc.save())
}
test('form values reuse native save, preserve original bytes and regenerate real Chinese appearances',async()=>{
 const input=await fixture(),copy=Buffer.from(input)
 for(const job of [createPdfFormValuesJob(),createIsolatedPdfFormValuesJob()]){
  const result=await job.execute(input,command([{name:'Name',value:'张三'},{name:'Check',checked:true},{name:'Radio',value:'Yes'},{name:'Choice',value:'Two'}]))
  const doc=await PDFDocument.load(result.bytes),form=doc.getForm()
  assert.equal(form.getTextField('Name').getText(),'张三');assert.equal(form.getCheckBox('Check').isChecked(),true);assert.equal(form.getRadioGroup('Radio').getSelected(),'Yes');assert.deepEqual(form.getDropdown('Choice').getSelected(),['Two'])
  const field=form.getTextField('Name'),ap=field.acroField.getWidgets()[0].dict.lookup(PDFName.of('AP'),PDFDict).lookup(PDFName.of('N'))
  assert.ok(ap.getContents().length>0);assert.ok(ap.dict.lookup(PDFName.of('Resources'),PDFDict).has(PDFName.of('Font')))
  assert.notEqual(String(form.acroForm.dict.get(PDFName.of('NeedAppearances'))),'true')
 }
 assert.deepEqual(input,copy)
})
test('form rejects invalid field batches before mutation',async()=>{
 const input=await fixture()
 for(const value of [{name:'Missing',value:'x'},{name:'Locked',value:'x'},{name:'Name',value:'12345678901'},{name:'Check',value:'true'},{name:'Radio',value:'Bad'},{name:'Choice',value:'Bad'}])await assert.rejects(createPdfFormValuesJob().execute(input,command([{name:'Name',value:'Valid'},value])),error=>error.code==='INVALID_PDF_FORM_VALUES')
 assert.throws(()=>validatePdfFormValueOperations([{op:'setFormValue',value:{name:'Name',value:'a'}},{op:'setFormValue',value:{name:'Name',value:'b'}}]))
 assert.throws(()=>validatePdfFormValueOperations([{op:'setFormValue',value:{name:'Name',kind:'text',value:'a'}}]))
})
test('form rejects XFA and actual signatures but keeps empty signature fields',async()=>{
 const input=await fixture(),doc=await PDFDocument.load(input)
 doc.getForm().acroForm.dict.set(PDFName.of('XFA'),doc.context.obj([]))
 await assert.rejects(createPdfFormValuesJob().execute(Buffer.from(await doc.save({updateFieldAppearances:false})),command([{name:'Name',value:'a'}])),error=>error.code==='PDF_EDIT_UNSUPPORTED_STRUCTURE')
 const fresh=await PDFDocument.load(input),form=fresh.getForm()
 form.acroForm.addField(fresh.context.register(fresh.context.obj({FT:'Sig',T:PDFHexString.fromText('Empty signature')})))
 const bytes=Buffer.from(await fresh.save())
 await createPdfFormValuesJob().execute(bytes,command([{name:'Name',value:'a'}]))
 const signed=await PDFDocument.load(bytes),sig=signed.getForm().getFields().find(f=>f.constructor.name==='PDFSignature')
 sig.acroField.dict.set(PDFName.of('V'),signed.context.register(signed.context.obj({Type:'Sig',ByteRange:[0,1,2,3]})))
 await assert.rejects(createPdfFormValuesJob().execute(Buffer.from(await signed.save()),command([{name:'Name',value:'a'}])),error=>error.code==='SIGNATURE_EDIT_REFUSED')
})

test('form preserves buttons and repairs unedited CJK appearances when source requests global regeneration',async()=>{
 const doc=await PDFDocument.load(await fixture()),form=doc.getForm(),page=doc.getPage(0)
 const before=form.getTextField('Name').acroField.getWidgets()[0].dict.lookup(PDFName.of('AP'),PDFDict).lookup(PDFName.of('N')).getContents()
 form.getTextField('Name').setText('张三')
 form.acroForm.dict.set(PDFName.of('NeedAppearances'),PDFBool.True)
 const button=form.createButton('Submit');button.addToPage('Submit',page,{x:200,y:20,width:100,height:25})
 const source=Buffer.from(await doc.save({updateFieldAppearances:false}))
 const result=await createPdfFormValuesJob().execute(source,command([{name:'Check',checked:true}]))
 const reopened=await PDFDocument.load(result.bytes),after=reopened.getForm().getTextField('Name').acroField.getWidgets()[0].dict.lookup(PDFName.of('AP'),PDFDict).lookup(PDFName.of('N')).getContents()
 assert.notDeepEqual(after,before);assert.equal(reopened.getForm().getTextField('Name').getText(),'张三');assert.ok(reopened.getForm().getButton('Submit'))
 await assert.rejects(createPdfFormValuesJob().execute(source,command([{name:'Submit',value:'Other'}])),error=>error.code==='INVALID_PDF_FORM_VALUES')
})
