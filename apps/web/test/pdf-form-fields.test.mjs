import test from 'node:test'
import assert from 'node:assert/strict'
import {PDFDocument,PDFName,PDFDict,PDFArray,PDFStream,PDFNumber,StandardFonts,degrees} from 'pdf-lib'
import {createHash} from 'node:crypto'
import {createPdfFormFieldsJob,parsePdfFormFieldsRequest} from '../server/src/pdf/form-fields-job.mjs'
import {validatePdfFormFieldOperations} from '../../../packages/web-contracts/src/pdf-form-fields.ts'
import {pdfInsertFormState} from '../server/src/pdf/insert-form-integrity.mjs'
const n=PDFName.of,hash=b=>createHash('sha256').update(b).digest('hex')
const field=(name,kind,extra={})=>({op:'addFormField',field:{name,kind,page:1,x:30,y:40,width:160,height:30,...extra}})
const request=operations=>JSON.stringify({version:1,action:'formFields',operations})
async function fixture(existing=false){const d=await PDFDocument.create();const p=d.addPage([500,650]);p.drawText('Unchanged page',{x:30,y:600});if(existing){const f=d.getForm().createTextField('existing');f.addToPage(p,{x:30,y:500,width:160,height:30});f.setText('Original');f.enableReadOnly();d.getForm().updateFieldAppearances(await d.embedFont(StandardFonts.Helvetica))}return Buffer.from(await d.save({useObjectStreams:false,updateFieldAppearances:false}))}

test('form field contract accepts five PC kinds and radio groups and rejects ambiguous or executable properties',()=>{
 const valid=[field('text','text',{value:'Hello',multiLine:true,maxLen:50,fontSize:12,textAlignment:'center',dateFormat:'yyyy-mm-dd'}),field('check','checkbox',{checked:true}),field('radio','radio',{exportValue:'one',checked:true}),field('radio','radio',{exportValue:'two',x:210}),field('choice','choice',{options:['One','Two'],value:'Two'}),field('sign','signature')]
 const parsed=validatePdfFormFieldOperations(valid);assert.equal(parsed.length,6);assert.ok(Object.isFrozen(parsed));assert.ok(Object.isFrozen(parsed[0].field));assert.deepEqual(parsePdfFormFieldsRequest(request(valid)),parsed)
 const bad=[[],[field('a','__proto__')],[field('a','toString')],[field('a','date')],[field('a','text',{page:0})],[field('a','text',{width:0})],[field('a','text',{width:NaN})],[field('a','text',{unknown:1})],[field('a','text',{checked:true})],[field('a','signature',{value:'signed'})],[field('a','choice',{options:['One'],value:'Other'})],[field('a','choice',{options:['One','One']})],[field('a','text',{maxLen:2,value:'long'})],[field('a','text',{dateFormat:'yyyy";alert(1)'})],[field('a','text'),field('a','text')],[field('a','text'),field('a.b','text')],[field('a','radio',{exportValue:'same'}),field('a','radio',{exportValue:'same'})],[field('a','radio',{checked:true}),field('a','radio',{checked:true})]]
 bad.push(Array.from({length:51},(_,i)=>field('limit'+i,'text')))
 for(const ops of bad)assert.throws(()=>validatePdfFormFieldOperations(ops),{code:'INVALID_PDF_FORM_FIELDS'})
 let called=false;const getter=field('getter','text');Object.defineProperty(getter.field,'value',{enumerable:true,get(){called=true;return 'bad'}});assert.throws(()=>validatePdfFormFieldOperations([getter]),{code:'INVALID_PDF_FORM_FIELDS'});assert.equal(called,false)
 for(const raw of [request(valid).replace('formFields','other'),JSON.stringify({version:1,action:'formFields',operations:valid,extra:true})])assert.throws(()=>parsePdfFormFieldsRequest(raw),{code:'INVALID_REQUEST'})
})

