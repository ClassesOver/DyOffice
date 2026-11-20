import test from 'node:test'
import assert from 'node:assert/strict'
import {createEmptyPdfPendingSnapshot} from '../../src/editors/pdf-pending-ops.ts'
import {queryPdfPendingPreview} from '../../src/editors/pdf-pending-preview.ts'

const snapshot=()=>createEmptyPdfPendingSnapshot({fileId:'file',baseRevision:'rev',generation:3,pageGeometries:[{pw:300,ph:200,rot:0}],savedFields:[]})
const pdf=Buffer.from('%PDF-1.7\npreview bytes').toString('base64')
const query=queryPdfPendingPreview

test('pending PDF preview freezes its exact generation before awaiting the read-only query',async()=>{
 const input=structuredClone(snapshot());let finish,seen
 const work=query(async(url,method,payload,signal)=>{seen={url,method,payload,signal};await new Promise(resolve=>{finish=resolve});return {revision:'rev',generation:3,pdf}},input)
 input.generation=4;input.rotations[0]=90;finish()
 const result=await work
 assert.equal(seen.url,'/api/v1/files/file/pdf/apply-ops/query');assert.equal(seen.method,'POST')
 assert.equal(seen.payload.snapshot.generation,3);assert.deepEqual(seen.payload.snapshot.rotations,{})
 assert.equal(result.generation,3);assert.equal(result.revision,'rev');assert.equal(Buffer.from(result.bytes).toString(),'%PDF-1.7\npreview bytes')
})

test('invalid mismatched or canceled preview results never yield PDF bytes',async()=>{
 for(const response of [{revision:'old',generation:3,pdf},{revision:'rev',generation:4,pdf},{revision:'rev',generation:3,pdf:'SGVsbG8='},{revision:'rev',generation:3,pdf:'%%%%'},{revision:'rev',generation:3,pdf:'JVBERi0=extra'},{revision:'rev',generation:3,pdf:''}])await assert.rejects(query(async()=>response,snapshot()))
 const abort=new AbortController()
 await assert.rejects(query(async()=>{abort.abort();return {revision:'rev',generation:3,pdf}},snapshot(),abort.signal),{name:'AbortError'})
 let requests=0
 await assert.rejects(query(async()=>{requests++;return {}},snapshot(),abort.signal),{name:'AbortError'});assert.equal(requests,0)
})
