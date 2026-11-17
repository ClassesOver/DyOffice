import {createServer} from 'node:http'
import {afterEach,expect,it} from 'vitest'
import {parseArgs} from '../src/args'
import {runHarnessDataCommand} from '../src/harness-data-command'
import {createHarnessDataClient} from '../src/harness-data'

const closes:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const close of closes.splice(0))await close()})
async function fixture(status=200) {
 const calls:Array<{url:string|undefined;body:unknown;authorization:string|undefined}>=[]
 const commandId='911fc57b-5682-4089-9322-139f051f8080'
 const server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk
  calls.push({url:req.url,body:JSON.parse(raw),authorization:req.headers.authorization})
  res.writeHead(status,{'content-type':'application/json'})
  res.end(JSON.stringify(status===200?{commandId,summary:'Committed report',artifacts:[]}:{message:'private diagnostic must not escape'}))
 })
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 closes.push(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve())}))
 const address=server.address();if(!address||typeof address==='string')throw Error('Missing TCP listener')
 const env={OFFICE_HARNESS_DATA_URL:`http://127.0.0.1:${address.port}/api/v1/agents`,OFFICE_HARNESS_TASK_ID:'task_recovery',OFFICE_HARNESS_DATA_CREDENTIAL:'synthetic-task-secret'}
 return {commandId,calls,env}
}
it('receipt command makes one authenticated read and never repeats commit',async()=>{
 const f=await fixture()
 const result=await runHarnessDataCommand(parseArgs(['receipt',f.commandId]),{cwd:process.cwd(),env:f.env})
 expect(result.detail).toMatchObject({commandId:f.commandId,summary:'Committed report'})
 expect(f.calls).toEqual([{url:'/api/v1/agents/tasks/task_recovery/data/execute',body:{operation:'artifacts.get_receipt',arguments:{commandId:f.commandId}},authorization:'Bearer synthetic-task-secret'}])
})
it('client receipt helper accepts only a bounded command identifier',async()=>{
 const f=await fixture();const client=createHarnessDataClient({baseUrl:f.env.OFFICE_HARNESS_DATA_URL,taskId:f.env.OFFICE_HARNESS_TASK_ID,credential:f.env.OFFICE_HARNESS_DATA_CREDENTIAL})
 await expect(client.receipt('../other-task')).rejects.toThrow()
 expect(f.calls).toHaveLength(0)
 expect(await client.receipt(f.commandId)).toMatchObject({commandId:f.commandId})
})
it('receipt rejects flags and cancellation before contacting the service',async()=>{
 const f=await fixture(),controller=new AbortController();controller.abort()
 await expect(runHarnessDataCommand(parseArgs(['receipt',f.commandId,'--args','{}']),{cwd:process.cwd(),env:f.env})).rejects.toThrow()
 await expect(runHarnessDataCommand(parseArgs(['receipt',f.commandId]),{cwd:process.cwd(),env:f.env,signal:controller.signal})).rejects.toThrow('cancelled')
 expect(f.calls).toHaveLength(0)
})
it('denied receipt does not retry, recommit, or disclose upstream error text',async()=>{
 const f=await fixture(403)
 await expect(runHarnessDataCommand(parseArgs(['receipt',f.commandId]),{cwd:process.cwd(),env:f.env})).rejects.toThrow('Office task data operation unavailable')
 expect(f.calls).toHaveLength(1)
 expect(f.calls[0]!.body).toEqual({operation:'artifacts.get_receipt',arguments:{commandId:f.commandId}})
})
