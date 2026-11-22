import {createApiShell} from '../../server/src/framework.ts'
import {registerSlidesRoutes} from '../../server/src/modules/slides/routes.ts'
import {createSlidesService} from '../../server/src/modules/slides/service.ts'
import {createSlidesSaveService} from '../../server/src/modules/slides/save.ts'
import {buildLocalApp} from '../../server/src/app.ts'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import JSZip from 'jszip'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {restrictedOrigin} from '../helpers/restricted.mjs'
import {createCsrfService} from '../../server/src/modules/auth/csrf.ts'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {openIsolatedPptxSession} from '../../worker/src/native/pptx-session-host.ts'
import {createSlidesBridge} from '../../src/editors/slides-bridge.ts'
import {auditSlideLayout} from '@genoffice/pipelines/slides/layout-audit'
const bytes=()=>readFile(new URL('../fixtures/slides/acceptance.pptx',import.meta.url))
const slidesHost={openSession(input,_signal){return openIsolatedPptxSession({fileId:input.fileId,revision:input.revision,bytes:input.bytes},{timeoutMs:60000,unsafeTestOnly:true})}}

test('AI layout audit gets the edited page number after a same-batch slide move',async t=>{
 const app=await createApiShell(),fileId=randomUUID(),revision=randomUUID(),editorId=randomUUID(),deck=await bytes()
 const slides=createSlidesService({files:{openFile:async()=>({format:'pptx',file:{revision}}),download:async()=>({format:'pptx',bytes:deck})},leases:{renewLease:async()=>{}},revisions:{},host:slidesHost})
 t.after(async()=>{slides.closeAll();await app.close()})
 registerSlidesRoutes(app,slides,{authenticate:async()=>{}},{originCheck(){},requireSession(){}})
 const bridge=createSlidesBridge({getState:()=>({revision:{revision},name:'deck.pptx',lease:{editorId,leaseEpoch:1}})},fileId,{language:'en'},{fetchImpl:async(url,init)=>{
  if(url==='/api/v1/auth/csrf')return Response.json({csrfToken:'a'.repeat(43)})
  const res=await app.inject({method:init.method,url,payload:JSON.parse(init.body)})
  return new Response(res.body,{status:res.statusCode,headers:{'content-type':'application/json'}})
 }})
 t.after(()=>bridge.dispose())
 const initial=await bridge.api.openPptx(960)
 const result=await bridge.api.applyTxn({ops:[
  {op:'duplicateSlide',target:{slide:0}},
  {op:'setTransform',target:{slide:0,el:'e_904989a1'},box:{x:14000000,y:500000,cx:4000000,cy:1000000}},
  {op:'moveSlide',target:{slide:0},to:1},
 ]})
 assert.equal(result.applied,true,JSON.stringify(result.failures))
 assert.equal(result.slides[1].partPath,initial.slides[0].partPath)
 const editedPage=Number(result.records.find(record=>record.op==='setTransform').target)
 assert.equal(editedPage,1)
 assert.match(auditSlideLayout(result.slides[editedPage]).join('\n'),/Off slide:/)
 const invalid=await app.inject({method:'POST',url:`/api/v1/files/${fileId}/slides/apply`,payload:{revision,editorId,leaseEpoch:1,generation:1,ops:[
  {op:'addTable',target:{slide:1},offset:{x:0,y:0,cx:1000000,cy:1000000},rows:1,cols:1,colWidthsEmu:[0]},
 ]}})
 assert.equal(invalid.statusCode,400)
})

