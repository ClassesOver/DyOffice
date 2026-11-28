import { parentPort, workerData } from 'node:worker_threads'
import { transformProtectedWorkbook } from './workbook-password-core.ts'

try {
  const verify = workerData.operation === 'verify'
  const { bytes, file } = await transformProtectedWorkbook(verify ? 'open' : workerData.operation, Buffer.from(workerData.input), workerData.password, workerData.format)
  if (verify) parentPort!.postMessage({ ok: true, file })
  else {
    const output = Uint8Array.from(bytes)
    parentPort!.postMessage({ ok: true, output, file }, [output.buffer])
  }
} catch (error) {
  const { code, statusCode } = error as { code?: string; statusCode?: number }
  parentPort!.postMessage({ ok: false, code, statusCode })
}
