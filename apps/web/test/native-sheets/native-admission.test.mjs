import {test} from 'node:test'
import assert from 'node:assert/strict'
import {setImmediate as turn} from 'node:timers/promises'
import {createXlsxNativeWorker} from '../../worker/src/native/xlsx.ts'
import {createNativeAdmission} from '../../worker/src/native/admission.ts'
import {SandboxError} from '../../worker/src/sandbox/contracts.ts'
import {createApiShell} from '../../server/src/framework.ts'

const metadata={sessionId:'00000000-0000-4000-8000-000000000000',sheets:[{id:'1',name:'Sheet1'}]}
const range={startRow:0,endRow:0,startColumn:0,endColumn:0}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
function fakeProcess(){
 const calls=[]
 const process={async run(input,execute,{signal}={}){
  if(calls.filter(call=>!call.done).length>=2)throw new SandboxError('SANDBOX_BUSY')
  const gate=deferred(),call={input,signal,gate,done:false};calls.push(call)
  try{await gate.promise;signal?.throwIfAborted();return await execute({
   async request(command){if(command==='open')return metadata;if(command==='read_range')return {indexingComplete:true,cells:[]};return {}},
   async readOutput(){return Buffer.from('output')},async writePart(){return '/work/part'},
  })}finally{call.done=true}
 }}
 return {process,calls,release:()=>calls.forEach(call=>call.gate.resolve())}
}

test('two native reads hold shared slots: inspect and every other operation queue FIFO',async t=>{
 const f=fakeProcess();t.after(f.release)
 const native=createXlsxNativeWorker(f.process),input=Buffer.from('workbook')
 const first=native.readRange(input,'Sheet1',range),second=native.readSheet(input,'Sheet1','formulas')
 const third=native.inspect(input),fourth=native.readMedia(input,'visual')
 const settled=Promise.allSettled([first,second,third,fourth])
 await turn();assert.equal(f.calls.length,2,'inspect must wait instead of reaching a busy host')
 f.calls[0].gate.resolve();await first;await turn()
 assert.equal(f.calls.length,3);assert.equal(f.calls[2].done,false)
 f.calls[1].gate.resolve();await second;await turn();assert.equal(f.calls.length,4)
 f.release();assert.deepEqual((await settled).map(result=>result.status),['fulfilled','fulfilled','fulfilled','fulfilled'])
})

test('cancelled queued work never starts and releases its queue position',async t=>{
 const f=fakeProcess();t.after(f.release)
 const native=createXlsxNativeWorker(f.process),input=Buffer.from('workbook'),controller=new AbortController()
 const first=native.inspect(input),second=native.inspect(input)
 const cancelled=native.inspect(input,controller.signal),rejected=assert.rejects(cancelled,{code:'ABORTED'})
 controller.abort();await rejected;assert.equal(f.calls.length,2)
 const next=native.inspect(input);f.release();await Promise.all([first,second]);await turn()
 assert.equal(f.calls.length,3);f.release();await next
})

test('native failures release a slot for queued save operations',async t=>{
 const f=fakeProcess();t.after(f.release)
 const native=createXlsxNativeWorker(f.process),input=Buffer.from('workbook')
 const first=native.inspect(input),failure=assert.rejects(first,/native failed/)
 const second=native.inspect(input),third=native.roundtrip(input),settled=Promise.allSettled([second,third])
 await turn();assert.equal(f.calls.length,2)
 f.calls[0].gate.reject(new Error('native failed'));await failure;await turn();assert.equal(f.calls.length,3)
 f.release();assert.deepEqual((await settled).map(result=>result.status),['fulfilled','fulfilled'])
})