test('AI rollback routes restore multiple native edits and fence lease, revision and generation',async t=>{
 const app=await createApiShell(),fileId=randomUUID(),revision=randomUUID(),editorId=randomUUID(),deck=await bytes()
 let leaseActive=true
 const slides=createSlidesService({files:{openFile:async()=>({format:'pptx',file:{revision}}),download:async()=>({format:'pptx',bytes:deck})},leases:{renewLease:async(_token,_id,input)=>{if(!leaseActive||input.editorId!==editorId||input.leaseEpoch!==1)throw Object.assign(new Error('lease'),{statusCode:409})}},revisions:{},host:slidesHost})
 t.after(async()=>{slides.closeAll();await app.close()})
 registerSlidesRoutes(app,slides,{authenticate:async()=>{}},{originCheck(){},requireSession(){}})
 const post=(method,payload={})=>app.inject({method:'POST',url:`/api/v1/files/${fileId}/slides/${method}`,payload:{revision,editorId,leaseEpoch:1,generation:0,...payload}})
 const original=(await post('open')).json().slides
 const begin=await post('history-batch-begin');assert.equal(begin.statusCode,200,begin.body);assert.deepEqual(begin.json(),{opened:true})
 assert.equal((await post('apply',{ops:[{op:'setText',target:{slide:0,el:'e_904989a1'},paragraphs:[{runs:[{text:'AI text'}]}]}]})).statusCode,200)
 assert.equal((await post('apply',{generation:1,ops:[{op:'setNotes',target:{slide:0},text:'AI notes'}]})).statusCode,200)
 const end=await post('history-batch-end',{generation:2});assert.equal(end.statusCode,200,end.body)
 const snapshotId=end.json().snapshotId;assert.equal(typeof snapshotId,'number');assert.deepEqual(end.json().history,{canUndo:true,canRedo:false})
 for(const input of [{generation:1},{generation:2,revision:randomUUID()},{generation:2,leaseEpoch:2}])assert.equal((await post('snapshot-restore',{snapshotId,...input})).statusCode,409)
 const restored=await post('snapshot-restore',{generation:2,snapshotId});assert.equal(restored.statusCode,200,restored.body);assert.deepEqual(restored.json().slides,original)
 assert.equal((await post('notes',{generation:3,index:0})).json().text,'')
 assert.equal((await post('snapshot-restore',{generation:3,snapshotId})).json().slides,null)
 leaseActive=false
 assert.equal((await post('history-batch-begin',{generation:3})).statusCode,409)
})

// A minimal verified build output so the /native-pptx static route can start.
async function fakeSlidesDist(t){
 const directory=await mkdtemp(join(tmpdir(),'dyoffice-native-slides-'))
 t.after(()=>rm(directory,{recursive:true,force:true}))
 await mkdir(join(directory,'.vite'),{recursive:true})
 await mkdir(join(directory,'assets'),{recursive:true})
 await writeFile(join(directory,'index.html'),'<!doctype html><div id="slides-root"></div>')
 await writeFile(join(directory,'assets','main.js'),'export {}')
 await writeFile(join(directory,'.vite','manifest.json'),JSON.stringify({slides:{file:'assets/main.js',css:[],assets:[]}}))
 await writeFile(join(directory,'.vite','native-assets.json'),JSON.stringify(['assets/main.js']))
 return directory
}

async function fixture(t,deck=bytes){
 const f=await fileFixture(t,{nativeSlidesDirectory:await fakeSlidesDist(t),slidesHost})
 const file=await importFile(f,f.alice.token,await deck(),'acceptance.pptx')
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey})
 const headers=(token=f.alice.token)=>({cookie:'__Host-dyoffice-session='+token,origin:restrictedOrigin,'x-csrf-token':csrf.sessionToken(token)})
 const leases=createLeaseService({transactions:f.transactions}),editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,file.file.fileId,{editorId})
 return {...f,file,csrf,headers,authority:{editorId,leaseEpoch:lease.leaseEpoch}}
}

test('PPTX editor assets cannot advertise editing without a session host',async t=>{
 const f=await fileFixture(t,{buildApp:false})
 const directory=await fakeSlidesDist(t)
 await assert.rejects(async()=>{
  const app=await buildLocalApp({
   db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,
   origin:restrictedOrigin,csrfKey:f.csrfKey,objectStore:f.objects,nativeSlidesDirectory:directory,
  })
  await app.close()
 },{message:'Native slides require a session host'})
})

