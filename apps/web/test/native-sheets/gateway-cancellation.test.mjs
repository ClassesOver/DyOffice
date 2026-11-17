import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createSheetsService} from '../../server/src/modules/sheets/service.ts'
import {createSheetsSaveService} from '../../server/src/modules/sheets/save.ts'

test('package parsing receives the request cancellation signal',async()=>{
  const controller=new AbortController()
  const service=createSheetsService({files:{download:async()=>({format:'xlsx',bytes:Buffer.from('input')}),openFile:async()=>({})},native:{},readPackage:async(bytes,signal)=>{assert.equal(signal,controller.signal);controller.abort();signal.throwIfAborted()}})
  await assert.rejects(()=>service.readPackage('token','file','revision',controller.signal),{name:'AbortError'})
})
test('save planning receives cancellation and cannot proceed to native output or staging',async()=>{
  const controller=new AbortController()
  const service=createSheetsSaveService({files:{openFile:async()=>({format:'xlsx',file:{revision:'revision'}}),readFile:async()=>Buffer.from('input')},leases:{renewLease:async()=>({})},revisions:{stageUpload:async()=>assert.fail('must not stage after cancellation')},native:{inspect:async()=>({sheets:[]}),savePlan:async()=>assert.fail('must not save after cancellation')},plan:async(bytes,sheets,request,signal)=>{assert.equal(signal,controller.signal);controller.abort();signal.throwIfAborted()}})
  await assert.rejects(()=>service.prepare('token','file',{baseRevision:'revision',leaseEpoch:1,editorId:'editor',request:{}},controller.signal),{name:'AbortError'})
})