test('busy host is retried only before execute begins, then stops at its deadline',async()=>{
 let attempts=0,executions=0
 const process={async run(_input,execute){attempts++;if(attempts<3)throw new SandboxError('SANDBOX_BUSY');return execute({})}}
 const native=createNativeAdmission(process,{timeoutMs:250,retryMs:5})
 assert.equal(await native.run(Buffer.from('input'),async()=>{executions++;return 'ok'}),'ok')
 assert.equal(attempts,3);assert.equal(executions,1)
 let timedAttempts=0
 const alwaysBusy=createNativeAdmission({async run(){timedAttempts++;throw new SandboxError('SANDBOX_BUSY')}},{timeoutMs:40,retryMs:5})
 await assert.rejects(alwaysBusy.run(Buffer.from('input'),async()=>{}),{code:'SANDBOX_BUSY',statusCode:503,retryAfter:1})
 assert.ok(timedAttempts>1);assert.ok(timedAttempts<20)
 let applied=0
 const appliedProcess=createNativeAdmission({async run(_input,execute){return execute({})}},{timeoutMs:100,retryMs:5})
 await assert.rejects(appliedProcess.run(Buffer.from('input'),async()=>{applied++;throw new SandboxError('SANDBOX_BUSY')}),{code:'SANDBOX_BUSY'})
 assert.equal(applied,1,'busy surfaced after execute starts must not replay a non-idempotent operation')
})

test('admission queue count is bounded and rejects before starting host work',async()=>{
 const gate=deferred();let calls=0
 const native=createNativeAdmission({async run(_input,execute){calls++;await gate.promise;return execute({})}})
 const work=Array.from({length:10},()=>native.run(Buffer.from('input'),async()=>undefined))
 try{
  await assert.rejects(native.run(Buffer.from('overflow'),async()=>{}),{code:'SANDBOX_BUSY',statusCode:429,retryAfter:1})
  assert.equal(calls,2)
 }finally{gate.resolve();await Promise.all(work)}
 assert.equal(calls,10)
 await native.run(Buffer.from('recovered'),async()=>undefined)
})

test('64 MiB captured byte limit includes active and queued snapshots and recovers on cancel',async()=>{
 const gate=deferred();let calls=0
 const native=createNativeAdmission({async run(_input,execute){calls++;await gate.promise;return execute({})}})
 const input=Buffer.alloc(16*1024*1024,1),controller=new AbortController()
 const first=native.run(input,async()=>{}),second=native.run(input,async()=>{})
 const queued=native.run(input,async()=>{}),cancelled=native.run(input,async()=>{},{signal:controller.signal})
 const rejected=assert.rejects(cancelled,{code:'ABORTED'})
 let replacement
 try{
  await assert.rejects(native.run(Buffer.from('overflow'),async()=>{}),{code:'SANDBOX_BUSY',statusCode:429,retryAfter:1})
  assert.equal(calls,2);controller.abort();await rejected
  replacement=native.run(input,async()=>{})
  await assert.rejects(native.run(Buffer.from('overflow'),async()=>{}),{statusCode:429})
 }finally{controller.abort();gate.resolve();await Promise.all([first,second,queued,replacement,rejected])}
 await native.run(input,async()=>{})
})

test('queued input is captured before callers mutate it',async t=>{
 const f=fakeProcess();t.after(f.release)
 const native=createXlsxNativeWorker(f.process),first=native.inspect(Buffer.from('one')),second=native.inspect(Buffer.from('two'))
 const input=Buffer.from('original'),queued=native.inspect(input),settled=Promise.allSettled([first,second,queued])
 input.fill(120);f.release();await Promise.all([first,second]);await turn()
 assert.equal(f.calls.length,3);assert.equal(Buffer.from(f.calls[2].input).toString(),'original')
 f.release();assert.ok((await settled).every(result=>result.status==='fulfilled'))
})

test('busy backoff can be cancelled and never retries after abort',async()=>{
 const attempted=deferred();let attempts=0
 const native=createNativeAdmission({async run(){attempts++;attempted.resolve();throw new SandboxError('SANDBOX_BUSY')}},{timeoutMs:1000,retryMs:100})
 const controller=new AbortController(),pending=native.run(Buffer.from('input'),async()=>{throw new Error('must not execute')},{signal:controller.signal})
 const rejected=assert.rejects(pending,error=>{assert.equal(error.code,'ABORTED');assert.notEqual(error.statusCode,503);return true})
 await attempted.promise;await turn();controller.abort();await rejected
 await turn();assert.equal(attempts,1)
})

