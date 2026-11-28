import { Worker } from 'node:worker_threads'
import type { OfficeDocumentConversionFormat } from '../../../../../../packages/web-contracts/src/file-imports.ts'
import { MAX_OBJECT_BYTES, storageError } from '../../storage/object-store.ts'

let active = 0

export async function convertOfficeDocument(bytes: Buffer, format: OfficeDocumentConversionFormat, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted()
  if (!bytes.length) throw storageError(400)
  if (bytes.length > MAX_OBJECT_BYTES) throw storageError(413)
  if (active >= 2) throw Object.assign(storageError(503), { retryAfter: 1 })
  active++
  let worker: Worker | undefined, deadline: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    const input = Uint8Array.from(bytes)
    worker = new Worker(new URL('./office-import-worker.ts', import.meta.url), {
      workerData: { input, format }, transferList: [input.buffer],
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      stdout: true, stderr: true,
    })
    worker.stdout.resume(); worker.stderr.resume()
    const output = await new Promise<Buffer>((resolve, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      deadline = setTimeout(() => reject(storageError(413)), 10_000)
      worker!.once('message', message => {
        if (!message.output) reject(storageError(message.statusCode === 413 ? 413 : 400))
        else resolve(Buffer.from(message.output.buffer, message.output.byteOffset, message.output.byteLength))
      })
      worker!.once('error', error => reject(storageError((error as NodeJS.ErrnoException).code === 'ERR_WORKER_OUT_OF_MEMORY' ? 413 : 503)))
      worker!.once('exit', () => reject(storageError(503)))
    })
    signal.throwIfAborted()
    return output
  } finally {
    if (abort) signal.removeEventListener('abort', abort)
    clearTimeout(deadline)
    await worker?.terminate()
    active--
  }
}
