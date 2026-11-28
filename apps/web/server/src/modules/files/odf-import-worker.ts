import { parentPort, workerData } from 'node:worker_threads'
import { convertOdpToPptx, convertOdtToDocx } from '../../../../../../packages/odf2ooxml/src/index.ts'
import { validateOdfInput, validateUploadInternal } from './validation-core.ts'

try {
  const { input, target } = workerData
  const source = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  await validateOdfInput(source)
  const converted = target === 'docx' ? (await convertOdtToDocx(source)).docx : (await convertOdpToPptx(source)).pptx
  const bytes = Buffer.from(converted.buffer, converted.byteOffset, converted.byteLength)
  await validateUploadInternal(bytes, `document.${target}`)
  const output = Uint8Array.from(bytes)
  parentPort!.postMessage({ output }, [output.buffer])
} catch (error) {
  parentPort!.postMessage({ statusCode: (error as { statusCode?: number }).statusCode === 413 ? 413 : 400 })
}
