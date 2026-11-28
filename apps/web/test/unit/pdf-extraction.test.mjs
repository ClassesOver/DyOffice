import test from 'node:test'
import assert from 'node:assert/strict'
import {createPdfExtraction} from '../../src/editors/pdf-extraction.ts'

const prepared={uploadId:'upload',fileId:'created',sha256:'a'.repeat(64),size:100}
const receipt={fileId:'created',revision:'new-revision',sha256:prepared.sha256,size:100}
function fixture(overrides={}){
 const calls=[],opened=[]
 const request=async(path,method,body,signal)=>{
  calls.push({path,method,body,signal})
  if(path.endsWith('/lease')&&method==='POST')return {leaseEpoch:7}
  if(path.endsWith('/extract-pages/uploads'))return prepared
  if(path.endsWith('/finish'))return {format:'pdf',file:receipt}
  if(path.includes('/revisions/'))return receipt
 }
 const client=createPdfExtraction({fileId:'source',name:'Report.pdf',request:overrides.request??request,getRevision:()=> 'source-revision',onCreated:async value=>{opened.push(value);await overrides.onCreated?.(value)}})
 return {client,calls,opened,request}
}
test('PDF extraction stages current source revision, finishes a new PDF and verifies its receipt before opening',async()=>{
 const f=fixture(),controller=new AbortController()
 assert.equal(await f.client.extract([1,3],controller.signal),true)
 assert.equal(f.client.hasPending(),false)
 assert.deepEqual(f.opened,[receipt])
 const stage=f.calls.find(call=>call.path.endsWith('/extract-pages/uploads'))
 assert.deepEqual(stage.body.pages,[1,3]);assert.equal(stage.body.baseRevision,'source-revision')
 assert.ok(f.calls.filter(call=>call.method==='POST').every(call=>call.signal===controller.signal))
 assert.equal(f.calls.some(call=>call.path.endsWith('/commits')),false)
 assert.ok(f.calls.findIndex(call=>call.path.includes('/revisions/'))>f.calls.findIndex(call=>call.path.endsWith('/finish')))
})
test('lost finish responses retain the same upload and block another extraction until receipt recovery',async()=>{
 let lost=true
 const base=fixture()
 const f=fixture({request:async(...args)=>{if(args[0].endsWith('/finish')&&lost){base.calls.push({path:args[0],method:args[1]});lost=false;throw Error('response lost')}return base.request(...args)}})
 await assert.rejects(f.client.extract([1]),/response lost/)
 assert.equal(f.client.hasPending(),true)
 assert.equal(await f.client.extract([1]),false)
 assert.equal(await f.client.confirm(),true)
 assert.equal(base.calls.filter(call=>call.path.endsWith('/extract-pages/uploads')).length,1)
 assert.deepEqual(base.calls.filter(call=>call.path.endsWith('/finish')).map(call=>call.path),['/api/v1/uploads/upload/finish','/api/v1/uploads/upload/finish'])
 assert.deepEqual(f.opened,[receipt])
})
test('canceling after extraction staging deletes its unpublished upload without finishing',async()=>{
 const controller=new AbortController(),base=fixture()
 const f=fixture({request:async(...args)=>{const result=await base.request(...args);if(args[0].endsWith('/extract-pages/uploads'))controller.abort();return result}})
 await assert.rejects(f.client.extract([1],controller.signal),{name:'AbortError'})
 assert.equal(f.client.hasPending(),false)
 assert.equal(base.calls.some(call=>call.path.endsWith('/finish')),false)
 assert.ok(base.calls.some(call=>call.path==='/api/v1/uploads/upload'&&call.method==='DELETE'))
})
test('created PDF open failure retains the receipt and retries opening without regenerating or finishing again',async()=>{
 let fail=true
 const f=fixture({onCreated:async()=>{if(fail){fail=false;throw Error('tab failed')}}})
 await assert.rejects(f.client.extract([1]),/已创建.*不要重复/)
 assert.equal(f.client.hasPending(),true)
 assert.equal(await f.client.confirm(),true)
 assert.equal(f.calls.filter(call=>call.path.endsWith('/extract-pages/uploads')).length,1)
 assert.equal(f.calls.filter(call=>call.path.endsWith('/finish')).length,1)
})
test('mismatched created PDF receipts cannot be opened or trigger a fresh extraction',async()=>{
 const base=fixture()
 const f=fixture({request:async(...args)=>args[0].endsWith('/finish')?{format:'pdf',file:{...receipt,sha256:'b'.repeat(64)}}:base.request(...args)})
 await assert.rejects(f.client.extract([1]),/回执/)
 assert.equal(f.opened.length,0);assert.equal(f.client.hasPending(),true)
 assert.equal(await f.client.extract([1]),false)
})

