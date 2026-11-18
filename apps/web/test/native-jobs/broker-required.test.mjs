import {test,mock} from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import {startNativeWorker} from '../../worker/src/main.ts'
import {configuredSheetsRuntime} from '../../server/src/modules/sheets/runtime.ts'
const protectedEnvironment=backend=>new Proxy({DYOFFICE_DOCUMENT_BACKEND:backend},{get(target,key){if(key==='DYOFFICE_DOCUMENT_BACKEND')return target[key];throw new Error('UNEXPECTED_CONFIGURATION_ACCESS')}})
for(const [name,start] of [['worker',startNativeWorker],['API Sheets runtime',configuredSheetsRuntime]]){
 test(`${name} broker-required denies before credential access or dependency connection`,async()=>{
  const connect=mock.method(net.Socket.prototype,'connect',()=>{throw Error('UNEXPECTED_DEPENDENCY_CONNECTION')})
  try{await assert.rejects(()=>start(protectedEnvironment('broker-required')),e=>e.code==='DOCUMENT_BROKER_UNAVAILABLE');assert.equal(connect.mock.callCount(),0)}finally{connect.mock.restore()}
 })
 test(`${name} rejects unknown backend rather than legacy fallback`,async()=>{
  for(const mode of ['broker','legacy','BROKER-REQUIRED','', 'broker-required '])await assert.rejects(()=>start(protectedEnvironment(mode)),e=>e.code==='DOCUMENT_BACKEND_INVALID')
 })
}
test('legacy compatibility never enables missing experimental runtime flags',async()=>{
 for(const backend of [undefined,'legacy-experimental']){
  const env=backend?{DYOFFICE_DOCUMENT_BACKEND:backend}:{}
  assert.equal(await configuredSheetsRuntime(env),undefined)
  await assert.rejects(()=>startNativeWorker(env),/Explicit experimental worker required/)
  await assert.rejects(()=>configuredSheetsRuntime({...env,DYOFFICE_NATIVE_XLSX:'experimental',DYOFFICE_AUTH_MODE:'local',NODE_ENV:'production'}),/experimental local mode/)
  await assert.rejects(()=>startNativeWorker({...env,DYOFFICE_NATIVE_WORKER:'experimental',DYOFFICE_OBJECT_STORE:'disk'}),/requires S3/)
 }
})
test('actual server entry rejects broker selection before exposing a listener',async()=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),{fileURLToPath}=await import('node:url')
 for(const [mode,message] of [['broker-required','document broker unavailable'],['broker','document backend invalid']]){
  await assert.rejects(()=>promisify(execFile)(process.execPath,['--import','tsx','server/index.mjs'],{cwd:fileURLToPath(new URL('../../',import.meta.url)),env:{PATH:process.env.PATH,DYOFFICE_DOCUMENT_BACKEND:mode},timeout:15000}),error=>{
   assert.equal(error.code,1);assert.match(error.stderr,new RegExp('dyoffice: '+message));assert.ok(!error.stdout.includes('http'));return true
  })
 }
})
