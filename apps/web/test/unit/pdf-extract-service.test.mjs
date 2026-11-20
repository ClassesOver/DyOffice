import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {PDFDocument} from 'pdf-lib'
import {createPdfService} from '../../server/src/modules/pdf/service.ts'
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
async function fixture(){
 const doc=await PDFDocument.create();for(const text of ['One','Two'])doc.addPage([300,200]).drawText(text,{x:20,y:100})
 const bytes=Buffer.from(await doc.save()),fileId=randomUUID(),baseRevision=randomUUID(),editorId=randomUUID(),targetId=randomUUID(),calls=[]
 const state={revision:baseRevision,lease:true,afterStage:null,afterReceive:null,stageError:null,receiveError:null,afterDownload:null}
 const files={
  async openFile(){return {format:'pdf',file:{revision:state.revision,sha256:hash(bytes)}}},
  async download(){state.afterDownload?.();return {format:'pdf',name:'Source.pdf',bytes}},
  async stageUpload(token,input){assert.equal(token,'session');calls.push(['stage',input]);if(state.stageError)throw state.stageError;state.afterStage?.();return {uploadId:'upload',fileId:targetId,expiresAt:'later'}},
  async receiveUpload(token,id,output){assert.equal(id,'upload');calls.push(['receive',Buffer.from(output)]);if(state.receiveError)throw state.receiveError;state.afterReceive?.()},
  async cancelUpload(_token,id){calls.push(['cancel',id])},
 }
 const leases={async getLease(){return {active:state.lease,heldByCurrentSession:true,editorId,leaseEpoch:1}}}
 const revisions={async stageUpload(){throw Error('must not stage a source revision')},async commitRevision(){throw Error('must not commit the source')}}
 return {service:createPdfService({files,leases,revisions}),fileId,targetId,input:{baseRevision,editorId,leaseEpoch:1,pages:[2,1]},calls,state}
}

test('PDF extraction prepares a distinct import receipt and never commits or revises its source',async()=>{
 const f=await fixture(),result=await f.service.stageExtractPages('session',f.fileId,f.input)
 assert.deepEqual(f.calls.map(call=>call[0]),['stage','receive'])
 assert.equal(result.fileId,f.targetId);assert.notEqual(result.fileId,f.fileId);assert.equal(result.uploadId,'upload')
 assert.equal(result.sha256,hash(f.calls[1][1]));assert.equal(result.size,f.calls[1][1].length)
 assert.deepEqual(f.calls[0][1],{name:'Source-pages.pdf',size:result.size})
 assert.equal((await PDFDocument.load(f.calls[1][1])).getPageCount(),2)
})

test('PDF extraction rejects stale versions, lost leases and invalid names without staging',async()=>{
 for(const mode of ['revision','lease','pages','name']){
  const f=await fixture()
  if(mode==='revision')f.state.revision=randomUUID()
  if(mode==='lease')f.state.lease=false
  if(mode==='pages')f.input.pages=[3]
  if(mode==='name')f.input.name='Wrong.docx'
  await assert.rejects(f.service.stageExtractPages('session',f.fileId,f.input),error=>error.statusCode===(['revision','lease'].includes(mode)?409:400))
  assert.deepEqual(f.calls,[])
 }
})

test('PDF extraction cancels prepared imports after cancellation or source authority changes',async()=>{
 for(const mode of ['abort-stage','abort-receive','lease','revision']){
  const f=await fixture(),controller=new AbortController()
  if(mode==='abort-stage')f.state.afterStage=()=>controller.abort()
  if(mode==='abort-receive')f.state.afterReceive=()=>controller.abort()
  if(mode==='lease')f.state.afterReceive=()=>{f.state.lease=false}
  if(mode==='revision')f.state.afterReceive=()=>{f.state.revision=randomUUID()}
  await assert.rejects(f.service.stageExtractPages('session',f.fileId,f.input,controller.signal),error=>mode.startsWith('abort')?error.name==='AbortError':error.statusCode===409)
  assert.deepEqual(f.calls.at(-1),['cancel','upload'])
 }
})


test('PDF extraction honors import quota and cleans a reserved import after upload failure',async()=>{
 const quota=await fixture();quota.state.stageError=Object.assign(new Error('quota'),{statusCode:413})
 await assert.rejects(quota.service.stageExtractPages('session',quota.fileId,quota.input),error=>error.statusCode===413)
 assert.deepEqual(quota.calls.map(call=>call[0]),['stage'])
 const io=await fixture();io.state.receiveError=new Error('private storage error')
 await assert.rejects(io.service.stageExtractPages('session',io.fileId,io.input),error=>error.statusCode===500&&error.detail==='PDF_EXTRACT_FAILED'&&!error.message.includes('private'))
 assert.deepEqual(io.calls.map(call=>call[0]),['stage','receive','cancel'])
})

test('PDF extraction rechecks source authority after source object IO before preparing output',async()=>{
 for(const mode of ['revision','lease']){
  const f=await fixture();f.state.afterDownload=()=>{if(mode==='revision')f.state.revision=randomUUID();else f.state.lease=false}
  await assert.rejects(f.service.stageExtractPages('session',f.fileId,f.input),error=>error.statusCode===409)
  assert.deepEqual(f.calls,[])
 }
})
