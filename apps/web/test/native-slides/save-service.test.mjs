import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import JSZip from 'jszip'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {openIsolatedPptxSession} from '../../worker/src/native/pptx-session-host.ts'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {createSlidesService} from '../../server/src/modules/slides/service.ts'
import {createSlidesSaveService} from '../../server/src/modules/slides/save.ts'
const bytes=()=>readFile(new URL('../fixtures/slides/acceptance.pptx',import.meta.url))
const host={openSession(input,_signal){return openIsolatedPptxSession({fileId:input.fileId,revision:input.revision,bytes:input.bytes},{timeoutMs:60000,unsafeTestOnly:true})}}
const ops=(el,text)=>[{op:'setText',target:{slide:0,el},paragraphs:[{runs:[{text}]}]}]

async function fixture(t){
 const f=await fileFixture(t),file=await importFile(f,f.alice.token,await bytes(),'acceptance.pptx')
 const leases=createLeaseService({transactions:f.transactions})
 const revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
 const sessions=createSlidesService({files:f.files,leases,revisions,host})
 t.after(()=>sessions.closeAll())
 const saves=createSlidesSaveService({files:f.files,leases,revisions,sessions})
 const editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,file.file.fileId,{editorId})
 return {...f,file,leases,revisions,sessions,saves,editorId,input:{baseRevision:file.file.revision,leaseEpoch:lease.leaseEpoch,editorId}}
}

test('a session export stages a T06 upload and commits exactly once, preserving unrelated parts',async t=>{
 const f=await fixture(t),fileId=f.file.file.fileId
 await f.sessions.open(f.alice.token,fileId,{editorId:f.editorId,leaseEpoch:f.input.leaseEpoch,revision:f.input.baseRevision,generation:0})
 await f.sessions.apply(f.alice.token,fileId,{editorId:f.editorId,leaseEpoch:f.input.leaseEpoch,revision:f.input.baseRevision,generation:0,ops:ops('e_904989a1','web edit')})
 const draft=await f.saves.prepare(f.alice.token,fileId,{...f.input,request:{revision:f.input.baseRevision,generation:1}})
 assert.equal((await f.files.openFile(f.alice.token,fileId)).file.revision,f.input.baseRevision)
 const commit={fileId,uploadId:draft.uploadId,baseRevision:f.input.baseRevision,leaseEpoch:f.input.leaseEpoch,idempotencyKey:randomUUID()}
 const saved=await f.revisions.commitRevision(f.alice.token,commit)
 assert.equal(saved.sha256,draft.sha256);assert.equal(saved.size,draft.size)
 assert.deepEqual(await f.revisions.commitRevision(f.alice.token,commit),saved)
 assert.deepEqual(await f.files.readFile(f.alice.token,fileId,f.input.baseRevision),await bytes())
 const output=await f.files.readFile(f.alice.token,fileId,saved.revision)
 const before=await JSZip.loadAsync(await bytes()),after=await JSZip.loadAsync(output)
 assert.match(await after.file('ppt/slides/slide1.xml').async('string'),/web edit/)
 assert.deepEqual(await before.file('customXml/t10-preserve.xml').async('nodebuffer'),await after.file('customXml/t10-preserve.xml').async('nodebuffer'))
 // The committed head carries the exported bytes: the session can be adopted on it.
 const view=await f.sessions.slides(f.alice.token,fileId,{editorId:f.editorId,leaseEpoch:f.input.leaseEpoch,revision:saved.revision,generation:1})
 assert.equal(view.generation,1)
 // A stale base revision conflicts without staging anything new.
 await assert.rejects(()=>f.saves.prepare(f.alice.token,fileId,{...f.input,request:{revision:f.input.baseRevision,generation:1}}),{statusCode:409})
})

test('save export fences the session generation and a stale one never stages',async t=>{
 const f=await fixture(t),fileId=f.file.file.fileId
 await f.sessions.open(f.alice.token,fileId,{editorId:f.editorId,leaseEpoch:f.input.leaseEpoch,revision:f.input.baseRevision,generation:0})
 await f.sessions.apply(f.alice.token,fileId,{editorId:f.editorId,leaseEpoch:f.input.leaseEpoch,revision:f.input.baseRevision,generation:0,ops:ops('e_904989a1','moved on')})
 const reservedBefore=(await f.files.usage(f.alice.token)).reservedBytes
 await assert.rejects(()=>f.saves.prepare(f.alice.token,fileId,{...f.input,request:{revision:f.input.baseRevision,generation:0}}),{statusCode:409})
 assert.equal((await f.files.usage(f.alice.token)).reservedBytes,reservedBefore)
 const draft=await f.saves.prepare(f.alice.token,fileId,{...f.input,request:{revision:f.input.baseRevision,generation:1}})
 assert.match(draft.sha256,/^[a-f0-9]{64}$/)
 assert.equal(draft.baseRevision,f.input.baseRevision)
 assert.equal(draft.leaseEpoch,f.input.leaseEpoch)
 // Foreign owners cannot stage saves on someone else's session.
 await assert.rejects(()=>f.saves.prepare(f.bob.token,fileId,{...f.input,request:{revision:f.input.baseRevision,generation:1}}),{statusCode:404})
})

