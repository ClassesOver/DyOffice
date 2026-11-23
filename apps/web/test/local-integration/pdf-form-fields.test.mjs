import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {PDFDocument,PDFName} from 'pdf-lib'
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {createPdfService} from '../../server/src/modules/pdf/service.ts'

test('PDF creates real fillable field types, preserves original fields and saves later values without changing history',async t=>{
 const f=await fileFixture(t,{buildApp:false}),doc=await PDFDocument.create(),page=doc.addPage([500,650]),form=doc.getForm()
 page.drawText('Original form',{x:30,y:610,size:14})
 const originalField=form.createTextField('Locked');originalField.setText('Original');originalField.addToPage(page,{x:30,y:30,width:200,height:24});originalField.enableReadOnly()
 const original=Buffer.from(await doc.save()),source=(await importFile(f,f.alice.token,original,'field-creation.pdf')).file
 const leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files}),pdf=createPdfService({files:f.files,leases,revisions}),editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,source.fileId,{editorId}),authority={editorId,leaseEpoch:lease.leaseEpoch}
 const field=(name,kind,y,extra={})=>({op:'addFormField',field:{name,kind,page:1,x:40,y,width:180,height:24,...extra}})
 const operations=[field('Reviewer','text',80,{value:'张三',required:true,maxLen:20,fontSize:16,textAlignment:'center'}),field('Consent','checkbox',130,{width:20,height:20,checked:true}),field('Status','choice',180,{options:['待审核','完成'],value:'待审核'}),field('Decision','radio',230,{width:20,height:20,exportValue:'Yes',checked:true}),field('Decision','radio',270,{width:20,height:20,exportValue:'No'}),field('Date','text',320,{dateFormat:'yyyy-mm-dd',value:'2026-11-20'}),field('Signature','signature',380)]
 const input={...authority,baseRevision:source.revision,idempotencyKey:randomUUID(),operations}
 await assert.rejects(pdf.stageFormFields(f.bob.token,source.fileId,input),e=>e.statusCode===404)
 await assert.rejects(pdf.stageFormFields(f.alice.token,source.fileId,{...input,leaseEpoch:lease.leaseEpoch+1}),e=>e.statusCode===409)
 for(const invalid of [[operations[0],field('Locked','text',500)],[operations[0],{op:'setFormValue',value:{name:'Locked',value:'wrong'}}],[field('Invalid','choice',400,{options:['one'],value:'missing'})]])await assert.rejects(pdf.stageFormFields(f.alice.token,source.fileId,{...input,operations:invalid}),e=>e.statusCode===400)
 const staged=await pdf.stageFormFields(f.alice.token,source.fileId,input)
 assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,source.revision)
 const saved=await revisions.commitRevision(f.alice.token,staged.commitInput);assert.deepEqual(await revisions.commitRevision(f.alice.token,staged.commitInput),saved)
 const bytes=await f.files.readFile(f.alice.token,source.fileId,saved.revision),savedDoc=await PDFDocument.load(bytes),result=savedDoc.getForm()
 assert.equal(result.getTextField('Reviewer').getText(),'张三');assert.equal(result.getTextField('Reviewer').isRequired(),true);assert.equal(result.getTextField('Reviewer').getMaxLength(),20)
 assert.equal(result.getCheckBox('Consent').isChecked(),true);assert.deepEqual(result.getDropdown('Status').getSelected(),['待审核']);assert.equal(result.getRadioGroup('Decision').getSelected(),'Yes');assert.deepEqual(result.getRadioGroup('Decision').getOptions(),['Yes','No'])
 assert.equal(result.getTextField('Date').getText(),'2026-11-20');assert.ok(result.getTextField('Date').acroField.dict.has(PDFName.of('AA')));assert.ok(result.getSignature('Signature'))
 assert.equal(result.getTextField('Locked').getText(),'Original');assert.equal(result.getTextField('Locked').isReadOnly(),true)
 const task=getDocument({data:Uint8Array.from(bytes),disableFontFace:true,useSystemFonts:true})
 try{const annotations=await (await (await task.promise).getPage(1)).getAnnotations();const reviewer=annotations.find(a=>a.fieldName==='Reviewer');assert.equal(reviewer.fieldValue,'张三');assert.equal(reviewer.hasAppearance,true);assert.equal(annotations.filter(a=>a.fieldName==='Decision').length,2)}finally{await task.destroy()}
 const filled=await pdf.stageFormValues(f.alice.token,source.fileId,{...authority,baseRevision:saved.revision,idempotencyKey:randomUUID(),operations:[{op:'setFormValue',value:{name:'Reviewer',value:'李四'}},{op:'setFormValue',value:{name:'Consent',checked:false}},{op:'setFormValue',value:{name:'Status',value:'完成'}},{op:'setFormValue',value:{name:'Decision',value:'No'}}]})
 const final=await revisions.commitRevision(f.alice.token,filled.commitInput),finalForm=(await PDFDocument.load(await f.files.readFile(f.alice.token,source.fileId,final.revision))).getForm()
 assert.equal(finalForm.getTextField('Reviewer').getText(),'李四');assert.equal(finalForm.getCheckBox('Consent').isChecked(),false);assert.deepEqual(finalForm.getDropdown('Status').getSelected(),['完成']);assert.equal(finalForm.getRadioGroup('Decision').getSelected(),'No');assert.equal(finalForm.getTextField('Locked').getText(),'Original')
 assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,saved.revision),bytes);assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),original)
})
