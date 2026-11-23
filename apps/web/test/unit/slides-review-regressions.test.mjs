import {test} from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import {createSlidesService} from '../../server/src/modules/slides/service.ts'
import {createSlidesSaveService} from '../../server/src/modules/slides/save.ts'
import {registerSlidesRoutes} from '../../server/src/modules/slides/routes.ts'
import {openIsolatedPptxSession} from '../../worker/src/native/pptx-session-host.ts'
const file='11111111-1111-4111-8111-111111111111',revision='22222222-2222-4222-8222-222222222222',editor='33333333-3333-4333-8333-333333333333'
const authority={editorId:editor,leaseEpoch:1},input={revision,generation:0,...authority}
function fixture(t){
 let current=revision,epoch=1,owner='a',applied=0,closed=0
 const files={openFile:async()=>({format:'pptx',file:{revision:current,sha256:'x'}}),download:async()=>({format:'pptx',bytes:new Uint8Array([1])})}
 const leases={renewLease:async(token,_file,a)=>{if(token!==owner||a.editorId!==editor||a.leaseEpoch!==epoch)throw Object.assign(Error('lost'),{statusCode:409})}}
 const handle={close(){closed++},outline:async()=>({size:{cx:1,cy:1}}),renderAll:async()=>[],apply:async()=>{applied++;return {generation:1,stateGeneration:1,transaction:{applied:true},records:[],created:[],slideIds:[],paths:[],canUndo:true,canRedo:false}},exportBytes:async()=>({generation:0,bytes:Buffer.from('old draft')})}
 const s=createSlidesService({files,leases,host:{openSession:async()=>handle}});t.after(()=>s.closeAll())
 return {s,files,leases,applied:()=>applied,closed:()=>closed,takeover(){epoch++},newHead(){current='44444444-4444-4444-8444-444444444444';return current},otherSession(){owner='b'}}
}
test('real route accepts bridge open/slide bodies without optional fitWidthPx',async t=>{
 const app=Fastify();t.after(()=>app.close())
 registerSlidesRoutes(app,{open:async()=>({ok:true}),slide:async()=>({ok:true})},{authenticate:async()=>{}},{originCheck(){},requireSession(){}})
 for(const [method,extra]of [['open',{}],['slide',{index:0}]]){
  const r=await app.inject({method:'POST',url:`/api/v1/files/${file}/slides/${method}`,payload:{...input,...extra}})
  assert.equal(r.statusCode,200,r.body)
 }
})
test('missing or stale lease cannot mutate native state',async t=>{
 const f=fixture(t);await f.s.open('a',file,input)
 await assert.rejects(()=>f.s.apply('a',file,{revision,generation:0,ops:[]}),{statusCode:400})
 f.takeover();await assert.rejects(()=>f.s.apply('a',file,{...input,ops:[]}),{statusCode:409});assert.equal(f.applied(),0)
})
test('same file draft is not reused across authenticated sessions or lease epochs',async t=>{
 const f=fixture(t);await f.s.open('a',file,input);f.otherSession()
 await assert.rejects(()=>f.s.apply('b',file,{...input,ops:[]}),{statusCode:409});assert.equal(f.applied(),0)
 await f.s.open('b',file,input);assert.equal(f.closed(),1)
})
test('unrelated head movement invalidates stale pinned draft',async t=>{
 const f=fixture(t);await f.s.open('a',file,input);f.newHead()
 await assert.rejects(()=>f.s.apply('a',file,{...input,ops:[]}),{statusCode:409});assert.equal(f.applied(),0)
})
test('save rejects old session revision paired with a newer base before export/stage',async()=>{
 let work=0
 const save=createSlidesSaveService({files:{},leases:{renewLease:async()=>{}},revisions:{stageUpload:async()=>{work++}},sessions:{exportForSave:async()=>{work++}}})
 await assert.rejects(()=>save.prepare('a',file,{baseRevision:'44444444-4444-4444-8444-444444444444',...authority,request:{revision,generation:0}}),{statusCode:409});assert.equal(work,0)
})
test('ordinary fork is fail-closed by default rather than advertised as sandbox',async()=>{
 await assert.rejects(()=>openIsolatedPptxSession({fileId:file,revision,bytes:new Uint8Array([1])}),/PPTX_OS_ISOLATION_UNAVAILABLE/)
})
test('actual bridge request passes real Fastify open schema and sends lease identity',async t=>{
 const {createSlidesBridge}=await import('../../src/editors/slides-bridge.ts')
 const app=Fastify();t.after(()=>app.close());let received
 registerSlidesRoutes(app,{open:async(_t,_f,body)=>{received=body;return {generation:0,dirty:false,slides:[],size:{cx:1,cy:1}}}},{authenticate:async()=>{}},{originCheck(){},requireSession(){}})
 const host={getState:()=>({revision:{revision},name:'deck.pptx',lease:authority})}
 const bridge=createSlidesBridge(host,file,{language:'en',theme:'light'},{fetchImpl:async(url,options)=>{
  if(url==='/api/v1/auth/csrf')return Response.json({csrfToken:'a'.repeat(43)})
  const r=await app.inject({method:options.method,url,headers:options.headers,payload:options.body});return new Response(r.body,{status:r.statusCode,headers:r.headers})
 }})
 t.after(()=>bridge.dispose());await bridge.api.openPptx(1280);assert.equal(received.editorId,editor);assert.equal(received.leaseEpoch,1)
})
test('lease lost during native work discards the draft and returns no success',async t=>{
 let release,entered,closed=0,epoch=1
 const gate=new Promise(r=>release=r),start=new Promise(r=>entered=r)
 const handle={close(){closed++},outline:async()=>({size:{cx:1,cy:1}}),renderAll:async()=>[],apply:async()=>{entered();await gate;return {generation:1,stateGeneration:1,transaction:{applied:true},records:[],slideIds:[],paths:[],created:[]}}}
 const s=createSlidesService({files:{openFile:async()=>({format:'pptx',file:{revision}}),download:async()=>({format:'pptx',bytes:new Uint8Array([1])})},leases:{renewLease:async(_t,_f,a)=>{if(a.leaseEpoch!==epoch)throw Object.assign(Error(),{statusCode:409})}},host:{openSession:async()=>handle}});t.after(()=>s.closeAll())
 await s.open('a',file,input);const pending=s.apply('a',file,{...input,ops:[]});await start;epoch=2;release()
 await assert.rejects(pending,{statusCode:409});assert.equal(closed,1)
})
test('deployment assembly rejects incomplete slides configuration without File API',async()=>{
 const {buildLocalApp}=await import('../../server/src/app.ts')
 await assert.rejects(()=>buildLocalApp({slidesHost:{openSession(){throw Error('must not execute')}}}),/Cannot read properties|File API/)
 await assert.rejects(()=>buildLocalApp({nativeSlidesDirectory:'/tmp/test'}),/Cannot read properties|File API/)
})
test('delayed old-pin apply after own export commit cannot mutate or destroy live draft',async t=>{
 const {createHash}=await import('node:crypto');let head=revision,sha='original',applied=0,closed=0
 const bytes=Buffer.from('own-export'),handle={close(){closed++},outline:async()=>({size:{cx:1,cy:1}}),renderAll:async()=>[],exportBytes:async()=>({generation:0,bytes}),apply:async()=>{applied++;return {generation:1,stateGeneration:1,transaction:{applied:true},records:[],slideIds:[],paths:[],created:[]}}}
 const s=createSlidesService({files:{openFile:async()=>({format:'pptx',file:{revision:head,sha256:sha}}),download:async()=>({format:'pptx',bytes:new Uint8Array([1])})},leases:{renewLease:async()=>{}},revisions:{verifyUploadCommit:async(_t,_f,p)=>{assert.equal(p.uploadId,'55555555-5555-4555-8555-555555555555')}},host:{openSession:async()=>handle}});t.after(()=>s.closeAll())
 await s.open('a',file,input);await s.exportForSave('a',file,input);await s.bindPreparedUpload('a',file,{...input,uploadId:'55555555-5555-4555-8555-555555555555'});head='44444444-4444-4444-8444-444444444444';sha=createHash('sha256').update(bytes).digest('hex')
 await assert.rejects(()=>s.apply('a',file,{...input,ops:[]}),{statusCode:409});assert.equal(applied,0);assert.equal(closed,0)
 await s.open('a',file,{...input,revision:head});assert.equal(closed,0)
})
test('save after undo adopts the exported state generation rather than IPC generation',async t=>{
 const {createHash}=await import('node:crypto');let head=revision,sha='original'
 const bytes=Buffer.from('undo-state'),handle={close(){},outline:async()=>({size:{cx:1,cy:1}}),renderAll:async()=>[],apply:async()=>({generation:1,stateGeneration:1,transaction:{applied:true},records:[],slideIds:[],paths:[],created:[]}),undo:async()=>({generation:2,stateGeneration:0,slides:[],canUndo:false,canRedo:true}),exportBytes:async()=>({generation:2,bytes})}
 const s=createSlidesService({files:{openFile:async()=>({format:'pptx',file:{revision:head,sha256:sha}}),download:async()=>({format:'pptx',bytes:new Uint8Array([1])})},leases:{renewLease:async()=>{}},revisions:{verifyUploadCommit:async(_t,_f,p)=>{assert.equal(p.uploadId,'55555555-5555-4555-8555-555555555555')}},host:{openSession:async()=>handle}});t.after(()=>s.closeAll())
 await s.open('a',file,input);await s.apply('a',file,{...input,ops:[]});await s.undo('a',file,{...input,generation:1});await s.exportForSave('a',file,{...input,generation:2});await s.bindPreparedUpload('a',file,{...input,generation:2,uploadId:'55555555-5555-4555-8555-555555555555'})
 head='44444444-4444-4444-8444-444444444444';sha=createHash('sha256').update(bytes).digest('hex')
 assert.equal((await s.open('a',file,{...input,revision:head,generation:2})).dirty,false)
})
test('same-hash foreign revision is not adopted as this session commit',async t=>{
 const {createHash}=await import('node:crypto');let head=revision,sha='original',applied=0
 const bytes=Buffer.from('same bytes'),handle={close(){},outline:async()=>({size:{cx:1,cy:1}}),renderAll:async()=>[],exportBytes:async()=>({generation:0,bytes}),apply:async()=>{applied++;return {generation:1,stateGeneration:1,transaction:{applied:true},records:[],slideIds:[],paths:[],created:[]}}}
 const s=createSlidesService({files:{openFile:async()=>({format:'pptx',file:{revision:head,sha256:sha}}),download:async()=>({format:'pptx',bytes:new Uint8Array([1])})},leases:{renewLease:async()=>{}},revisions:{verifyUploadCommit:async()=>{throw Object.assign(Error('foreign'),{statusCode:409})}},host:{openSession:async()=>handle}});t.after(()=>s.closeAll())
 await s.open('a',file,input);await s.exportForSave('a',file,input);await s.bindPreparedUpload('a',file,{...input,uploadId:'55555555-5555-4555-8555-555555555555'})
 head='44444444-4444-4444-8444-444444444444';sha=createHash('sha256').update(bytes).digest('hex')
 await assert.rejects(()=>s.apply('a',file,{...input,revision:head,ops:[]}),{statusCode:409});assert.equal(applied,0)
})

test('large slides apply bodies are accepted only for one analysis picture batch', async () => {
  const { assertApplySize } = await import('../../server/src/modules/slides/routes.ts')
  const big = 'x'.repeat(300 * 1024)
  assert.doesNotThrow(() => assertApplySize([{ op: 'addElement', text: 'small' }]))
  assert.doesNotThrow(() => assertApplySize([{ op: 'addPicture', bytes: big }, { op: 'addElement', text: 'Source: s' }]))
  for (const ops of [[{ op: 'addElement', text: big }], [{ op: 'addPicture', bytes: big }, { op: 'addPicture', bytes: 'y' }], [{ op: 'addPicture', bytes: big }, { op: 'a' }, { op: 'b' }]])
    assert.throws(() => assertApplySize(ops), error => error.statusCode === 413)
})
