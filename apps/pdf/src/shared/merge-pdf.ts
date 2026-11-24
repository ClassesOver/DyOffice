import { PDFDocument } from 'pdf-lib'

/** Keep the first PDF intact and append each source's pages in order. */
export async function mergePdfBytes(
  first: Uint8Array,
  others: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  { maxPages = Infinity, signal }: { maxPages?: number; signal?: AbortSignal } = {},
): Promise<{ merged: Uint8Array; appended: number }> {
  const check = () => signal?.throwIfAborted()
  check()
  const destination = await PDFDocument.load(first, { updateMetadata: false })
  const initialPages = destination.getPageCount()
  if (initialPages > maxPages) throw new Error('PDF exceeds the merge page limit.')
  let appended = 0
  for await (const bytes of others) {
    check()
    const source = await PDFDocument.load(bytes, { updateMetadata: false })
    if (initialPages + appended + source.getPageCount() > maxPages) {
      throw new Error('PDF exceeds the merge page limit.')
    }
    check()
    const pages = await destination.copyPages(source, source.getPageIndices())
    for (const page of pages) destination.addPage(page)
    appended += pages.length
  }
  check()
  const merged = await destination.save({ useObjectStreams: false })
  check()
  return { merged, appended }
}
