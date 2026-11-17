import { createHash } from 'node:crypto'
import { MAX_OBJECT_BYTES } from '../../../server/src/storage/object-store.ts'
import type { JobClaim,JobWorkerStore } from '../../../server/src/modules/jobs/worker-store.ts'
import type { FileService } from '../../../server/src/modules/files/service.ts'
import type { LeaseService } from '../../../server/src/modules/leases/service.ts'
import type { RevisionService } from '../../../server/src/modules/revisions/service.ts'
import type { JobCredential } from '../../../server/src/db/context.ts'
import type { RevisionRef } from '../../../../../packages/web-contracts/src/api.ts'

type FailureCode = 'AUTHORITY_LOST' | 'ABORTED' | 'UNSUPPORTED_JOB' | 'NATIVE_FAILED' | 'RESOURCE_LIMIT' | 'TIMEOUT' | 'WORKER_FAILED'
export class JobExecutionError extends Error {
  readonly code: FailureCode
  constructor(code: FailureCode) { super(code); this.name='JobExecutionError'; this.code=code }
}
interface NativeXlsx { roundtrip(input: Uint8Array,signal?: AbortSignal): Promise<{ bytes: Buffer; sheetCount: number }> }
function failure(error: unknown): JobExecutionError {
  if (error instanceof JobExecutionError) return error
  const e = error as { code?: string; statusCode?: number }
  if (e?.code==='RESOURCE_LIMIT') return new JobExecutionError('RESOURCE_LIMIT')
  if (e?.code==='SANDBOX_TIMEOUT') return new JobExecutionError('TIMEOUT')
  if (e?.code==='ABORTED') return new JobExecutionError('ABORTED')
  if (e?.statusCode===401) return new JobExecutionError('AUTHORITY_LOST')
  if (['NATIVE_FAILED','INVALID_OUTPUT','INVALID_PROTOCOL','OUTPUT_LIMIT','INPUT_LIMIT'].includes(e?.code ?? '')) return new JobExecutionError('NATIVE_FAILED')
  return new JobExecutionError('WORKER_FAILED')
}
/** Trusted controller only. The native adapter gets bytes and an AbortSignal,
 * never SQL credentials, session tokens or the fenced job capability. */
export function createXlsxJobExecutor({ store,files,leases,revisions,native,heartbeatMs = Math.floor(store.claimLeaseMs/3) }: {
  store: JobWorkerStore; files: FileService; leases: LeaseService; revisions: RevisionService; native: NativeXlsx; heartbeatMs?: number
}) {
  if (!Number.isInteger(heartbeatMs) || heartbeatMs<25 || heartbeatMs>store.claimLeaseMs/2) throw new Error('Invalid job heartbeat timing')
  return {
    async execute(input: JobClaim,{ signal }: { signal?: AbortSignal } = {}): Promise<RevisionRef> {
      const claim = Object.freeze({ ...input })
      const auth: JobCredential = Object.freeze({ kind: 'job',jobId: claim.jobId,epoch: claim.epoch,token: claim.token })
      const controller = new AbortController()
      let finished = false,inFlight: Promise<void> | undefined,lease: Awaited<ReturnType<LeaseService['acquireLease']>> | undefined
      const abort = () => { if (!controller.signal.aborted) controller.abort(new JobExecutionError('ABORTED')) }
      signal?.addEventListener('abort',abort,{ once: true })
      if (signal?.aborted) abort()
      const check = () => { if (controller.signal.aborted) throw controller.signal.reason }
      const timer = setInterval(() => {
        if (finished || inFlight || controller.signal.aborted) return
        inFlight = (async () => {
          try {
            const renewed = await store.renew(claim)
            if (finished) return
            if (!renewed) throw new JobExecutionError('AUTHORITY_LOST')
            if (lease) lease = await leases.renewLease(auth,claim.fileId,{ editorId: claim.jobId,leaseEpoch: lease.leaseEpoch })
          } catch (error) {
            if (!finished && !controller.signal.aborted) controller.abort(failure(error))
          } finally { inFlight=undefined }
        })()
      },heartbeatMs)
      const stopMonitoring = async () => {
        finished=true; clearInterval(timer); signal?.removeEventListener('abort',abort)
        await inFlight
      }
      try {
        check()
        if (claim.type!=='xlsx.roundtrip') throw new JobExecutionError('UNSUPPORTED_JOB')
        lease = await leases.acquireLease(auth,claim.fileId,{ editorId: claim.jobId })
        check()
        const bytes = await files.readFile(auth,claim.fileId,claim.artifactId)
        check()
        // No principal transaction remains open across untrusted native work.
        const output = await native.roundtrip(bytes,controller.signal)
        check()
        // Snapshot native-owned bytes before any storage await. This binds output
        // identity, not runtime provenance or a proof of OS isolation.
        if (!Buffer.isBuffer(output?.bytes) || output.bytes.length===0) throw new JobExecutionError('NATIVE_FAILED')
        if (output.bytes.length>MAX_OBJECT_BYTES) throw new JobExecutionError('RESOURCE_LIMIT')
        const outputBytes = Buffer.from(output.bytes)
        const outputHash = createHash('sha256').update(outputBytes).digest('hex')
        const upload = await revisions.stageUpload(auth,claim.fileId,{ size: outputBytes.length,baseRevision: claim.baseRevision,leaseEpoch: lease.leaseEpoch,editorId: claim.jobId })
        check()
        const received = await files.receiveUpload(auth,upload.uploadId,outputBytes)
        check()
        if (received.uploadId!==upload.uploadId || received.size!==outputBytes.length || received.sha256!==outputHash) throw new JobExecutionError('NATIVE_FAILED')
        // This call owns the authoritative commit, including job success and
        // edit-lease release. A late heartbeat seeing terminal state must not
        // reinterpret a committed result as a failed operation.
        return await revisions.commitRevision(auth,{ fileId: claim.fileId,uploadId: upload.uploadId,baseRevision: claim.baseRevision,leaseEpoch: lease.leaseEpoch,idempotencyKey: 'job_' + claim.jobId })
      } catch (error) {
        const stopped = controller.signal.aborted ? failure(controller.signal.reason) : failure(error)
        if (!controller.signal.aborted) controller.abort(stopped)
        await stopMonitoring()
        if (lease) await leases.releaseLease(auth,claim.fileId,{ editorId: claim.jobId,leaseEpoch: lease.leaseEpoch }).catch(() => {})
        const code = stopped.code==='RESOURCE_LIMIT' ? 'RESOURCE_LIMIT' : stopped.code==='TIMEOUT' ? 'TIMEOUT' : stopped.code==='NATIVE_FAILED' ? 'NATIVE_FAILED' : 'WORKER_FAILED'
        // Lost/cancelled authority cannot change a newer or terminal claim.
        await store.fail(claim,code,stopped.code==='ABORTED' || stopped.code==='WORKER_FAILED').catch(() => {})
        throw stopped
      } finally { await stopMonitoring() }
    },
  }
}