test('canceling a dispatched finish keeps the upload pending and confirmation cannot regenerate it',async()=>{
 const controller=new AbortController(),base=fixture()
 let first=true
 const f=fixture({request:async(...args)=>{if(args[0].endsWith('/finish')&&first){first=false;controller.abort();throw new DOMException('Cancelled','AbortError')}return base.request(...args)}})
 await assert.rejects(f.client.extract([1],controller.signal),{name:'AbortError'})
 assert.equal(f.client.hasPending(),true)
 assert.equal(await f.client.confirm(),true)
 assert.equal(base.calls.filter(call=>call.path.endsWith('/extract-pages/uploads')).length,1)
 assert.equal(base.calls.some(call=>call.path==='/api/v1/uploads/upload'&&call.method==='DELETE'),false)
})
test('an unknown stage is never automatically restaged or published',async()=>{
 let preparations=0
 const f=fixture({request:async(path,method)=>{
  if(path.endsWith('/lease')&&method==='POST')return {leaseEpoch:7}
  if(path.endsWith('/extract-pages/uploads')){preparations++;throw Error('stage response lost')}
 }})
 await assert.rejects(f.client.extract([1]),/stage response lost/)
 assert.equal(f.client.hasPending(),false)
 await assert.rejects(f.client.extract([1]),/准备结果未确认/)
 assert.equal(preparations,1);assert.deepEqual(f.opened,[])
})

for(const status of [401,403,404,409])test(`post-finish session proof ${status} preserves the upload instead of allowing a duplicate new file`,async()=>{
 const base=fixture();let first=true
 const f=fixture({request:async(...args)=>{if(args[0].endsWith('/finish')&&first){first=false;throw Object.assign(Error('session proof changed'),{status})}return base.request(...args)}})
 await assert.rejects(f.client.extract([1]),/session proof/)
 assert.equal(f.client.hasPending(),true)
 assert.equal(await f.client.extract([1]),false)
 assert.equal(await f.client.confirm(),true)
 assert.equal(base.calls.filter(call=>call.path.endsWith('/extract-pages/uploads')).length,1)
})

for(const status of [401,403,404,409])test(`PDF extraction recovery ${status} keeps the original upload pending`,async()=>{
 const base=fixture();let attempts=0
 const f=fixture({request:async(...args)=>{
  if(args[0].endsWith('/finish')){
   attempts++
   if(attempts===1)throw Error('lost finish response')
   if(attempts===2)throw Object.assign(Error('authority temporarily unavailable'),{status})
  }
  return base.request(...args)
 }})
 await assert.rejects(f.client.extract([1]),/lost finish/)
 await assert.rejects(f.client.confirm(),/authority/)
 assert.equal(f.client.hasPending(),true)
 assert.equal(await f.client.extract([1]),false)
 assert.equal(await f.client.confirm(),true)
 assert.equal(base.calls.filter(call=>call.path.endsWith('/extract-pages/uploads')).length,1)
 assert.deepEqual(f.opened,[receipt])
})

