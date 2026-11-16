import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {fileFixture,docxBytes,importFile} from '../helpers/files.mjs'
import {restrictedOrigin} from '../helpers/restricted.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
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
