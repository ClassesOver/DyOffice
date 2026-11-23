import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {runInNewContext} from 'node:vm'
import {fileFixture,docxBytes,importFile} from '../helpers/files.mjs'
import {restrictedOrigin} from '../helpers/restricted.mjs'
import {createLocalShellClient} from '../../src/shell/local-client.ts'
const source=await readFile(new URL('../../src/shell/local-main.tsx',import.meta.url),'utf8')
const match=source.match(/<WorkspaceTrash request=\{([^}]+)\}/)
assert.ok(match,'test must use the actual WorkspaceTrash request wiring')
async function fixture(t){
 const f=await fileFixture(t),bytes=await docxBytes()
 const aliceFile=await importFile(f,f.alice.token,bytes,'Alice-private.docx'),bobFile=await importFile(f,f.bob.token,bytes,'Bob-private.docx')
 await f.files.trashFile(f.alice.token,aliceFile.file.fileId);await f.files.trashFile(f.bob.token,bobFile.file.fileId)
 const address=await f.app.listen({host:'127.0.0.1',port:0});let cookie=f.alice.token;let rotateAfter;const writes=[]
 const client=createLocalShellClient(async(path,init={})=>{
  if(!['GET','HEAD'].includes(init.method??'GET'))writes.push(path)
  const response=await fetch(address+path,{...init,headers:{...init.headers,origin:restrictedOrigin,cookie:'__Host-dyoffice-session='+cookie}})
  if(path===rotateAfter)cookie=f.bob.token
  return response
 })
 const bound=await client.bindSession()
 const request=runInNewContext(match[1],{client,sourceWorkspace:{bound}})
 return {...f,request,aliceFile,bobFile,writes,rotateAfter(path){rotateAfter=path},switchToBob(){cookie=f.bob.token}}
}
const list='/api/v1/workspace/files?view=trash&limit=10&offset=0'
test('trash reload in an old workspace refuses replacement account data',async t=>{
 const f=await fixture(t)
 assert.equal((await f.request(list)).files[0].name,'Alice-private.docx')
 f.switchToBob()
 await assert.rejects(f.request(list),{code:'stale_session'})
 assert.deepEqual(f.writes,[])
})
test('original workspace trash restore preserves bytes and other owner state',async t=>{
 const f=await fixture(t)
 await f.request(`/api/v1/files/${f.aliceFile.file.fileId}/restore`,'POST')
 const opened=await f.files.openFile(f.alice.token,f.aliceFile.file.fileId)
 assert.deepEqual(await f.files.readFile(f.alice.token,opened.file.fileId,opened.file.revision),await docxBytes())
 assert.equal((await f.files.listFiles(f.bob.token,{trash:true})).files.length,1)
 assert.equal((await f.request(list)).files.length,0)
 assert.equal(f.writes.length,1)
})

test('trash list response arriving after cookie rotation is rejected before rendering',async t=>{
 const f=await fixture(t);f.rotateAfter(list)
 await assert.rejects(f.request(list),{code:'stale_session'})
 assert.deepEqual(f.writes,[])
})
for(const action of ['restore','purge'])test(`old workspace ${action} never mutates the replacement account`,async t=>{
 const f=await fixture(t);f.switchToBob()
 await assert.rejects(f.request(`/api/v1/files/${f.bobFile.file.fileId}/${action}`,'POST'),error=>error.status===403||error.code==='stale_session')
 assert.equal((await f.files.listFiles(f.bob.token,{trash:true})).files.length,1)
 assert.equal((await f.files.listFiles(f.alice.token,{trash:true})).files.length,1)
 assert.equal(f.writes.length,1)
})
test('restore committed before cookie rotation stays unknown without retry',async t=>{
 const f=await fixture(t),path=`/api/v1/files/${f.aliceFile.file.fileId}/restore`;f.rotateAfter(path)
 await assert.rejects(f.request(path,'POST'),{code:'stale_session'})
 assert.equal((await f.files.listFiles(f.alice.token,{trash:false})).files.length,1)
 assert.equal((await f.files.listFiles(f.bob.token,{trash:true})).files.length,1)
 assert.deepEqual(f.writes,[path])
})
