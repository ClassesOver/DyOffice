import {test} from 'node:test'
import assert from 'node:assert/strict'
import {fileFixture,docxBytes} from '../helpers/files.mjs'
import {restrictedOrigin} from '../helpers/restricted.mjs'
import {createLocalShellClient} from '../../src/shell/local-client.ts'

async function fixture(t){
 const f=await fileFixture(t)
 const address=await f.app.listen({host:'127.0.0.1',port:0})
 let cookie=f.alice.token;const writes=[]
 const client=createLocalShellClient(async(path,init={})=>{
  if(!['GET','HEAD'].includes(init.method??'GET'))writes.push(path)
  return fetch(address+path,{...init,headers:{...init.headers,origin:restrictedOrigin,cookie:'__Host-dyoffice-session='+cookie}})
 })
 const workspace=await client.bindSession()
 return {...f,client,workspace,writes,switchToBob(){cookie=f.bob.token}}
}

test('real HTTP upload cannot create a private file in the replacement cookie account',async t=>{
 const f=await fixture(t),bytes=await docxBytes()
 f.switchToBob()
 const outcome=await f.client.upload(new File([bytes],'alice-private.docx'),f.workspace.proof).then(value=>({value}),error=>({error}))
 assert.deepEqual((await f.files.listFiles(f.bob.token,{})).files,[],'Bob must not receive Alice upload')
 assert.deepEqual((await f.files.listFiles(f.alice.token,{})).files,[])
 assert.deepEqual(f.writes,[])
 assert.equal(outcome.error?.code,'stale_session')
})

test('real HTTP bound upload preserves the original bytes and scoped ownership',async t=>{
 const f=await fixture(t),bytes=await docxBytes()
 const result=await f.client.upload(new File([bytes],'alice-private.docx'),f.workspace.proof)
 const opened=await f.files.openFile(f.alice.token,result.file.fileId)
 assert.deepEqual(await f.files.readFile(f.alice.token,opened.file.fileId,opened.file.revision),bytes)
 await assert.rejects(f.files.openFile(f.bob.token,opened.file.fileId))
 assert.equal(f.writes.length,3)
})
