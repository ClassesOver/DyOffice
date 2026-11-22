import {Pool} from 'pg'
import {buildLocalApp} from '../../server/src/app.ts'
import {createIdentityStore} from '../../server/src/db/identity.ts'
import {createPasswordService} from '../../server/src/modules/auth/passwords.ts'
import {createLocalObjectStore} from '../../server/src/storage/local-dev.ts'
import {restrictedOrigin} from './restricted.mjs'

// Test credentials and the fixture's storage path arrive through IPC only.
process.once('message',async config=>{
 const auth=new Pool({connectionString:config.auth,max:2}),businessPool=new Pool({connectionString:config.business,max:3})
 try{
  const app=await buildLocalApp({db:createIdentityStore(auth),businessPool,assistantChannels:true,passwords:await createPasswordService(),
   deploymentId:config.deploymentId,origin:restrictedOrigin,csrfKey:config.csrfKey,
   objectStore:await createLocalObjectStore({directory:config.directory}),providerGateway:{mode:'shared'},
   globalConfigKeyring:{activeKeyId:'fixture',keys:{fixture:new Uint8Array(32).fill(1)}},
   codingHarnesses:{defaultId:'fixture',adapters:[{
    descriptor:{id:'fixture',name:'Calculator',origin:'external',capabilities:['coding']},
    async run(input,_signal,context){
     process.send({phase:'execution',instruction:input.instruction})
     if(input.instruction==='Wait for interruption'){
      context.onProgress({kind:'status',text:'Waiting for interruption'})
      await new Promise(()=>{})
     }
     return {summary:'Calculated',output:'42'}
    },
   }]},
  })
  process.send({phase:'ready',origin:await app.listen({host:'127.0.0.1',port:0})})
 }catch{
  process.send({phase:'error'})
  await Promise.allSettled([auth.end(),businessPool.end()])
  process.exitCode=1
  process.disconnect()
 }
})
