import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {PDFDocument,StandardFonts,PDFName} from 'pdf-lib'
import {createPdfService} from '../../server/src/modules/pdf/service.ts'
import {createPdfAnnotationJob} from '../../server/src/pdf/annotation-job.mjs'

const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
async function fixture(annotated=false){
 const doc=await PDFDocument.create(),page=doc.addPage([300,200]),font=await doc.embedFont(StandardFonts.Helvetica)
 page.drawText('Original report',{x:20,y:100,size:12,font})
 let bytes=Buffer.from(await doc.save())
 if(annotated)bytes=(await createPdfAnnotationJob().execute(bytes,JSON.stringify({version:1,action:'annotateText',operations:[{page:1,text:'Original',type:'note',contents:'Please verify.'}]}))).bytes
 const fileId=randomUUID(),baseRevision=randomUUID(),editorId=randomUUID(),calls=[]
 const reopened=await PDFDocument.load(bytes),annotationId=reopened.getPage(0).node.Annots()?.get(0)?.objectNumber+'R'
 const files={
  async openFile(token,id){assert.equal(token,'session');assert.equal(id,fileId);return {format:'pdf',file:{revision:baseRevision,sha256:digest(bytes)}}},
  async download(){return {format:'pdf',bytes}},
  async receiveUpload(token,id,output){calls.push(['upload',Buffer.from(output)])},
  async cancelUpload(){calls.push(['cancel'])},
 }
 let leaseActive=true
 const leases={async getLease(){return {active:leaseActive,heldByCurrentSession:true,editorId,leaseEpoch:1}}}
 const revisions={
  async stageUpload(_token,id,input){calls.push(['stage',id,input]);return {uploadId:'upload'}},
  async commitRevision(token,input){calls.push(['commit',token,input]);return {fileId,revision:'new-revision'}},
 }
 return {service:createPdfService({files,leases,revisions}),input:{baseRevision,editorId,leaseEpoch:1,idempotencyKey:'edit-text-test',operations:[{page:1,oldText:'Original',newText:'Updated'}]},fileId,calls,annotationId,revoke(){leaseActive=false}}
}

test('PDF text service stages edited bytes and commits with the original lease and revision',async()=>{
 const f=await fixture(),saved=await f.service.editTextAndCommit('session',f.fileId,f.input)
 assert.equal(saved.revision,'new-revision')
 assert.deepEqual(f.calls.map(call=>call[0]),['stage','upload','commit'])
 assert.deepEqual(f.calls[2][2],{fileId:f.fileId,uploadId:'upload',baseRevision:f.input.baseRevision,leaseEpoch:1,idempotencyKey:'edit-text-test'})
 const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs')
 const task=getDocument({data:Uint8Array.from(f.calls[1][1]),disableFontFace:true,useSystemFonts:true})
 try{
  const text=(await (await (await task.promise).getPage(1)).getTextContent()).items.map(item=>item.str??'').join('')
  assert.equal(text,'Updated report')
 }finally{await task.destroy()}
})
test('PDF text staging preserves the exact commit input without committing',async()=>{
 const f=await fixture(),prepared=await f.service.stageTextEdit('session',f.fileId,f.input)
 assert.deepEqual(f.calls.map(call=>call[0]),['stage','upload'])
 assert.deepEqual(prepared.commitInput,{fileId:f.fileId,uploadId:'upload',baseRevision:f.input.baseRevision,leaseEpoch:1,idempotencyKey:'edit-text-test'})
 assert.equal(prepared.sha256,digest(f.calls[1][1]));assert.equal(prepared.size,f.calls[1][1].length)
})
test('PDF annotation staging returns a replayable commit without publishing it',async()=>{
 const f=await fixture(),prepared=await f.service.stageAnnotate('session',f.fileId,{...f.input,operations:[{page:1,text:'Original',type:'note',contents:'Please verify.'}]})
 assert.deepEqual(f.calls.map(call=>call[0]),['stage','upload'])
 assert.deepEqual(prepared.commitInput,{fileId:f.fileId,uploadId:'upload',baseRevision:f.input.baseRevision,leaseEpoch:1,idempotencyKey:'edit-text-test'})
})
test('PDF mutation cancellation after preparation never begins the commit',async()=>{
 for(const [stage,commit]of [['stageTextEdit','editTextAndCommit'],['stageAnnotate','annotateAndCommit'],['stageDeleteAnnotations','deleteAnnotationsAndCommit'],['stageUpdateNotes','updateNotesAndCommit'],['stagePageOps','pageOpsAndCommit']]){
  const f=await fixture(),controller=new AbortController()
  f.service[stage]=async()=>{controller.abort();return {commitInput:{}}}
  await assert.rejects(f.service[commit]('session',f.fileId,f.input,controller.signal),{name:'AbortError'})
  assert.deepEqual(f.calls,[])
 }
})