test('native form fields create all five real field kinds with values flags dates and radio widgets',async()=>{
 const original=await fixture(),digest=hash(original),ops=[field('text','text',{value:'Hello',required:true,multiLine:true,maxLen:50,fontSize:12,textAlignment:'right',dateFormat:'yyyy-mm-dd'}),field('check','checkbox',{checked:true,y:90,width:20,height:20}),field('radio','radio',{exportValue:'one',checked:true,y:120,width:20,height:20}),field('radio','radio',{exportValue:'two',x:70,y:120,width:20,height:20}),field('choice','choice',{options:['One','Two'],value:'Two',y:170}),field('sign','signature',{y:220})]
 const result=await createPdfFormFieldsJob().execute(original,request(ops)),d=await PDFDocument.load(result.bytes),form=d.getForm()
 assert.equal(result.inputSha256,digest);assert.equal(result.sha256,hash(result.bytes));assert.equal(result.size,result.bytes.length);assert.equal(hash(original),digest)
 assert.equal(form.getFields().length,5);const text=form.getTextField('text');assert.equal(text.getText(),'Hello');assert.equal(text.isRequired(),true);assert.equal(text.isMultiline(),true);assert.equal(text.getMaxLength(),50);assert.equal(text.getAlignment(),2);assert.ok(text.acroField.dict.lookup(n('AA'),PDFDict))
 assert.equal(form.getCheckBox('check').isChecked(),true);assert.deepEqual(form.getRadioGroup('radio').getOptions(),['one','two']);assert.equal(form.getRadioGroup('radio').getSelected(),'one');assert.equal(form.getRadioGroup('radio').acroField.getWidgets().length,2);assert.deepEqual(form.getDropdown('choice').getSelected(),['Two']);assert.equal(form.getSignature('sign').acroField.dict.has(n('V')),false)
 for(const f of form.getFields().filter(f=>f.getName()!=='sign'))for(const w of f.acroField.getWidgets())assert.ok(w.dict.lookup(n('AP'),PDFDict))
})

test('native field layout uses CropBox UserUnit and all page rotations in display points',async()=>{
 for(const rotation of [0,90,180,270]){
  const d=await PDFDocument.load(await fixture()),p=d.getPage(0);p.setCropBox(40,60,300,400);p.setRotation(degrees(rotation));p.node.set(n('UserUnit'),PDFNumber.of(2));const original=Buffer.from(await d.save({updateFieldAppearances:false})),op=field('position','text',{x:24,y:36,width:120,height:40})
  const result=await createPdfFormFieldsJob().execute(original,request([op])),out=await PDFDocument.load(result.bytes),rect=out.getForm().getTextField('position').acroField.getWidgets()[0].getRectangle()
  const {pdfRectToCss}=await import('../../pdf/src/renderer/annotations.ts'),display=pdfRectToCss({pw:600,ph:800,x0:40,y0:60,rot:rotation,userUnit:2},[rect.x,rect.y,rect.x+rect.width,rect.y+rect.height],1)
  for(const [key,value]of Object.entries({left:24,top:36,width:120,height:40}))assert.ok(Math.abs(display[key]-value)<0.02,`${rotation} ${key} ${display[key]}`)
  await assert.rejects(createPdfFormFieldsJob().execute(original,request([field('outside','text',{x:790,y:790})])),{code:'INVALID_PDF_FORM_FIELDS'})
 }
})

test('new CJK text and choice values have embedded font appearances instead of NeedAppearances fallback',async()=>{
 const ops=[field('中文','text',{value:'中文 日本語 한국어',fontSize:12}),field('choice','choice',{options:['中文','日本語','한국어'],value:'한국어',y:100})],result=await createPdfFormFieldsJob().execute(await fixture(),request(ops)),d=await PDFDocument.load(result.bytes),form=d.getForm()
 assert.equal(form.getTextField('中文').getText(),'中文 日本語 한국어');assert.deepEqual(form.getDropdown('choice').getSelected(),['한국어']);assert.notEqual(String(form.acroForm.dict.get(n('NeedAppearances'))),'true')
 for(const f of form.getFields())for(const w of f.acroField.getWidgets()){const ap=w.dict.lookup(n('AP'),PDFDict).lookup(n('N'));assert.ok(ap instanceof PDFStream);assert.ok(ap.getContents().length>20);const fonts=ap.dict.lookup(n('Resources'),PDFDict).lookup(n('Font'),PDFDict);assert.ok([...fonts.values()].some(ref=>String(d.context.lookup(ref).get(n('Subtype')))==='/Type0'))}
})

