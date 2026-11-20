import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {PDFDocument,PDFDict,PDFName} from 'pdf-lib'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {createPdfService} from '../../server/src/modules/pdf/service.ts'
import {createEmptyPdfPendingSnapshot,planPdfPendingOps} from '../../src/editors/pdf-pending-ops.ts'
import {readPdfLeafObjects} from '../../../pdf/src/main/text-edit.ts'
import {createPdfPendingSession} from '../../src/editors/pdf-pending-session.ts'
import {createPdfAnnotationDrafts} from '../../src/editors/pdf-annotation-drafts.ts'
import {createPdfTextDrafts} from '../../src/editors/pdf-text-drafts.ts'
import {queryPdfPendingPreview} from '../../src/editors/pdf-pending-preview.ts'
import {createPdfImageDrafts} from '../../src/editors/pdf-image-drafts.ts'
import {PNG} from 'pngjs'

test('PDF mixed snapshot stages once and commits one revision with original history and field appearances preserved',async t=>{
 const f=await fileFixture(t,{buildApp:false}),doc=await PDFDocument.create(),pages=Array.from({length:3},(_,i)=>{const page=doc.addPage([500,650]);page.drawText('Original page '+(i+1),{x:30,y:610,size:14});return page}),form=doc.getForm()
 for(const name of ['Name','Locked']){const field=form.createTextField(name);field.setText(name==='Name'?'Before':'Keep');field.addToPage(pages[0],{x:30,y:name==='Name'?30:70,width:160,height:24});if(name==='Locked')field.enableReadOnly()}
 const radio=form.createRadioGroup('Decision');radio.addOptionToPage('Keep',pages[0],{x:250,y:30,width:18,height:18});radio.addOptionToPage('Drop',pages[2],{x:250,y:30,width:18,height:18});radio.select('Keep')
 const original=Buffer.from(await doc.save()),source=(await importFile(f,f.alice.token,original,'mixed.pdf')).file
 const revisionCount=()=>f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async connection=>Number((await connection.query('SELECT count(*) AS count FROM file_revisions WHERE file_id=$1',[source.fileId])).rows[0].count))
 assert.equal(await revisionCount(),1)
 const originalDoc=await PDFDocument.load(original),n=PDFName.of,appearance=pdf=>pdf.getForm().getTextField('Locked').acroField.getWidgets()[0].dict.lookup(n('AP'),PDFDict).lookup(n('N')).getContents()
 const oldAppearance=Buffer.from(appearance(originalDoc))
 const leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files}),pdf=createPdfService({files:f.files,leases,revisions}),editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,source.fileId,{editorId})
 const context={fileId:source.fileId,baseRevision:source.revision,generation:0,pageGeometries:pages.map(()=>({pw:500,ph:650,rot:0})),savedFields:[{name:'Name',kind:'text',pageIndex:0},{name:'Locked',kind:'text',pageIndex:0,readOnly:true},{name:'Decision',kind:'radio',pageIndex:0,options:['Keep','Drop']}]}
 const initial={...createEmptyPdfPendingSnapshot(context),markups:['Pkeep','Premove'].map(id=>({id,pageIndex:0,type:'highlight',color:[1,1,0],quads:[[30,620,130,620,30,600,130,600]]})),notes:[{id:'Pnote',input:{kind:'note',pageIndex:1,at:[50,500],color:[1,1,0],contents:'Before'}}],textInserts:['Tkeep','Tremove'].map(id=>({id,input:{pageIndex:0,origin:[30,id==='Tkeep'?500:450],text:id==='Tkeep'?'Surviving draft':'Removed draft',fontSize:12,color:[0,0,0]}}))}
 const planned=planPdfPendingOps(initial,[{op:'removeMarkup',id:'Premove'},{op:'setNoteContents',id:'Pnote',contents:'Updated note'},{op:'removeTextInsert',id:'Tremove'},{op:'setFormValue',value:{name:'Name',value:'First'}},{op:'setFormValue',value:{name:'Name',value:'张三'}},{op:'addFormField',field:{name:'Status',kind:'choice',page:2,x:40,y:100,width:180,height:24,options:['待审','完成'],value:'完成'}},{op:'rotatePages',pages:[1],dir:90},{op:'deletePage',page:3},{op:'setPageOrder',order:[2,1]},{op:'setMetadata',metadata:{title:'Mixed report',author:'Office'}}],context)
 assert.deepEqual(planned.failures,[])
 const input={baseRevision:source.revision,editorId,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID(),snapshot:planned.next}
 await assert.rejects(pdf.stageApplyOps(f.bob.token,source.fileId,input),e=>e.statusCode===404)
 await assert.rejects(pdf.stageApplyOps(f.alice.token,source.fileId,{...input,leaseEpoch:lease.leaseEpoch+1}),e=>e.statusCode===409)
 for(const snapshot of [{...input.snapshot,fileId:randomUUID()},{...input.snapshot,baseRevision:randomUUID()},{...input.snapshot,formEdits:{Locked:{name:'Locked',kind:'text',value:'Overwrite'}}},{...input.snapshot,path:'/tmp/not-authorized'}])await assert.rejects(pdf.stageApplyOps(f.alice.token,source.fileId,{...input,snapshot}),e=>e.statusCode===400)
 const staged=await pdf.stageApplyOps(f.alice.token,source.fileId,input)
 assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,source.revision)
 assert.equal(await revisionCount(),1)
 const saved=await revisions.commitRevision(f.alice.token,staged.commitInput);assert.deepEqual(await revisions.commitRevision(f.alice.token,staged.commitInput),saved)
 assert.equal(await revisionCount(),2)
 const bytes=await f.files.readFile(f.alice.token,source.fileId,saved.revision),out=await PDFDocument.load(bytes),fields=out.getForm()
 assert.equal(out.getPageCount(),2);assert.equal(out.getTitle(),'Mixed report');assert.equal(out.getAuthor(),'Office')
 assert.equal(out.getPage(0).getRotation().angle,0);assert.equal(out.getPage(1).getRotation().angle,90)
 assert.equal(fields.getTextField('Name').getText(),'张三');assert.equal(fields.getTextField('Locked').getText(),'Keep');assert.deepEqual(Buffer.from(appearance(out)),oldAppearance)
 assert.deepEqual(fields.getDropdown('Status').getSelected(),['完成']);assert.equal(fields.getRadioGroup('Decision').acroField.getWidgets().length,1);assert.equal(fields.getRadioGroup('Decision').getSelected(),'Keep')
 const notes=out.getPages().flatMap(page=>(page.node.Annots()?.asArray()??[]).map(ref=>out.context.lookup(ref)).filter(dict=>String(dict.get(n('Subtype')))==='/Text'))
 assert.ok(notes.some(dict=>dict.lookup(n('Contents')).decodeText()==='Updated note'))
 const text=(await readPdfLeafObjects(bytes)).filter(object=>object.type===1).map(object=>object.text).join('|')
 assert.match(text,/Original page 1/);assert.match(text,/Original page 2/);assert.match(text,/Surviving draft/);assert.doesNotMatch(text,/Original page 3|Removed draft/)
 assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),original)
})


