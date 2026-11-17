import {spawn} from 'node:child_process'
import {createServer} from 'node:http'
import {mkdtemp,rm,writeFile,readdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {afterEach,expect,it} from 'vitest'
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
 const {createHarnessDataMailbox}=await import('../../../apps/web/server/src/modules/coding/data-mailbox')
 const calls:Array<Record<string,unknown>>=[]
 const mailbox=await createHarnessDataMailbox({async inject(request:Record<string,unknown>){calls.push(request);return {statusCode:200,headers:{'content-type':'application/json'},rawPayload:Buffer.from('{"sources":[{"id":"sales"}]}')}}} as never,'task_1')
 cleanup.push(()=>mailbox.close())
 const result=await runHarnessDataCommand(parseArgs(['execute','sources.list']),{cwd:mailbox.directory,env:{OFFICE_HARNESS_DATA_URL:'http://127.0.0.1/api/v1/agents',OFFICE_HARNESS_TASK_ID:'task_1',OFFICE_HARNESS_DATA_CREDENTIAL:'secret-in-env',OFFICE_HARNESS_DATA_MAILBOX:mailbox.directory}})
 expect(result.detail).toEqual({sources:[{id:'sales'}]})
 expect(calls).toHaveLength(1);expect(calls[0]!.url).toBe('/api/v1/agents/tasks/task_1/data/execute')
 expect(await readdir(mailbox.directory)).toEqual([])
})
it('取消停滞任务邮箱请求会清理文件，绝不切换网络或重试',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'office-mailbox-cancel-'))
 cleanup.push(()=>rm(directory,{recursive:true,force:true}))
 const controller=new AbortController()
 const operation=runHarnessDataCommand(parseArgs(['execute','sources.list']),{cwd:directory,env:{OFFICE_HARNESS_DATA_URL:'http://127.0.0.1/api/v1/agents',OFFICE_HARNESS_TASK_ID:'task_1',OFFICE_HARNESS_DATA_CREDENTIAL:'secret-in-env',OFFICE_HARNESS_DATA_MAILBOX:directory},signal:controller.signal})
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