test('adding fields preserves existing field tree value flags and appearance bytes',async()=>{
 const original=await fixture(true),before=await PDFDocument.load(original),expected=pdfInsertFormState(before),result=await createPdfFormFieldsJob().execute(original,request([field('new','text',{value:'Added'}),field('sign','signature',{y:120})])),after=await PDFDocument.load(result.bytes),roots=after.getForm().acroForm.dict.lookup(n('Fields'),PDFArray)
 while(roots.size()>1)roots.remove(roots.size()-1)
 const annots=after.getPage(0).node.Annots();while(annots.size()>1)annots.remove(annots.size()-1)
 assert.equal(pdfInsertFormState(after),expected)
 for(const name of ['existing','existing.child'])await assert.rejects(createPdfFormFieldsJob().execute(original,request([field(name,'text')])),{code:'PDF_FORM_FIELD_CONFLICT'})
 const grouped=await PDFDocument.load(await fixture()),g=grouped.getForm().createTextField('parent.child');g.addToPage(grouped.getPage(0),{x:30,y:500,width:160,height:30});const groupedBytes=Buffer.from(await grouped.save({updateFieldAppearances:false}));await assert.rejects(createPdfFormFieldsJob().execute(groupedBytes,request([field('parent','text')])),{code:'PDF_FORM_FIELD_CONFLICT'})
})

test('signed originals XFA malformed input and abort remain refused',async()=>{
 for(const kind of ['directValue','indirectValue','type','byteRange','perms','xfa']){
  const d=await PDFDocument.load(await fixture()),form=d.getForm(),dict=d.context.obj({FT:kind==='indirectValue'?d.context.register(n('Sig')):n('Sig'),T:d.context.obj('Signed')})
  if(kind==='directValue'||kind==='indirectValue')dict.set(n('V'),d.context.obj({Contents:d.context.obj('signature')}))
  if(kind==='type')dict.set(n('Type'),d.context.register(n('Sig')))
  if(kind==='byteRange')dict.set(n('ByteRange'),d.context.obj([0,1,2,3]))
  if(kind==='perms')d.catalog.set(n('Perms'),d.context.obj({}))
  if(kind==='xfa')form.acroForm.dict.set(n('XFA'),d.context.stream('unsupported'))
  form.acroForm.addField(d.context.register(dict))
  await assert.rejects(createPdfFormFieldsJob().execute(Buffer.from(await d.save({updateFieldAppearances:false})),request([field('new','text')])),{code:kind==='xfa'?'PDF_EDIT_UNSUPPORTED_STRUCTURE':'SIGNATURE_EDIT_REFUSED'})
 }
 await assert.rejects(createPdfFormFieldsJob().execute(Buffer.from('bad'),request([field('new','text')])),{code:'MAGIC_MISMATCH'})
 const controller=new AbortController();controller.abort();await assert.rejects(createPdfFormFieldsJob().execute(await fixture(),request([field('new','text')]),controller.signal),{code:'ABORTED'})
})

test('existing unsigned signature fields permit subsequent authoring with original tree intact',async()=>{
 const first=await createPdfFormFieldsJob().execute(await fixture(),request([field('sign','signature')])),before=await PDFDocument.load(first.bytes),expected=pdfInsertFormState(before)
 for(const indirect of [false,true]){
  const source=await PDFDocument.load(first.bytes),signature=source.getForm().getSignature('sign')
  if(indirect)signature.acroField.dict.set(n('FT'),source.context.register(n('Sig')))
  const original=Buffer.from(await source.save({updateFieldAppearances:false})),prior=pdfInsertFormState(await PDFDocument.load(original)),second=await createPdfFormFieldsJob().execute(original,request([field('second','text',{value:'Added later',y:120})])),after=await PDFDocument.load(second.bytes)
  assert.equal(after.getForm().getTextField('second').getText(),'Added later');assert.equal(after.getForm().getSignature('sign').acroField.dict.has(n('V')),false)
  after.getForm().acroForm.dict.lookup(n('Fields'),PDFArray).remove(1);after.getPage(0).node.Annots().remove(1)
  assert.equal(pdfInsertFormState(after),prior);if(!indirect)assert.equal(prior,expected)
 }
})


