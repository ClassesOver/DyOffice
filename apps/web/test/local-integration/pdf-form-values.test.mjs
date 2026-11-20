import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdir,writeFile} from 'node:fs/promises'
import {PDFDocument} from 'pdf-lib'
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {createPdfService} from '../../server/src/modules/pdf/service.ts'

test('PDF form batch saves real field values and appearances while preserving earlier revisions',async t=>{
 const f=await fileFixture(t,{buildApp:false}),doc=await PDFDocument.create(),page=doc.addPage([500,400]),form=doc.getForm()
 page.drawText('Reviewer / consent / decision / status',{x:35,y:360,size:14})
 const reviewer=form.createTextField('Reviewer');reviewer.setText('Before');reviewer.setMaxLength(10);reviewer.addToPage(page,{x:35,y:290,width:220,height:30})
 const consent=form.createCheckBox('Consent');consent.addToPage(page,{x:35,y:240,width:20,height:20})
 const decision=form.createRadioGroup('Decision');decision.addOptionToPage('Yes',page,{x:35,y:190,width:20,height:20});decision.addOptionToPage('No',page,{x:95,y:190,width:20,height:20});decision.select('No')
 const state=form.createDropdown('Status');state.addOptions(['Review','Done']);state.select('Review');state.addToPage(page,{x:35,y:125,width:220,height:30})
 const locked=form.createTextField('Locked');locked.setText('Original');locked.addToPage(page,{x:35,y:60,width:220,height:30});locked.enableReadOnly()
 const original=Buffer.from(await doc.save()),source=(await importFile(f,f.alice.token,original,'form.pdf')).file
 const leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
 const pdf=createPdfService({files:f.files,leases,revisions}),editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,source.fileId,{editorId})
 const ops=values=>values.map(value=>({op:'setFormValue',value}))
 const input={baseRevision:source.revision,editorId,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID(),operations:ops([{name:'Reviewer',value:'张三'},{name:'Consent',checked:true},{name:'Decision',value:'Yes'},{name:'Status',value:'Done'}])}
 await assert.rejects(pdf.stageFormValues(f.bob.token,source.fileId,input),error=>error.statusCode===404)
 await assert.rejects(pdf.stageFormValues(f.alice.token,source.fileId,{...input,leaseEpoch:lease.leaseEpoch+1}),error=>error.statusCode===409)
 for(const value of [{name:'missing',value:'x'},{name:'Consent',checked:'false'},{name:'Status',value:'Unknown'},{name:'Locked',value:'Changed'},{name:'Reviewer',value:'12345678901'}]){
  await assert.rejects(pdf.stageFormValues(f.alice.token,source.fileId,{...input,operations:ops([{name:'Reviewer',value:'Valid'},value])}),error=>error.statusCode===400)
 }
 const prepared=await pdf.stageFormValues(f.alice.token,source.fileId,input)
 assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,source.revision)
 const saved=await revisions.commitRevision(f.alice.token,prepared.commitInput)
 assert.deepEqual(await revisions.commitRevision(f.alice.token,prepared.commitInput),saved)
 const bytes=await f.files.readFile(f.alice.token,source.fileId,saved.revision),result=(await PDFDocument.load(bytes)).getForm()
 assert.equal(result.getTextField('Reviewer').getText(),'张三')
 assert.equal(result.getCheckBox('Consent').isChecked(),true)
 assert.equal(result.getRadioGroup('Decision').getSelected(),'Yes')
 assert.deepEqual(result.getDropdown('Status').getSelected(),['Done'])
 assert.equal(result.getTextField('Locked').getText(),'Original');assert.equal(result.getTextField('Locked').isReadOnly(),true)
 const loading=getDocument({data:Uint8Array.from(bytes),disableFontFace:true,useSystemFonts:true})
 try{
  const annotations=await (await (await loading.promise).getPage(1)).getAnnotations()
  const field=annotations.find(annotation=>annotation.fieldName==='Reviewer')
  assert.equal(field.fieldValue,'张三');assert.equal(field.hasAppearance,true)
 }finally{await loading.destroy()}
 assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),original)
 assert.equal((await PDFDocument.load(original)).getForm().getTextField('Reviewer').getText(),'Before')
 await mkdir('/tmp/dyoffice-pdf-form-review',{recursive:true})
 await writeFile('/tmp/dyoffice-pdf-form-review/filled.pdf',bytes)
})
