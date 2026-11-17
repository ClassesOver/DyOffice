import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createSheetsSaveService} from '../../server/src/modules/sheets/save.ts'

const mutation=()=>({replaced:new Map([['xl/worksheets/sheet1.xml','xml']]),added:new Map(),addedBinary:new Map(),removedEntries:[]})
function fixture({planFromWorkbook,barrier}={}){
  const calls=[],bytes=Buffer.from('authorized immutable bytes'),signal=new AbortController().signal
  let allowed=true
  const check=()=>{if(!allowed)throw Object.assign(new Error('revoked'),{statusCode:404})}
  const files={async openFile(){check();calls.push('head');return {format:'xlsx',file:{revision:'revision'}}},async readFile(){check();calls.push('bytes');return bytes},async receiveUpload(){check();calls.push('receive')},async cancelUpload(){calls.push('cancel')}}
  const leases={async renewLease(){check();calls.push('lease')}}
  const revisions={async stageUpload(){check();calls.push('stage');return {uploadId:'upload'}}}
  const native={async inspect(){calls.push('inspect');return {sheets:[{id:'sheet-1',name:'Acceptance'}]}},async savePlan(input,plan,gotSignal){assert.equal(input,bytes);assert.equal(gotSignal,signal);calls.push('save');await barrier?.();return {bytes:Buffer.from('saved')}}}
  const plan=async()=>{calls.push('legacy-plan');return mutation()}
  const workbook=planFromWorkbook??(async(input,request,gotSignal)=>{assert.equal(input,bytes);assert.deepEqual(request,{edits:[]});assert.equal(gotSignal,signal);calls.push('workbook-plan');return mutation()})
  const service=createSheetsSaveService({files,leases,revisions,native,plan,planFromWorkbook:workbook})
  return {calls,service,signal,revoke(){allowed=false},input:{baseRevision:'revision',leaseEpoch:1,editorId:'editor',request:{edits:[]}}}
}
test('opt-in workbook planner uses authorized bytes and skips only the redundant source inspect',async()=>{
  const f=fixture();await f.service.prepare('owner','file',f.input,f.signal)
  assert.deepEqual(f.calls,['lease','head','bytes','workbook-plan','save','stage','receive','lease'])
})
test('unauthorized principal never reaches either workbook parser or native save',async()=>{
  const f=fixture();f.revoke();await assert.rejects(()=>f.service.prepare('foreign','file',f.input,f.signal),{statusCode:404});assert.deepEqual(f.calls,[])
})
test('revocation during optimized work is rechecked before upload publication',async()=>{
  let f;f=fixture({barrier:async()=>f.revoke()});await assert.rejects(()=>f.service.prepare('owner','file',f.input,f.signal),{statusCode:404})
  assert.equal(f.calls.includes('workbook-plan'),true);assert.equal(f.calls.includes('stage'),false);assert.equal(f.calls.includes('receive'),false)
})
test('workbook planner cancellation never falls back to inspect, saves or stages',async()=>{
  const controller=new AbortController(),f=fixture({planFromWorkbook:async()=>{controller.abort();controller.signal.throwIfAborted()}})
  await assert.rejects(()=>f.service.prepare('owner','file',f.input,controller.signal),{name:'AbortError'})
  assert.deepEqual(f.calls,['lease','head','bytes'])
})
