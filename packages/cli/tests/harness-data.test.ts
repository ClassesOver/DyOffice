import {createHash} from 'node:crypto'
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach,describe,expect,it,vi} from 'vitest'
import {createQuerySnapshot} from '../../../apps/web/server/src/modules/sources/provenance'
import {createHarnessDataClient} from '../src/harness-data'

const baseUrl='https://office.example/api/v1/harness'
const options={baseUrl,taskId:'task_123',credential:'task-scoped-secret'}
const directories:string[]=[]
afterEach(async()=>{for(const path of directories.splice(0))await rm(path,{recursive:true,force:true})})
async function directory(){const path=await mkdtemp(join(tmpdir(),'office-harness-data-'));directories.push(path);return path}
const rawHash=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex')
function snapshot(value=7,label='中文') {
  return createQuerySnapshot({sourceId:'sales',sourceVersion:2,timezone:'UTC',sourceTruncated:false,
    schema:[{name:'z',type:'number',unit:'CNY'},{name:'a',type:'string'}],rows:[{a:label,z:value}]})
}
function downloadResponse(value=snapshot(),headers:Record<string,string>={}) {
  const bytes=Buffer.from(JSON.stringify(value))
  return new Response(bytes,{headers:{'content-type':'application/json','x-content-sha256':rawHash(bytes),'x-snapshot-sha256':value.sha256,...headers}})
}