function splitFixture({finish,onCreated,onBatchPublished,stage}={}){
 const files=[1,2,3].map(n=>({...prepared,uploadId:`upload-${n}`,fileId:`created-${n}`})),calls=[],opened=[]
 const receipts=files.map(file=>({...receipt,fileId:file.fileId})),revealed=[]
 const client=createPdfExtraction({fileId:'source',name:'Report.pdf',getRevision:()=> 'source-revision',onCreated:async value=>{opened.push(value);await onCreated?.(value)},...(onBatchPublished?{onBatchPublished:async value=>{revealed.push(value);await onBatchPublished(value)}}:{}),request:async(path,method,body,signal)=>{
  calls.push({path,method,body,signal})
  if(path.endsWith('/lease')&&method==='POST')return {leaseEpoch:7}
  if(path.endsWith('/split/uploads')){await stage?.();return {files}}
  const index=files.findIndex(file=>path.includes(file.uploadId))
  if(path.endsWith('/finish')){await finish?.(index);return {format:'pdf',file:receipts[index]}}
  if(path.includes('/revisions/'))return receipts.find(value=>path.includes(value.fileId))
 }})
 return {client,files,calls,opened,receipts,revealed}
}
test('split recovers a lost second finish using its original upload, without duplicating the first file',async()=>{
 let lost=true
 const f=splitFixture({finish:async index=>{if(index===1&&lost){lost=false;throw Error('response lost')}}})
 await assert.rejects(f.client.split(2),/response lost/)
 assert.deepEqual(f.client.getProgress(),{created:1,total:3})
 assert.equal(f.client.hasPending(),true)
 assert.equal(await f.client.split(2),false)
 assert.equal(await f.client.confirm(),true)
 assert.deepEqual(f.opened,f.receipts)
 assert.equal(f.calls.filter(call=>call.path.endsWith('/split/uploads')).length,1)
 assert.deepEqual(f.calls.filter(call=>call.path.endsWith('/finish')).map(call=>call.path),['/api/v1/uploads/upload-1/finish','/api/v1/uploads/upload-2/finish','/api/v1/uploads/upload-2/finish','/api/v1/uploads/upload-3/finish'])
 assert.deepEqual(f.calls.find(call=>call.path.endsWith('/split/uploads')).body.pagesPerFile,2)
})
test('manual PDF split reveals the completed batch once and retries a failed reveal using the verified receipts',async()=>{
 let failFinish=true,failReveal=true
 const f=splitFixture({
  finish:async index=>{if(index===1&&failFinish){failFinish=false;throw Error('response lost')}},
  onBatchPublished:async()=>{if(failReveal){failReveal=false;throw Error('folder view failed')}},
 })
 await assert.rejects(f.client.split(2,undefined,{name:'Report.pdf',folderId:'project'}),/response lost/)
 assert.deepEqual(f.opened,[])
 assert.deepEqual(f.revealed,[])
 await assert.rejects(f.client.confirm(),/定位/)
 assert.deepEqual(f.opened,[])
 assert.deepEqual(f.revealed,[f.receipts[0]])
 assert.deepEqual(f.client.getReceipts(),f.receipts)
 assert.equal(f.client.hasPending(),true)
 const callCount=f.calls.length
 assert.equal(await f.client.confirm(),true)
 assert.equal(f.calls.length,callCount)
 assert.deepEqual(f.revealed,[f.receipts[0],f.receipts[0]])
 assert.equal(f.client.hasPending(),false)
})
test('split opening failure retains its receipt and stops later creation until confirmation',async()=>{
 let fail=true
 const f=splitFixture({onCreated:async value=>{if(value.fileId==='created-2'&&fail){fail=false;throw Error('open failed')}}})
 await assert.rejects(f.client.split(2),/打开失败/)
 assert.deepEqual(f.client.getProgress(),{created:2,total:3})
 assert.equal(f.calls.filter(call=>call.path.endsWith('/finish')).length,2)
 assert.equal(await f.client.confirm(),true)
 assert.equal(f.calls.filter(call=>call.path.endsWith('/finish')).length,3)
 assert.deepEqual(f.opened.map(value=>value.fileId),['created-1','created-2','created-2','created-3'])
})
test('canceling a split after the first publication preserves completed and unfinished files for confirmation',async()=>{
 const controller=new AbortController()
 const f=splitFixture({onCreated:async()=>controller.abort()})
 await assert.rejects(f.client.split(2,controller.signal),{name:'AbortError'})
 assert.deepEqual(f.client.getProgress(),{created:1,total:3})
 assert.equal(f.calls.filter(call=>call.path.endsWith('/finish')).length,1)
 assert.equal(await f.client.confirm(),true)
 assert.deepEqual(f.opened,f.receipts)
 assert.equal(f.calls.some(call=>call.method==='DELETE'&&call.path.includes('/uploads/')),false)
})
test('canceling split staging deletes every unpublished upload',async()=>{
 const controller=new AbortController(),f=splitFixture({stage:async()=>controller.abort()})
 await assert.rejects(f.client.split(2,controller.signal),{name:'AbortError'})
 assert.equal(f.client.hasPending(),false)
 assert.equal(f.calls.filter(call=>call.method==='DELETE'&&call.path.includes('/uploads/')).length,3)
 assert.equal(f.calls.some(call=>call.path.endsWith('/finish')),false)
})
test('split finish 409 may follow publication and retains the same upload until its receipt can be confirmed',async()=>{
 let unavailable=true
 const f=splitFixture({finish:async index=>{if(index===1&&unavailable)throw Object.assign(Error('auth version changed after publication'),{status:409})}})
 await assert.rejects(f.client.split(2),/auth version/)
 assert.equal(f.client.hasPending(),true)
 assert.deepEqual(f.client.getProgress(),{created:1,total:3})
 await assert.rejects(f.client.confirm(),/auth version/)
 assert.equal(f.client.hasPending(),true)
 assert.equal(await f.client.split(2),false)
 assert.equal(f.calls.some(call=>call.method==='DELETE'&&call.path.includes('/uploads/')),false)
 unavailable=false
 assert.equal(await f.client.confirm(),true)
 assert.equal(f.client.hasPending(),false)
 assert.equal(f.calls.filter(call=>call.path.endsWith('/split/uploads')).length,1)
 assert.equal(f.calls.filter(call=>call.path==='/api/v1/uploads/upload-1/finish').length,1)
 assert.equal(f.calls.filter(call=>call.path==='/api/v1/uploads/upload-2/finish').length,3)
 assert.deepEqual(f.opened,f.receipts)
})

