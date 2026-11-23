// Isolated process fixture: credentials arrive over IPC and are never logged.
import {Pool} from 'pg'
import {createPrincipalTransactions} from '../../server/src/db/context.ts'
import {createAssistantChannelService} from '../../server/src/modules/assistant-channel/service.ts'
import {createAssistantBackgroundStore} from '../../server/src/modules/assistant-channel/background-store.ts'
import {createAssistantBackgroundRunner} from '../../server/src/modules/assistant-channel/background-runner.ts'
import {createLocalObjectStore} from '../../server/src/storage/local-dev.ts'

process.once('message',async config=>{
 const business=new Pool({connectionString:config.business,max:2}),worker=new Pool({connectionString:config.worker,max:1})
 let runner
 try{
  const service=createAssistantChannelService({transactions:createPrincipalTransactions({pool:business,deploymentId:config.deploymentId}),credentialKey:config.key,backgroundEnabled:true})
  const objects=await createLocalObjectStore({directory:config.directory})
  runner=createAssistantBackgroundRunner({service,objects,store:createAssistantBackgroundStore({pool:worker,deploymentId:config.deploymentId}),answer:async input=>{
   process.send({phase:'answer',revision:input.revision,text:input.text})
   if(config.hold)await new Promise((resolve,reject)=>{
    input.signal.addEventListener('abort',()=>reject(Error('stopped')),{once:true})
    process.once('message',message=>message==='release'?resolve():reject(Error('stopped')))
   })
   return '进程验证：42万元'
  }})
  process.on('message',message=>{if(message==='stop')runner.dispose()})
  process.send({phase:'ready'})
  const worked=await runner.runOnce()
  process.send({phase:'done',worked})
 }catch{
  process.send({phase:'error'})
  process.exitCode=1
 }finally{
  runner?.dispose();await runner?.drain()
  await Promise.all([business.end(),worker.end()])
  process.disconnect()
 }
})
