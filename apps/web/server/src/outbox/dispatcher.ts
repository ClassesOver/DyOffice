import { Queue, Worker } from 'bullmq'
import type { RedisOptions } from 'bullmq'
import type { JobClaim,JobDelivery,JobWorkerStore } from '../modules/jobs/worker-store.ts'

type Hint = { jobId: string; deliveryEpoch: number }
function hint(value: unknown): Hint {
  const v = value as Hint
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== 'deliveryEpoch,jobId' || typeof v.jobId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v.jobId) || !Number.isSafeInteger(v.deliveryEpoch) || v.deliveryEpoch < 1) throw new Error('Invalid opaque job hint')
  return { jobId: v.jobId,deliveryEpoch: v.deliveryEpoch }
}
function connectionOptions(value: string): RedisOptions {
  try {
    const url = new URL(value), host = url.hostname.replace(/^\[|\]$/g,''), dbPath = url.pathname || '/'
    if (!['redis:','rediss:'].includes(url.protocol) || url.search || url.hash || !/^\/(?:[0-9]|1[0-5])?$/.test(dbPath) || (url.protocol === 'redis:' && !['127.0.0.1','localhost','::1'].includes(host))) throw new Error()
    return { host,port: Number(url.port || 6379),db: Number(dbPath.slice(1) || 0),username: url.username ? decodeURIComponent(url.username) : undefined,password: url.password ? decodeURIComponent(url.password) : undefined,...(url.protocol === 'rediss:' ? { tls: {} } : {}),connectTimeout: 3000,maxRetriesPerRequest: 1,enableOfflineQueue: false,retryStrategy: attempts => Math.min(100*attempts,2000) }
  } catch { throw new Error('Invalid Redis configuration') }
}
export async function createJobQueue({ url,name,onError = () => {} }: { url: string; name: string; onError?: (error: Error) => void }) {
  if (!/^dyoffice-[a-z0-9-]{1,100}$/.test(name)) throw new Error('Invalid job queue name')
  const connection = connectionOptions(url), queue = new Queue<Hint>(name,{ connection,defaultJobOptions: { attempts: 1,removeOnComplete: 100,removeOnFail: 100 } })
  const workers = new Set<Worker<Hint>>()
  const error = (value: Error) => { try { onError(value) } catch { /* observers cannot alter task state */ } }
  queue.on('error',error)
  let startupTimer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([queue.waitUntilReady(),new Promise((_,reject) => { startupTimer = setTimeout(() => reject(new Error('Redis startup deadline exceeded')),3000) })])
  } catch (failure) { await queue.close().catch(() => {}); throw failure }
  finally { clearTimeout(startupTimer) }
  return {
    // Internal BullMQ handle for operations/diagnostics, never exposed in an HTTP DTO.
    queue,
    async enqueueHint(value: Hint) {
      const data = hint(value)
      // Queue IDs only reduce hints. SQL claim epochs own execution fencing.
      await queue.add('native-job',data,{ jobId: data.jobId + '-' + data.deliveryEpoch })
    },
    consume(store: JobWorkerStore,execute: (claim: JobClaim) => Promise<void>) {
      const worker = new Worker<Hint>(name,async job => {
        const data = hint(job.data), claim = await store.claim(data.jobId)
        if (claim) await execute(claim)
        // Completing a hint never marks the database job successful.
      },{ connection: { ...connection,maxRetriesPerRequest: null,enableOfflineQueue: true,retryStrategy: attempts => Math.min(100*attempts,2000) },concurrency: 1 })
      worker.on('error',error); workers.add(worker); worker.on('closed',() => workers.delete(worker))
      return worker
    },
    async close() { await Promise.allSettled([...workers].map(worker => worker.close(true))); await queue.close() },
  }
}
export function createJobDispatcher({ store,queue }: { store: JobWorkerStore; queue: { enqueueHint(hint: Hint): Promise<void> } }) {
  return {
    async runOnce() {
      const delivery: JobDelivery | null = await store.takeDelivery()
      if (!delivery) return false
      await queue.enqueueHint({ jobId: delivery.jobId,deliveryEpoch: delivery.deliveryEpoch })
      // Lost ack is safe: the lease expires and SQL reconciles another hint.
      await store.ackDelivery(delivery)
      return true
    },
  }
}

// Revision notifications are opaque hints. Receiving/publishing one does not
// assert that indexing or any other downstream projection has processed it.
export async function createRevisionQueue({url,name,onError=()=>{}}:{url:string;name:string;onError?:(error:Error)=>void}) {
  if(!/^dyoffice-revisions-[a-z0-9-]{1,80}$/.test(name))throw new Error('Invalid revision queue name')
  const queue=new Queue<{eventId:string}>(name,{connection:connectionOptions(url)})
  queue.on('error',error=>{try{onError(error)}catch{}})
  let timer:ReturnType<typeof setTimeout>|undefined
  try{await Promise.race([queue.waitUntilReady(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Revision queue startup timeout')),3000)})])}
  catch(error){await queue.close().catch(()=>{});throw error}finally{clearTimeout(timer)}
  return {
    queue,
    async publish(eventId:string){
      if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(eventId))throw new Error('Invalid revision event')
      await queue.add('file.revision.committed',{eventId},{jobId:eventId,removeOnComplete:true,removeOnFail:true})
    },
    close:()=>queue.close(),
  }
}
export function createRevisionDispatcher({store,queue}:{store:JobWorkerStore;queue:{publish(eventId:string):Promise<void>}}){
  return {async runOnce(){
    const delivery=await store.takeRevisionDelivery()
    if(!delivery)return false
    await queue.publish(delivery.eventId)
    await store.ackRevisionDelivery(delivery)
    return true
  }}
}
