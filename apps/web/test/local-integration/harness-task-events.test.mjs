import test from 'node:test'
import assert from 'node:assert/strict'
import {createCodingTaskRecoveryStore} from '../../server/src/modules/coding/task-recovery-store.ts'
import {fileFixture,docxBytes,importFile} from '../helpers/files.mjs'

test('Harness task events are ordered, owner-scoped, readable after a sequence and closed by the final state',async t=>{
 const f=await fileFixture(t,{buildApp:false})
 const {file}=await importFile(f,f.alice.token,await docxBytes())
 const store=createCodingTaskRecoveryStore(f.transactions),reader=createCodingTaskRecoveryStore(f.transactions)
 await store.start(f.alice.token,file.fileId,'events-1',{modelId:'fixture'},undefined)
 assert.deepEqual(await reader.events(f.alice.token,file.fileId,'events-1',0),{state:'running',events:[{sequence:1,kind:'state',payload:{state:'running'}}]})
 assert.equal(await store.append(f.alice.token,file.fileId,'events-1',[{kind:'activity',payload:{text:'Running tests'}},{kind:'progress',payload:{text:'ok 1\n'}}]),true)
 // Oversized payloads are dropped instead of failing the batch.
 await store.append(f.alice.token,file.fileId,'events-1',[{kind:'progress',payload:{text:'x'.repeat(9000)}},{kind:'progress',payload:{text:'ok 2\n'}}])
 const page=await reader.events(f.alice.token,file.fileId,'events-1',1)
 assert.deepEqual(page.events.map(event=>[event.sequence,event.kind,event.payload.text]),[[2,'activity','Running tests'],[3,'progress','ok 1\n'],[4,'progress','ok 2\n']])
 await assert.rejects(reader.events(f.bob.token,file.fileId,'events-1',0))
 await assert.rejects(reader.events(f.alice.token,file.fileId,'missing',0),{statusCode:404})
 assert.equal(await store.cancel(f.alice.token,'events-1'),true)
 await store.finish(f.alice.token,file.fileId,'events-1',{modelId:'fixture',state:'failed',failure:'Stopped'})
 const final=await reader.events(f.alice.token,file.fileId,'events-1',4)
 assert.equal(final.state,'failed')
 assert.deepEqual(final.events.map(event=>event.payload),[{state:'cancel_requested'},{state:'failed',failure:'Stopped'}])
 // A finished task accepts no more live events.
 assert.equal(await store.append(f.alice.token,file.fileId,'events-1',[{kind:'activity',payload:{text:'late'}}]),false)
})

test('a task whose lease lapsed reads as unknown_outcome so streams end',async t=>{
 const f=await fileFixture(t,{buildApp:false})
 const {file}=await importFile(f,f.alice.token,await docxBytes())
 const store=createCodingTaskRecoveryStore(f.transactions)
 await store.start(f.alice.token,file.fileId,'lapsed',{modelId:'fixture'},undefined)
 await f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},c=>c.query("UPDATE task_runtime_codex SET lease_until=clock_timestamp()-interval '1 second' WHERE turn_id='lapsed'"))
 const pages=await Promise.all([0,1].map(()=>store.events(f.alice.token,file.fileId,'lapsed',1)))
 assert.ok(pages.every(page=>page.state==='unknown_outcome'&&page.events.length===1&&page.events[0].payload.state==='unknown_outcome'))
 await store.start(f.alice.token,file.fileId,'result',{modelId:'fixture'},undefined)
 await store.finish(f.alice.token,file.fileId,'result',{modelId:'fixture',state:'succeeded',result:{summary:'private'}})
 const final=await store.events(f.alice.token,file.fileId,'result',1)
 assert.deepEqual(final.events.map(e=>[e.kind,e.payload]),[['result',{turnId:'result'}],['state',{state:'succeeded'}]])
})