for(const files of [[prepared],[prepared,{...prepared,fileId:'created-2'}],[prepared,{...prepared,uploadId:'second'}],[prepared,{...prepared,uploadId:'second',fileId:'source'}]])test('malformed split preparations never publish or allow automatic duplicate staging',async()=>{
 let stages=0,finishes=0
 const f=fixture({request:async(path,method)=>{
  if(path.endsWith('/lease')&&method==='POST')return {leaseEpoch:7}
  if(path.endsWith('/split/uploads')){stages++;return {files}}
  if(path.endsWith('/finish'))finishes++
 }})
 await assert.rejects(f.client.split(1),/Invalid PDF extraction preparation/)
 await assert.rejects(f.client.split(1),/准备结果未确认/)
 assert.equal(stages,1);assert.equal(finishes,0)
})

test('expired extraction 410 proves no publication and clears its pending upload',async()=>{
 const base=fixture()
 const f=fixture({request:async(...args)=>{if(args[0].endsWith('/finish'))throw Object.assign(Error('expired'),{status:410});return base.request(...args)}})
 await assert.rejects(f.client.extract([1]),/expired/)
 assert.equal(f.client.hasPending(),false)
 assert.deepEqual(f.client.getProgress(),{created:0,total:1})
 assert.ok(base.calls.some(call=>call.path==='/api/v1/uploads/upload'&&call.method==='DELETE'))
})
test('only expired split uploads can be skipped while preserving an honest partial completion result',async()=>{
 const f=splitFixture({finish:async index=>{if(index===1)throw Object.assign(Error('expired'),{status:410})}})
 await assert.rejects(f.client.split(2),/expired/)
 assert.equal(f.client.hasPending(),true)
 await assert.rejects(f.client.confirm(),/2\/3/)
 assert.equal(f.client.hasPending(),false)
 assert.equal(f.calls.filter(call=>call.path==='/api/v1/uploads/upload-2/finish').length,1)
 assert.deepEqual(f.opened,[f.receipts[0],f.receipts[2]])
})

for(const operation of [{kind:'split',perPage:4},{kind:'merge',perSheet:6,direction:'vertical',separator:true}])test(`page-layout ${operation.kind} stages a new PDF and recovers the same upload after an uncertain finish`,async()=>{
 const base=fixture();let lost=true
 const f=fixture({request:async(...args)=>{
  if(args[0].endsWith('/page-layout/uploads')){base.calls.push({path:args[0],method:args[1],body:args[2],signal:args[3]});return prepared}
  if(args[0].endsWith('/finish')&&lost){lost=false;throw Object.assign(Error('auth proof changed'),{status:409})}
  return base.request(...args)
 }})
 const controller=new AbortController()
 await assert.rejects(f.client.layout(operation,controller.signal),/auth proof/)
 assert.equal(f.client.hasPending(),true)
 assert.equal(await f.client.layout(operation),false)
 assert.equal(await f.client.confirm(),true)
 const stages=base.calls.filter(call=>call.path.endsWith('/page-layout/uploads'))
 assert.equal(stages.length,1);assert.equal(stages[0].signal,controller.signal)
 assert.deepEqual(stages[0].body.operation,operation);assert.equal(stages[0].body.baseRevision,'source-revision')
 assert.deepEqual(f.opened,[receipt])
 assert.equal(base.calls.some(call=>call.path.endsWith('/commits')),false)
})
