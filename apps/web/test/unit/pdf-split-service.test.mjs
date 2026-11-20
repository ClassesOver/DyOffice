import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {PDFDocument} from 'pdf-lib'
import {createPdfService} from '../../server/src/modules/pdf/service.ts'
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
async function fixture(){
 const doc=await PDFDocument.create();for(let i=1;i<=5;i++)doc.addPage([300,200]).drawText('Page '+i,{x:20,y:100})
 const bytes=Buffer.from(await doc.save()),fileId=randomUUID(),baseRevision=randomUUID(),editorId=randomUUID(),calls=[]
 const state={revision:baseRevision,lease:true,stageErrorAt:0,receiveErrorAt:0,afterReceive:null}
 let stages=0,receives=0
 const files={
  async openFile(){return {format:'pdf',file:{revision:state.revision,sha256:hash(bytes)}}},
  async download(){return {format:'pdf',name:'Source.pdf',bytes}},
  async stageUpload(token,input){assert.equal(token,'session');stages++;calls.push(['stage',input]);if(stages===state.stageErrorAt)throw Object.assign(new Error('quota'),{statusCode:413});return {uploadId:'upload-'+stages,fileId:randomUUID(),expiresAt:'later'}},
  async receiveUpload(_token,id,output){receives++;calls.push(['receive',id,Buffer.from(output)]);if(receives===state.receiveErrorAt)throw new Error('private io');state.afterReceive?.(receives)},
  async cancelUpload(_token,id){calls.push(['cancel',id])},
 }
 const leases={async getLease(){return {active:state.lease,heldByCurrentSession:true,editorId,leaseEpoch:1}}}
 const revisions={async stageUpload(){throw Error('source revision must not be staged')},async commitRevision(){throw Error('source must not be committed')}}
 return {service:createPdfService({files,leases,revisions}),fileId,input:{baseRevision,editorId,leaseEpoch:1,pagesPerFile:2},calls,state}
}
test('PDF split stages ordered import receipts without publishing or revising its source',async()=>{
 const f=await fixture(),result=await f.service.stageSplit('session',f.fileId,f.input)
 assert.equal(result.files.length,3);assert.deepEqual(f.calls.map(call=>call[0]),['stage','receive','stage','receive','stage','receive'])
 assert.deepEqual(f.calls.filter(call=>call[0]==='stage').map(call=>call[1].name),['Source-part-1.pdf','Source-part-2.pdf','Source-part-3.pdf'])
 for(let i=0;i<3;i++){
  const output=f.calls.filter(call=>call[0]==='receive')[i][2]
  assert.equal(result.files[i].uploadId,'upload-'+(i+1));assert.notEqual(result.files[i].fileId,f.fileId);assert.equal(result.files[i].sha256,hash(output));assert.equal(result.files[i].size,output.length)
  assert.equal((await PDFDocument.load(output)).getPageCount(),i===2?1:2)
 }
})
test('PDF split rolls back every prepared import on later quota, IO or cancellation failures',async()=>{
 for(const mode of ['quota','io','abort']){
  const f=await fixture(),controller=new AbortController()
  if(mode==='quota')f.state.stageErrorAt=2
  if(mode==='io')f.state.receiveErrorAt=3
  if(mode==='abort')f.state.afterReceive=count=>{if(count===2)controller.abort()}
  await assert.rejects(f.service.stageSplit('session',f.fileId,f.input,controller.signal),error=>mode==='abort'?error.name==='AbortError':error.statusCode===(mode==='quota'?413:500))
  assert.deepEqual(f.calls.filter(call=>call[0]==='cancel').map(call=>call[1]),mode==='quota'?['upload-1']:mode==='io'?['upload-1','upload-2','upload-3']:['upload-1','upload-2'])
 }
})
test('PDF split rejects stale source and invalid sizes before stage and rechecks authority before returning receipts',async()=>{
 for(const mode of ['revision','lease','size','late-revision','late-lease']){
  const f=await fixture()
  if(mode==='revision')f.state.revision=randomUUID()
  if(mode==='lease')f.state.lease=false
  if(mode==='size')f.input.pagesPerFile=5
  if(mode.startsWith('late'))f.state.afterReceive=count=>{if(count===3){if(mode==='late-revision')f.state.revision=randomUUID();else f.state.lease=false}}
  await assert.rejects(f.service.stageSplit('session',f.fileId,f.input),error=>error.statusCode===(mode==='size'?400:409))
  assert.equal(f.calls.filter(call=>call[0]==='cancel').length,mode.startsWith('late')?3:0)
  if(!mode.startsWith('late'))assert.deepEqual(f.calls,[])
 }
})