test('lease takeover while the export runs fences the output before staging',async t=>{
 const f=await fixture(t),fileId=f.file.file.fileId
 await f.sessions.open(f.alice.token,fileId,{editorId:f.editorId,leaseEpoch:f.input.leaseEpoch,revision:f.input.baseRevision,generation:0})
 let release,started
 const entered=new Promise(resolve=>{started=resolve}),gate=new Promise(resolve=>{release=resolve})
 // Wrap the sessions' exportForSave to pause mid-export.
 const original=f.sessions.exportForSave.bind(f.sessions)
 f.sessions.exportForSave=(token,id,input,signal)=>{started();return gate.then(()=>original(token,id,input,signal))}
 const pending=f.saves.prepare(f.alice.token,fileId,{...f.input,request:{revision:f.input.baseRevision,generation:0}})
 await entered
 await f.leases.takeoverLease(f.alice.token,fileId,{editorId:randomUUID(),expectedEpoch:f.input.leaseEpoch})
 release()
 await assert.rejects(pending,{statusCode:409})
 assert.equal((await f.files.usage(f.alice.token)).reservedBytes,0)
 assert.equal((await f.files.openFile(f.alice.token,fileId)).file.revision,f.input.baseRevision)
})

test('analysis native table and text survive isolated slide apply and an explicit PostgreSQL revision commit',async t=>{
 const {analysisSlideOperations}=await import('../../../slides/src/renderer/analysis-insert.ts')
 const f=await fixture(t),fileId=f.file.file.fileId
 await f.sessions.open(f.alice.token,fileId,{editorId:f.editorId,leaseEpoch:f.input.leaseEpoch,revision:f.input.baseRevision,generation:0})
 const transaction=await f.sessions.apply(f.alice.token,fileId,{editorId:f.editorId,leaseEpoch:f.input.leaseEpoch,revision:f.input.baseRevision,generation:0,ops:[...analysisSlideOperations({kind:'text',text:'<b>literal</b> =1+1'},0,960,540),...analysisSlideOperations({kind:'table',rows:[['=SUM(A1)','<script>literal</script>'],['001','42']]},0,960,540)]})
 assert.equal(transaction.transaction.applied,true)
 assert.equal((await f.files.openFile(f.alice.token,fileId)).file.revision,f.input.baseRevision,'insertion is not a commit')
 const draft=await f.saves.prepare(f.alice.token,fileId,{...f.input,request:{revision:f.input.baseRevision,generation:transaction.generation}})
 const saved=await f.revisions.commitRevision(f.alice.token,{fileId,uploadId:draft.uploadId,baseRevision:f.input.baseRevision,leaseEpoch:f.input.leaseEpoch,idempotencyKey:randomUUID()})
 assert.notEqual(saved.revision,f.input.baseRevision)
 const archive=await JSZip.loadAsync(await f.files.readFile(f.alice.token,fileId,saved.revision)),xml=await archive.file('ppt/slides/slide1.xml').async('string')
 assert.match(xml,/<a:tbl>/);assert.match(xml,/=SUM\(A1\)/);assert.match(xml,/&lt;script&gt;literal&lt;\/script&gt;/);assert.match(xml,/&lt;b&gt;literal&lt;\/b&gt; =1\+1/)
})

test('Ribbon size op survives native export, PostgreSQL commit and a fresh isolated reopen',async t=>{
 const f=await fixture(t),fileId=f.file.file.fileId
 const opened=await f.sessions.open(f.alice.token,fileId,{...f.input,revision:f.input.baseRevision,generation:0})
 const changed=await f.sessions.apply(f.alice.token,fileId,{...f.input,revision:f.input.baseRevision,generation:0,ops:[{op:'setSlideSize',cx:9144000,cy:6858000}]})
 assert.deepEqual(changed.size,{cx:9144000,cy:6858000})
 const draft=await f.saves.prepare(f.alice.token,fileId,{...f.input,request:{revision:f.input.baseRevision,generation:changed.generation}})
 const saved=await f.revisions.commitRevision(f.alice.token,{fileId,uploadId:draft.uploadId,baseRevision:f.input.baseRevision,leaseEpoch:f.input.leaseEpoch,idempotencyKey:randomUUID()})
 const output=await f.files.readFile(f.alice.token,fileId,saved.revision)
 const archive=await JSZip.loadAsync(output)
 assert.match(await archive.file('ppt/presentation.xml').async('string'),/<p:sldSz[^>]*cx="9144000"[^>]*cy="6858000"/)
 assert.deepEqual(await f.files.readFile(f.alice.token,fileId,f.input.baseRevision),await bytes())
 f.sessions.closeAll()
 const fresh=await f.sessions.open(f.alice.token,fileId,{...f.input,revision:saved.revision,generation:0})
 assert.deepEqual(fresh.size,{cx:9144000,cy:6858000})
 assert.equal(fresh.slides.length,opened.slides.length)
 assert.ok(fresh.slides.every(slide=>Math.abs(slide.widthPx/slide.heightPx-4/3)<0.001))
})

