import test from 'node:test'
import assert from 'node:assert/strict'
import { previewTrashRetention } from '../../server/src/modules/files/retention-preview.ts'
const deploymentId='00000000-0000-4000-8000-000000000001', ownerId='00000000-0000-4000-8000-000000000002'
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const row=(n=3, extra={})=>({id:id(n),deploymentId,ownerId,deletedAtMs:1000,purgeStarted:false,purged:false,activeJobs:0,receivingUploads:0,uncertainUploads:0,...extra})
const input=(extra={})=>({scope:{deploymentId,ownerId},nowMs:10000,policy:{enabled:true,retainForMs:9000},limit:10,files:[row()],...extra})
test('explicit age boundary yields review only, not purge authority',()=>assert.deepEqual(previewTrashRetention(input()),{kind:'review_only',candidates:[{fileId:id(3),deletedAtMs:1000}],blocked:{},truncated:false}))
test('disabled or absent policy never inspects candidates',()=>{
 for(const policy of [undefined,{enabled:false}]) assert.deepEqual(previewTrashRetention(input({policy})),{kind:'disabled',candidates:[],blocked:{},truncated:false})
})
test('too recent/live/future timestamps are not selected',()=>{
 const out=previewTrashRetention(input({files:[row(3,{deletedAtMs:1001}),row(4,{deletedAtMs:null}),row(5,{deletedAtMs:10001})]}))
 assert.deepEqual(out.candidates,[]); assert.deepEqual(out.blocked,{not_old_enough:1,not_trashed:1,invalid_snapshot:1})
})
test('foreign owner or deployment rejects the whole snapshot',()=>{
 for(const extra of [{ownerId:id(99)},{deploymentId:id(99)}]) assert.throws(()=>previewTrashRetention(input({files:[row(),row(4,extra)]})),/Invalid retention preview/)
})
test('active jobs, receiving and uncertain uploads block candidates',()=>{
 const out=previewTrashRetention(input({files:[row(3,{activeJobs:1}),row(4,{receivingUploads:1}),row(5,{uncertainUploads:1})]}))
 assert.deepEqual(out.candidates,[]); assert.deepEqual(out.blocked,{active_jobs:1,receiving_uploads:1,uncertain_uploads:1})
})
test('started and completed purges are never automatically resumed',()=>{
 const out=previewTrashRetention(input({files:[row(3,{purgeStarted:true}),row(4,{purgeStarted:true,purged:true})]}))
 assert.deepEqual(out.candidates,[]); assert.deepEqual(out.blocked,{purge_in_progress:1,already_purged:1})
})
test('bounded deterministic oldest-first selection with stable ID ties',()=>{
 const files=[row(6),row(5,{deletedAtMs:900}),row(4,{deletedAtMs:900}),row(3)]
 const out=previewTrashRetention(input({files,limit:2})); assert.deepEqual(out.candidates.map(x=>x.fileId),[id(4),id(5)]); assert.equal(out.truncated,true)
 assert.deepEqual(out,previewTrashRetention(input({files:[...files].reverse(),limit:2})))
})
test('does not mutate supplied snapshot or policy',()=>{
 const data=input({files:Object.freeze([Object.freeze(row())])}); Object.freeze(data.scope);Object.freeze(data.policy);Object.freeze(data)
 assert.equal(previewTrashRetention(data).candidates.length,1)
})
test('invalid policy/clock/limits reject',()=>{
 for(const value of [0,-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1]) {
 assert.throws(()=>previewTrashRetention(input({policy:{enabled:true,retainForMs:value}})),/Invalid retention preview/)
 assert.throws(()=>previewTrashRetention(input({limit:value})),/Invalid retention preview/)
 }
 assert.throws(()=>previewTrashRetention(input({limit:101})),/Invalid retention preview/)
 assert.throws(()=>previewTrashRetention(input({nowMs:-1})),/Invalid retention preview/)
})
test('duplicate IDs, excessive snapshots, and incomplete rows reject',()=>{
 for(const files of [[row(),row()],Array.from({length:1001},(_,i)=>row(i+3)),[{id:id(3),deploymentId,ownerId}]]) assert.throws(()=>previewTrashRetention(input({files})),/Invalid retention preview/)
})
test('malformed state fields reject instead of assuming idle',()=>{
 for(const extra of [{activeJobs:-1},{uncertainUploads:NaN},{receivingUploads:'0'},{purgeStarted:'false'},{purged:null},{deletedAtMs:'1000'}]) assert.throws(()=>previewTrashRetention(input({files:[row(3,extra)]})),/Invalid retention preview/)
})
test('disabled policy does not read file list',()=>{
 const data={policy:{enabled:false},get files(){throw Error('must not inspect')}}
 assert.equal(previewTrashRetention(data).kind,'disabled')
})
test('result is immutable and independent of later source changes',()=>{
 const data=input(),out=previewTrashRetention(data); data.files[0].deletedAtMs=99
 assert.equal(out.candidates[0].deletedAtMs,1000)
 assert.throws(()=>out.candidates.push({fileId:id(10),deletedAtMs:1}),TypeError)
 assert.throws(()=>{out.candidates[0].fileId=id(10)},TypeError)
 assert.throws(()=>{out.blocked.active_jobs=3},TypeError)
})
test('unknown policy state does not silently enable a preview',()=>{
 for(const policy of [null,{}, {enabled:'true'},{enabled:true}]) assert.throws(()=>previewTrashRetention(input({policy})),/Invalid retention preview/)
})
test('very long explicit retention selects nothing and zero epoch remains valid',()=>{
 assert.deepEqual(previewTrashRetention(input({policy:{enabled:true,retainForMs:Number.MAX_SAFE_INTEGER}})).candidates,[])
 assert.equal(previewTrashRetention(input({nowMs:1,policy:{enabled:true,retainForMs:1},files:[row(3,{deletedAtMs:0})]})).candidates.length,1)
})
