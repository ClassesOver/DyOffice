import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createServer} from 'node:http'
import {mkdtemp,rm,writeFile,readdir,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import Fastify,{type FastifyInstance} from 'fastify'
import {afterEach,expect,it,vi} from 'vitest'
import {createHarnessDataMailbox} from '../../../apps/web/server/src/modules/coding/data-mailbox'
import {registerHarnessDataRoutes} from '../../../apps/web/server/src/modules/coding/data-routes'
import {createQuerySnapshot} from '../../../apps/web/server/src/modules/sources/provenance'
import {parseArgs} from '../src/args'
import {runHarnessDataCommand} from '../src/harness-data-command'

const cleanup:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const clean of cleanup.splice(0).reverse())await clean()})
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'office-data-socket-'))
 cleanup.push(()=>rm(directory,{recursive:true,force:true}))
 const socket=join(directory,'data.sock'),requests:Array<{path:string;authorization:string|undefined;body:unknown}>=[]
 const server=createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk
  requests.push({path:req.url!,authorization:req.headers.authorization,body:JSON.parse(body)})
  res.setHeader('content-type','application/json');res.end(JSON.stringify({resultId:'result_1',rowCount:3}))
 })
 await new Promise<void>(resolve=>server.listen(socket,resolve))
 cleanup.push(()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())))
 const env={OFFICE_HARNESS_DATA_URL:'http://127.0.0.1/api/v1/agents',OFFICE_HARNESS_TASK_ID:'task_1',OFFICE_HARNESS_DATA_CREDENTIAL:'secret-in-env',OFFICE_HARNESS_DATA_SOCKET:socket}
 return {directory,requests,env,server}
}
it('内外部共用命令通过任务 UDS 复用 HTTP 路径与授权',async()=>{
 const f=await fixture()
 const result=await runHarnessDataCommand(parseArgs(['execute','sources.query','--args','{"sourceId":"sales","sql":"select 1"}']),{cwd:f.directory,env:f.env})
 expect(result.detail).toEqual({resultId:'result_1',rowCount:3})
 expect(f.requests).toEqual([{path:'/api/v1/agents/tasks/task_1/data/execute',authorization:'Bearer secret-in-env',body:{operation:'sources.query',arguments:{sourceId:'sales',sql:'select 1'}}}])
 await runHarnessDataCommand(parseArgs(['manifest','result_1']),{cwd:f.directory,env:f.env})
 expect(f.requests[1]!.body).toEqual({operation:'results.get_manifest',arguments:{resultId:'result_1'}})
})
it('拒绝 argv 凭据且错误不回显环境凭据',async()=>{
 const f=await fixture()
 await expect(runHarnessDataCommand(parseArgs(['manifest','result_1','--credential','secret']),{cwd:f.directory,env:f.env})).rejects.toThrow('data execute')
 await expect(runHarnessDataCommand(parseArgs(['execute','sources.query','--args','not-json']),{cwd:f.directory,env:f.env})).rejects.toThrow('Office task data operation unavailable')
 expect(f.requests).toEqual([])
})
it('已打包小 helper 作为实际独立进程访问 UDS，无 npm 运行依赖',async()=>{
 const f=await fixture(),helper=join(f.directory,'helper.mjs')
 const {build}=await import('esbuild')
 await build({entryPoints:[fileURLToPath(new URL('../src/harness-data-helper.ts',import.meta.url))],outfile:helper,bundle:true,platform:'node',target:'node22',format:'esm',logLevel:'silent'})
 const result=await new Promise<{code:number|null;stdout:string;stderr:string}>(resolve=>{
  const child=spawn(process.execPath,[helper,'manifest','result_1'],{cwd:f.directory,env:{...f.env},stdio:['ignore','pipe','pipe']})
  let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x)
  child.on('close',code=>resolve({code,stdout,stderr}))
 })
 expect(result.code).toBe(0);expect(result.stderr).toBe('')
 expect(JSON.parse(result.stdout)).toMatchObject({status:'ok',detail:{resultId:'result_1'}})
 expect(f.requests).toHaveLength(1)
})

it('大产物使用本地参数文件，避开 shell argv 限制',async()=>{
 const f=await fixture(),path=join(f.directory,'stage.json')
 const bytesBase64='eA=='.repeat(20000)
 await writeFile(path,JSON.stringify({bytesBase64}))
 await runHarnessDataCommand(parseArgs(['execute','artifacts.stage','--args-file',path]),{cwd:f.directory,env:f.env})
 expect(f.requests[0]!.body).toEqual({operation:'artifacts.stage',arguments:{bytesBase64}})
})

