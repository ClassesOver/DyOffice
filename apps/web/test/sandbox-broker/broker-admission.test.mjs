import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {requireRunnableBrokerFixture} from '../helpers/broker-fixture-preflight.mjs'
const golden=JSON.parse(await readFile(new URL('../../../../services/document-broker/tests/fixtures/control-frame.json',import.meta.url),'utf8'))
const options=()=>({unsafeTestOnly:true,context:golden.context,brokerBootId:golden.brokerBootId})
const old=process.env.NODE_ENV
before(async()=>{
 process.env.NODE_ENV='test'
 for(const artifact of ['dyoffice-document-broker','examples/admission-fixture']) {
  requireRunnableBrokerFixture(fileURLToPath(new URL(`../../../../services/document-broker/target/debug/${artifact}`,import.meta.url)))
 }
 // Prove the socketpair fixture really runs before any fault expectation can
 // mistake spawn/loader/socket failure for the intended injected fault.
 const {createTestBrokerAdmissionBackend}=await import('../../worker/src/sandbox/document-broker-admission.ts')
 await assert.rejects(()=>createTestBrokerAdmissionBackend(options()).start({...golden.request,deadlineAt:new Date(Date.now()+5000).toISOString()},new Uint8Array(),new AbortController().signal),{code:'DOCUMENT_BROKER_DISABLED'})
})
after(()=>{if(old===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=old})
test('actual Rust socketpair admission returns a bound denial, never a start handle',async()=>{
 const {createTestBrokerAdmissionBackend}=await import('../../worker/src/sandbox/document-broker-admission.ts')
 const backend=createTestBrokerAdmissionBackend(options())
 await assert.rejects(()=>backend.start({...golden.request,deadlineAt:new Date(Date.now()+5000).toISOString()},new Uint8Array(),new AbortController().signal),{code:'DOCUMENT_BROKER_DISABLED'})
})
test('actual default Rust exit 78 is unavailable, not stop proof',async()=>{
 const {createTestBrokerAdmissionBackend}=await import('../../worker/src/sandbox/document-broker-admission.ts')
 const backend=createTestBrokerAdmissionBackend({...options(),fixture:'default-disabled'})
 await assert.rejects(()=>backend.start({...golden.request,deadlineAt:new Date(Date.now()+5000).toISOString()},new Uint8Array(),new AbortController().signal),{code:'DOCUMENT_BROKER_UNCERTAIN'})
 await assert.rejects(()=>backend.stop({}),{code:'DOCUMENT_BROKER_UNCERTAIN'})
})
test('production has no enabling options and test backend refuses outside test environment',async()=>{
 const {createBrokerAdmissionBackend,createTestBrokerAdmissionBackend}=await import('../../worker/src/sandbox/document-broker-admission.ts')
 process.env.NODE_ENV='production'
 try{assert.throws(()=>createTestBrokerAdmissionBackend(options()));await assert.rejects(()=>createBrokerAdmissionBackend().start({},new Uint8Array(),new AbortController().signal),{code:'DOCUMENT_BROKER_UNAVAILABLE'})}finally{process.env.NODE_ENV='test'}
})
test('denial correlation rejects wrong identity, duplicate, trailing, partial and success-shaped frames',async()=>{
 const {validateBrokerDenial}=await import('../../worker/src/sandbox/document-broker-admission.ts')
 const expected={requestId:golden.requestId,brokerBootId:golden.brokerBootId}
 const r={protocolVersion:1,...expected,status:'disabled',reason:'REAL_BACKEND_UNAVAILABLE'},raw=JSON.stringify(r)
 assert.doesNotThrow(()=>validateBrokerDenial(Buffer.from(raw),expected))
 for(const bad of [raw+raw,raw+' ',raw.slice(0,-1),raw.replace('"protocolVersion":1','"protocolVersion":1,"protocolVersion":1'),JSON.stringify({...r,requestId:golden.brokerBootId}),JSON.stringify({...r,brokerBootId:golden.requestId}),JSON.stringify({...r,context:golden.context}),JSON.stringify({...r,status:'success'}),JSON.stringify({...r,handle:{}})])assert.throws(()=>validateBrokerDenial(Buffer.from(bad),expected),{code:'DOCUMENT_BROKER_UNCERTAIN'})
})
for(const fault of ['stall','stdout-flood','stderr-flood','partial','early-close'])test(`actual Rust ${fault} is bounded and remains uncertain`,async()=>{
 const {createTestBrokerAdmissionBackend}=await import('../../worker/src/sandbox/document-broker-admission.ts')
 const started=performance.now()
 await assert.rejects(async()=>{
  const backend=createTestBrokerAdmissionBackend({...options(),fixture:fault})
  await backend.start({...golden.request,deadlineAt:new Date(Date.now()+5000).toISOString()},new Uint8Array(),new AbortController().signal)
 },{code:'DOCUMENT_BROKER_UNCERTAIN'})
 assert.ok(performance.now()-started<(fault==='stall'?2500:1000))
})
test('actual stalled Rust child is cancelled without manufacturing a stop acknowledgement',async()=>{
 const {createTestBrokerAdmissionBackend}=await import('../../worker/src/sandbox/document-broker-admission.ts')
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),100),started=performance.now()
 try{await assert.rejects(async()=>createTestBrokerAdmissionBackend({...options(),fixture:'stall'}).start({...golden.request,deadlineAt:new Date(Date.now()+5000).toISOString()},new Uint8Array(),controller.signal),{code:'DOCUMENT_BROKER_UNCERTAIN'})}finally{clearTimeout(timer)}
 assert.ok(performance.now()-started<1000)
})
