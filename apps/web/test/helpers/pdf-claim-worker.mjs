// Disposable integration child. Claims through the real BullMQ/PG worker, then
// waits to be killed by the parent. Private claim data travels only over IPC.
import pg from 'pg'
import {createJobQueue} from '../../server/src/outbox/dispatcher.ts'
import {createJobWorkerStore} from '../../server/src/modules/jobs/worker-store.ts'
if(process.env.NODE_ENV!=='test'||!process.send)throw Error('Test child requires IPC')
if('DYOFFICE_TEST_DATABASE_URL' in process.env)throw Error('Owner URL must not reach worker')
const input=JSON.parse(process.env.PDF_DISPATCH_FIXTURE)
if(!['127.0.0.1','localhost'].includes(new URL(input.redis).hostname)||!/^\/dyoffice_test_rls_[a-f0-9]+$/.test(new URL(input.worker).pathname))throw Error('Disposable local fixture required')
const pool=new pg.Pool({connectionString:input.worker})
try{
 const queue=await createJobQueue({url:input.redis,name:input.queue})
 const store=createJobWorkerStore({pool,deploymentId:input.deploymentId,leaseMs:1200})
 const worker=queue.consume(store,async claim=>{
  process.send({kind:'claimed',claim})
  await new Promise(()=>{})
 })
 await worker.waitUntilReady()
}catch{process.send({kind:'failed'});await pool.end();process.exitCode=1}