test('generated pages round trip through the HTTP routes and isolated PPTX worker',async t=>{
 const app=await createApiShell()
 const fileId=randomUUID(),revision=randomUUID(),editorId=randomUUID()
 const input=await JSZip.loadAsync(await bytes())
 const presentation=await input.file('ppt/presentation.xml').async('string')
 input.file('ppt/presentation.xml',presentation.replace('cx="12192000"','cx="9144000"'))
 const deck=await input.generateAsync({type:'nodebuffer'})
 const slides=createSlidesService({
  files:{openFile:async()=>({format:'pptx',file:{revision}}),download:async()=>({format:'pptx',bytes:deck})},
  leases:{renewLease:async()=>{}},revisions:{},host:slidesHost,
 })
 t.after(async()=>{slides.closeAll();await app.close()})
 registerSlidesRoutes(app,slides,{authenticate:async()=>{}},{originCheck(){},requireSession(){}})
 const url='/api/v1/files/'+fileId+'/slides/'
 const post=(method,payload={})=>app.inject({method:'POST',url:url+method,payload:{revision,editorId,leaseEpoch:1,generation:0,...payload}})
 const opened=await post('open')
 assert.equal(opened.statusCode,200,opened.body)
 assert.deepEqual(opened.json().size,{cx:9144000,cy:6858000})
 const titles=['Overview','Results','Methods','Next steps']
 const generated=await Promise.all(titles.map(text=>{
  const specJson=JSON.stringify({elements:[{type:'text',x:40,y:40,w:600,h:120,paragraphs:[{runs:[{text}]}]}]})
  return post('generate-page',{specJson,images:[]})
 }))
 for(const response of generated)assert.equal(response.statusCode,200,response.body)
 const markers=generated.map(response=>response.json().marker)
 const landed=await post('generated-pages',{markers,mode:'replace'})
 assert.equal(landed.statusCode,200,landed.body)
 assert.equal(landed.json().slides.length,titles.length)
 assert.equal(landed.json().generation,1)
 assert.deepEqual(landed.json().size,{cx:12192000,cy:6858000})
 const pageText=landed.json().slides.map(page=>page.nodes.flatMap(node=>node.text?.lines?.flatMap(line=>line.runs.map(run=>run.text))??[]).join(''))
 assert.deepEqual(pageText,titles)
 const undone=await post('undo',{generation:1})
 assert.equal(undone.statusCode,200,undone.body)
 assert.deepEqual(undone.json().size,opened.json().size)
 assert.deepEqual(undone.json().slides,opened.json().slides)
 const added=await post('apply',{generation:2,ops:[{op:'addComment',target:{slide:0},author:'Web User',text:'Review this slide'}]})
 assert.equal(added.statusCode,200,added.body)
 const comments=(await post('comments',{generation:3,index:0})).json()
 assert.deepEqual(comments.map(comment=>comment.text),['Review this slide'])
 const removed=await post('apply',{generation:3,ops:[{op:'deleteComment',target:{slide:0},authorId:comments[0].authorId,idx:comments[0].idx}]})
 assert.equal(removed.statusCode,200,removed.body)
 assert.deepEqual((await post('comments',{generation:4,index:0})).json(),[])
})

test('chart edits preserve the imported chart confirmation and session fences',async t=>{
 const f=await fixture(t,async()=>{
  const session=await slidesHost.openSession({fileId:randomUUID(),revision:randomUUID(),bytes:await bytes()})
  try{
   await session.apply(0,[{op:'addChart',target:{slide:0},kind:'bar',categories:['A'],series:[{name:'S',values:[3]}],offset:{x:1000,y:1000,cx:3000000,cy:2000000}}])
   const zip=await JSZip.loadAsync((await session.exportBytes(1)).bytes)
   const path='ppt/slides/slide1.xml'
   const xml=await zip.file(path).async('string')
   assert.match(xml,/ descr="aislides-chart"/)
   zip.file(path,xml.replace(' descr="aislides-chart"',''))
   return await zip.generateAsync({type:'nodebuffer'})
  }finally{session.close()}
 })
 const url='/api/v1/files/'+f.file.file.fileId+'/slides/'
 const post=(method,input={})=>f.app.inject({method:'POST',url:url+method,headers:f.headers(),payload:{...f.authority,revision:f.file.file.revision,generation:0,...input}})
 const opened=await post('open')
 assert.equal(opened.statusCode,200,opened.body)
 const chart=opened.json().slides[0].nodes.find(node=>node.type==='chart')
 assert.ok(chart && !chart.appCreated)
 const input={slide:0,sourceId:chart.sourceId,patch:{title:'Updated chart'}}
 const direct=await post('apply',{ops:[{op:'setChart',target:{slide:0,el:chart.sourceId},patch:input.patch}]})
 assert.equal(direct.statusCode,400,direct.body)
 const first=await post('chart-edit',input)
 assert.equal(first.statusCode,200,first.body)
 assert.deepEqual(first.json(),{confirmationRequired:true})
 assert.equal((await post('open')).json().dirty,false)
 assert.equal((await post('chart-edit',{...input,confirmed:true,generation:1})).statusCode,409)
 assert.equal((await post('chart-edit',{...input,confirmed:true,leaseEpoch:f.authority.leaseEpoch+1})).statusCode,409)
 const edited=await post('chart-edit',{...input,confirmed:true})
 assert.equal(edited.statusCode,200,edited.body)
 assert.equal(edited.json().generation,1)
 assert.ok(edited.json().slide.nodes.find(node=>node.type==='chart').labels.some(label=>label.text==='Updated chart'))
 const again=await post('chart-edit',{...input,sourceId:edited.json().sourceId,patch:{title:'Another title'},generation:1})
 assert.equal(again.statusCode,200,again.body)
 assert.equal(again.json().generation,2)
})

