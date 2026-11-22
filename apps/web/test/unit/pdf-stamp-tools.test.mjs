import test from 'node:test'
import assert from 'node:assert/strict'
import {createPdfMutations} from '../../src/editors/pdf-mutations.ts'

test('stamp saves stage exactly one configuration and recover the same commit after response loss',async()=>{
 const requests=[],saved=[],controller=new AbortController();let commits=0
 const input={fileId:'file',uploadId:'upload',baseRevision:'old',leaseEpoch:3,idempotencyKey:'same-key'}
 const client=createPdfMutations({fileId:'file',getRevision:()=> 'old',onSaved:async receipt=>saved.push(receipt),request:async(path,method,body)=>{
  requests.push({path,method,body})
  if(path.endsWith('/lease')&&method==='POST')return {leaseEpoch:3}
  if(path.endsWith('/pdf/stamps/uploads'))return {commitInput:input}
  if(path.endsWith('/commits')){if(++commits===1)throw new TypeError('lost response');return {fileId:'file',revision:'new'}}
 }})
 const operation={op:'set_watermark',text:'CONFIDENTIAL'}
 await assert.rejects(client.mutate('stamps',[operation],controller.signal),/lost response/)
 assert.equal(client.hasPending(),true);assert.equal(await client.mutate('stamps',[operation]),false)
 const staged=requests.find(r=>r.path.endsWith('/pdf/stamps/uploads'))
 assert.deepEqual(staged.body.operation,operation);assert.equal('operations' in staged.body,false)
 assert.equal(await client.confirm(),true);assert.deepEqual(saved,[{fileId:'file',revision:'new'}])
 assert.equal(requests.filter(r=>r.path.endsWith('/pdf/stamps/uploads')).length,1)
 assert.deepEqual(requests.filter(r=>r.path.endsWith('/commits')).map(r=>r.body),[input,input])
 assert.equal(await client.mutate('stamps',[]),false)
 assert.equal(await client.mutate('stamps',[operation,operation]),false)
})
