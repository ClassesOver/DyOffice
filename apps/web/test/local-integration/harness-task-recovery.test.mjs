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
 const build=()=>buildLocalApp({
  db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin:restrictedOrigin,
  csrfKey:f.csrfKey,objectStore:f.objects,providerGateway:{mode:'shared'},globalConfigKeyring:{activeKeyId:'test',keys:{test:new Uint8Array(32).fill(1)}},
  codingHarnesses:{defaultId:'fixture',adapters:[{descriptor:{id:'fixture',name:'Calculator',origin:'external',capabilities:['coding']},async run(input,signal,context){
   runs++;context.onProgress({kind:'status',text:'Computing fixture total'})
   if(input.instruction==='Interrupt this task')await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}))
   else await gate
   signal.throwIfAborted()
   return {summary:'Done',output:'42'}
  }}]},
 })
 let app=await build()
 const close=()=>{app.server.closeAllConnections();return app.close()}
 f.cleanup.unshift(async()=>{release();await close()})
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
 // Replace the whole API instance while keeping the session, files and database.
 await close()
 app=await build()
 const restored=await status()
 assert.equal(restored.statusCode,200)
 assert.deepEqual(restored.json(),final)
 assert.deepEqual((await claim()).json().checkpoint,checkpoint)
 assert.equal((await status(f.bob.token)).statusCode,404)
 assert.equal((await status(secondSession.token)).statusCode,404)
 const consume=instance=>instance.inject({method:'POST',url:'/api/v1/agents/tasks/fixture-recover/continuation',
  headers:{...headers(f.alice.token),origin:restrictedOrigin},payload:{documentId:file.fileId,revision:file.revision,modelId:'local-fixture'}})
 const peer=await build()
 try{assert.deepEqual((await Promise.all([consume(app),consume(peer)])).map(res=>res.statusCode).sort(),[200,409])}
 finally{await peer.close()}
 await close()
 app=await build()
 assert.equal((await status()).json().hasContinuation,false)
 const duplicate=await app.inject({method:'POST',url:'/api/v1/agents/tasks',headers:{...headers(f.alice.token),origin:restrictedOrigin},payload})
 assert.match(duplicate.body,/event: error/)
 assert.equal(runs,1)
 const interruptedId='interrupted-task',interruptedStatus=()=>app.inject({url:`/api/v1/agents/tasks/${interruptedId}/status?documentId=${file.fileId}`,headers:headers(f.alice.token)})
 const restartedOrigin=await app.listen({host:'127.0.0.1',port:0})
 const interrupted=await fetch(restartedOrigin+'/api/v1/agents/tasks',{method:'POST',
  headers:{...headers(f.alice.token),origin:restrictedOrigin,'content-type':'application/json'},body:JSON.stringify({
   turnId:interruptedId,documentId:file.fileId,modelId:'fixture',request:{system:'',tools:[],messages:[{role:'user',text:JSON.stringify({instruction:'Interrupt this task',officeModelId:'local-fixture'})}]},
  })})
 assert.equal(interrupted.status,200)
 const reader=interrupted.body.getReader(),decoder=new TextDecoder()
 let progress=''
 while(!progress.includes('Computing fixture total')){
  const part=await reader.read();assert.equal(part.done,false);progress+=decoder.decode(part.value,{stream:true})
 }
 assert.equal((await interruptedStatus()).json().state,'running')
 await close()
 app=await build()
 const stopped=(await interruptedStatus()).json()
 assert.equal(stopped.state,'unknown_outcome')
 assert.equal(stopped.hasContinuation,false)
 assert.match(stopped.failure,/saved delivery/)
 assert.equal(runs,2)
 await f.files.trashFile(f.alice.token,file.fileId)
 assert.equal((await status()).statusCode,404)
 assert.equal((await claim()).statusCode,404)
 assert.equal((await f.files.purgeFile(f.alice.token,file.fileId)).state,'purged')
 assert.equal(await f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async c=>
  (await c.query('SELECT 1 FROM harness_task_recovery WHERE file_id=$1',[file.fileId])).rowCount),0)
 await f.sessions.logout(f.alice.token)
 assert.equal((await status()).statusCode,401)
})