test('authenticated slides routes pin revisions, fence generations and reject foreign owners',async t=>{
 const f=await fixture(t)
 const url='/api/v1/files/'+f.file.file.fileId+'/slides/'
 const opened=await f.app.inject({method:'POST',url:url+'open',headers:f.headers(),payload:{...f.authority,revision:f.file.file.revision,generation:0,fitWidthPx:1280}})
 assert.equal(opened.statusCode,200,opened.body)
 assert.equal(opened.headers['cache-control'],'private, no-store')
 assert.equal(opened.json().generation,0)
 assert.equal(opened.json().dirty,false)
 assert.equal(opened.json().slides.length,2)
 assert.equal(opened.json().slides[0].partPath,'ppt/slides/slide1.xml')
 assert.deepEqual(opened.json().history,{canUndo:false,canRedo:false})
 assert.equal(Object.hasOwn(opened.json(),'sessionId'),false)
 for(const token of [f.bob.token,f.adminSigned.token])assert.equal((await f.app.inject({method:'POST',url:url+'open',headers:f.headers(token),payload:{...f.authority,revision:f.file.file.revision,generation:0,fitWidthPx:1280}})).statusCode,404)
 assert.equal((await f.app.inject({method:'POST',url:url+'open',headers:f.headers(),payload:{...f.authority,revision:f.file.file.revision,generation:0,fitWidthPx:1280,path:'/etc/passwd'}})).statusCode,400)
 assert.equal((await f.app.inject({method:'POST',url:url+'open',headers:f.headers(),payload:{...f.authority,revision:f.file.file.revision,generation:9,fitWidthPx:1280}})).statusCode,409)
 const applied=await f.app.inject({method:'POST',url:url+'apply',headers:f.headers(),payload:{...f.authority,revision:f.file.file.revision,generation:0,ops:[{op:'setText',target:{slide:0,el:'e_904989a1'},paragraphs:[{runs:[{text:'web edited'}]}]}]}})
 assert.equal(applied.statusCode,200,applied.body)
 assert.deepEqual(applied.json().changed,[0])
 assert.equal(applied.json().dirty,true)
 assert.deepEqual(applied.json().history,{canUndo:true,canRedo:false})
 assert.deepEqual(applied.json().created,[])
 const shapeAdd=await f.app.inject({method:'POST',url:url+'apply',headers:f.headers(),payload:{...f.authority,revision:f.file.file.revision,generation:1,ops:[{op:'addElement',target:{slide:0},kind:'roundRect',offset:{x:914400,y:914400,cx:1828800,cy:914400},fill:'#204060'}]}})
 assert.equal(shapeAdd.statusCode,200,shapeAdd.body)
 assert.match(shapeAdd.json().created[0].id,/^spnew_/)
 assert.equal(shapeAdd.json().created[0].slide,0)
 const notes=await f.app.inject({method:'POST',url:url+'apply',headers:f.headers(),payload:{...f.authority,revision:f.file.file.revision,generation:2,ops:[{op:'setNotes',target:{slide:0},text:'speaker notes'}]}})
 assert.equal(notes.statusCode,200,notes.body)
 assert.equal(notes.json().generation,3)
 assert.equal((await f.app.inject({method:'POST',url:url+'apply',headers:f.headers(),payload:{...f.authority,revision:f.file.file.revision,generation:3,ops:[{op:'addPicture',target:{slide:0},offset:{x:0,y:0,cx:1,cy:1},bytes:'aGk=',ext:'png'}]}})).statusCode,400)
 const image=await f.app.inject({method:'POST',url:url+'media',headers:f.headers(),payload:{...f.authority,revision:f.file.file.revision,generation:3,mode:'insert',slide:9,xPx:0,yPx:0,wPx:100,hPx:100,fitWidthPx:1280,bytesBase64:'aGVsbG8=',ext:'png'}})
 assert.equal(image.statusCode,400,'image route rejects invalid media and slide targets')
 assert.equal((await f.app.inject({method:'POST',url:url+'media',headers:f.headers(),payload:{...f.authority,revision:f.file.file.revision,generation:3,mode:'nope'}})).statusCode,400)
 const slides=await f.app.inject({method:'POST',url:url+'slides',headers:f.headers(),payload:{...f.authority,revision:f.file.file.revision,generation:3}})
 assert.equal(slides.statusCode,200,slides.body)
 assert.equal(slides.json().slides.length,2)
 const single=await f.app.inject({method:'POST',url:url+'slide',headers:f.headers(),payload:{...f.authority,revision:f.file.file.revision,generation:3,index:0,fitWidthPx:640}})
 assert.equal(single.statusCode,200)
 assert.equal(single.json().widthPx,640)
 assert.equal(single.json().partPath,'ppt/slides/slide1.xml')
 const undone=await f.app.inject({method:'POST',url:url+'undo',headers:f.headers(),payload:{...f.authority,revision:f.file.file.revision,generation:3}})
 assert.equal(undone.statusCode,200,undone.body)
 assert.equal(undone.json().generation,4)
 assert.equal(undone.json().dirty,true)
 assert.equal(undone.json().slides.length,2)
 const redone=await f.app.inject({method:'POST',url:url+'redo',headers:f.headers(),payload:{...f.authority,revision:f.file.file.revision,generation:4}})
 assert.equal(redone.statusCode,200)
 assert.equal(redone.json().slides.length,2)
 assert.equal(redone.json().dirty,true,'redo restores the saved-and-further state')
 const draft=await f.app.inject({method:'POST',url:url+'export',headers:f.headers(),payload:{...f.authority,revision:f.file.file.revision,generation:5}})
 assert.equal(draft.statusCode,200,draft.body)
 assert.equal(draft.headers['content-type'],'application/octet-stream')
 assert.equal(draft.headers['x-slides-generation'],'5')
 assert.deepEqual([...draft.body.slice(0,2)],['P','K'])
 // CSRF and origin enforcement mirror every other authenticated route.
 const missingCsrf=f.headers();delete missingCsrf['x-csrf-token']
 assert.equal((await f.app.inject({method:'POST',url:url+'open',headers:missingCsrf,payload:{...f.authority,revision:f.file.file.revision,generation:5,fitWidthPx:1280}})).statusCode,403)
 assert.equal((await f.app.inject({method:'POST',url:url+'open',headers:{...f.headers(),origin:'https://foreign.example'},payload:{...f.authority,revision:f.file.file.revision,generation:5,fitWidthPx:1280}})).statusCode,403)
})