it('任务文件邮箱与 HTTP/UDS 使用相同客户端且完成后清理交换文件',async()=>{
 const calls:Array<Record<string,unknown>>=[]
 const mailbox=await createHarnessDataMailbox({async inject(request:Record<string,unknown>){calls.push(request);return {statusCode:200,headers:{'content-type':'application/json'},rawPayload:Buffer.from('{"sources":[{"id":"sales"}]}')}}} as never,'task_1')
 cleanup.push(()=>mailbox.close())
 const result=await runHarnessDataCommand(parseArgs(['execute','sources.list']),{cwd:mailbox.directory,env:{OFFICE_HARNESS_DATA_URL:'http://127.0.0.1/api/v1/agents',OFFICE_HARNESS_TASK_ID:'task_1',OFFICE_HARNESS_DATA_CREDENTIAL:'secret-in-env',OFFICE_HARNESS_DATA_MAILBOX:mailbox.directory}})
 expect(result.detail).toEqual({sources:[{id:'sales'}]})
 expect(calls).toHaveLength(1);expect(calls[0]!.url).toBe('/api/v1/agents/tasks/task_1/data/execute')
 expect(await readdir(mailbox.directory)).toEqual([])
})

const taskEnv={OFFICE_HARNESS_DATA_URL:'http://127.0.0.1/api/v1/agents',OFFICE_HARNESS_TASK_ID:'task_1',OFFICE_HARNESS_DATA_CREDENTIAL:'x'.repeat(43)}
async function taskTransport(app:FastifyInstance,transport:'mailbox'|'socket'|'HTTP',directory:string) {
 const env:NodeJS.ProcessEnv={...taskEnv}
 cleanup.push(async()=>{app.server.closeAllConnections();await app.close()})
 if(transport==='mailbox'){
  await app.ready()
  const mailbox=await createHarnessDataMailbox(app,'task_1')
  env.OFFICE_HARNESS_DATA_MAILBOX=mailbox.directory
  cleanup.push(()=>mailbox.close())
 }else if(transport==='socket'){
  const path=join(directory,'data.sock')
  await app.listen({path})
  env.OFFICE_HARNESS_DATA_SOCKET=path
 }else{
  env.OFFICE_HARNESS_DATA_URL=await app.listen({host:'127.0.0.1',port:0})+'/api/v1/agents'
 }
 return env
}

it('returns all four wide schemas through the mailbox within the requested batch budget',async()=>{
 const queries=['select 1','select 2','select 3','select 4']
 const schema=Array.from({length:256},(_,i)=>({name:'列'.repeat(145)+i,type:'string',unit:'元'.repeat(75)}))
 const items=queries.map((_,i)=>({ok:true,result:{artifact:{resultId:'result_'+i},schema,timezone:'UTC',totalRows:0,sourceTruncated:false}}))
 let metadata:unknown={items}
 const rawPayload=()=>Buffer.from(JSON.stringify(metadata))
 expect(rawPayload().length).toBeGreaterThan(2*256*1024)
 expect(rawPayload().length).toBeLessThan(4*256*1024)
 const mailbox=await createHarnessDataMailbox({async inject(){return {statusCode:200,headers:{'content-type':'application/json'},rawPayload:rawPayload()}}} as never,'task_1')
 cleanup.push(()=>mailbox.close())
 const execute=(args:object)=>runHarnessDataCommand(parseArgs(['execute','sources.query','--args',JSON.stringify({sourceId:'sales',...args})]),{
  cwd:mailbox.directory,env:{...taskEnv,OFFICE_HARNESS_DATA_MAILBOX:mailbox.directory}
 })
 expect((await execute({queries})).detail).toEqual({items})
 await expect(execute({queries:queries.slice(0,2)})).rejects.toThrow('unavailable')
 await expect(execute({sql:'select 1'})).rejects.toThrow('unavailable')
 metadata={items:items.map((item,i)=>i===0?{...item,result:{...item.result,preview:[{value:1}]}}:item)}
 await expect(execute({queries})).rejects.toThrow('unavailable')
})

it.each(['HTTP','socket','mailbox'] as const)('downloads a verified 4,000,000-byte snapshot and rejects one more byte over %s',async transport=>{
 const directory=await mkdtemp(join(tmpdir(),'office-data-limit-'))
 cleanup.push(()=>rm(directory,{recursive:true,force:true}))
 const snapshot=(value:string)=>createQuerySnapshot({sourceId:'sales',sourceVersion:1,timezone:'UTC',sourceTruncated:false,
  schema:[{name:'text',type:'string'}],rows:[{text:value}]})
 const overhead=Buffer.byteLength(JSON.stringify(snapshot('')))
 const app=Fastify()
 registerHarnessDataRoutes(app,{
  async download(_task:string,_bearer:string,id:string){
   const size=id==='over'?4_000_001:4_000_000
   const value=snapshot('x'.repeat(size-overhead))
   return {bytes:Buffer.from(JSON.stringify(value)),sha256:value.sha256}
  },dispose(){},
 } as never)
 const env=await taskTransport(app,transport,directory)
 const download=(id:string)=>runHarnessDataCommand(parseArgs(['download',id,'--out',id+'.json']),{cwd:directory,env})
 const result=await download('limit')
 const bytes=await readFile(join(directory,'limit.json'))
 expect(bytes.length).toBe(4_000_000)
 expect(result.detail).toMatchObject({sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})
 await expect(download('over')).rejects.toThrow('unavailable')
 await expect(readFile(join(directory,'over.json'))).rejects.toMatchObject({code:'ENOENT'})
})