test('queue wait has a deadline and expired work never starts',async()=>{
 const gate=deferred();let calls=0
 const native=createNativeAdmission({async run(_input,execute){calls++;return execute({})}},{timeoutMs:35,retryMs:5})
 const first=native.run(Buffer.from('one'),()=>gate.promise),second=native.run(Buffer.from('two'),()=>gate.promise)
 const third=native.run(Buffer.from('three'),async()=>{})
 try{await assert.rejects(third,{code:'SANDBOX_BUSY',statusCode:503,retryAfter:1});assert.equal(calls,2)}
 finally{gate.resolve();await Promise.all([first,second])}
 assert.equal(calls,2)
 await native.run(Buffer.from('next'),async()=>{});assert.equal(calls,3)
})

test('aborting running work holds its slot until the process has finished cleanup',async()=>{
 const cleanup=deferred(),entered=deferred();let calls=0
 const native=createNativeAdmission({async run(_input,execute,{signal}){
  const n=++calls
  if(n!==1)return execute({})
  entered.resolve()
  await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}))
  await cleanup.promise
  throw new SandboxError('ABORTED')
 }})
 const controller=new AbortController(),first=native.run(Buffer.from('one'),async()=>{},{signal:controller.signal})
 const rejected=assert.rejects(first,{code:'ABORTED'});await entered.promise
 const held=deferred(),second=native.run(Buffer.from('two'),()=>held.promise)
 const third=native.run(Buffer.from('three'),async()=>{})
 controller.abort();await turn();assert.equal(calls,2)
 cleanup.resolve();await rejected;await third;assert.equal(calls,3)
 held.resolve();await second
})

test('all XLSX entry points share admission including savePlan and recalculate',async()=>{
 const entered=deferred(),gate=deferred();let calls=0
 const native=createXlsxNativeWorker({async run(){calls++;if(calls===2)entered.resolve();await gate.promise;throw new SandboxError('NATIVE_FAILED')}})
 const input=Buffer.from('input'),plan={replaced:new Map(),added:new Map(),addedBinary:new Map(),removedEntries:[]}
 const work=[native.readMedia(input,'visual'),native.recalculate(input,{edits:[],reads:[]}),native.inspect(input),native.readSheet(input,'Sheet1','outline'),native.readRange(input,'Sheet1',range),native.savePlan(input,plan),native.roundtrip(input)]
 const settled=Promise.allSettled(work)
 try{await entered.promise;await turn();assert.equal(calls,2)}finally{gate.resolve();await settled}
 assert.equal(calls,7)
})

test('native output Buffer is returned unchanged, not copied by admission',async()=>{
 const output=Buffer.from('output'),native=createXlsxNativeWorker({async run(_input,execute){return execute({
  async request(command){return command==='open'?metadata:{}},async readOutput(){return output},
 })}})
 assert.equal((await native.roundtrip(Buffer.from('input'))).bytes,output)
})

test('HTTP errors expose 429/503 and Retry-After instead of 500',async t=>{
 const app=await createApiShell();t.after(()=>app.close())
 const gate=deferred(),native=createNativeAdmission({async run(_input,execute){await gate.promise;return execute({})}})
 const work=Array.from({length:10},()=>native.run(Buffer.from('input'),async()=>{}))
 const busy=createNativeAdmission({async run(){throw new SandboxError('SANDBOX_BUSY')}},{timeoutMs:30,retryMs:5})
 app.get('/full',()=>native.run(Buffer.from('overflow'),async()=>{}))
 app.get('/busy',()=>busy.run(Buffer.from('input'),async()=>{}))
 try{
  for(const [url,status] of [['/full',429],['/busy',503]]){
   const response=await app.inject({method:'GET',url})
   assert.equal(response.statusCode,status);assert.equal(response.headers['retry-after'],'1')
  }
 }finally{gate.resolve();await Promise.all(work)}
})