test('slides uploads stage a T06 draft and commit into a new head the session adopts',async t=>{
 const f=await fixture(t)
 const fileId=f.file.file.fileId,base=f.file.file.revision
 const url='/api/v1/files/'+fileId+'/slides/'
 await f.app.inject({method:'POST',url:url+'open',headers:f.headers(),payload:{...f.authority,revision:base,generation:0,fitWidthPx:1280}})
 await f.app.inject({method:'POST',url:url+'apply',headers:f.headers(),payload:{...f.authority,revision:base,generation:0,ops:[{op:'setText',target:{slide:0,el:'e_904989a1'},paragraphs:[{runs:[{text:'committed edit'}]}]}]}})
 const leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
 const editorId=f.authority.editorId,lease=await leases.acquireLease(f.alice.token,fileId,{editorId})
 const draft=await f.app.inject({method:'POST',url:url+'uploads',headers:f.headers(),payload:{baseRevision:base,leaseEpoch:lease.leaseEpoch,editorId,request:{revision:base,generation:1}}})
 assert.equal(draft.statusCode,200,draft.body)
 assert.match(draft.json().sha256,/^[a-f0-9]{64}$/)
 assert.equal(draft.json().baseRevision,base)
 assert.equal(draft.json().leaseEpoch,lease.leaseEpoch)
 assert.equal((await f.files.openFile(f.alice.token,fileId)).file.revision,base)
 const saved=await revisions.commitRevision(f.alice.token,{fileId,uploadId:draft.json().uploadId,baseRevision:base,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID()})
 assert.equal(saved.sha256,draft.json().sha256)
 const output=await f.files.readFile(f.alice.token,fileId,saved.revision)
 const archive=await JSZip.loadAsync(output)
 assert.match(await archive.file('ppt/slides/slide1.xml').async('string'),/committed edit/)
 assert.equal(await archive.file('customXml/t10-preserve.xml').async('string'),'<probe>Untouched custom part</probe>')
 // The stale base now conflicts and the old pin is re-pinned transparently onto the head.
 assert.equal((await f.app.inject({method:'POST',url:url+'uploads',headers:f.headers(),payload:{baseRevision:base,leaseEpoch:lease.leaseEpoch,editorId,request:{revision:base,generation:1}}})).statusCode,409)
 const after=await f.app.inject({method:'POST',url:url+'slides',headers:f.headers(),payload:{...f.authority,revision:saved.revision,generation:1}})
 assert.equal(after.statusCode,200,after.body)
 assert.equal(after.json().generation,1)
})

