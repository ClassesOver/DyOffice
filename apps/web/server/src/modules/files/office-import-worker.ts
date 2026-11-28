import { parentPort, workerData } from 'node:worker_threads'
import { officeDocumentConversionTargets, type OfficeDocumentConversionFormat } from '../../../../../../packages/web-contracts/src/file-imports.ts'
import { validateOdfInput, validateUploadInternal } from './validation-core.ts'

async function convert(source: Buffer, format: OfficeDocumentConversionFormat) {
  switch (format) {
    case 'doc':
    case 'dot': {
      const { convertLegacyDocToDocx } = await import('../../../../../../packages/doc2docx/src/index.ts')
      return (await convertLegacyDocToDocx(source)).docx
    }
    case 'ppt': {
      const { convertPptToPptx } = await import('../../../../../../packages/ppt2pptx/src/index.ts')
      return (await convertPptToPptx(source)).bytes
    }
    default: {
      await validateOdfInput(source)
      const { convertOdpToPptx, convertOdtToDocx } = await import('../../../../../../packages/odf2ooxml/src/index.ts')
      return officeDocumentConversionTargets[format] === 'docx'
        ? (await convertOdtToDocx(source)).docx : (await convertOdpToPptx(source)).pptx
    }
  }
}

try {
  const { input, format } = workerData as { input: Uint8Array; format: OfficeDocumentConversionFormat }
  const source = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  const converted = await convert(source, format)
  const bytes = Buffer.from(converted.buffer, converted.byteOffset, converted.byteLength)
  await validateUploadInternal(bytes, `document.${officeDocumentConversionTargets[format]}`)
  const output = Uint8Array.from(bytes)
  parentPort!.postMessage({ output }, [output.buffer])
} catch (error) {
  parentPort!.postMessage({ statusCode: (error as { statusCode?: number }).statusCode === 413 ? 413 : 400 })
}
