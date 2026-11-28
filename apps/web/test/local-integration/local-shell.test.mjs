import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {fileFixture,docxBytes,importFile} from '../helpers/files.mjs'
import {restrictedOrigin} from '../helpers/restricted.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {createCsrfService,SESSION_COOKIE} from '../../server/src/modules/auth/csrf.ts'
const directory=fileURLToPath(new URL('../../dist-local-shell',import.meta.url))
test('built local Home is public login chrome while files and preferences stay user scoped',async t=>{
 const f=await fileFixture(t)
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin:restrictedOrigin,csrfKey:f.csrfKey,objectStore:f.objects,localShellDirectory:directory})
 f.cleanup.push(()=>app.close())
 const imported=await importFile(f,f.alice.token,await docxBytes(),'alice-private.docx')
 const root=await app.inject('/');assert.equal(root.statusCode,200);assert.match(root.body,/<div id="app">/);assert.equal(root.body.includes('alice'),false)
 assert.equal((await app.inject('/api/v1/files')).statusCode,401)
 for(const path of ['/legacy.html','/admin','/app.js'])assert.equal((await app.inject(path)).statusCode,404)
 const cookie=token=>({cookie:'__Host-dyoffice-session='+token})
 const list=await app.inject({url:'/api/v1/files',headers:cookie(f.alice.token)});assert.equal(list.statusCode,200);assert.equal(list.json().files[0].id,imported.file.fileId)
 assert.deepEqual((await app.inject({url:'/api/v1/files',headers:cookie(f.bob.token)})).json().files,[])
 assert.equal((await app.inject({url:'/api/v1/files/'+imported.file.fileId,headers:cookie(f.bob.token)})).statusCode,404)
 await f.preferences.update(f.alice.token,{authorName:'Alice only'})
 assert.equal((await app.inject({url:'/api/v1/preferences',headers:cookie(f.alice.token)})).json().authorName,'Alice only')
 assert.equal((await app.inject({url:'/api/v1/preferences',headers:cookie(f.bob.token)})).json().authorName,'')
 assert.equal((await app.inject({url:'/api/preferences',headers:{authorization:'Bearer personal-secret'}})).statusCode,401)
})

test('import confirmation preferences inherit older ODF choices and merge independent writes',async t=>{
 const f=await fileFixture(t),url='/api/v1/preferences'
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey})
 const headers=token=>({origin:restrictedOrigin,cookie:`${SESSION_COOKIE}=${token}`,'x-csrf-token':csrf.sessionToken(token)})
 const put=async payload=>f.app.inject({method:'PUT',url,headers:headers(f.alice.token),payload})
 const get=async token=>(await f.app.inject({url,headers:headers(token)})).json()
 const legacy=await put({skipOdfImportPrompt:true})
 assert.equal(legacy.statusCode,200,legacy.body)
 assert.equal(legacy.json().skipOdtImportPrompt,true)
 assert.equal(legacy.json().skipOdsImportPrompt,true)
 assert.equal(legacy.json().skipOdpImportPrompt,true)
 assert.equal(legacy.json().skipWord97ImportPrompt,false)
 const writes=await Promise.all([put({skipOdtImportPrompt:false}),put({skipHwpImportPrompt:true})])
 for(const write of writes)assert.equal(write.statusCode,200,write.body)
 const alice=await get(f.alice.token),bob=await get(f.bob.token)
 assert.equal(alice.skipOdtImportPrompt,false)
 assert.equal(alice.skipOdsImportPrompt,true)
 assert.equal(alice.skipHwpImportPrompt,true)
 assert.equal(bob.skipOdsImportPrompt,false)
 assert.equal(bob.skipHwpImportPrompt,false)
 assert.equal((await put({skipHwpImportPrompt:'yes'})).statusCode,400)
 assert.equal((await put({skipUnknownImportPrompt:true})).statusCode,400)
})

test('workspace autosave versions advance only when the default changes',async t=>{
 const f=await fileFixture(t),url='/api/v1/preferences'
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey})
 const headers=token=>({origin:restrictedOrigin,cookie:`${SESSION_COOKIE}=${token}`,'x-csrf-token':csrf.sessionToken(token)})
 const get=async token=>(await f.app.inject({url,headers:headers(token)})).json()
 const put=(payload)=>f.app.inject({method:'PUT',url,headers:headers(f.alice.token),payload})
 const initial=(await get(f.alice.token)).autoSaveUpdatedAt??1
 const off=await put({autoSave:false})
 assert.equal(off.statusCode,200,off.body)
 assert.ok(off.json().autoSaveUpdatedAt>initial)
 const stamp=off.json().autoSaveUpdatedAt
 for(const patch of [{autoSave:false},{authorName:'Reviewer'}]){
  const saved=await put(patch)
  assert.equal(saved.statusCode,200,saved.body)
  assert.equal(saved.json().autoSaveUpdatedAt,stamp)
 }
 const on=await put({autoSave:true})
 assert.equal(on.statusCode,200,on.body)
 assert.ok(on.json().autoSaveUpdatedAt>stamp)
 assert.equal((await get(f.alice.token)).autoSaveUpdatedAt,on.json().autoSaveUpdatedAt)
 assert.equal((await get(f.bob.token)).autoSaveUpdatedAt??1,initial)
 assert.equal((await put({autoSaveUpdatedAt:99})).statusCode,400)
})