test('PDF text service refuses a lost lease and unmatched original without staging bytes',async()=>{
 const f=await fixture();f.revoke()
 await assert.rejects(f.service.editTextAndCommit('session',f.fileId,f.input),error=>error.statusCode===409)
 assert.deepEqual(f.calls,[])
 const unmatched=await fixture()
 await assert.rejects(unmatched.service.editTextAndCommit('session',unmatched.fileId,{...unmatched.input,operations:[{page:1,oldText:'Missing',newText:'New'}]}),error=>error.statusCode===400)
 assert.deepEqual(unmatched.calls,[])
})

test('PDF annotation service commits a standard sticky note in a new revision',async()=>{
 const f=await fixture()
 const result=await f.service.annotateAndCommit('session',f.fileId,{...f.input,operations:[{page:1,text:'Original',type:'note',contents:'Please verify.'}]})
 assert.equal(result.revision,'new-revision')
 assert.deepEqual(f.calls.map(call=>call[0]),['stage','upload','commit'])
 const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs')
 const task=getDocument({data:Uint8Array.from(f.calls[1][1]),disableFontFace:true,useSystemFonts:true})
 try{
  const annotations=await (await (await task.promise).getPage(1)).getAnnotations()
  assert.equal(annotations[0].contentsObj.str,'Please verify.')
  assert.equal(annotations[0].titleObj.str,'AI Assistant')
 }finally{await task.destroy()}
})

test('PDF annotation deletion stages exact-ID removal with a revision-bound replayable commit',async()=>{
 const f=await fixture(true),input={...f.input,operations:[{page:1,annotationId:f.annotationId}]}
 const prepared=await f.service.stageDeleteAnnotations('session',f.fileId,input)
 assert.deepEqual(f.calls.map(call=>call[0]),['stage','upload'])
 assert.deepEqual(prepared.commitInput,{fileId:f.fileId,uploadId:'upload',baseRevision:f.input.baseRevision,leaseEpoch:1,idempotencyKey:'edit-text-test'})
 const reopened=await PDFDocument.load(f.calls[1][1])
 assert.equal(reopened.getPage(0).node.Annots()?.size()??0,0)
 for(const [,object]of reopened.context.enumerateIndirectObjects())if(object?.get)assert.notEqual(object.get(PDFName.of('Contents'))?.decodeText?.(),'Please verify.')
 const g=await fixture(true)
 assert.equal((await g.service.deleteAnnotationsAndCommit('session',g.fileId,{...g.input,operations:[{page:1,annotationId:g.annotationId}]})).revision,'new-revision')
 assert.deepEqual(g.calls.map(call=>call[0]),['stage','upload','commit'])
})

test('PDF annotation deletion refuses lost leases and missing IDs without staging output',async()=>{
 const f=await fixture(true);f.revoke()
 await assert.rejects(f.service.stageDeleteAnnotations('session',f.fileId,{...f.input,operations:[{page:1,annotationId:f.annotationId}]}),error=>error.statusCode===409)
 assert.deepEqual(f.calls,[])
 const g=await fixture(true)
 await assert.rejects(g.service.stageDeleteAnnotations('session',g.fileId,{...g.input,operations:[{page:1,annotationId:'999999R'}]}),error=>error.statusCode===400&&error.detail==='PDF_ANNOTATION_NOT_FOUND')
 assert.deepEqual(g.calls,[])
})


test('PDF note update stages exact revision-bound replies and preserves the root through commit',async()=>{
 const f=await fixture(true),input={...f.input,operations:[{page:1,annotationId:f.annotationId,action:'reply',text:'已处理'}]}
 const prepared=await f.service.stageUpdateNotes('session',f.fileId,input)
 assert.deepEqual(f.calls.map(call=>call[0]),['stage','upload'])
 assert.deepEqual(prepared.commitInput,{fileId:f.fileId,uploadId:'upload',baseRevision:f.input.baseRevision,leaseEpoch:1,idempotencyKey:'edit-text-test'})
 assert.equal(prepared.sha256,digest(f.calls[1][1]));assert.equal(prepared.size,f.calls[1][1].length)
 const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs')
 const task=getDocument({data:Uint8Array.from(f.calls[1][1]),disableFontFace:true,useSystemFonts:true})
 try{
  const annotations=await (await (await task.promise).getPage(1)).getAnnotations()
  assert.equal(annotations.length,2);assert.equal(annotations[0].contentsObj.str,'Please verify.')
  assert.equal(annotations[1].contentsObj.str,'已处理');assert.equal(annotations[1].inReplyTo,f.annotationId);assert.equal(annotations[1].titleObj.str,'AI Assistant')
 }finally{await task.destroy()}
 const edit=await fixture(true)
 const result=await edit.service.updateNotesAndCommit('session',edit.fileId,{...edit.input,operations:[{page:1,annotationId:edit.annotationId,action:'edit',text:'Updated note'}]})
 assert.equal(result.revision,'new-revision');assert.deepEqual(edit.calls.map(call=>call[0]),['stage','upload','commit'])
})

