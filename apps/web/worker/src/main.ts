import {assertDocumentBackendPolicy} from './sandbox/document-backend-policy.ts'
import { Pool } from 'pg'
import { setTimeout as delay } from 'node:timers/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertRuntimePool,assertSharedDatabase } from '../../server/src/db/roles.ts'
import { createPrincipalTransactions } from '../../server/src/db/context.ts'
import { configuredObjectStore } from '../../server/src/storage/config.ts'
import { createFileService } from '../../server/src/modules/files/service.ts'
import { createLeaseService } from '../../server/src/modules/leases/service.ts'
import { createRevisionService } from '../../server/src/modules/revisions/service.ts'
import { createJobWorkerStore } from '../../server/src/modules/jobs/worker-store.ts'
import { createJobQueue,createJobDispatcher,createRevisionQueue,createRevisionDispatcher } from '../../server/src/outbox/dispatcher.ts'
import { uuid } from '../../server/src/modules/files/queries.ts'
import { recoverHostProcesses } from './sandbox/host-recovery.ts'
import { createHostProcess } from './sandbox/host-process.ts'
import { createXlsxNativeWorker } from './native/xlsx.ts'
import { createXlsxJobExecutor } from './jobs/xlsx.ts'

export async function startNativeWorker(environment: NodeJS.ProcessEnv = process.env,{ signal }: { signal?: AbortSignal } = {}) {
  assertDocumentBackendPolicy(environment)
  if (environment.NODE_ENV==='production' || environment.DYOFFICE_NATIVE_WORKER!=='experimental') throw new Error('Explicit experimental worker required')
  if (environment.DYOFFICE_DATABASE_URL || environment.DYOFFICE_AUTH_DATABASE_URL || environment.DYOFFICE_USER_TOKEN || environment.DYOFFICE_ADMIN_TOKEN) throw new Error('Worker rejects privileged or unrelated credentials')
  if (environment.DYOFFICE_OBJECT_STORE!=='s3') throw new Error('Native worker requires S3 object storage')
  const required = (name: string) => { const value=environment[name]; if (!value) throw new Error('Worker configuration missing'); return value }
  const deploymentId=uuid(required('DYOFFICE_DEPLOYMENT_ID'))
  const workerUrl=required('DYOFFICE_WORKER_DATABASE_URL'),businessUrl=required('DYOFFICE_BUSINESS_DATABASE_URL'),redisUrl=required('DYOFFICE_REDIS_URL'),binary=required('DYOFFICE_NATIVE_BINARY'),sha256=required('DYOFFICE_NATIVE_SHA256')
  const controller=new AbortController(),active=new Set<Promise<unknown>>()
  let workerPool: Pool | undefined,businessPool: Pool | undefined,storage: Awaited<ReturnType<typeof configuredObjectStore>> | undefined
  let queue: Awaited<ReturnType<typeof createJobQueue>> | undefined,consumer: ReturnType<Awaited<ReturnType<typeof createJobQueue>>['consume']> | undefined
  let revisionQueue: Awaited<ReturnType<typeof createRevisionQueue>> | undefined
  let loop: Promise<void> | undefined,started=false,closing: Promise<void> | undefined,resolveClosed!: () => void,rejectClosed!: (error: unknown) => void
  const closed=new Promise<void>((resolve,reject) => { resolveClosed=resolve; rejectClosed=reject }); void closed.catch(() => {})
  const check = () => { if (controller.signal.aborted) throw new Error('Worker startup aborted') }
  let lastWarning=0
  const warn = () => { if (Date.now()-lastWarning>10_000) { lastWarning=Date.now(); console.error('dyoffice-worker: dependency unavailable') } }
  const close = () => closing ??= (async () => {
    controller.abort(); signal?.removeEventListener('abort',abort)
    try {
      if (consumer) {
        await consumer.pause(true).catch(() => {})
        await consumer.close(!started)
      }
      await Promise.allSettled([...active])
      await loop
    } finally {
      try { await Promise.all([queue?.close(),revisionQueue?.close()]) }
      finally {
        storage?.close()
        await Promise.allSettled([workerPool?.end(),businessPool?.end()])
      }
    }
  })().then(() => { resolveClosed() },error => { rejectClosed(error); throw error })
  const abort = () => { controller.abort(); if (started) void close().catch(() => {}) }
  signal?.addEventListener('abort',abort,{ once: true }); if (signal?.aborted) abort()
  try {
    check()
    workerPool=new Pool({ connectionString: workerUrl,max: 4,connectionTimeoutMillis: 5000,statement_timeout: 10_000,query_timeout: 12_000,idle_in_transaction_session_timeout: 30_000 })
    businessPool=new Pool({ connectionString: businessUrl,max: 4,connectionTimeoutMillis: 5000,statement_timeout: 10_000,query_timeout: 12_000,idle_in_transaction_session_timeout: 30_000 })
    await assertRuntimePool(workerPool,'worker'); check()
    await assertRuntimePool(businessPool,'business'); check()
    await assertSharedDatabase(workerPool,businessPool); check()
    if (!(await workerPool.query('SELECT native_deployment_ready($1::uuid) AS ready',[deploymentId])).rows[0].ready) throw new Error('Worker deployment is not bootstrapped')
    storage=await configuredObjectStore(environment); check()
    if (!storage.objectStore) throw new Error('Native worker requires explicit File API storage')
    await recoverHostProcesses(deploymentId); check()
    const sandbox=createHostProcess({ binary,sha256,deploymentId,allowedCommands: ['open','read_range','recalc_cells','save_archive','close'] })
    // Boot and close the actual isolated program before accepting jobs. No
    // document is parsed and no task or output is fabricated for readiness.
    await sandbox.run(Buffer.from('worker-startup'),async () => {},{ signal: controller.signal }); check()
    const transactions=createPrincipalTransactions({ pool: businessPool,deploymentId })
    const files=createFileService({ transactions,objects: storage.objectStore,...storage.filePolicy })
    const leases=createLeaseService({ transactions,assertOfficeWritable:files.assertOfficeWritable }),revisions=createRevisionService({ transactions,objects: storage.objectStore,files,...storage.filePolicy })
    const store=createJobWorkerStore({ pool: workerPool,deploymentId,reconcileMs: 1000 })
    const executor=createXlsxJobExecutor({ store,files,leases,revisions,native: createXlsxNativeWorker(sandbox),heartbeatMs: 1000 })
    queue=await createJobQueue({ url: redisUrl,name: 'dyoffice-native-' + deploymentId,onError: warn }); check()
    consumer=queue.consume(store,async claim => {
      const pending=executor.execute(claim,{ signal: controller.signal }); active.add(pending)
      try { await pending } finally { active.delete(pending) }
    })
    let readyTimer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([consumer.waitUntilReady(),new Promise((_,reject) => { readyTimer=setTimeout(() => reject(new Error('Worker queue startup timeout')),3000) })]) }
    finally { clearTimeout(readyTimer) }
    check()
    revisionQueue=await createRevisionQueue({url:redisUrl,name:'dyoffice-revisions-'+deploymentId,onError:warn});check()
    const revisionsDispatcher=createRevisionDispatcher({store,queue:revisionQueue})
    const dispatcher=createJobDispatcher({ store,queue })
    let nextRecovery=Date.now()+60_000
    loop=(async () => {
      while (!controller.signal.aborted) {
        try {
          if(Date.now()>=nextRecovery){
            nextRecovery=Date.now()+60_000
            try{await recoverHostProcesses(deploymentId)}catch{warn()}
          }
          for (let i=0;i<16 && !controller.signal.aborted;i++) if (!await dispatcher.runOnce()) break
          for (let i=0;i<16 && !controller.signal.aborted;i++) if (!await revisionsDispatcher.runOnce()) break }
        catch { if (!controller.signal.aborted) warn() }
        await delay(1000,undefined,{ signal: controller.signal }).catch(() => {})
      }
    })()
    started=true
    return { close,closed }
  } catch (error) { await close(); throw error }
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const stop=new AbortController()
  process.on('SIGTERM',() => stop.abort()); process.on('SIGINT',() => stop.abort())
  let ready=false
  try {
    const runtime=await startNativeWorker(process.env,{ signal: stop.signal })
    ready=true
    console.log('dyoffice-worker: ready')
    await runtime.closed
  } catch { console.error(ready ? 'dyoffice-worker: shutdown failed' : 'dyoffice-worker: startup failed'); process.exitCode=1 }
}
