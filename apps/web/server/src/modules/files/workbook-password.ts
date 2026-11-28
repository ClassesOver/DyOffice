import { Worker } from 'node:worker_threads'
import { MAX_OBJECT_BYTES, storageError } from '../../storage/object-store.ts'
import type { EncryptedOfficeFormat } from '../../../../../../packages/web-contracts/src/api.ts'
import type { transformProtectedWorkbook } from './workbook-password-core.ts'

type Result = Awaited<ReturnType<typeof transformProtectedWorkbook>>
type Operation = 'open' | 'seal' | 'verify'
type Output<T extends Operation> = T extends 'verify' ? Result['file'] : Result

/** A password and decrypted package live in memory for the lifetime of this operation. */
export function createWorkbookPasswordCodec({ timeoutMs = 6000, maxConcurrent = 2 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 ||
      !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) throw storageError(400)
  let active = 0
  async function transform<T extends Operation>(operation: T, bytes: Buffer, password: string, signal?: AbortSignal, format:EncryptedOfficeFormat='xlsx'): Promise<Output<T>> {
    signal?.throwIfAborted()
    if (!Buffer.isBuffer(bytes) || !bytes.length || typeof password !== 'string' || !password.length || password.length > 255) throw storageError(400)
    if (bytes.length > MAX_OBJECT_BYTES) throw storageError(413)
    if (active >= maxConcurrent) throw Object.assign(storageError(503), { retryAfter: 1 })
    active++
    let worker: Worker | undefined, deadline: ReturnType<typeof setTimeout> | undefined
    let abort: (() => void) | undefined
    try {
      const input = Uint8Array.from(bytes)
      worker = new Worker(new URL('./workbook-password-worker.ts', import.meta.url), {
        workerData: { operation, input, password, format }, transferList: [input.buffer],
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
        stdout: true, stderr: true,
      })
      worker.stdout.resume(); worker.stderr.resume()
      const result = await new Promise<Output<T>>((resolve, reject) => {
        abort = () => reject(signal?.reason)
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
        deadline = setTimeout(() => reject(storageError(413)), timeoutMs)
        worker!.once('message', message => {
          if (message.ok) {
            const output = operation === 'verify' ? message.file
              : { bytes: Buffer.from(message.output.buffer, message.output.byteOffset, message.output.byteLength), file: message.file }
            return resolve(output)
          }
          const status = message.statusCode === 413 || message.statusCode === 422 ? message.statusCode : 400
          const error = storageError(status)
          if (message.code === 'WORKBOOK_PASSWORD_INVALID' || message.code === 'WORKBOOK_ENCRYPTION_INVALID') {
            Object.assign(error, { code: message.code })
          }
          reject(error)
        })
        worker!.once('error', error => reject(storageError((error as NodeJS.ErrnoException).code === 'ERR_WORKER_OUT_OF_MEMORY' ? 413 : 503)))
        worker!.once('exit', () => reject(storageError(503)))
      })
      signal?.throwIfAborted()
      return result
    } finally {
      if (abort) signal?.removeEventListener('abort', abort)
      clearTimeout(deadline)
      await worker?.terminate()
      active--
    }
  }
  return {
    open: (bytes: Buffer, password: string, signal?: AbortSignal, format?:EncryptedOfficeFormat) => transform('open', bytes, password, signal,format),
    seal: (bytes: Buffer, password: string, signal?: AbortSignal,format?:EncryptedOfficeFormat) => transform('seal', bytes, password, signal,format),
    verify: (bytes: Buffer, password: string, signal?: AbortSignal, format?:EncryptedOfficeFormat) => transform('verify', bytes, password, signal,format),
  }
}