test('existing radio groups accept new options and requested state while preserving old appearances and other fields',async()=>{
 const d=await PDFDocument.load(await fixture(true)),radio=d.getForm().createRadioGroup('existingRadio');radio.addOptionToPage('old',d.getPage(0),{x:240,y:500,width:20,height:20});radio.select('old');const original=Buffer.from(await d.save({updateFieldAppearances:false})),before=await PDFDocument.load(original),old=before.getForm().getRadioGroup('existingRadio'),oldWidget=old.acroField.getWidgets()[0],oldAp=hash(before.context.lookup(oldWidget.dict.lookup(n('AP'),PDFDict).get(n('N'))).lookup(n('0')).getContents())
 for(const checked of [false,true]){
  const result=await createPdfFormFieldsJob().execute(original,request([field('existingRadio','radio',{exportValue:'new',checked,required:true,x:240,y:100,width:20,height:20}),field('existingRadio','radio',{exportValue:'third',x:280,y:100,width:20,height:20})])),after=await PDFDocument.load(result.bytes),group=after.getForm().getRadioGroup('existingRadio')
  assert.deepEqual(group.getOptions(),['old','new','third']);assert.equal(group.getSelected(),checked?'new':'old');assert.equal(group.isRequired(),true);assert.equal(group.acroField.getWidgets().length,3)
  assert.equal(after.getForm().getTextField('existing').getText(),'Original');assert.equal(after.getForm().getTextField('existing').isReadOnly(),true)
  const ap=group.acroField.getWidgets()[0].dict.lookup(n('AP'),PDFDict).lookup(n('N'),PDFDict);assert.equal(hash(after.context.lookup(ap.get(n('0'))).getContents()),oldAp)
 }
 await assert.rejects(createPdfFormFieldsJob().execute(original,request([field('existingRadio','radio',{exportValue:'old'})])),{code:'PDF_FORM_FIELD_CONFLICT'})
 const result=await createPdfFormFieldsJob().execute(original,request([field('existingRadio','radio')])),after=await PDFDocument.load(result.bytes);assert.deepEqual(after.getForm().getRadioGroup('existingRadio').getOptions(),['old','option_2'])
})

test('adding a sibling within an existing field group preserves its parent and existing child',async()=>{
 const d=await PDFDocument.load(await fixture()),old=d.getForm().createTextField('group.old');old.addToPage(d.getPage(0),{x:30,y:500,width:160,height:30});old.setText('Original');d.getForm().updateFieldAppearances(await d.embedFont(StandardFonts.Helvetica));const original=Buffer.from(await d.save({updateFieldAppearances:false})),result=await createPdfFormFieldsJob().execute(original,request([field('group.new','text',{value:'New'})])),after=await PDFDocument.load(result.bytes)
 assert.equal(after.getForm().getTextField('group.old').getText(),'Original');assert.equal(after.getForm().getTextField('group.new').getText(),'New')
})


test('adding a field to one page leaves other pages without annotations untouched',async()=>{
 const d=await PDFDocument.load(await fixture());d.addPage([500,650]);const original=Buffer.from(await d.save({updateFieldAppearances:false})),result=await createPdfFormFieldsJob().execute(original,request([field('single','text',{value:'One page'})])),out=await PDFDocument.load(result.bytes)
 assert.equal(out.getPageCount(),2);assert.equal(out.getPage(1).node.Annots(),undefined)
 assert.throws(()=>validatePdfFormFieldOperations([field('bad','text',{page:3})],2),{code:'INVALID_PDF_FORM_FIELDS'})
 await assert.rejects(createPdfFormFieldsJob().execute(original,request([field('bad','text',{page:3})])),{code:'INVALID_PDF_FORM_FIELDS'})
})


test('effective visible field geometry intersects CropBox and MediaBox',async()=>{
 const d=await PDFDocument.load(await fixture()),p=d.getPage(0);p.setCropBox(-100,-100,700,850);const original=Buffer.from(await d.save({updateFieldAppearances:false})),result=await createPdfFormFieldsJob().execute(original,request([field('inside','text',{x:30,y:40,width:160,height:30})])),out=await PDFDocument.load(result.bytes),rect=out.getForm().getTextField('inside').acroField.getWidgets()[0].getRectangle()
 assert.deepEqual(rect,{x:30,y:580,width:160,height:30})
 await assert.rejects(createPdfFormFieldsJob().execute(original,request([field('outside','text',{x:490,y:40,width:160,height:30})])),{code:'INVALID_PDF_FORM_FIELDS'})
})
