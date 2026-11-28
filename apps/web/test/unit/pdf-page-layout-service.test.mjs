import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {PDFDocument} from 'pdf-lib'
import {createPdfService} from '../../server/src/modules/pdf/service.ts'
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
async function fixture(){
 const doc=await PDFDocument.create();for(let i=0;i<2;i++)doc.addPage([300,200]).drawText('Page '+i,{x:20,y:100})
 const bytes=Buffer.from(await doc.save()),fileId=randomUUID(),baseRevision=randomUUID(),editorId=randomUUID(),calls=[],state={revision:baseRevision,lease:true,quota:false,io:false,afterReceive:null}
 const files={
  async openFile(){return {format:'pdf',file:{revision:state.revision,sha256:hash(bytes)}}},async download(){return {format:'pdf',name:'Source.pdf',bytes}},
  async stageUpload(_token,input){calls.push(['stage',input]);if(state.quota)throw Object.assign(new Error('quota'),{statusCode:413});return {uploadId:'upload',fileId:randomUUID()}},
  async receiveUpload(_token,_id,output){calls.push(['receive',Buffer.from(output)]);if(state.io)throw new Error('private storage');state.afterReceive?.()},async cancelUpload(_token,id){calls.push(['cancel',id])},
 }
 const leases={async getLease(){return {active:state.lease,heldByCurrentSession:true,editorId,leaseEpoch:1}}}
 const revisions={async commitRevision(){throw new Error('must not revise source')}}
 return {service:createPdfService({files,leases,revisions}),fileId,input:{baseRevision,editorId,leaseEpoch:1,operation:{kind:'split',perPage:2}},calls,state}
}
test('PDF layout stages a distinct import with real split or merge bytes, not a source revision',async()=>{
 for(const operation of [{kind:'split',perPage:2},{kind:'merge',perSheet:2,direction:'vertical',separator:false}]){
  const f=await fixture(),result=await f.service.stagePageLayout('session',f.fileId,{...f.input,operation,name:'Selected pages.pdf'})
  assert.deepEqual(f.calls.map(call=>call[0]),['stage','receive']);assert.notEqual(result.fileId,f.fileId);assert.equal(result.sha256,hash(f.calls[1][1]));assert.equal(result.size,f.calls[1][1].length)
  assert.equal(f.calls[0][1].name,'Selected pages.pdf')
  assert.equal((await PDFDocument.load(f.calls[1][1])).getPageCount(),operation.kind==='split'?4:1)
 }
})
test('PDF layout rejects stale source authority before staging',async()=>{
 for(const mode of ['revision','lease','schema']){
  const f=await fixture();if(mode==='revision')f.state.revision=randomUUID();if(mode==='lease')f.state.lease=false;if(mode==='schema')f.input.operation.perPage=3
  await assert.rejects(f.service.stagePageLayout('session',f.fileId,f.input),error=>error.statusCode===(mode==='schema'?400:409));assert.deepEqual(f.calls,[])
 }
})
test('PDF layout cancels staged outputs on cancellation, lost authority or upload failure and honors quota',async()=>{
 for(const mode of ['abort','lease','revision','io','quota']){
  const f=await fixture(),controller=new AbortController()
  if(mode==='abort')f.state.afterReceive=()=>controller.abort()
  if(mode==='lease')f.state.afterReceive=()=>{f.state.lease=false}
  if(mode==='revision')f.state.afterReceive=()=>{f.state.revision=randomUUID()}
  if(mode==='io')f.state.io=true
  if(mode==='quota')f.state.quota=true
  await assert.rejects(f.service.stagePageLayout('session',f.fileId,f.input,controller.signal),error=>mode==='abort'?error.name==='AbortError':error.statusCode===(mode==='quota'?413:mode==='io'?500:409))
  assert.equal(f.calls.filter(call=>call[0]==='cancel').length,mode==='quota'?0:1)
 }
})
