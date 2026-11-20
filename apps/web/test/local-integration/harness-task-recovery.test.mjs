import test from 'node:test'
import assert from 'node:assert/strict'
import {buildLocalApp} from '../../server/src/app.ts'
import {createCsrfService} from '../../server/src/modules/auth/csrf.ts'
import {fileFixture,docxBytes,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {restrictedOrigin} from '../helpers/restricted.mjs'

test('recovering a document Harness task rechecks a real login and current file visibility',{timeout:30000},async t=>{
 const f=await fileFixture(t,{buildApp:false})
 const {file}=await importFile(f,f.alice.token,await docxBytes())
 const {file:unrelated}=await importFile(f,f.alice.token,await docxBytes(),'other.docx')
 let release,runs=0
 const gate=new Promise(resolve=>{release=resolve})
 const app=await buildLocalApp({
  db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin:restrictedOrigin,
  csrfKey:f.csrfKey,objectStore:f.objects,providerGateway:{mode:'shared'},globalConfigKeyring:{activeKeyId:'test',keys:{test:new Uint8Array(32).fill(1)}},
  codingHarnesses:{defaultId:'fixture',adapters:[{descriptor:{id:'fixture',name:'Calculator',origin:'external',capabilities:['coding']},async run(_input,signal,context){
   runs++;context.onProgress({kind:'status',text:'Computing fixture total'})
   await gate;signal.throwIfAborted()
   return {summary:'Done',output:'42'}
  }}]},
 })
 f.cleanup.unshift(async()=>{release();await app.close()})
 const origin=await app.listen({host:'127.0.0.1',port:0})
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey})
 const headers=token=>({cookie:'__Host-dyoffice-session='+token,'x-csrf-token':csrf.sessionToken(token)})
 const checkpoint={userIndex:0,turns:0,executedCalls:[],messages:[{role:'user',text:'Read the fixture and use its calculated total'},{role:'assistant',text:'',toolCalls:[{id:'pending-delegate',name:'delegate_agent_task',input:{instruction:'Calculate the fixture total'}}]}]}
 const payload={turnId:'fixture-recover',documentId:file.fileId,modelId:'fixture',continuation:{revision:file.revision,checkpoint},
  request:{system:'',tools:[],messages:[{role:'user',text:JSON.stringify({instruction:'Calculate the fixture total',officeModelId:'local-fixture'})}]}}
 const denied=await app.inject({method:'POST',url:'/api/v1/agents/tasks',headers:{...headers(f.bob.token),origin:restrictedOrigin},payload})
 assert.match(denied.body,/event: error/)
 assert.equal(runs,0)
 const controller=new AbortController()
 const response=await fetch(origin+'/api/v1/agents/tasks',{
  method:'POST',signal:controller.signal,
  headers:{...headers(f.alice.token),origin:restrictedOrigin,'content-type':'application/json'},
  body:JSON.stringify(payload),
 })
 try{
  assert.equal(response.status,200)
  const reader=response.body.getReader(),decoder=new TextDecoder()
  let frames=''
  while(!frames.includes('Computing fixture total')){
   const part=await reader.read();assert.equal(part.done,false)
   frames+=decoder.decode(part.value,{stream:true})
  }
 }finally{controller.abort()}
 const status=(token=f.alice.token,documentId=file.fileId,extra={})=>
  app.inject({url:'/api/v1/agents/tasks/fixture-recover/status?documentId='+documentId,headers:{...headers(token),...extra}})
 const claim=(token=f.alice.token,extra={})=>app.inject({method:'POST',url:'/api/v1/agents/tasks/fixture-recover/continuation',
  headers:{...headers(token),origin:restrictedOrigin,...extra},payload:{documentId:file.fileId,revision:file.revision,modelId:'local-fixture',defer:true}})
 assert.equal((await status()).json().state,'running')
 assert.equal((await claim()).statusCode,409)
 assert.equal((await status(f.bob.token)).statusCode,404)
 assert.equal((await status(f.alice.token,unrelated.fileId)).statusCode,404)
 assert.equal((await status(f.alice.token,file.fileId,{'x-csrf-token':'z'.repeat(43)})).statusCode,403)
 const secondSession=await f.sessions.login('alice',password)
 assert.equal((await status(secondSession.token)).statusCode,404)
 release()
 let final
 for(let i=0;i<50;i++){
  final=(await status()).json()
  if(final.state!=='running')break
  await new Promise(resolve=>setTimeout(resolve,20))
 }
 assert.equal(final.state,'succeeded')
 assert.equal(final.agentId,'fixture')
 assert.deepEqual(final.result,{summary:'Done',output:'42'})
 assert.equal(final.hasContinuation,true)
 assert.equal((await claim(f.bob.token)).statusCode,404)
 assert.equal((await claim(secondSession.token)).statusCode,404)
 assert.equal((await claim(f.alice.token,{'x-csrf-token':'z'.repeat(43)})).statusCode,403)
 const claimed=await Promise.all([claim(),claim()])
 assert.deepEqual(claimed.map(response=>response.statusCode),[200,200])
 for(const response of claimed)assert.deepEqual(response.json().checkpoint,checkpoint)
 assert.equal(runs,1)
 await f.files.trashFile(f.alice.token,file.fileId)
 assert.equal((await status()).statusCode,404)
 assert.equal((await claim()).statusCode,404)
 await f.sessions.logout(f.alice.token)
 assert.equal((await status()).statusCode,401)
})