test('PDF annotation geometry query authorizes the exact revision without taking a lease or saving a version',async t=>{
 const f=await fileFixture(t,{buildApp:false}),doc=await PDFDocument.create()
 doc.addPage([300,200]).drawText('Original report',{x:20,y:100,size:12})
 const bytes=Buffer.from(await doc.save()),source=(await importFile(f,f.alice.token,bytes,'query.pdf')).file
 const pdf=createPdfService({files:f.files,leases:{},revisions:{}}),input={revision:source.revision,operations:[{page:1,text:'Original',type:'highlight'},{page:1,text:'report',type:'note',contents:'Review'}]}
 await assert.rejects(pdf.queryAnnotations(f.bob.token,source.fileId,input),e=>e.statusCode===404)
 await assert.rejects(pdf.queryAnnotations(f.alice.token,source.fileId,{...input,revision:randomUUID()}),e=>e.statusCode===409)
 const planned=await pdf.queryAnnotations(f.alice.token,source.fileId,input)
 assert.equal(planned.revision,source.revision);assert.equal(planned.markups.length,1);assert.equal(planned.notes.length,1)
 assert.equal(planned.markups[0].quads[0][0],20);assert.equal(planned.notes[0].contents,'Review')
 const count=await f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async connection=>Number((await connection.query('SELECT count(*) AS count FROM file_revisions WHERE file_id=$1',[source.fileId])).rows[0].count))
 assert.equal(count,1);assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,source.revision)
 assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),bytes)
 const session=createPdfPendingSession({getContext:()=>({fileId:source.fileId,baseRevision:source.revision,pageGeometries:[{pw:300,ph:200,rot:0}],savedFields:[]}),onChange(){}})
 const drafts=createPdfAnnotationDrafts({session,isReady:()=>true,request:async(url,method,payload,signal)=>{
  assert.equal(url,`/api/v1/files/${source.fileId}/pdf/annotations/query`);assert.equal(method,'POST')
  return pdf.queryAnnotations(f.alice.token,source.fileId,payload,signal)
 }})
 const added=await drafts.append(input.operations)
 assert.equal(session.read().markups.length,1);assert.equal(session.read().notes.length,1)
 const textDrafts=createPdfTextDrafts({fileId:source.fileId,session,getRevision:()=>source.revision,isReady:()=>true,onChange(){},request:async(url,method,payload,signal)=>{
  assert.equal(url,`/api/v1/files/${source.fileId}/pdf/text-inserts/query`);assert.equal(method,'POST')
  return pdf.queryTextInserts(f.alice.token,source.fileId,payload,signal)
 }})
 const text=await textDrafts.insert({page:1,text:'Pending text',x:20,y:150,font_size:12})
 assert.equal(session.read().textInserts[0].id,text.id)
 const imageDrafts=createPdfImageDrafts({fileId:source.fileId,session,getRevision:()=>source.revision,isReady:()=>true,onChange(){},request:async(url,method,payload,signal)=>{
  assert.equal(url,`/api/v1/files/${source.fileId}/pdf/image-inserts/query`);assert.equal(method,'POST')
  return pdf.queryImageInserts(f.alice.token,source.fileId,payload,signal)
 }})
 const png=new PNG({width:2,height:2});for(let i=0;i<png.data.length;i+=4){png.data[i]=255;png.data[i+3]=255}
 const image=await imageDrafts.insert({op:'insert_image',page:1,x:200,y:50,width:20,height:20,image:{mime:'image/png',base64:PNG.sync.write(png).toString('base64')}})
 assert.equal(session.read().imageEdits[0].id,image.id)
 const applied=session.apply([{op:'removeMarkup',id:added.markups[0].id},{op:'setNoteContents',id:added.notes[0].id,contents:'Updated pending note'},{op:'rotatePages',pages:[1],dir:90},{op:'setMetadata',metadata:{title:'Pending query save'}}])
 assert.deepEqual(applied.failures,[]);session.undo();assert.equal(session.read().markups.length,1);assert.equal(session.read().notes[0].input.contents,'Review')
 session.redo();assert.equal(session.read().markups.length,0)
 const preview=await queryPdfPendingPreview(async(url,method,payload,signal)=>{
  assert.equal(url,`/api/v1/files/${source.fileId}/pdf/apply-ops/query`);assert.equal(method,'POST')
  return pdf.queryApplyOps(f.alice.token,source.fileId,payload,signal)
 },session.read())
 const pending=await PDFDocument.load(preview.bytes)
 assert.equal(pending.getTitle(),'Pending query save');assert.equal(pending.getPage(0).getRotation().angle,90)
 assert.equal(preview.generation,session.read().generation)
 assert.match((await readPdfLeafObjects(preview.bytes)).filter(item=>item.type===1).map(item=>item.text).join('|'),/Pending text/)
 assert.equal((await readPdfLeafObjects(preview.bytes)).filter(item=>item.type===3).length,1)
 assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,source.revision)
 const leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files}),writer=createPdfService({files:f.files,leases,revisions}),editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,source.fileId,{editorId})
 const staged=await writer.stageApplyOps(f.alice.token,source.fileId,{baseRevision:source.revision,editorId,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID(),snapshot:session.read()})
 const saved=await revisions.commitRevision(f.alice.token,staged.commitInput),out=await PDFDocument.load(await f.files.readFile(f.alice.token,source.fileId,saved.revision))
 assert.equal(out.getTitle(),'Pending query save');assert.equal(out.getPage(0).getRotation().angle,90)
 assert.match((await readPdfLeafObjects(await f.files.readFile(f.alice.token,source.fileId,saved.revision))).filter(item=>item.type===1).map(item=>item.text).join('|'),/Pending text/)
 const annotations=out.getPage(0).node.Annots().asArray().map(ref=>out.context.lookup(ref))
 assert.equal(annotations.length,1);assert.equal(String(annotations[0].get(PDFName.of('Subtype'))),'/Text');assert.equal(annotations[0].lookup(PDFName.of('Contents')).decodeText(),'Updated pending note')
 assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),bytes)
 drafts.dispose();session.dispose()
})
