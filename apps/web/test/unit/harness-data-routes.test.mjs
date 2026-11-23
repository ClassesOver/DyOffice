import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import Fastify from 'fastify'
import {registerHarnessDataRoutes,registerAnalysisDeliveryRoutes} from '../../server/src/modules/coding/data-routes.ts'
import {createHarnessDataMailbox} from '../../server/src/modules/coding/data-mailbox.ts'
import {registerWorkspaceSourceToolRoutes} from '../../server/src/modules/sources/tool-routes.ts'
import {registerAssistantSourceCatalog} from '../../server/src/modules/sources/assistant-catalog.ts'
import {setTimeout as delay} from 'node:timers/promises'
import {readFile,writeFile,access} from 'node:fs/promises'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'

test('task HTTP routes expose only bounded operations and verified content headers',async t=>{
 const app=Fastify();t.after(()=>app.close())
 const bytes=Buffer.from('{"frozen":true}'),calls=[]
 registerHarnessDataRoutes(app,{
  async execute(task,bearer,op,args){calls.push({task,bearer,op,args});return {items:[]}},
  async download(task,bearer,id){assert.equal(bearer,'x'.repeat(43));return {bytes,sha256:'a'.repeat(64)}},dispose(){},
 })
 const url='/api/v1/agents/tasks/task/data/execute',headers={authorization:'Bearer '+'x'.repeat(43)}
 assert.equal((await app.inject({method:'POST',url,payload:{operation:'sources.list',arguments:{}}})).statusCode,403)
 assert.equal((await app.inject({method:'POST',url,headers,payload:{operation:'results.download',arguments:{}}})).statusCode,400)
 assert.equal((await app.inject({method:'POST',url,headers,payload:{operation:'sources.list',arguments:{}}})).statusCode,200)
 assert.equal(calls.length,1)
 const result=await app.inject({url:'/api/v1/agents/tasks/task/data/results/result/content',headers})
 assert.deepEqual(result.rawPayload,bytes)
 assert.equal(result.headers['x-content-sha256'],createHash('sha256').update(bytes).digest('hex'))
 assert.equal(result.headers['x-snapshot-sha256'],'a'.repeat(64))
})

test('batch query handlers can outlast the normal socket timeout on each HTTP transport',async t=>{
 const app=Fastify({connectionTimeout:100})
 t.after(()=>app.close())
 const finish=async documentId=>{await delay(250);return {completed:true,...(documentId&&{documentId})}}
 const sessions={async authenticate(){}},csrf={originCheck(){},requireSession(){}}
 const tools={execute(token,_call,documentId){assert.equal(token,'x'.repeat(43));return finish(documentId)}}
 registerHarnessDataRoutes(app,{execute:()=>finish(),dispose(){}})
 registerWorkspaceSourceToolRoutes(app,{tools,sessions,csrf,results:{}})
 registerAssistantSourceCatalog(app,{analysis:tools,sessions,csrf,sources:{}})
 const url=await app.listen({host:'127.0.0.1',port:0})
 const document='10000000-0000-4000-8000-000000000001'
 for(const [path,field,documentId] of [
  ['/api/v1/agents/tasks/task/data/execute','operation'],
  ['/api/v1/workspace/source-tools/execute','name'],
  ['/api/v1/ai/sources/execute','name'],
  ['/api/v1/files/'+document+'/source-tools/execute','name',document],
  ['/api/v1/files/'+document+'/ai/sources/execute','name',document],
 ])await t.test(path,async()=>{
  const auth=field==='operation'?{authorization:'Bearer '+'x'.repeat(43)}:{cookie:'__Host-dyoffice-session='+'x'.repeat(43)}
  const call=args=>fetch(url+path,{method:'POST',headers:{'content-type':'application/json',...auth},
   body:JSON.stringify({[field]:'sources.query',arguments:{sourceId:'sales',...args}})})
  const response=await call({queries:['select 1','select 2','select 3','select 4']})
  assert.equal(response.status,200)
  assert.deepEqual(await response.json(),{completed:true,...(documentId&&{documentId})})
  await assert.rejects(call({sql:'select 1'}),error=>error.cause?.code==='UND_ERR_SOCKET')
 })
})