test('PDF note updates reject stale revision, lease and annotation identities before staging',async()=>{
 for(const mode of ['revision','lease','id','page','schema']){
  const f=await fixture(true),input={...f.input,operations:[{page:1,annotationId:f.annotationId,action:'edit',text:'Updated'}]}
  if(mode==='revision')input.baseRevision=randomUUID()
  if(mode==='lease')f.revoke()
  if(mode==='id')input.operations[0].annotationId='999R'
  if(mode==='page')input.operations[0].page=2
  if(mode==='schema')input.operations[0].author='Imposter'
  await assert.rejects(f.service.stageUpdateNotes('session',f.fileId,input),error=>error.statusCode===(['revision','lease'].includes(mode)?409:400))
  assert.deepEqual(f.calls,[])
 }
})


test('PDF page operations stage replayable receipts without publishing, and commit through the same lease',async()=>{
 const f=await fixture(true),input={...f.input,operations:[{op:'rotatePages',pages:[1],dir:90},{op:'insertBlankPage',afterPage:1}]}
 const prepared=await f.service.stagePageOps('session',f.fileId,input)
 assert.deepEqual(f.calls.map(call=>call[0]),['stage','upload'])
 assert.deepEqual(prepared.commitInput,{fileId:f.fileId,uploadId:'upload',baseRevision:f.input.baseRevision,leaseEpoch:1,idempotencyKey:'edit-text-test'})
 assert.equal(prepared.sha256,digest(f.calls[1][1]));assert.equal(prepared.size,f.calls[1][1].length)
 const doc=await PDFDocument.load(f.calls[1][1]);assert.equal(doc.getPageCount(),2);assert.equal(doc.getPage(0).getRotation().angle,90);assert.equal(doc.getPage(1).getRotation().angle,90)
 assert.equal(doc.context.lookup(doc.getPage(0).node.Annots().get(0)).get(PDFName.of('Contents')).decodeText(),'Please verify.')
 const commit=await fixture(),result=await commit.service.pageOpsAndCommit('session',commit.fileId,{...commit.input,operations:[{op:'insertBlankPage',afterPage:0}]})
 assert.equal(result.revision,'new-revision');assert.deepEqual(commit.calls.map(call=>call[0]),['stage','upload','commit'])
})

test('PDF page operations reject wrong revision, lost lease and source layout before staging',async()=>{
 for(const mode of ['revision','lease','deleteAll','missingPage','schema']){
  const f=await fixture(),input={...f.input,operations:[{op:'rotatePages',pages:[1],dir:90}]}
  if(mode==='revision')input.baseRevision=randomUUID()
  if(mode==='lease')f.revoke()
  if(mode==='deleteAll')input.operations=[{op:'deletePage',page:1}]
  if(mode==='missingPage')input.operations=[{op:'rotatePages',pages:[2],dir:90}]
  if(mode==='schema')input.operations=[{op:'deletePage',page:1,path:'/tmp/a'}]
  await assert.rejects(f.service.stagePageOps('session',f.fileId,input),error=>error.statusCode===(['revision','lease'].includes(mode)?409:400))
  assert.deepEqual(f.calls,[])
 }
})


test('PDF page geometry stages rotated-size and CropBox bytes while retaining revision fencing',async()=>{
 for(const operation of [{op:'setPageSize',width:600,height:800},{op:'cropPages',pages:[1],left:0.1,top:0.2,right:0.9,bottom:0.8}]){
  const f=await fixture(true),input={...f.input,operations:[operation]}
  const prepared=await f.service.stagePageOps('session',f.fileId,input)
  assert.deepEqual(f.calls.map(call=>call[0]),['stage','upload'])
  assert.equal(prepared.commitInput.baseRevision,f.input.baseRevision);assert.equal(prepared.sha256,digest(f.calls[1][1]))
  const doc=await PDFDocument.load(f.calls[1][1]),page=doc.getPage(0)
  if(operation.op==='setPageSize'){assert.equal(page.getWidth(),600);assert.equal(page.getHeight(),800)}
  else{assert.deepEqual(page.getMediaBox(),{x:0,y:0,width:300,height:200});assert.equal(page.getCropBox().width,240);assert.ok(Math.abs(page.getCropBox().height-120)<1e-7)}
  assert.equal(doc.context.lookup(page.node.Annots().get(0)).get(PDFName.of('Contents')).decodeText(),'Please verify.')
 }
})