test('static native slides entry authorizes owners, serves build assets and gates capabilities',async t=>{
 const f=await fixture(t)
 const path='/native-pptx/?fileId='+f.file.file.fileId
 assert.equal((await f.app.inject({url:path})).statusCode,401)
 assert.equal((await f.app.inject({url:path,headers:{cookie:'__Host-dyoffice-session='+f.bob.token}})).statusCode,404)
 const html=await f.app.inject({url:path,headers:{cookie:'__Host-dyoffice-session='+f.alice.token}})
 assert.equal(html.statusCode,200)
 assert.equal(html.headers['cache-control'],'private, no-store')
 assert.equal((await f.app.inject({url:'/native-pptx/assets/main.js'})).statusCode,401)
 assert.equal((await f.app.inject({url:'/native-pptx/assets/main.js',headers:{cookie:'__Host-dyoffice-session='+f.alice.token}})).statusCode,200)
 assert.equal((await f.app.inject({url:'/native-pptx/src/editors/slides-entry.tsx',headers:{cookie:'__Host-dyoffice-session='+f.alice.token}})).statusCode,404)
 assert.deepEqual((await f.app.inject({url:'/api/v1/capabilities',headers:{cookie:'__Host-dyoffice-session='+f.alice.token}})).json(),{docx:'unsupported',xlsx:'unsupported',pptx:'editable',pdf:'unsupported'})
 assert.equal((await f.app.inject({url:'/api/v1/files/'+f.file.file.fileId,headers:{cookie:'__Host-dyoffice-session='+f.alice.token}})).json().capabilities.pptx,'editable')
 const doc=await importFile(f,f.alice.token,Buffer.from('not a docx'),'broken.docx').catch(()=>null)
 void doc
 assert.equal((await f.app.inject({url:'/native-pptx/?fileId='+randomUUID(),headers:{cookie:'__Host-dyoffice-session='+f.alice.token}})).statusCode,404)
})

