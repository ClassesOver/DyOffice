import { parentPort, workerData } from 'node:worker_threads'
import { validateUploadInternal } from './validation-core.ts'

try {
  const value = await validateUploadInternal(Buffer.from(workerData.bytes), workerData.name, workerData.policy)
  parentPort!.postMessage({ ok: true, value })
} catch (error) {
  parentPort!.postMessage({ ok: false, statusCode: (error as { statusCode?: number }).statusCode === 413 ? 413 : 400 })
}