test('PDF cross-file replace stages binary output and returns the original commit receipt without publishing',async()=>{
 const f=await fixture(),sourceDoc=await PDFDocument.create();sourceDoc.addPage([400,300]).drawText('Imported source')
 const source=Buffer.from(await sourceDoc.save()),input={baseRevision:f.input.baseRevision,editorId:f.input.editorId,leaseEpoch:1,idempotencyKey:'replace-pages-test',pages:[1,1]},prepared=await f.service.stageReplacePages('session',f.fileId,input,source)
 assert.deepEqual(f.calls.map(call=>call[0]),['stage','upload']);assert.deepEqual(prepared.commitInput,{fileId:f.fileId,uploadId:'upload',baseRevision:input.baseRevision,leaseEpoch:1,idempotencyKey:'replace-pages-test'});assert.equal(prepared.sha256,digest(f.calls[1][1]))
 const {readPdfLeafObjects}=await import('../../../pdf/src/main/text-edit.ts');assert.equal((await readPdfLeafObjects(f.calls[1][1])).filter(item=>item.type===1).map(item=>item.text).join(''),'Imported source')
 for(const mode of ['lease','revision','source','pages','abort']){
  const rejected=await fixture(),controller=new AbortController();if(mode==='lease')rejected.revoke();if(mode==='abort')controller.abort()
  const value={...input,baseRevision:mode==='revision'?randomUUID():rejected.input.baseRevision,editorId:rejected.input.editorId,pages:mode==='pages'?[2]:[1]}
  await assert.rejects(rejected.service.stageReplacePages('session',rejected.fileId,value,mode==='source'?Buffer.from('not pdf'):source,controller.signal));assert.deepEqual(rejected.calls,[])
 }
})

test('redaction query is revision-bound and copy stages a new file without publishing the source revision',async()=>{
 const doc=await PDFDocument.create();doc.addPage([500,600]).drawText('Keep a@example.com and a@example.com tail',{x:30,y:200,size:12});const bytes=Buffer.from(await doc.save()),fileId=randomUUID(),revision=randomUUID(),editorId=randomUUID(),newId=randomUUID(),calls=[];let active=true
 const files={async openFile(){return {format:'pdf',file:{revision,sha256:digest(bytes)}}},async download(){return {format:'pdf',bytes,name:'Original.pdf'}},async stageUpload(_token,input){calls.push(['new-upload',input]);return {fileId:newId,uploadId:'redact-upload'}},async receiveUpload(_token,_id,output){calls.push(['bytes',output])},async cancelUpload(){calls.push(['cancel'])}}
 const leases={async getLease(){return {active,heldByCurrentSession:true,editorId,leaseEpoch:1}}},revisions={async stageUpload(){throw Error('source revision must not change')},async commitRevision(){throw Error('must not publish')}}
 const service=createPdfService({files,leases,revisions}),report=await service.queryRedactions('session',fileId,{revision,patterns:['email']});assert.equal(report.candidates.length,2);assert.deepEqual(calls,[])
 const input={baseRevision:revision,editorId,leaseEpoch:1,patterns:['email'],ids:[report.candidates[0].id]},result=await service.stageRedactedCopy('session',fileId,input)
 assert.equal(result.fileId,newId);assert.equal(result.uploadId,'redact-upload');assert.deepEqual(calls.map(call=>call[0]),['new-upload','bytes']);assert.match(calls[0][1].name,/涂黑副本.pdf$/);assert.equal(result.sha256,digest(calls[1][1]))
 const {readPdfLeafObjects}=await import('../../../pdf/src/main/text-edit.ts'),contents=(await readPdfLeafObjects(calls[1][1])).map(item=>item.text??'').join('');assert.equal(contents.match(/a@example.com/g).length,1)
 calls.length=0;active=false;await assert.rejects(service.stageRedactedCopy('session',fileId,input),error=>error.statusCode===409);assert.deepEqual(calls,[])
 await assert.rejects(service.queryRedactions('session',fileId,{revision:randomUUID(),patterns:['email']}),error=>error.statusCode===409)
})
