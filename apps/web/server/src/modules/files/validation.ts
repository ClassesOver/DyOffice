import { Worker } from 'node:worker_threads'
import { MAX_OBJECT_BYTES, storageError } from '../../storage/object-store.ts'
import { validateFileName, type FileValidationPolicy, type validateUploadInternal } from './validation-core.ts'
export { validateFileName, uploadLimits } from './validation-core.ts'

// Workers bound parser CPU/wall time and JS heap; this is not the future OS
// sandbox or malware scanner. Excess work is rejected without a pending queue.
export function createFileValidator({ timeoutMs = 5000, maxConcurrent = 2 }: { timeoutMs?: number; maxConcurrent?: number } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) throw storageError(400)
  let active = 0
  return async function validate(bytes: Buffer, name: string, policy: Partial<FileValidationPolicy> = {}): ReturnType<typeof validateUploadInternal> {
    validateFileName(name)
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw storageError(400)
    if (bytes.length > MAX_OBJECT_BYTES || bytes.length > (policy.maxBytes ?? MAX_OBJECT_BYTES)) throw storageError(413)
    if (active >= maxConcurrent) throw Object.assign(storageError(503), { retryAfter: 1 })
    active++
    let worker: Worker | undefined, deadline: ReturnType<typeof setTimeout> | undefined
    try {
      const snapshot = new Uint8Array(bytes.length)
      snapshot.set(bytes)
      worker = new Worker(new URL('./validation-worker.ts', import.meta.url), {
        workerData: { bytes: snapshot, name, policy }, transferList: [snapshot.buffer],
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }, stdout: true, stderr: true,
      })
      worker.stdout.resume(); worker.stderr.resume()
      return await new Promise((resolve, reject) => {
        deadline = setTimeout(() => reject(storageError(413)), timeoutMs)
        worker!.once('message', message => message.ok ? resolve(message.value) : reject(storageError(message.statusCode === 413 ? 413 : 400)))
        worker!.once('error', error => reject(storageError((error as NodeJS.ErrnoException).code === 'ERR_WORKER_OUT_OF_MEMORY' ? 413 : 503)))
        worker!.once('exit', () => reject(storageError(503)))
      })
    } finally {
      clearTimeout(deadline)
      await worker?.terminate()
      active--
    }
  }
}
export const validateUpload = createFileValidator()
