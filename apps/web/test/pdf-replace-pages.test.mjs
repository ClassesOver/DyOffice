import test from 'node:test'
import assert from 'node:assert/strict'
import {PDFArray,PDFDict,PDFDocument,PDFName,PDFString} from 'pdf-lib'
import {createHash,randomBytes} from 'node:crypto'
import {createPdfReplacePagesJob,framePdfReplacePages} from '../server/src/pdf/replace-pages-job.mjs'
import {createIsolatedPdfReplacePagesJob} from '../server/src/pdf/replace-pages-isolated.mjs'
import {createPdfStampsJob} from '../server/src/pdf/stamps-job.mjs'
import {readPdfLeafObjects} from '../../pdf/src/main/text-edit.ts'
const command=pages=>JSON.stringify({version:1,action:'replacePages',pages}),hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const insertCommand=afterPageIndex=>JSON.stringify({version:1,action:'insertPages',afterPageIndex})
async function fixture(labels){const d=await PDFDocument.create();for(const label of labels)d.addPage([500,600]).drawText(label,{x:30,y:200,size:14});return Buffer.from(await d.save())}
const text=async bytes=>(await readPdfLeafObjects(bytes)).filter(item=>item.type===1).map(item=>item.text).join('|')
const stamp=async(bytes,operation)=>(await createPdfStampsJob().execute(bytes,JSON.stringify({version:1,action:'stamps',operation}))).bytes
test('replace pages follows PC sorted unique target semantics and binds both PDF snapshots',async()=>{
 const target=await fixture(['Target 1','Target 2','Target 3','Target 4']),source=await fixture(['Imported A','Imported B']),frame=framePdfReplacePages(target,source)
 for(const job of [createPdfReplacePagesJob(),createIsolatedPdfReplacePagesJob()]){
  const result=await job.execute(frame,command([4,2,2]));assert.equal(await text(result.bytes),'Target 1|Imported A|Imported B|Target 3');assert.equal(result.inputSha256,hash(target));assert.equal(result.sourceSha256,hash(source));assert.equal(result.sha256,hash(result.bytes));assert.equal(result.size,result.bytes.length)
 }
 const all=await createPdfReplacePagesJob().execute(frame,command([1,2,3,4]));assert.equal(await text(all.bytes),'Imported A|Imported B')
})
test('insert pages uses the requested after-page position through the isolated worker',async()=>{
 const target=await fixture(['Target 1','Target 2','Target 3']),source=await fixture(['Imported A','Imported B']),job=createIsolatedPdfReplacePagesJob()
 const result=await job.execute(framePdfReplacePages(target,source),insertCommand(0))
 assert.equal(await text(result.bytes),'Target 1|Imported A|Imported B|Target 2|Target 3')
 assert.equal(result.inputSha256,hash(target));assert.equal(result.sourceSha256,hash(source));assert.equal(result.sha256,hash(result.bytes))
 await assert.rejects(job.execute(framePdfReplacePages(target,source),insertCommand(3)),{code:'INVALID_PDF_INSERT_PAGES'})
})
test('insert and replace ordinary pages in an AcroForm target keep the surviving fields editable',async()=>{
 const original=await PDFDocument.load(await fixture(['Target 1','Target 2','Target 3']))
 const [first,,third]=original.getPages(),form=original.getForm()
 const customer=form.createTextField('contact.customer')
 for(const page of [first,third])customer.addToPage(page,{x:32,y:75,width:90,height:20})
 customer.setText('Ada Lovelace')
 const removed=form.createTextField('contact.old');removed.addToPage(first,{x:32,y:110,width:90,height:20})
 const delivery=form.createRadioGroup('delivery')
 delivery.addOptionToPage('Pickup',first,{x:32,y:150,width:20,height:20})
 delivery.addOptionToPage('Courier',third,{x:32,y:150,width:20,height:20})
 delivery.select('Pickup')
 const target=Buffer.from(await original.save()),source=await fixture(['Imported']),job=createIsolatedPdfReplacePagesJob()
 const framed=framePdfReplacePages(target,source)
 const inserted=await job.execute(framed,insertCommand(-1))
 const insertedDoc=await PDFDocument.load(inserted.bytes)
 assert.deepEqual(insertedDoc.getForm().getTextField('contact.customer').acroField.getWidgets().map(w=>String(w.P())),[1,3].map(i=>String(insertedDoc.getPage(i).ref)))
 assert.equal(insertedDoc.getForm().getRadioGroup('delivery').getSelected(),'Pickup')
 assert.equal(await text(inserted.bytes),'Imported|Target 1|Target 2|Target 3')
 const replaced=await job.execute(framed,command([2,1]))
 const replacedDoc=await PDFDocument.load(replaced.bytes),replacedForm=replacedDoc.getForm()
 assert.equal(await text(replaced.bytes),'Imported|Target 3')
 assert.deepEqual(replacedForm.getFields().map(field=>field.getName()),['contact.customer','delivery'])
 const retained=replacedForm.getTextField('contact.customer')
 assert.equal(retained.getText(),'Ada Lovelace')
 assert.deepEqual(retained.acroField.getWidgets().map(w=>String(w.P())),[String(replacedDoc.getPage(1).ref)])
 const radio=replacedForm.getRadioGroup('delivery')
 assert.deepEqual(radio.getOptions(),['Courier'])
 assert.equal(radio.getSelected(),undefined)
 radio.select('Courier')
 assert.equal((await PDFDocument.load(await replacedDoc.save())).getForm().getRadioGroup('delivery').getSelected(),'Courier')
 assert.equal((await PDFDocument.load(target)).getForm().getRadioGroup('delivery').getSelected(),'Pickup')
})
test('insert and replace from a form PDF preserve the source field tree in a plain target',async()=>{
 const target=await fixture(['Target 1','Target 2','Target 3'])
 const donor=await PDFDocument.load(await fixture(['Donor 1','Donor 2'])),form=donor.getForm()
 const shared=form.createTextField('client.name')
 for(const page of donor.getPages())shared.addToPage(page,{x:30,y:70,width:90,height:22})
 shared.setText('Taylor Chen')
 form.createTextField('client.internal').setText('Hidden value')
 const donorBytes=Buffer.from(await donor.save()),original=Buffer.from(donorBytes)
 const frame=framePdfReplacePages(target,donorBytes),job=createIsolatedPdfReplacePagesJob()
 for(const [request,expected] of [[insertCommand(0),'Target 1|Donor 1|Donor 2|Target 2|Target 3'],[command([2]),'Target 1|Donor 1|Donor 2|Target 3']]){
  const result=await job.execute(frame,request),output=await PDFDocument.load(result.bytes)
  assert.equal(await text(result.bytes),expected)
  const imported=output.getForm(),field=imported.getTextField('client.name')
  assert.equal(field.getText(),'Taylor Chen')
  assert.equal(imported.getTextField('client.internal').getText(),'Hidden value')
  assert.deepEqual(field.acroField.getWidgets().map(widget=>String(widget.P())),[1,2].map(i=>String(output.getPage(i).ref)))
  field.setText('Updated name')
  assert.equal((await PDFDocument.load(await output.save())).getForm().getTextField('client.name').getText(),'Updated name')
 }
 const prior=await PDFDocument.load(target),obsolete=prior.getForm().createTextField('obsolete')
 obsolete.addToPage(prior.getPage(1),{x:30,y:70,width:90,height:22})
 const replaced=await job.execute(framePdfReplacePages(Buffer.from(await prior.save()),donorBytes),command([2]))
 const reopened=await PDFDocument.load(replaced.bytes)
 assert.deepEqual(reopened.getForm().getFields().map(field=>field.getName()),['client.name','client.internal'])
 assert.deepEqual(donorBytes,original)
})
test('PDF imports keep duplicate field names independent and resolve conflicting form fonts',async()=>{
 const n=PDFName.of
 async function filled(label,font){
  const doc=await PDFDocument.load(await fixture([label,'Retained '+label])),form=doc.getForm()
  const field=form.createTextField('client.name')
  field.addToPage(doc.getPage(1),{x:30,y:70,width:90,height:22});field.setText(label)
  form.updateFieldAppearances()
  const acro=form.acroForm.dict,resource=doc.context.register(doc.context.obj({Type:'Font',Subtype:'Type1',BaseFont:font}))
  acro.set(n('DR'),doc.context.obj({Font:{Shared:resource}}))
  acro.set(n('DA'),PDFString.of('/Shared 10 Tf 0 g'))
  field.acroField.dict.delete(n('DA'))
  acro.set(n('CO'),doc.context.obj([field.ref]))
  return Buffer.from(await doc.save({updateFieldAppearances:false}))
 }
 const destination=await filled('Destination','Helvetica'),source=await filled('Imported','Courier')
 const frame=framePdfReplacePages(destination,source),job=createIsolatedPdfReplacePagesJob()
 for(const [request,widgetPages] of [[insertCommand(0),[3,2]],[command([1]),[2,1]]]){
  const result=await job.execute(frame,request),doc=await PDFDocument.load(result.bytes),form=doc.getForm()
  const existing=form.getTextField('client.name'),incoming=form.getTextField('client_2.name')
  assert.deepEqual([existing.getText(),incoming.getText()],['Destination','Imported'])
  assert.deepEqual([existing,incoming].map(field=>String(field.acroField.getWidgets()[0].P())),widgetPages.map(i=>String(doc.getPage(i).ref)))
  const acro=form.acroForm.dict,fonts=acro.lookup(n('DR'),PDFDict).lookup(n('Font'),PDFDict)
  const da=incoming.acroField.dict.lookup(n('DA')).decodeText()
  const importedFont=n(da.match(/^\/([^ ]+) /)[1]);assert.notEqual(importedFont,n('Shared'))
  assert.equal(fonts.lookup(n('Shared'),PDFDict).lookup(n('BaseFont')),n('Helvetica'))
  assert.equal(fonts.lookup(importedFont,PDFDict).lookup(n('BaseFont')),n('Courier'))
  assert.deepEqual(acro.lookup(n('CO'),PDFArray).asArray().map(String),[existing.ref,incoming.ref].map(String))
  incoming.setText('Changed')
  const reopened=(await PDFDocument.load(await doc.save())).getForm()
  assert.deepEqual([reopened.getTextField('client.name').getText(),reopened.getTextField('client_2.name').getText()],['Destination','Changed'])
 }
})
test('insert and replace keep imported page links and resolve donor names before copying',async()=>{
 const target=await PDFDocument.load(await fixture(['Target 1','Target 2','Target 3']))
 const source=await PDFDocument.load(await fixture(['Imported A','Imported B']))
 const [first,second]=source.getPages()
 const key=PDFName.of
 const addLink=(page,destination)=>{
  page.node.addAnnot(source.context.register(source.context.obj({
   Type:'Annot',Subtype:'Link',Rect:[20,30,100,50],...destination,
  })))
 }
 addLink(first,{Dest:[second.ref,'Fit']})
 addLink(first,{A:{S:'GoTo',D:PDFString.of('chapter')}})
 addLink(first,{A:{S:'URI',URI:PDFString.of('https://example.org/source')}})
 addLink(second,{A:{S:'GoTo',D:[first.ref,'XYZ',25,30,null]}})
 addLink(second,{Dest:key('legacy')})
 const named=source.context.register(source.context.obj({Names:[PDFString.of('chapter'),{D:[second.ref,'FitH',250]}]}))
 source.catalog.set(key('Names'),source.context.obj({Dests:{Kids:[named]}}))
 source.catalog.set(key('Dests'),source.context.obj({legacy:[first.ref,'Fit']}))
 target.catalog.set(key('Names'),target.context.obj({Dests:{Names:[PDFString.of('chapter'),[target.getPage(0).ref,'Fit']]}}))
 const targetPage=target.getPage(0)
 targetPage.node.addAnnot(target.context.register(target.context.obj({
  Type:'Annot',Subtype:'Link',Rect:[20,30,100,50],Dest:[2,'Fit'],
 })))
 const frame=framePdfReplacePages(Buffer.from(await target.save()),Buffer.from(await source.save()))
 const job=createIsolatedPdfReplacePagesJob()
 for(const request of [insertCommand(0),command([2])]){
  const output=await PDFDocument.load((await job.execute(frame,request)).bytes)
  const [insertedA,insertedB]=output.getPages().slice(1,3)
  const annotations=page=>page.node.Annots().asArray().map(ref=>output.context.lookup(ref,PDFDict))
  const action=annotation=>annotation.lookup(key('A'),PDFDict)
  const destination=(dict,name)=>dict.lookup(key(name),PDFArray).asArray().map(String)
  const [direct,namedLink,external]=annotations(insertedA)
  const [back,legacy]=annotations(insertedB)
  assert.deepEqual(destination(direct,'Dest'),[String(insertedB.ref),'/Fit'])
  assert.deepEqual(destination(action(namedLink),'D'),[String(insertedB.ref),'/FitH','250'])
  assert.equal(action(external).lookup(key('URI'),PDFString).decodeText(),'https://example.org/source')
  assert.deepEqual(destination(action(back),'D'),[String(insertedA.ref),'/XYZ','25','30','null'])
  assert.deepEqual(destination(legacy,'Dest'),[String(insertedA.ref),'/Fit'])
  const remaining=output.catalog.lookup(key('Names'),PDFDict).lookup(key('Dests'),PDFDict).lookup(key('Names'),PDFArray)
  assert.equal(String(remaining.lookup(1,PDFArray).get(0)),String(output.getPage(0).ref))
  const last=output.getPage(output.getPageCount()-1)
  assert.deepEqual(destination(annotations(output.getPage(0))[0],'Dest'),[String(last.ref),'/Fit'])
 }
})
test('replacement keeps existing document jumps attached to the corresponding new pages',async()=>{
 const target=await PDFDocument.load(await fixture(['First','Remove A','Keep','Remove B','Remove C']))
 const [first,removeA,keep,removeB,removeC]=target.getPages()
 const key=PDFName.of
 const addLink=entry=>first.node.addAnnot(target.context.register(target.context.obj({
  Type:'Annot',Subtype:'Link',Rect:[20,30,100,50],...entry,
 })))
 addLink({Dest:[removeA.ref,'XYZ',35,250,null]})
 addLink({A:{S:'GoTo',D:[removeB.ref,'Fit']}})
 addLink({Dest:[2,'Fit']})
 addLink({A:{S:'GoTo',D:[removeC.ref,'Fit']}})
 addLink({Dest:PDFString.of('Chapter')})
 addLink({A:{S:'GoToR',F:PDFString.of('external.pdf'),D:[1,'Fit']}})
 const destTree=target.context.register(target.context.obj({
  Limits:[PDFString.of('Chapter'),PDFString.of('Unpaired')],
  Names:[PDFString.of('Chapter'),{D:[removeB.ref,'FitH',275]},PDFString.of('Unpaired'),[removeC.ref,'Fit']],
 }))
 target.catalog.set(key('Names'),target.context.obj({Dests:{Kids:[destTree]}}))
 target.catalog.set(key('Dests'),target.context.obj({legacy:[removeA.ref,'Fit']}))
 const root=target.context.register(target.context.obj({Type:'Outlines',Count:2}))
 const parent=target.context.register(target.context.obj({
  Title:PDFString.of('Existing outline'),Parent:root,Count:1,Dest:[removeA.ref,'Fit'],
 }))
 const child=target.context.register(target.context.obj({
  Title:PDFString.of('Nested outline'),Parent:parent,A:{S:'GoTo',D:[removeB.ref,'Fit']},
 }))
 target.context.lookup(root,PDFDict).set(key('First'),parent)
 target.context.lookup(parent,PDFDict).set(key('First'),child)
 target.catalog.set(key('Outlines'),root)
 target.catalog.set(key('OpenAction'),target.context.obj({S:'GoTo',D:[removeA.ref,'FitH',235]}))
 const source=await fixture(['Replacement A','Replacement B'])
 const result=await createIsolatedPdfReplacePagesJob().execute(
  framePdfReplacePages(Buffer.from(await target.save()),source),command([5,2,4]),
 )
 const output=await PDFDocument.load(result.bytes),[keptFirst,a,b,keptMiddle]=output.getPages()
 const [direct,action,coordinate,unpaired,named,remote]=keptFirst.node.Annots().asArray().map(ref=>output.context.lookup(ref,PDFDict))
 const values=(dict,field)=>dict.lookup(key(field),PDFArray).asArray().map(String)
 assert.deepEqual(values(direct,'Dest'),[String(a.ref),'/XYZ','35','250','null'])
 assert.deepEqual(values(action.lookup(key('A'),PDFDict),'D'),[String(b.ref),'/Fit'])
 assert.deepEqual(values(coordinate,'Dest'),[String(keptMiddle.ref),'/Fit'])
 assert.equal(String(keptMiddle.ref),String(keep.ref))
 assert.equal(unpaired.has(key('A')),false)
 assert.equal(named.lookup(key('Dest'),PDFString).decodeText(),'Chapter')
 assert.deepEqual(values(remote.lookup(key('A'),PDFDict),'D'),['1','/Fit'])
 const leaf=output.catalog.lookup(key('Names'),PDFDict).lookup(key('Dests'),PDFDict).lookup(key('Kids'),PDFArray).lookup(0,PDFDict)
 const names=leaf.lookup(key('Names'),PDFArray)
 assert.deepEqual(values(names.lookup(1,PDFDict),'D'),[String(b.ref),'/FitH','275'])
 assert.equal(names.size(),2)
 assert.deepEqual(leaf.lookup(key('Limits'),PDFArray).asArray().map(value=>value.decodeText()),['Chapter','Chapter'])
 assert.deepEqual(values(output.catalog.lookup(key('Dests'),PDFDict),'legacy'),[String(a.ref),'/Fit'])
 const outline=output.catalog.lookup(key('Outlines'),PDFDict).lookup(key('First'),PDFDict)
 assert.deepEqual(values(outline,'Dest'),[String(a.ref),'/Fit'])
 assert.deepEqual(values(outline.lookup(key('First'),PDFDict).lookup(key('A'),PDFDict),'D'),[String(b.ref),'/Fit'])
 assert.deepEqual(values(output.catalog.lookup(key('OpenAction'),PDFDict),'D'),[String(a.ref),'/FitH','235'])
})
test('target global stamps recompute page numbers while source managed stamps remain visible imported content',async()=>{
 const target=await stamp(await fixture(['Target 1','Target 2','Target 3']),{op:'set_header_footer',page_number:true}),source=await stamp(await fixture(['Imported A','Imported B']),{op:'set_watermark',text:'Source watermark'}),result=await createPdfReplacePagesJob().execute(framePdfReplacePages(target,source),command([2]))
 const contents=await text(result.bytes);assert.match(contents,/Source watermark/);assert.match(contents,/4 \/ 4/)
 const removed=await stamp(result.bytes,{op:'set_header_footer'});assert.doesNotMatch(await text(removed),/1 \/ 4/);assert.equal((await text(removed)).match(/Source watermark/g).length,2);assert.match(await text(removed),/Target 1.*Imported A.*Imported B.*Target 3/)
})
test('page import preserves a target form when page-number stamps are rebuilt',async()=>{
 const target=await PDFDocument.load(await fixture(['Target 1','Target 2']))
 const field=target.getForm().createTextField('customer')
 field.addToPage(target.getPage(0),{x:32,y:75,width:90,height:20});field.setText('Ada')
 const stamped=await createPdfStampsJob({allowAcroForm:true}).execute(Buffer.from(await target.save()),JSON.stringify({
  version:1,action:'stamps',operation:{op:'set_header_footer',page_number:true},
 }))
 const framing=framePdfReplacePages(stamped.bytes,await fixture(['Imported']))
 const result=await createPdfReplacePagesJob().execute(framing,insertCommand(-1))
 const output=await PDFDocument.load(result.bytes),customer=output.getForm().getTextField('customer')
 assert.equal(customer.getText(),'Ada')
 assert.deepEqual(customer.acroField.getWidgets().map(widget=>String(widget.P())),[String(output.getPage(1).ref)])
 assert.match(await text(result.bytes),/3 \/ 3/)
})
test('replace refuses invalid pages, malformed frames, protected PDFs, oversized page result and cancellation',async()=>{
 const target=await fixture(['Target']),source=await fixture(['Source']),job=createPdfReplacePagesJob(),frame=framePdfReplacePages(target,source)
 for(const pages of [[],[0],[2],[1.5]])await assert.rejects(job.execute(frame,command(pages)),{code:'INVALID_PDF_REPLACE_PAGES'})
 await assert.rejects(job.execute(Buffer.from([0,0,0,250,1,2]),command([1])),{code:'INPUT_LIMIT'})
 const signed=await PDFDocument.load(source);signed.context.register(signed.context.obj({Type:'Sig',ByteRange:[0,1,2,3]}));await assert.rejects(job.execute(framePdfReplacePages(target,Buffer.from(await signed.save())),command([1])),{code:'SIGNATURE_EDIT_REFUSED'})
 await assert.rejects(job.execute(framePdfReplacePages(Buffer.from(await signed.save()),source),insertCommand(-1)),{code:'SIGNATURE_EDIT_REFUSED'})
 const form=await PDFDocument.load(source);form.getForm().createTextField('customer')
 const formBytes=Buffer.from(await form.save())
 form.getForm().getTextField('customer').acroField.dict.set(PDFName.of('AA'),form.context.obj({F:{S:'JavaScript',JS:PDFString.of('event.value = this.getField("customer").value')}}))
 const scripted=Buffer.from(await form.save())
 await assert.rejects(job.execute(framePdfReplacePages(formBytes,scripted),insertCommand(-1)),{code:'PDF_EDIT_UNSUPPORTED_STRUCTURE'})
 form.getForm().acroForm.dict.set(PDFName.of('XFA'),form.context.register(form.context.flateStream('<xdp/>')))
 const xfa=Buffer.from(await form.save({updateFieldAppearances:false}))
 await assert.rejects(job.execute(framePdfReplacePages(xfa,source),command([1])),{code:'PDF_EDIT_UNSUPPORTED_STRUCTURE'})
 await assert.rejects(job.execute(framePdfReplacePages(target,xfa),insertCommand(-1)),{code:'PDF_EDIT_UNSUPPORTED_STRUCTURE'})
 const many=await fixture(Array.from({length:100},(_,i)=>'P'+i));const atLimit=await job.execute(framePdfReplacePages(many,source),command([1]));assert.equal((await PDFDocument.load(atLimit.bytes)).getPageCount(),100)
 const two=await fixture(['A','B']);await assert.rejects(job.execute(framePdfReplacePages(many,two),command([1])),{code:'PDF_EDIT_LIMIT'})
 const controller=new AbortController(),pending=createIsolatedPdfReplacePagesJob().execute(frame,command([1]),controller.signal);controller.abort();await assert.rejects(pending,{code:'ABORTED'})
})

test('isolated binary frame accepts source PDFs above raw-request limits without base64 expansion',async()=>{
 const target=await fixture(['Target']),d=await PDFDocument.load(await fixture(['Large source']));d.context.register(d.context.stream(randomBytes(1100000)));const source=Buffer.from(await d.save({useObjectStreams:false}));assert.ok(source.length>1024*1024)
 const result=await createIsolatedPdfReplacePagesJob().execute(framePdfReplacePages(target,source),command([1]));assert.equal(result.sourceSha256,hash(source));assert.equal(await text(result.bytes),'Large source')
})