it.each(['HTTP','socket'] as const)('a stalled query aborts the active %s connection when its deadline expires',async transport=>{
 const directory=await mkdtemp(join(tmpdir(),'office-query-timeout-'))
 cleanup.push(()=>rm(directory,{recursive:true,force:true}))
 let started!:()=>void,release!:()=>void,disconnected!:()=>void
 const running=new Promise<void>(resolve=>{started=resolve}),finish=new Promise<void>(resolve=>{release=resolve})
 const closed=new Promise<void>(resolve=>{disconnected=resolve})
 const app=Fastify()
 app.post('/api/v1/agents/tasks/task_1/data/execute',async request=>{
  request.socket.once('close',disconnected);started();await finish;return {items:[]}
 })
 const env=await taskTransport(app,transport,directory)
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout']})
 try{
  const work=runHarnessDataCommand(parseArgs(['execute','sources.query','--args','{"sourceId":"sales","queries":["select 1","select 2"]}']),{cwd:directory,env})
  const outcome=expect(work).rejects.toThrow('unavailable')
  await running;vi.advanceTimersByTime(120_001);vi.useRealTimers()
  let timeout:ReturnType<typeof setTimeout>|undefined
  try{
   await Promise.race([closed,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(Error('Stalled query connection is still open')),2000)})])
  }finally{clearTimeout(timeout);release()}
  await outcome
 }finally{vi.useRealTimers();release()}
})

it.each([
 {scenario:'four queries can finish after 150 seconds',batch:true,elapsed:150_000,succeeds:true},
 {scenario:'four stalled queries still expire',batch:true,elapsed:240_001,succeeds:false},
 {scenario:'a single query still expires after 60 seconds',batch:false,elapsed:60_001,succeeds:false},
])('mailbox deadline: $scenario',async({batch,elapsed,succeeds})=>{
 let started!:()=>void,release!:()=>void
 const running=new Promise<void>(resolve=>{started=resolve}),reply=new Promise<void>(resolve=>{release=resolve})
 const rawPayload=Buffer.from(JSON.stringify(batch?{items:[1,2,3,4]}:{resultId:'one'}))
 const mailbox=await createHarnessDataMailbox({async inject(){
  started();await reply
  return {statusCode:200,headers:{'content-type':'application/json'},rawPayload}
 }} as never,'task_1')
 cleanup.push(()=>mailbox.close())
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout']})
 const args=batch?{sourceId:'sales',queries:['select 1','select 2','select 3','select 4']}:{sourceId:'sales',sql:'select 1'}
 const operation=runHarnessDataCommand(parseArgs(['execute','sources.query','--args',JSON.stringify(args)]),{
  cwd:mailbox.directory,env:{...taskEnv,OFFICE_HARNESS_DATA_MAILBOX:mailbox.directory}
 })
 const outcome=succeeds?expect(operation).resolves.toMatchObject({detail:{items:[1,2,3,4]}}):expect(operation).rejects.toThrow('unavailable')
 try{
  await running
  // Four 30 s statements, each with connection and capture overhead.
  vi.advanceTimersByTime(elapsed)
 }finally{vi.useRealTimers();release()}
 await outcome
})
it.each([
 ['sources.list',{}],
 ['sources.query',{sourceId:'sales',queries:['select 1','select 2']}],
] as const)('取消停滞的 %s 任务邮箱请求会清理文件，绝不切换网络或重试',async(name,args)=>{
 const directory=await mkdtemp(join(tmpdir(),'office-mailbox-cancel-'))
 cleanup.push(()=>rm(directory,{recursive:true,force:true}))
 const controller=new AbortController()
 const operation=runHarnessDataCommand(parseArgs(['execute',name,'--args',JSON.stringify(args)]),{cwd:directory,env:{...taskEnv,OFFICE_HARNESS_DATA_MAILBOX:directory},signal:controller.signal})
 setTimeout(()=>controller.abort(),40)
 await expect(operation).rejects.toThrow('cancelled')
 expect(await readdir(directory)).toEqual([])
})

it('内置任务从限长只读凭据文件读取，凭据值无需进入 argv',async()=>{
 const f=await fixture(),path=join(f.directory,'credential')
 await writeFile(path,f.env.OFFICE_HARNESS_DATA_CREDENTIAL,{mode:0o600})
 const env={...f.env,OFFICE_HARNESS_DATA_CREDENTIAL:undefined,OFFICE_HARNESS_DATA_CREDENTIAL_FILE:path}
 await runHarnessDataCommand(parseArgs(['manifest','result_1']),{cwd:f.directory,env})
 expect(f.requests[0]!.authorization).toBe('Bearer secret-in-env')
 await writeFile(path,'x'.repeat(2049))
 await expect(runHarnessDataCommand(parseArgs(['manifest','result_1']),{cwd:f.directory,env})).rejects.toThrow('authorization is unavailable')
 expect(f.requests).toHaveLength(1)
})