test('Office artifact download remains owner-authenticated and forced attachment',async t=>{
 const app=Fastify();t.after(()=>app.close())
 registerAnalysisDeliveryRoutes(app,{async download(token,id){if(token!=='o'.repeat(43))throw Object.assign(Error('denied'),{statusCode:403});return {artifact:{name:'chart.html',sha256:'a'.repeat(64)},bytes:Buffer.from('<script>bad()</script>')}}},{originCheck(){},requireSessionRead(req,token){if(token!=='o'.repeat(43))throw Object.assign(Error('denied'),{statusCode:403})}})
 const url='/api/v1/agents/artifacts/id/content'
 assert.equal((await app.inject({url})).statusCode,403)
 const result=await app.inject({url,headers:{cookie:'__Host-dyoffice-session='+'o'.repeat(43)}})
 assert.equal(result.statusCode,200);assert.equal(result.headers['content-type'],'application/octet-stream')
 assert.match(result.headers['content-disposition'],/^attachment;/);assert.match(result.headers['content-security-policy'],/sandbox/)
})

test('network-free mailbox forwards the same task API and removes its transport directory',async t=>{
 const app=Fastify();t.after(()=>app.close())
 registerHarnessDataRoutes(app,{async execute(){return {items:['authorized']}},dispose(){}})
 await app.ready()
 const mailbox=await createHarnessDataMailbox(app,'task')
 try {
  async function submit(path){
   const id=randomUUID()
   await writeFile(join(mailbox.directory,id+'.request'),JSON.stringify({path,method:'POST',headers:{authorization:'Bearer '+'x'.repeat(43)},body:JSON.stringify({operation:'sources.list',arguments:{}})}))
   for(let attempt=0;attempt<100;attempt++) {
    try{return JSON.parse(await readFile(join(mailbox.directory,id+'.response'),'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
    await new Promise(resolve=>setTimeout(resolve,25))
   }
   throw Error('Mailbox response timed out')
  }
  assert.equal((await submit('/api/v1/agents/tasks/other/data/execute')).status,403)
  assert.equal((await submit('/api/v1/agents/tasks/task/data/../execute')).status,403)
  assert.equal((await submit('/api/v1/agents/tasks/task/data/execute?owner=other')).status,403)
  const result=await submit('/api/v1/agents/tasks/task/data/execute')
  assert.equal(result.status,200);assert.match(Buffer.from(result.bytesBase64,'base64').toString(),/authorized/)
 } finally {await mailbox.close()}
 await assert.rejects(access(mailbox.directory))
})

test('artifact download rejects any supplied stale or empty session proof before storage access',async t=>{
 const app=Fastify();t.after(()=>app.close());let downloads=0
 registerAnalysisDeliveryRoutes(app,{async download(){downloads++;return {artifact:{name:'report.txt',sha256:'a'.repeat(64)},bytes:Buffer.from('x')}}},{originCheck(){},requireSessionRead(req){if(req.headers['x-csrf-token']!=='original-proof')throw Object.assign(Error('denied'),{statusCode:403})}})
 for(const proof of ['', 'replacement-session-proof'])assert.equal((await app.inject({url:'/api/v1/agents/artifacts/id/content',headers:{'x-csrf-token':proof}})).statusCode,403)
 assert.equal(downloads,0)
 assert.equal((await app.inject({url:'/api/v1/agents/artifacts/id/content',headers:{'x-csrf-token':'original-proof'}})).statusCode,200)
 assert.equal(downloads,1)
})

test('a slow mailbox request is forwarded once and answered once, never with a spurious 403',async t=>{
 const app=Fastify();t.after(()=>app.close())
 let executions=0
 registerHarnessDataRoutes(app,{async execute(){executions++;await new Promise(resolve=>setTimeout(resolve,200));return {items:['slow']}},dispose(){}})
 await app.ready()
 const mailbox=await createHarnessDataMailbox(app,'task')
 try {
  const ids=[randomUUID(),randomUUID()]
  for(const id of ids)await writeFile(join(mailbox.directory,id+'.request'),JSON.stringify({path:'/api/v1/agents/tasks/task/data/execute',method:'POST',headers:{authorization:'Bearer '+'x'.repeat(43)},body:JSON.stringify({operation:'sources.list',arguments:{}})}))
  const responses=[]
  for(const id of ids){
   for(let attempt=0;attempt<100;attempt++){
    try{responses.push(JSON.parse(await readFile(join(mailbox.directory,id+'.response'),'utf8')));break}catch(error){if(error.code!=='ENOENT')throw error}
    await new Promise(resolve=>setTimeout(resolve,25))
   }
  }
  // Several 25 ms scans ran while each request was in flight.
  await new Promise(resolve=>setTimeout(resolve,200))
  assert.deepEqual(responses.map(response=>response.status),[200,200])
  assert.equal(executions,2)
 } finally {await mailbox.close()}
})
