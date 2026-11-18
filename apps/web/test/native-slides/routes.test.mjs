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
const bytes=()=>readFile(new URL('../fixtures/slides/acceptance.pptx',import.meta.url))
const slidesHost={openSession(input,_signal){return openIsolatedPptxSession({fileId:input.fileId,revision:input.revision,bytes:input.bytes},{timeoutMs:60000,unsafeTestOnly:true})}}

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

async function fixture(t){
 const f=await fileFixture(t,{nativeSlidesDirectory:await fakeSlidesDist(t),slidesHost})
 const file=await importFile(f,f.alice.token,await bytes(),'acceptance.pptx')
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey})
 const headers=(token=f.alice.token)=>({cookie:'__Host-dyoffice-session='+token,origin:restrictedOrigin,'x-csrf-token':csrf.sessionToken(token)})
 const leases=createLeaseService({transactions:f.transactions}),editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,file.file.fileId,{editorId})
 return {...f,file,csrf,headers,authority:{editorId,leaseEpoch:lease.leaseEpoch}}
}

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