test('PPTX links and animations read routes use the pinned generation and reject unoffered request fields',async t=>{
 const f=await fixture(t),id=f.file.file.fileId
 const request={revision:f.file.file.revision,generation:0,...f.authority}
 const post=(method,payload,headers=f.headers())=>f.app.inject({method:'POST',url:`/api/v1/files/${id}/slides/${method}`,headers,payload})
 assert.equal((await post('open',request)).statusCode,200)
 const items=[{sourceId:'e_904989a1',effect:'fade',trigger:'onClick',durationMs:500,delayMs:0}]
 const target={slide:0,el:'e_904989a1'},paragraphs=[{runs:[
  {text:'Plain ',link:null,redact:null},
  {text:'Details',link:{kind:'url',url:'https://example.com/details'},redact:null},
  {text:'Next',link:{kind:'slide',slideIndex:1},redact:null},
 ]}]
 const edit=await post('apply',{...request,ops:[{op:'setText',target,paragraphs},{op:'setLink',target,link:{kind:'url',url:'https://example.com'}},{op:'setAnimations',target:{slide:0},items}]})
 assert.equal(edit.statusCode,200,edit.body)
 const current={...request,generation:edit.json().generation,index:0}
 assert.equal((await post('animations',current)).json()[0].durationMs,500)
 assert.equal((await post('links',current)).json()[0].target.url,'https://example.com')
 const runs=await post('run-links',current)
 assert.equal(runs.statusCode,200,runs.body)
 const render=await post('slides',{...request,generation:current.generation})
 assert.equal(render.statusCode,200,render.body)
 const sourceId=render.json().slides[0].nodes.find(node=>JSON.stringify(node).includes('"text":"Details"'))?.sourceId
 assert.ok(sourceId,'run link IDs must match the render nodes used for hit testing')
 assert.deepEqual(runs.json(),[
  {sourceId,paraIndex:0,runIndex:1,target:{kind:'url',url:'https://example.com/details'}},
  {sourceId,paraIndex:0,runIndex:2,target:{kind:'slide',slideIndex:1}},
 ])
 for(const method of ['animations','links','run-links']){
  assert.equal((await post(method,{...current,generation:0})).statusCode,409)
  assert.equal((await post(method,{...current,path:'/etc/passwd'})).statusCode,400)
  assert.equal((await post(method,current,f.headers(f.bob.token))).statusCode,404)
 }
 assert.equal((await post('run-links',{...current,leaseEpoch:current.leaseEpoch+1})).statusCode,409)
 assert.equal((await post('apply',{...request,generation:current.generation,ops:[{op:'setText',target,paragraphs:[{runs:[{text:'Rejected',link:{kind:'url',url:'file:///report.pdf'}}]}]}]})).statusCode,400)
 assert.deepEqual((await post('run-links',current)).json(),runs.json())
 const clear=await post('apply',{...request,generation:current.generation,ops:[{op:'setLink',target,link:null}]})
 assert.equal(clear.statusCode,200,clear.body)
 const cleared={...current,generation:clear.json().generation}
 assert.deepEqual((await post('links',cleared)).json(),[])
 const withoutSourceIds=links=>links.map(({sourceId,...link})=>link)
 assert.deepEqual(withoutSourceIds((await post('run-links',cleared)).json()),withoutSourceIds(runs.json()))

 const draft=await post('uploads',{...f.authority,baseRevision:request.revision,request:{revision:request.revision,generation:cleared.generation}})
 assert.equal(draft.statusCode,200,draft.body)
 const revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
 const saved=await revisions.commitRevision(f.alice.token,{fileId:id,uploadId:draft.json().uploadId,baseRevision:request.revision,leaseEpoch:request.leaseEpoch,idempotencyKey:randomUUID()})
 const fresh=await slidesHost.openSession({fileId:id,revision:saved.revision,bytes:await f.files.readFile(f.alice.token,id,saved.revision)})
 t.after(()=>fresh.close())
 assert.deepEqual(withoutSourceIds(await fresh.runLinks(0,0)),withoutSourceIds(runs.json()))
 assert.deepEqual(await fresh.links(0,0),[])
})


test('PPTX chart reads enforce owner generation lease and strict input schema',async t=>{
 const f=await fixture(t),id=f.file.file.fileId,request={revision:f.file.file.revision,generation:0,...f.authority}
 const post=(method,payload,headers=f.headers())=>f.app.inject({method:'POST',url:`/api/v1/files/${id}/slides/${method}`,headers,payload})
 assert.equal((await post('open',request)).statusCode,200)
 const edit=await post('apply',{...request,ops:[{op:'addChart',target:{slide:0},kind:'bar',title:'Actual',categories:['Q1'],series:[{name:'Sales',values:[8]}],offset:{x:95250,y:95250,cx:3000000,cy:2000000}}]})
 assert.equal(edit.statusCode,200,edit.body)
 const view=await post('slides',{...request,generation:edit.json().generation}),chart=view.json().slides[0].nodes.find(node=>node.type==='chart')
 const current={...request,generation:edit.json().generation},queries=[['chart-data',{...current,index:0,sourceId:chart.sourceId}],['chart-color-schemes',current]]
 assert.equal((await post(...queries[0])).json().title,'Actual')
 assert.equal((await post(...queries[1])).json()[1].key,'colorful')
 for(const [method,input] of queries){
  assert.equal((await post(method,{...input,generation:0})).statusCode,409)
  assert.equal((await post(method,{...input,path:'/etc/passwd'})).statusCode,400)
  assert.equal((await post(method,input,f.headers(f.bob.token))).statusCode,404)
  assert.equal((await post(method,{...input,leaseEpoch:input.leaseEpoch+1})).statusCode,409)
 }
})