describe('内外部 harness 统一数据客户端',()=>{
  it.each([
    {elapsed:180_000,callerCancels:false,succeeds:true},
    {elapsed:240_001,callerCancels:false,succeeds:false},
    {elapsed:30_000,callerCancels:true,succeeds:false},
  ])('bounds a four-query request before headers at $elapsed ms (callerCancels=$callerCancels)',async({elapsed,callerCancels,succeeds})=>{
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']})
    const caller=new AbortController(),cancel=vi.fn()
    let deliver!:(response:Response)=>void
    const transport=new Promise<Response>(resolve=>{deliver=resolve})
    const client=createHarnessDataClient({...options,fetchImpl:async()=>transport})
    const request=client.execute('execute_sql',{sourceId:'sales',queries:['select 1','select 2','select 3','select 4']},caller.signal)
    const outcome=succeeds?expect(request).resolves.toEqual({items:[]}):expect(request).rejects.toThrow()
    try{
      vi.advanceTimersByTime(elapsed)
      if(callerCancels)caller.abort()
      const bytes=new TextEncoder().encode('{"items":[]}')
      const response=new Response(new ReadableStream({start(stream){stream.enqueue(bytes);if(succeeds)stream.close()},cancel}),{headers:{'content-type':'application/json'}})
      if(succeeds)deliver(response)
      else {
        // Even a transport delivering headers late must release the discarded body.
        const settled=await Promise.race([request.then(()=>false,()=>true),new Promise<false>(resolve=>setImmediate(()=>resolve(false)))])
        if(!settled)caller.abort()
        deliver(response)
        expect(settled).toBe(true)
      }
      await outcome
      if(!succeeds)expect(cancel).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    }finally{vi.useRealTimers()}
  })
  it('用任务凭据调用同一接口，结果只接受有界元数据',async()=>{
    const fetchImpl=vi.fn<typeof fetch>(async()=>Response.json({resultId:'result_1',rowCount:1,truncated:false}))
    const client=createHarnessDataClient({...options,fetchImpl})
    expect(await client.execute('execute_sql',{sourceId:'sales',sql:'select amount from sales'})).toEqual({resultId:'result_1',rowCount:1,truncated:false})
    const [url,init]=fetchImpl.mock.calls[0]!
    expect(url).toBe(baseUrl+'/tasks/task_123/data/execute')
    expect(init).toMatchObject({method:'POST',redirect:'error',credentials:'omit',headers:{authorization:'Bearer task-scoped-secret'}})
    expect(JSON.parse(String(init!.body))).toEqual({operation:'execute_sql',arguments:{sourceId:'sales',sql:'select amount from sales'}})
    await client.manifest('result_1')
    expect(JSON.parse(String(fetchImpl.mock.calls[1]![1]!.body))).toEqual({operation:'results.get_manifest',arguments:{resultId:'result_1'}})
  })

  it('拒绝不安全地址、路径标识和超过40KiB的输入，不发送凭据',async()=>{
    const fetchImpl=vi.fn()
    for(const url of ['http://office.example/api','file:///tmp/data','https://user:secret@office.example/api','https://office.example/api?token=x','https://office.example/a/../b','https://office.example/a%2fb'])
      expect(()=>createHarnessDataClient({...options,baseUrl:url,fetchImpl})).toThrow()
    expect(()=>createHarnessDataClient({...options,taskId:'../other',fetchImpl})).toThrow()
    const client=createHarnessDataClient({...options,fetchImpl})
    await expect(client.execute('execute_sql',{sql:'中'.repeat(14_000)})).rejects.toThrow()
    await expect(client.manifest('../result')).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(()=>createHarnessDataClient({...options,baseUrl:'http://127.0.0.1:8080/api/'})).not.toThrow()
  })

  it('仅产物上传和提交使用对应有界大请求',async()=>{
    const fetchImpl=vi.fn<typeof fetch>(async()=>Response.json({artifactId:'artifact_1'}))
    const client=createHarnessDataClient({...options,fetchImpl})
    await client.execute('artifacts.stage',{contentBase64:'x'.repeat(1024*1024)})
    await client.execute('artifacts.commit',{summary:'x'.repeat(64*1024)})
    await expect(client.execute('artifacts.stage',{contentBase64:'x'.repeat(12*1024*1024)})).rejects.toThrow()
    await expect(client.execute('artifacts.commit',{summary:'x'.repeat(80*1024)})).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('不接受重定向后的响应，也不跟随307到另一个服务',async()=>{
    const redirected=Response.json({ok:true})
    Object.defineProperty(redirected,'redirected',{value:true})
    Object.defineProperty(redirected,'url',{value:'https://other.example/leak'})
    const client=createHarnessDataClient({...options,fetchImpl:async()=>redirected})
    await expect(client.execute('list_connections',{})).rejects.toThrow()
    const fetchImpl=vi.fn<typeof fetch>(async()=>new Response(null,{status:307,headers:{location:'https://other.example/leak'}}))
    await expect(createHarnessDataClient({...options,fetchImpl}).execute('list_connections',{})).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0]![1]!.redirect).toBe('error')
  })

  it('执行响应不容许原始数据行、预览或超过256KiB的内容',async()=>{
    for(const body of [{artifact:{rows:[{secret:'raw'}]}},{preview:[{amount:1}]},{note:'x'.repeat(256*1024)}]) {
      const client=createHarnessDataClient({...options,fetchImpl:async()=>Response.json(body)})
      await expect(client.execute('execute_sql',{sourceId:'sales'})).rejects.toThrow()
    }
  })

  it('分别验证原始字节和按schema顺序重算的快照摘要，再原子写入指定本地文件',async()=>{
    const path=join(await directory(),'input.json'),value=snapshot()
    const bytes=Buffer.from(JSON.stringify(value))
    const client=createHarnessDataClient({...options,fetchImpl:async()=>downloadResponse(value)})
    const result=await client.download('result_1',path)
    expect(result).toEqual({destination:path,resultId:'result_1',sha256:rawHash(bytes),snapshotSha256:value.sha256,sizeBytes:bytes.length})
    expect(rawHash(bytes)).not.toBe(value.sha256)
    expect(await readFile(path)).toEqual(bytes)
    expect(await readdir(join(path,'..'))).toEqual(['input.json'])
  })

  it('原始字节损坏或语义摘要损坏均拒绝下载且不留下文件',async()=>{
    const root=await directory(),path=join(root,'input.json')
    const corrupted={...snapshot(),sha256:'1'.repeat(64)}
    for(const response of [downloadResponse(snapshot(),{'x-content-sha256':'0'.repeat(64)}),downloadResponse(corrupted)]) {
      await expect(createHarnessDataClient({...options,fetchImpl:async()=>response}).download('result_1',path)).rejects.toThrow()
      expect(await readdir(root)).toEqual([])
    }
  })

  it('截断流和超过冻结结果字节上限的内容不产生半成品，也不重跑SQL',async()=>{
    const root=await directory(),path=join(root,'input.json')
    const broken=new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"version":1'));controller.error(Error('disconnected'))}}),{headers:{'content-type':'application/json'}})
    const oversized=downloadResponse(snapshot(7,'x'.repeat(4_000_000)))
    for(const response of [broken,oversized]) {
      const fetchImpl=vi.fn(async()=>response)
      await expect(createHarnessDataClient({...options,fetchImpl}).download('result_1',path)).rejects.toThrow()
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      expect(await readdir(root)).toEqual([])
    }
  })

  it('取消停滞响应会取消reader，清理临时文件并保留AbortError',async()=>{
    const root=await directory(),path=join(root,'input.json'),controller=new AbortController(),cancel=vi.fn()
    let started!:()=>void
    const ready=new Promise<void>(resolve=>{started=resolve})
    const response=new Response(new ReadableStream({start(){started()},cancel}),{headers:{'content-type':'application/json','x-content-sha256':'0'.repeat(64),'x-snapshot-sha256':'0'.repeat(64)}})
    const client=createHarnessDataClient({...options,fetchImpl:async()=>response})
    const pending=client.download('result_1',path,controller.signal)
    await ready;await new Promise(resolve=>setTimeout(resolve,0));controller.abort()
    await expect(pending).rejects.toMatchObject({name:'AbortError'})
    expect(cancel).toHaveBeenCalled();expect(await readdir(root)).toEqual([])
  })

  it('已有文件绝不覆盖，两个并发下载最多一个发布成功',async()=>{
    const root=await directory(),path=join(root,'input.json')
    await writeFile(path,'existing')
    const client=createHarnessDataClient({...options,fetchImpl:async()=>downloadResponse()})
    await expect(client.download('result_1',path)).rejects.toThrow()
    expect(await readFile(path,'utf8')).toBe('existing')
    const racePath=join(root,'race.json')
    const raced=await Promise.allSettled([client.download('result_1',racePath),client.download('result_1',racePath)])
    expect(raced.filter(value=>value.status==='fulfilled')).toHaveLength(1)
    expect(JSON.parse(await readFile(racePath,'utf8'))).toEqual(snapshot())
    expect((await readdir(root)).sort()).toEqual(['input.json','race.json'])
  })
})

