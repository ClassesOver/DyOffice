import test from 'node:test'
import {createServer} from 'node:http'
import assert from 'node:assert/strict'
import {randomUUID,randomBytes} from 'node:crypto'
import {fileFixture,docxBytes,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {restrictedOrigin} from '../helpers/restricted.mjs'
import {createCsrfService} from '../../server/src/modules/auth/csrf.ts'
import {createSourceService} from '../../server/src/modules/sources/service.ts'
import {createWorkspaceSourceResults} from '../../server/src/modules/sources/results.ts'
import {createWorkspaceSourceTools} from '../../server/src/modules/sources/tools.ts'
import {createHarnessDataAccess} from '../../server/src/modules/coding/data-access.ts'
import {createQuerySnapshot} from '../../server/src/modules/sources/provenance.ts'
import {postgresTargets} from '../helpers/postgres-source.mjs'

test('Workspace and Codex SQL batches keep each captured result in the authorized document',async t=>{
 const f=await fileFixture(t,{buildApp:false}),token=f.alice.token,target=await postgresTargets(t,f)
 const bytes=await docxBytes()
 const a=(await importFile(f,token,bytes,'A.docx')).file.fileId
 const b=(await importFile(f,token,bytes,'B.docx')).file.fileId
 const sources=createSourceService({transactions:f.transactions,credentialKeys:'test:'+randomBytes(32).toString('base64'),egressTargets:target.approvals})
 f.cleanup.unshift(()=>sources.close())
 const results=createWorkspaceSourceResults({transactions:f.transactions})
 let inactiveOnError,inactiveAfterCapture,executed=0
 const tools=createWorkspaceSourceTools({sources:{...sources,async querySource(...args){
  executed++
  try{return await sources.querySource(...args)}catch(error){
   if(inactiveOnError)await f.files.trashFile(token,inactiveOnError)
   throw error
  }
 }},results:{...results,async capture(...args){
  const artifact=await results.capture(...args)
  if(inactiveAfterCapture)await f.files.trashFile(token,inactiveAfterCapture)
  return artifact
 }}})
 await sources.create(token,{sourceId:'sales',kind:'postgres',name:'Sales',config:{},secret:target.readerDsn})
 const data=createHarnessDataAccess({tools,results,sessions:f.sessions})
 t.after(()=>data.dispose())
 const issue=(documentId,inputs)=>data.issue({token,documentId,agentId:'worker',inputs,signal:new AbortController().signal})
 const grant=await issue(b,{sourceIds:['sales'],resultIds:[]})
 const workspace=queries=>tools.execute(token,{name:'execute_sql',arguments:{sourceId:'sales',queries}},a)
 const codex=queries=>data.execute(grant.taskId,grant.credential,'execute_sql',{sourceId:'sales',queries})
 const missing=`SELECT missing_column FROM ${target.probeTable}`
 for(const [run,documentId,other] of [[workspace,a,b],[codex,b,a]]){
  const {items}=await run(['SELECT 1 AS n',missing,'SELECT 3 AS n'])
  assert.deepEqual(items.map(item=>item.ok),[true,false,true])
  for(const item of [items[0],items[2]]){
   const resultId=item.result.artifact.resultId
   const save={name:'save_query_result',arguments:{resultId,name:'Frozen',commandId:randomUUID()}}
   for(const scope of [other,undefined]){
    await assert.rejects(results.read(token,{resultId},scope),{statusCode:404})
    await assert.rejects(tools.execute(token,save,scope),{statusCode:404})
    await assert.rejects(issue(scope,{sourceIds:[],resultIds:[resultId]}),{statusCode:403})
   }
   await tools.execute(token,save,documentId)
   if(run===codex)assert.equal((await data.download(grant.taskId,grant.credential,resultId)).sha256,item.result.sha256)
   else await assert.rejects(data.download(grant.taskId,grant.credential,resultId),{statusCode:403})
  }
  inactiveOnError=documentId
  await assert.rejects(run(['SELECT 4 AS n',missing]),{statusCode:run===codex?403:404})
  const prior=executed
  await assert.rejects(run(['SELECT 5 AS n']),{statusCode:run===codex?403:404})
  assert.equal(executed,prior,'an inactive document cannot dispatch a statement')
  await f.files.restoreFile(token,documentId)
  if(run===codex){
   const pending=(await results.list(token,{},documentId,true)).items.filter(item=>item.state==='pending')
   assert.equal(pending.length,1)
   await assert.rejects(data.download(grant.taskId,grant.credential,pending[0].resultId),{statusCode:403})
  }
  inactiveOnError=undefined
  inactiveAfterCapture=documentId
  const beforeCapture=executed
  await assert.rejects(run(['SELECT 6 AS n','SELECT 7 AS n']),{statusCode:run===codex?403:404})
  assert.equal(executed,beforeCapture+1,'a later statement cannot run after the file is trashed')
  await f.files.restoreFile(token,documentId)
  inactiveAfterCapture=undefined
 }
})

test('two documents owned by the same user and Home partition frozen results throughout their lifecycle',async t=>{
 let queries=0
 const server=createServer((_req,res)=>{
  queries++
  res.writeHead(200,{'content-type':'application/json'})
  res.end(JSON.stringify({rows:[{amount:42}]}))
 })
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve))})
 const endpoint='http://127.0.0.1:'+server.address().port+'/rows'
 const credentialKeys='test:'+randomBytes(32).toString('base64')
 const targets=[{kind:'http',endpoint,addresses:['127.0.0.1'],allowInsecure:true}]
 const f=await fileFixture(t,{sourcesCredentialKeys:credentialKeys,sourcesEgressTargets:targets}),token=f.alice.token,bytes=await docxBytes()
 const a=(await importFile(f,token,bytes,'A.docx')).file.fileId
 const b=(await importFile(f,token,bytes,'B.docx')).file.fileId
 const sources=createSourceService({transactions:f.transactions,credentialKeys,egressTargets:targets})
 f.cleanup.unshift(()=>sources.close())
 const results=createWorkspaceSourceResults({transactions:f.transactions})
 await sources.create(token,{sourceId:'reporting',name:'Reporting',kind:'http',config:{rowPath:'rows',timezone:'UTC'},secret:endpoint})
 const snapshot=createQuerySnapshot({sourceId:'reporting',sourceVersion:1,timezone:'UTC',schema:[{name:'amount',type:'number'}],rows:[{amount:42}],sourceTruncated:false})
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,key:f.csrfKey,origin:restrictedOrigin})
 const headers={origin:restrictedOrigin,cookie:'__Host-dyoffice-session='+token,'x-csrf-token':csrf.sessionToken(token)}
 const request=(base,method,path,payload)=>f.app.inject({url:base+path,method,headers,payload})
 const docA='/api/v1/files/'+a,docB='/api/v1/files/'+b,workspace='/api/v1/workspace'
 const query=await request(docA,'POST','/source-tools/execute',{name:'execute_sql',arguments:{sourceId:'reporting'}})
 assert.equal(query.statusCode,200,query.body)
 const captured=query.json().artifact
 const resultId=captured.resultId, args={resultId,name:'Report',commandId:randomUUID()}
 const temporary=await request(docA,'GET','/data-results?includePending=true')
 assert.equal(temporary.statusCode,200,temporary.body)
 assert.deepEqual(temporary.json().items.map(row=>[row.resultId,row.state]),[[resultId,'pending']])
 assert.deepEqual((await request(docB,'GET','/data-results?includePending=true')).json().items,[])
 assert.deepEqual((await request(docA,'GET','/data-results')).json().items,[])
 assert.equal((await request(workspace,'GET','/data-results?includePending=true')).statusCode,400)
 const otherSession=await f.sessions.login('alice',password)
 assert.deepEqual((await results.list(otherSession.token,{},a,true)).items,[])
 const home=await results.capture(token,snapshot,'a'.repeat(64))
 await results.save(token,{...args,resultId:home.resultId})
 const save=base=>request(base,'POST','/source-tools/execute',{name:'save_query_result',arguments:args})
 for(const base of [docB,workspace])assert.equal((await save(base)).statusCode,404)
 assert.equal((await save(docA)).statusCode,200)
 assert.equal((await save(docA)).statusCode,200)
 assert.deepEqual((await results.list(otherSession.token,{},a,true)).items.map(row=>row.resultId),[resultId])
 for(const [base,expected] of [[docA,[resultId]],[docB,[]],[workspace,[home.resultId]]]){
  const list=await request(base,'GET','/data-results')
  assert.equal(list.statusCode,200,list.body)
  assert.deepEqual(list.json().items.map(item=>item.resultId),expected)
 }
 for(const base of [docB,workspace]){
  for(const [method,suffix] of [['GET',''],['GET','/content'],['DELETE','']])
   assert.equal((await request(base,method,'/data-results/'+resultId+suffix)).statusCode,404)
 }
 assert.equal((await request(docA,'GET','/data-results/'+home.resultId)).statusCode,404)
 assert.equal((await request(docA,'GET','/data-results/'+resultId+'/content')).statusCode,200)
 await assert.rejects(results.capture(f.bob.token,snapshot,'a'.repeat(64),a),{statusCode:404})
 const data=createHarnessDataAccess({tools:createWorkspaceSourceTools({sources,results}),results,sessions:f.sessions})
 t.after(()=>data.dispose())
 const grantFor=documentId=>data.issue({token,documentId,agentId:'worker',inputs:{sourceIds:[],resultIds:[resultId]},signal:new AbortController().signal})
 await assert.rejects(grantFor(b))
 await assert.rejects(grantFor(undefined))
 const grant=await grantFor(a)
 assert.equal((await data.download(grant.taskId,grant.credential,resultId)).sha256,captured.sha256)
 await f.files.trashFile(token,a)
 assert.equal((await request(docA,'GET','/data-results/'+resultId+'/content')).statusCode,404)
 for(const [name,args] of [['list_connections',{}],['search_objects',{sourceId:'reporting'}],['execute_sql',{sourceId:'reporting'}]]){
  const response=await request(docA,'POST','/source-tools/execute',{name,arguments:args})
  assert.equal(response.statusCode,404,name+' should reject an inactive document before calling the source')
 }
 assert.equal(queries,1,'inactive document requests must never reach the connector')
 await f.files.restoreFile(token,a)
 assert.equal((await request(docA,'GET','/data-results/'+resultId+'/content')).statusCode,200)
 const pending=await results.capture(token,snapshot,'a'.repeat(64),a)
 const saved=await results.capture(token,snapshot,'a'.repeat(64),a)
 await results.save(token,{...args,resultId:saved.resultId,commandId:randomUUID()},a)
 assert.equal((await request(docA,'DELETE','/data-results/'+resultId)).statusCode,204)
 await assert.rejects(data.download(grant.taskId,grant.credential,resultId))
 const storedRows=()=>f.transactions.withPrincipalTransaction({kind:'session',token},async c=>
  (await c.query('SELECT result_id FROM workspace_source_results WHERE document_id=$1',[a])).rows.map(row=>row.result_id).sort())
 assert.deepEqual(await storedRows(),[saved.resultId,pending.resultId].sort())
 await f.files.trashFile(token,a)
 assert.deepEqual(await f.files.purgeFile(token,a),{state:'purged'})
 assert.deepEqual(await storedRows(),[])
 assert.equal((await request(workspace,'GET','/data-results/'+home.resultId+'/content')).statusCode,200)
})