test('master edits are lease and generation fenced and exported from the original package', async t => {
 const app = await createApiShell(), fileId = randomUUID(), revision = randomUUID(), editorId = randomUUID()
 const deck = await bytes()
 const slides = createSlidesService({
  files:{openFile:async()=>({format:'pptx',file:{revision}}),download:async()=>({format:'pptx',bytes:deck})},
  leases:{renewLease:async(_token,_id,input)=>{if(input.editorId!==editorId||input.leaseEpoch!==1)throw Object.assign(new Error('lease'),{statusCode:409})}},
  revisions:{}, host:slidesHost,
 })
 t.after(async()=>{slides.closeAll();await app.close()})
 registerSlidesRoutes(app, slides, {authenticate:async()=>{}}, {originCheck(){},requireSession(){}})
 const post = (method,payload={}) => app.inject({method:'POST',url:`/api/v1/files/${fileId}/slides/${method}`,payload:{revision,editorId,leaseEpoch:1,generation:0,...payload}})
 assert.equal((await post('open')).statusCode,200)
 const listed = await post('master-parts',{fitWidthPx:960})
 assert.equal(listed.statusCode,200,listed.body)
 const partPath = listed.json().items.find(item=>item.kind==='master').partPath
 const operation = {op:'addElement',kind:'textbox',offset:{x:0,y:0,cx:5000000,cy:400000},paragraphs:[{runs:[{text:'RouteMasterRoundTrip'}]}]}
 assert.equal((await post('master-edit',{leaseEpoch:2,partPath,operation})).statusCode,409)
 assert.equal((await post('master-edit',{partPath:'ppt/slides/slide1.xml',operation})).statusCode,400)
 const edited = await post('master-edit',{partPath,operation})
 assert.equal(edited.statusCode,200,edited.body)
 assert.equal(edited.json().generation,1)
 assert.equal(edited.json().dirty,true)
 assert.ok(edited.json().sourceId)
 assert.equal((await post('master-edit',{partPath,operation})).statusCode,409)
 const exported = await post('export',{generation:1})
 assert.equal(exported.statusCode,200,exported.body)
 const saved = await JSZip.loadAsync(exported.rawPayload)
 assert.match(await saved.file(partPath).async('string'),/RouteMasterRoundTrip/)

 slides.closeAll()
 const bridge=createSlidesBridge({getState:()=>({revision:{revision},name:'deck.pptx',lease:{editorId,leaseEpoch:1}})},fileId,{language:'en'},{fetchImpl:async(url,init)=>{
  if(url==='/api/v1/auth/csrf')return Response.json({csrfToken:'a'.repeat(43)})
  const response=await app.inject({method:init.method,url,payload:JSON.parse(init.body)})
  return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}})
 }})
 t.after(()=>bridge.dispose())
 await bridge.api.openPptx(960)
 const master = await bridge.api.masterEnter(960)
 assert.equal(master.items[0].partPath,partPath)
 const layout = master.items.find(item=>item.kind==='layout')
 assert.ok(await bridge.api.masterOpen(layout.partPath))
 const inserted = await bridge.api.masterAddElement({kind:'textbox',xPx:20,yPx:40,wPx:375,hPx:60,fitWidthPx:960,paragraphs:[{runs:[{text:'BridgeMasterLayout'}]}]})
 assert.ok(inserted.slide.nodes.some(node=>node.sourceId===inserted.sourceId))
 await bridge.api.masterEditText({sourceId:inserted.sourceId,paragraphs:[{runs:[{text:'StableLayoutElement'}]}]})
 assert.ok((await bridge.api.masterClose()).length)
 assert.equal(await bridge.api.isDirty(),true)
 const savedLayout = await post('export',{generation:2})
 assert.equal(savedLayout.statusCode,200)
 assert.match(await (await JSZip.loadAsync(savedLayout.rawPayload)).file(layout.partPath).async('string'),/StableLayoutElement/)
})
