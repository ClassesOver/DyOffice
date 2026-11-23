import test from 'node:test'
import {createServer} from 'node:http'
import assert from 'node:assert/strict'
import {randomUUID,randomBytes} from 'node:crypto'
import {fileFixture,docxBytes,importFile} from '../helpers/files.mjs'
import {restrictedOrigin} from '../helpers/restricted.mjs'
import {createCsrfService} from '../../server/src/modules/auth/csrf.ts'
import {createSourceService} from '../../server/src/modules/sources/service.ts'
import {createWorkspaceSourceResults} from '../../server/src/modules/sources/results.ts'
import {createWorkspaceSourceTools} from '../../server/src/modules/sources/tools.ts'
import {createHarnessDataAccess} from '../../server/src/modules/coding/data-access.ts'
import {createQuerySnapshot} from '../../server/src/modules/sources/provenance.ts'

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
 const results=createWorkspaceSourceResults({transactions:f.transactions})
 await sources.create(token,{sourceId:'reporting',name:'Reporting',kind:'http',config:{rowPath:'rows',timezone:'UTC'},secret:endpoint})
 const snapshot=createQuerySnapshot({sourceId:'reporting',sourceVersion:1,timezone:'UTC',schema:[{name:'amount',type:'number'}],rows:[{amount:42}],sourceTruncated:false})
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,key:f.csrfKey,origin:restrictedOrigin})
 const headers={origin:restrictedOrigin,cookie:'__Host-dyoffice-session='+token,'x-csrf-token':csrf.sessionToken(token)}
 const request=(base,method,path,payload)=>f.app.inject({url:base+path,method,headers,payload})
 const docA='/api/v1/files/'+a,docB='/api/v1/files/'+b,workspace='/api/v1/workspace'
 const query=await request(docA,'POST','/source-tools/execute',{name:'sources.query',arguments:{sourceId:'reporting'}})
 assert.equal(query.statusCode,200,query.body)
 const captured=query.json().artifact
 const resultId=captured.resultId, args={resultId,name:'Report',commandId:randomUUID()}
 const home=await results.capture(token,snapshot,'a'.repeat(64))
 await results.save(token,{...args,resultId:home.resultId})
 const save=base=>request(base,'POST','/source-tools/execute',{name:'sources.save_result',arguments:args})
 for(const base of [docB,workspace])assert.equal((await save(base)).statusCode,404)
 assert.equal((await save(docA)).statusCode,200)
 assert.equal((await save(docA)).statusCode,200)
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
 for(const [name,args] of [['sources.list',{}],['sources.describe',{sourceId:'reporting'}],['sources.query',{sourceId:'reporting'}]]){
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
