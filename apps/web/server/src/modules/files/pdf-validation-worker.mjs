import { parentPort, workerData } from 'node:worker_threads'
import { validatePdf } from './pdf-validation.mjs'

try {
  const bytes = Buffer.from(workerData.bytes.buffer)
  const value = await validatePdf(bytes, workerData.policy.allowEncryptedPdf === true)
  parentPort.postMessage({ ok: true, value })
} catch {
  parentPort.postMessage({ ok: false, statusCode: 400 })
}