test('links and animations preserve both entries across a real PostgreSQL save and fresh native reopen',async t=>{
 const f=await fixture(t),fileId=f.file.file.fileId,request={...f.input,revision:f.input.baseRevision,generation:0}
 await f.sessions.open(f.alice.token,fileId,request)
 const items=[{sourceId:'e_904989a1',effect:'fade',trigger:'onClick',durationMs:700,delayMs:120},{sourceId:'e_904989a1',effect:'wipe',trigger:'afterPrev',durationMs:900,delayMs:40,direction:'top'}],link={kind:'url',url:'https://example.com/presentation'}
 const applied=await f.sessions.apply(f.alice.token,fileId,{...request,ops:[{op:'setLink',target:{slide:0,el:'e_904989a1'},link},{op:'setAnimations',target:{slide:0},items}]})
 const current={...request,generation:applied.generation,index:0}
 assert.equal((await f.sessions.animations(f.alice.token,fileId,current)).length,2)
 await assert.rejects(()=>f.sessions.animations(f.bob.token,fileId,current),{statusCode:404})
 await assert.rejects(()=>f.sessions.links(f.alice.token,fileId,{...current,generation:0}),{statusCode:409})
 const draft=await f.saves.prepare(f.alice.token,fileId,{...f.input,request:{revision:request.revision,generation:applied.generation}})
 const saved=await f.revisions.commitRevision(f.alice.token,{fileId,uploadId:draft.uploadId,baseRevision:f.input.baseRevision,leaseEpoch:f.input.leaseEpoch,idempotencyKey:randomUUID()})
 f.sessions.closeAll()
 const reopened={...request,revision:saved.revision,generation:0,index:0}
 await f.sessions.open(f.alice.token,fileId,reopened)
 const actual=await f.sessions.animations(f.alice.token,fileId,reopened)
 assert.deepEqual(actual.map(({sourceId,targetName,...item})=>item),items.map(({sourceId,...item})=>item))
 assert.ok((await f.sessions.links(f.alice.token,fileId,reopened)).some(item=>item.target.url===link.url))
 assert.deepEqual(await f.files.readFile(f.alice.token,fileId,f.input.baseRevision),await bytes())
})


test('chart read data survives PostgreSQL commit and a fresh native session',async t=>{
 const f=await fixture(t),id=f.file.file.fileId,request={revision:f.input.baseRevision,generation:0,editorId:f.editorId,leaseEpoch:f.input.leaseEpoch}
 await f.sessions.open(f.alice.token,id,request)
 const added=await f.sessions.apply(f.alice.token,id,{...request,ops:[{op:'addChart',target:{slide:0},kind:'bar',title:'Before',categories:['Q1'],series:[{name:'Sales',values:[8]}],offset:{x:95250,y:95250,cx:3000000,cy:2000000}}]})
 const chart=(await f.sessions.slides(f.alice.token,id,{...request,generation:added.generation})).slides[0].nodes.find(node=>node.type==='chart')
 const edit=await f.sessions.editChart(f.alice.token,id,{...request,generation:added.generation,slide:0,sourceId:chart.sourceId,patch:{title:'After',series:[{name:'Sales',values:[42]}],colorScheme:'colorful2'}})
 const current={...request,generation:edit.generation,index:0,sourceId:edit.sourceId},expected=await f.sessions.chartData(f.alice.token,id,current)
 assert.equal(expected.title,'After');assert.deepEqual(expected.series,[{name:'Sales',values:[42]}])
 const schemes=await f.sessions.chartColorSchemes(f.alice.token,id,current)
 const draft=await f.saves.prepare(f.alice.token,id,{...f.input,request:{revision:request.revision,generation:edit.generation}})
 const saved=await f.revisions.commitRevision(f.alice.token,{fileId:id,uploadId:draft.uploadId,baseRevision:f.input.baseRevision,leaseEpoch:f.input.leaseEpoch,idempotencyKey:randomUUID()})
 f.sessions.closeAll();const reopened={...request,revision:saved.revision,generation:0};await f.sessions.open(f.alice.token,id,reopened)
 const savedChart=(await f.sessions.slides(f.alice.token,id,reopened)).slides[0].nodes.find(node=>node.type==='chart')
 assert.deepEqual(await f.sessions.chartData(f.alice.token,id,{...reopened,index:0,sourceId:savedChart.sourceId}),expected)
 assert.deepEqual(await f.sessions.chartColorSchemes(f.alice.token,id,reopened),schemes)
 assert.deepEqual(await f.files.readFile(f.alice.token,id,f.input.baseRevision),await bytes())
})
