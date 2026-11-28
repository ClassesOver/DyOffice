import test from 'node:test'
import assert from 'node:assert/strict'
import {PDFDocument,PDFHexString,PDFName,PDFPageLeaf,PDFRadioGroup} from 'pdf-lib'
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs'
import {createIsolatedPdfExtractPagesJob} from '../server/src/pdf/extract-pages-isolated.mjs'
import {createIsolatedPdfSplitJob} from '../server/src/pdf/split-isolated.mjs'

const name=PDFName.of
const extract=(bytes,pages)=>createIsolatedPdfExtractPagesJob().execute(bytes,JSON.stringify({version:1,action:'extractPages',pages}))
const split=(bytes)=>createIsolatedPdfSplitJob().execute(bytes,JSON.stringify({version:1,action:'splitPdf',pagesPerFile:1}))

async function fixture(){
 const doc=await PDFDocument.create(),first=doc.addPage(),middle=doc.addPage(),last=doc.addPage(),form=doc.getForm()
 const shared=form.createTextField('customer.name')
 for(const page of [first,middle,last])shared.addToPage(page,{x:32,y:40,width:90,height:18})
 shared.setText('Taylor Chen')
 const omitted=form.createTextField('customer.internal')
 omitted.addToPage(middle,{x:32,y:72,width:90,height:18})
 omitted.setText('Omitted page only')
 const approved=form.createCheckBox('approval.accepted')
 approved.addToPage(last,{x:32,y:104,width:18,height:18});approved.check()
 return Buffer.from(await doc.save())
}

async function inspect(bytes){
 const task=getDocument({data:Uint8Array.from(bytes),disableFontFace:true,useSystemFonts:true})
 try {
  const doc=await task.promise,pages=[]
  for(let i=1;i<=doc.numPages;i++){
   const widgets=(await (await doc.getPage(i)).getAnnotations()).filter(a=>a.subtype==='Widget')
   pages.push(widgets.map(({fieldName,fieldValue})=>[fieldName,fieldValue]))
  }
  return pages
 }finally{await task.destroy()}
}

test('extract keeps editable fields on the selected pages and removes unselected widgets and fields',async()=>{
 const bytes=await fixture(),before=Buffer.from(bytes),result=await extract(bytes,[3,1])
 assert.deepEqual(await inspect(result.bytes),[
  [['customer.name','Taylor Chen'],['approval.accepted','Yes']],
  [['customer.name','Taylor Chen']],
 ])
 const document=await PDFDocument.load(result.bytes),form=document.getForm()
 assert.deepEqual(form.getFields().map(field=>field.getName()).sort(),['approval.accepted','customer.name'])
 const shared=form.getTextField('customer.name')
 assert.deepEqual(shared.acroField.getWidgets().map(widget=>String(widget.P())).sort(),document.getPages().map(page=>String(page.ref)).sort())
 assert.equal(document.context.enumerateIndirectObjects().filter(([,object])=>object instanceof PDFPageLeaf).length,2)
 assert.equal(Buffer.from(result.bytes).includes(Buffer.from(PDFHexString.fromText('Omitted page only').asString())),false)
 shared.setText('Updated name')
 const updated=await inspect(await document.save())
 assert.deepEqual(updated.map(widgets=>widgets[0][1]),['Updated name','Updated name'])
 assert.deepEqual(bytes,before)
})

test('split reconstructs a separate field tree for every part',async()=>{
 const result=await split(await fixture())
 assert.deepEqual(await Promise.all(result.files.map(part=>inspect(part.bytes))),[
  [[['customer.name','Taylor Chen']]],
  [[['customer.name','Taylor Chen'],['customer.internal','Omitted page only']]],
  [[['customer.name','Taylor Chen'],['approval.accepted','Yes']]],
 ])
 for(const part of result.files){
  const doc=await PDFDocument.load(part.bytes)
  assert.equal(doc.getForm().getTextField('customer.name').acroField.getWidgets().length,1)
  assert.equal(doc.context.enumerateIndirectObjects().filter(([,object])=>object instanceof PDFPageLeaf).length,1)
 }
})

test('page copies keep radio export values and clear a selection whose widget was omitted',async()=>{
 const doc=await PDFDocument.create(),first=doc.addPage(),second=doc.addPage(),third=doc.addPage()
 const radio=doc.getForm().createRadioGroup('delivery.choice')
 radio.addOptionToPage('Pickup',first,{x:30,y:30,width:20,height:20})
 radio.addOptionToPage('Courier',second,{x:30,y:30,width:20,height:20})
 radio.addOptionToPage('Post',third,{x:30,y:30,width:20,height:20})
 radio.select('Courier')
 radio.acroField.dict.set(name('DV'),radio.acroField.getValue())
 const bytes=Buffer.from(await doc.save())
 const extracted=await extract(bytes,[3,2])
 async function inspectRadio(bytes,options,selected){
  const output=await PDFDocument.load(bytes),field=output.getForm().getField('delivery.choice')
  assert.ok(field instanceof PDFRadioGroup)
  assert.deepEqual(field.getOptions(),options)
  assert.equal(field.getSelected(),selected)
  assert.equal(field.acroField.dict.get(name('DV')),selected?field.acroField.getValue():name('Off'))
  assert.equal(field.acroField.getWidgets().length,options.length)
  if(selected===undefined){
   assert.equal(field.acroField.getValue(),name('Off'))
   assert.equal(field.acroField.getWidgets()[0].getAppearanceState(),name('Off'))
   field.select(options[0]);assert.equal(field.getSelected(),options[0])
  }
 }
 await inspectRadio(extracted.bytes,['Courier','Post'],'Courier')
 assert.deepEqual(await inspect(extracted.bytes),[[['delivery.choice','Courier']],[['delivery.choice','Courier']]])
 const result=await split(bytes)
 await inspectRadio(result.files[0].bytes,['Pickup'],undefined)
 await inspectRadio(result.files[1].bytes,['Courier'],'Courier')
 await inspectRadio(result.files[2].bytes,['Post'],undefined)
})

test('form page copies still refuse XFA and unsigned signature widgets',async()=>{
 const bytes=await fixture(),xfa=await PDFDocument.load(bytes)
 xfa.getForm().acroForm.dict.set(name('XFA'),xfa.context.register(xfa.context.flateStream('<xdp/>')))
 const xfaBytes=Buffer.from(await xfa.save({updateFieldAppearances:false}))
 await assert.rejects(extract(xfaBytes,[1]),{code:'PDF_EDIT_UNSUPPORTED_STRUCTURE'})
 await assert.rejects(split(xfaBytes),{code:'PDF_EDIT_UNSUPPORTED_STRUCTURE'})
 const signed=await PDFDocument.load(bytes)
 signed.context.register(signed.context.obj({FT:'Sig'}))
 const signedBytes=Buffer.from(await signed.save())
 await assert.rejects(extract(signedBytes,[1]),{code:'SIGNATURE_EDIT_REFUSED'})
 await assert.rejects(split(signedBytes),{code:'SIGNATURE_EDIT_REFUSED'})
})
