import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFObjectCopier,
  PDFPage,
  PDFPageLeaf,
  PDFRef,
} from 'pdf-lib'
import { copiedPageDestinationResolver } from './pdf-destination-tree'
import { selectPageForm, setTemporaryPdfEntry } from './copy-selected-page-form'
import { mergePageForms } from './merge-page-forms'
import { appendCopiedPageOutlines } from './copy-page-outlines'
import { appendPdfAttachments } from './copy-pdf-attachments'

const key = PDFName.of

function rewriteLocalLinks(
  source: PDFDocument,
  pages: PDFPage[],
  resolve: ReturnType<typeof copiedPageDestinationResolver>,
  restore: (() => void)[],
): void {
  for (const page of pages) {
    for (const ref of page.node.Annots()?.asArray() ?? []) {
      const annotation = source.context.lookup(ref)
      if (!(annotation instanceof PDFDict) || annotation.lookup(key('Subtype')) !== key('Link')) continue
      const destKey = key('Dest')
      if (annotation.has(destKey)) setTemporaryPdfEntry(annotation, destKey, resolve(annotation.lookup(destKey)), restore)
      const actionKey = key('A')
      const action = annotation.lookup(actionKey)
      if (action instanceof PDFDict && action.lookup(key('S')) === key('GoTo')) {
        const field = key('D')
        const destination = resolve(action.lookup(field))
        if (destination) setTemporaryPdfEntry(action, field, destination, restore)
        else setTemporaryPdfEntry(annotation, actionKey, undefined, restore)
      }
    }
  }
}

/** Copy by indirect reference so annotations point into the output's page tree. */
export async function copyImportedPages(
  target: PDFDocument,
  source: PDFDocument,
  indices = source.getPageIndices(),
  { copyForm, copyAttachments }: { copyForm?: 'subset' | 'all'; copyAttachments?: boolean } = {},
): Promise<PDFPage[]> {
  await source.flush()
  const originals = source.getPages()
  const pages = indices.map(index => originals[index]!)
  const resolve = copiedPageDestinationResolver(source, pages)
  const restore: (() => void)[] = []
  try {
    // Remove jumps to omitted pages before copying, so they never become
    // hidden orphan page objects in the output. Restore the source for later parts.
    rewriteLocalLinks(source, pages, resolve, restore)
    const form = copyForm ? selectPageForm(source, pages, restore, copyForm === 'all') : undefined
    const copier = PDFObjectCopier.for(source.context, target.context)
    const used = new Set<PDFRef>()
    const copied = pages.map(page => {
      const ref = copier.copy(page.ref)
      const node = target.context.lookup(ref)
      if (!(ref instanceof PDFRef) || !(node instanceof PDFPageLeaf)) {
        throw new Error('Could not copy the imported PDF page')
      }
      if (used.has(ref)) {
        const duplicate = node.clone(target.context)
        return PDFPage.of(duplicate, target.context.register(duplicate), target)
      }
      used.add(ref)
      return PDFPage.of(node, ref, target)
    })
    if (form) {
      const imported = copier.copy(form)
      const existing = target.catalog.lookup(key('AcroForm'))
      if (existing instanceof PDFDict) mergePageForms(existing, imported)
      else target.catalog.set(key('AcroForm'), target.context.register(imported))
    }
    if (copied.length) appendCopiedPageOutlines(target, source, resolve, copier)
    if (copyAttachments) appendPdfAttachments(target, source, copier)
    return copied
  } finally {
    for (const revert of restore.reverse()) revert()
  }
}
