import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createGatewayAdapter,encodeGatewayPlan,decodeGatewayPlan} from '../../worker/src/native/gateway.ts'
const part='/work/part-12345678-1234-1234-1234-123456789abc'
const wire=()=>({replaced:[['xl/workbook.xml','<workbook/>']],added:[],addedBinary:[['xl/media/a.png','AQID']],removedEntries:['xl/old.xml']})
function fixture(output=wire(),reply={written:true}) {
  const calls=[]
  const process={async run(bytes,execute,options){calls.push(['run',Buffer.from(bytes),options?.signal]);return execute({async writePart(bytes){calls.push(['part',JSON.parse(Buffer.from(bytes).toString())]);return part},async request(command,args){calls.push(['request',command,args]);return reply},async readOutput(){return Buffer.isBuffer(output)?output:Buffer.from(JSON.stringify(output))}})}}
  return {adapter:createGatewayAdapter(process),calls}
}
test('gateway planner uses bounded part protocol and restores text/binary Maps',async()=>{
  const f=fixture(),signal=new AbortController().signal,input=Buffer.from('xlsx'),sheets=[{id:'s1',name:'Sheet1'}],request={mode:'save'}
  const result=await f.adapter.planWorkbookSave(input,sheets,request,signal)
  assert.ok(f.calls[0][2] instanceof AbortSignal);assert.equal(f.calls[0][2].aborted,false)
  assert.deepEqual(f.calls,[['run',input,f.calls[0][2]],['part',{sheets,request}],['request','gateway_plan',{path:part}]])
  assert.deepEqual([...result.replaced],[['xl/workbook.xml','<workbook/>']]);assert.deepEqual([...result.addedBinary],[['xl/media/a.png',Buffer.from([1,2,3])]])
  assert.deepEqual(result.removedEntries,['xl/old.xml'])
})
test('workbook planner sends no caller sheet mapping and retains bounded plan validation',async()=>{
  const f=fixture(),input=Buffer.from('xlsx'),request={mode:'save'},signal=new AbortController().signal
  const result=await f.adapter.planFromWorkbook(input,request,signal)
  assert.deepEqual(f.calls.slice(1),[['part',{request}],['request','gateway_plan',{path:part}]])
  assert.equal(result.replaced.get('xl/workbook.xml'),'<workbook/>')
  await assert.rejects(()=>fixture({...wire(),replaced:[['../escape','xml']]}).adapter.planFromWorkbook(input,request),{code:'INVALID_OUTPUT'})
})
test('legacy gateway projects native metadata to exact id/name wire contract',async()=>{
  const f=fixture();await f.adapter.planWorkbookSave(Buffer.from('xlsx'),[{id:'sheet-1',name:'Sheet1',rowCount:10}],{})
  assert.deepEqual(f.calls[1],['part',{sheets:[{id:'sheet-1',name:'Sheet1'}],request:{}}])
})
test('gateway package uses separate command and returns package metadata',async()=>{
  const metadata={redactions:[],slicers:[],connections:{connections:[]},queries:[]},f=fixture(metadata)
  assert.deepEqual(await f.adapter.readWorkbookPackage(Buffer.from('xlsx')),metadata)
  assert.deepEqual(f.calls[1],['part',{}]);assert.deepEqual(f.calls[2],['request','gateway_package',{path:part}])
})
test('gateway rejects invalid output, unsafe paths, duplicates, excess parts and malformed binary',async()=>{
  const invalid=[Buffer.from('{'),{...wire(),replaced:[['../escape','x']]},{...wire(),replaced:[['xl\\escape','x']]},{...wire(),added:[['xl/workbook.xml','duplicate']]},{...wire(),removedEntries:Array.from({length:257},(_,i)=>'xl/'+i)},{...wire(),addedBinary:[['xl/media/a.png','not-base64!']]},{...wire(),replaced:[['xl/a\u0000','x']]},{...wire(),unknown:true}]
  for(const output of invalid)await assert.rejects(()=>fixture(output).adapter.planWorkbookSave(Buffer.from('xlsx'),[],{}),{code:'INVALID_OUTPUT'})
  await assert.rejects(()=>fixture(wire(),{written:false}).adapter.readWorkbookPackage(Buffer.from('xlsx')),{code:'INVALID_PROTOCOL'})
  await assert.rejects(()=>fixture(Buffer.alloc(32*1024*1024+1)).adapter.readWorkbookPackage(Buffer.from('xlsx')),{code:'OUTPUT_LIMIT'})
})
test('gateway rejects oversized request before starting sandbox and handles pre-cancel',async()=>{
  const f=fixture();await assert.rejects(()=>f.adapter.planWorkbookSave(Buffer.from('xlsx'),[],{text:'x'.repeat(4*1024*1024)}),{code:'INPUT_LIMIT'});assert.equal(f.calls.length,0)
  const controller=new AbortController();controller.abort();await assert.rejects(()=>f.adapter.readWorkbookPackage(Buffer.from('xlsx'),controller.signal),{code:'ABORTED'});assert.equal(f.calls.length,0)
})
test('gateway forwards in-flight cancellation to process and does not read cancelled output',async()=>{
  const controller=new AbortController();let signal,started
  const began=new Promise(resolve=>{started=resolve})
  const adapter=createGatewayAdapter({run(_bytes,_execute,options){signal=options.signal;started();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('ABORTED'),{code:'ABORTED'})),{once:true}))}})
  const result=adapter.readWorkbookPackage(Buffer.from('xlsx'),controller.signal);await began;controller.abort();assert.equal(signal.aborted,true);await assert.rejects(result,{code:'ABORTED'})
})
test('gateway wire encoder enforces cumulative content budget and rejects duplicate remove names',()=>{
  const plan={replaced:new Map([['xl/a','a'.repeat(16*1024*1024)],['xl/b','b'.repeat(16*1024*1024)]]),added:new Map(),addedBinary:new Map(),removedEntries:[]}
  assert.equal(encodeGatewayPlan(plan).replaced.length,2)
  plan.added.set('xl/c','c');assert.throws(()=>encodeGatewayPlan(plan),{code:'INVALID_OUTPUT'})
  assert.throws(()=>decodeGatewayPlan({...wire(),removedEntries:['xl/old.xml','xl/old.xml']}),{code:'INVALID_OUTPUT'})
})
test('gateway never sends an untrusted part path to the sandbox protocol',async()=>{
  let requests=0
  const adapter=createGatewayAdapter({async run(_bytes,execute){return execute({async writePart(){return '/etc/passwd'},async request(){requests++;return {written:true}},async readOutput(){return Buffer.from('{}')}})}})
  await assert.rejects(()=>adapter.readWorkbookPackage(Buffer.from('xlsx')),{code:'INVALID_PROTOCOL'});assert.equal(requests,0)
})
test('controlled gateway input errors retain HTTP 400 without accepting arbitrary error payloads',async()=>{
  const guarded=createGatewayAdapter({async run(bytes,execute){try{return await execute({writePart:async()=>'/work/part-00000000-0000-0000-0000-000000000000',request:async()=>({error:'INVALID_INPUT'})})}catch(error){if(error?.name==='SandboxError')throw error;throw new Error('host wraps non-sandbox errors')}}})
  await assert.rejects(()=>guarded.planWorkbookSave(Buffer.from('xlsx'),[],{}),{statusCode:400})
  await assert.rejects(()=>fixture(wire(),{error:'INVALID_INPUT'}).adapter.planWorkbookSave(Buffer.from('xlsx'),[],{}),{statusCode:400,message:'Invalid workbook input'})
  await assert.rejects(()=>fixture(wire(),{error:'INVALID_INPUT',detail:'private/path'}).adapter.planWorkbookSave(Buffer.from('xlsx'),[],{}),{code:'INVALID_PROTOCOL'})
  await assert.rejects(()=>fixture(wire(),{error:'DATABASE_PASSWORD'}).adapter.readWorkbookPackage(Buffer.from('xlsx')),{code:'INVALID_PROTOCOL'})
})
test('gateway decodes large canonical binary without recursive regular expressions',()=>{
  const binary=Buffer.alloc(8*1024*1024,7),encoded=binary.toString('base64')
  const decoded=decodeGatewayPlan({replaced:[],added:[],addedBinary:[['xl/media/large.bin',encoded]],removedEntries:[]})
  assert.deepEqual(decoded.addedBinary.get('xl/media/large.bin'),binary)
  assert.throws(()=>decodeGatewayPlan({replaced:[],added:[],addedBinary:[['xl/media/large.bin',encoded.slice(0,-4)+'!!!!']],removedEntries:[]}),{code:'INVALID_OUTPUT'})
})
