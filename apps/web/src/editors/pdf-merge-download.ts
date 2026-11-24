import {mergePdfBytes} from '../../../pdf/src/shared/merge-pdf'

const PDF_MERGE_MAX_FILES = 32
const PDF_MERGE_MAX_BYTES = 64 * 1024 * 1024
const PDF_MERGE_MAX_PAGES = 500

export function validatePdfMergeFiles(files: readonly File[]): number {
  const size = files.reduce((total, file) => total + file.size, 0)
  if (files.length > PDF_MERGE_MAX_FILES || files.some(file => !file.size) || size >= PDF_MERGE_MAX_BYTES) {
    throw new Error('Choose up to 32 nonempty PDFs, with a combined size of up to 64 MiB including the open PDF.')
  }
  return size
}

export async function preparePdfMerge(
  base: ArrayBuffer,
  files: readonly File[],
  signal: AbortSignal,
): Promise<{ merged: Uint8Array<ArrayBuffer>; appended: number }> {
  const size = validatePdfMergeFiles(files)
  if (base.byteLength + size > PDF_MERGE_MAX_BYTES) {
    throw new Error('PDFs exceed the combined merge size limit of 64 MiB.')
  }
  async function* sources() {
    for (const file of files) {
      signal.throwIfAborted()
      yield new Uint8Array(await file.arrayBuffer())
    }
  }
  const { merged, appended } = await mergePdfBytes(new Uint8Array(base), sources(), {
    maxPages: PDF_MERGE_MAX_PAGES,
    signal,
  })
  if (!appended) throw new Error('The selected PDFs do not contain any pages.')
  if (merged.byteLength > PDF_MERGE_MAX_BYTES) throw new Error('The resulting PDF exceeds the download size limit of 64 MiB.')
  return { merged: new Uint8Array(merged), appended }
}
