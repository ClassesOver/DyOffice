import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import Fastify from 'fastify'
import {registerHarnessDataRoutes,registerAnalysisDeliveryRoutes} from '../../server/src/modules/coding/data-routes.ts'
import {createHarnessDataMailbox} from '../../server/src/modules/coding/data-mailbox.ts'
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
