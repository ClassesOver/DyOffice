import { PDFDict, PDFDocument, PDFName } from 'pdf-lib'
import { copyImportedPages } from './copy-imported-pages'
import { selectPageForm } from './copy-selected-page-form'
import { readPageLabels, writePageLabels } from './page-labels'
import { assertNoPdfSignatures } from './pdf-signature-guard'
import { detachPdfStampManagement } from './managed-page-stamps'
import { remapStaticFormFills, staticFormFillsFromCatalog, writeStaticFormFills } from './static-form-fills'

function validateMergeInput(doc: PDFDocument): void {
  assertNoPdfSignatures(doc)
  const form = doc.catalog.lookup(PDFName.of('AcroForm'))
  if (form instanceof PDFDict && form.has(PDFName.of('XFA'))) {
    throw new Error('PDFs with XFA forms cannot be merged.')
  }
}

/** Append each source's pages in order and retain their visible content. */
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
  validateMergeInput(destination)
  selectPageForm(destination, destination.getPages(), [], true)
  const labels = readPageLabels(destination)
  const fills = staticFormFillsFromCatalog(destination)
  let appended = 0
  for await (const bytes of others) {
    check()
    const source = await PDFDocument.load(bytes, { updateMetadata: false })
    if (initialPages + appended + source.getPageCount() > maxPages) {
      throw new Error('PDF exceeds the merge page limit.')
    }
    validateMergeInput(source)
    check()
    detachPdfStampManagement(source)
    const pages = await copyImportedPages(destination, source, undefined, { copyForm: 'all', copyAttachments: true })
    for (const fill of remapStaticFormFills(source, source.getPageIndices(), initialPages + appended)) fills.push(fill)
    if (!appended && pages.length) detachPdfStampManagement(destination)
    for (const page of pages) destination.addPage(page)
    for (const label of readPageLabels(source)) labels.push(label)
    appended += pages.length
  }
  check()
  if (appended) {
    writePageLabels(destination, labels)
    writeStaticFormFills(destination, fills)
  }
  const merged = await destination.save({ useObjectStreams: false, updateFieldAppearances: false })
  check()
  return { merged, appended }
}