it('cancels a late response body even when abort preceded body-reader acquisition',async()=>{
 const root=await directory(),controller=new AbortController(),cancel=vi.fn(async()=>{throw Error('private stream cleanup failure')})
 await writeFile(join(root,'committed.json'),'existing committed bytes')
 const client=createHarnessDataClient({...options,fetchImpl:async()=>{
  const response=new Response(new ReadableStream({cancel}),{headers:{'content-type':'application/json'}})
  controller.abort();return response
 }})
 await expect(client.download('result_1',join(root,'new.json'),controller.signal)).rejects.toMatchObject({name:'AbortError'})
 expect(cancel).toHaveBeenCalledTimes(1)
 expect(await readdir(root)).toEqual(['committed.json']);expect(await readFile(join(root,'committed.json'),'utf8')).toBe('existing committed bytes')
})

it('late localhost HTTP body is closed on cancellation without touching committed files',async()=>{
 const {createServer}=await import('node:http')
 const root=await directory(),controller=new AbortController()
 await writeFile(join(root,'committed.json'),'committed bytes')
 let disconnected!:()=>void
 const closed=new Promise<void>(resolve=>{disconnected=resolve})
 const server=createServer((request,response)=>{
  expect(request.headers.authorization).toBe('Bearer task-scoped-secret')
  response.on('close',disconnected)
  response.writeHead(200,{'content-type':'application/json'});response.write('{')
 })
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
 const address=server.address();if(!address||typeof address==='string')throw Error('No test listener')
 let timer:ReturnType<typeof setTimeout>|undefined
 try {
  const client=createHarnessDataClient({...options,baseUrl:`http://127.0.0.1:${address.port}/api/v1/harness`,fetchImpl:async(input,init)=>{
   // Reproduce a response already delivered by the transport when cancel wins.
   const response=await fetch(input,{...init,signal:null});controller.abort();return response
  }})
  await expect(client.download('result_1',join(root,'new.json'),controller.signal)).rejects.toMatchObject({name:'AbortError'})
  await Promise.race([closed,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Cancelled HTTP response remained open')),2000)})])
  expect(await readdir(root)).toEqual(['committed.json']);expect(await readFile(join(root,'committed.json'),'utf8')).toBe('committed bytes')
 }finally{clearTimeout(timer);server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
})
