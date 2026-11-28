import { PDFArray, PDFDict, PDFName, PDFStream } from 'pdf-lib'
import type { PDFDocument, PDFObject } from 'pdf-lib'

/** Reject signatures before rewriting PDF bytes. An unsigned field is opt-in. */
export function assertNoPdfSignatures(
  doc: PDFDocument,
  { allowUnsignedFields = false, maxObjects = Infinity } = {},
): void {
  const name = PDFName.of
  const signed = () => Object.assign(new Error('PDFs with signatures cannot be rewritten.'), { code: 'SIGNATURE_EDIT_REFUSED' })
  if (doc.catalog.has(name('Perms'))) throw signed()
  const pending = doc.context.enumerateIndirectObjects().map(([, object]) => object)
  const visited = new Set<PDFObject>()
  while (pending.length) {
    const object = pending.pop()
    if (!object || visited.has(object)) continue
    visited.add(object)
    if (visited.size > maxObjects) throw Object.assign(new Error('PDF_EDIT_LIMIT'), { code: 'PDF_EDIT_LIMIT' })
    if (object instanceof PDFDict) {
      const isSignatureField = object.lookup(name('FT')) === name('Sig')
      if (object.lookup(name('Type')) === name('Sig') || object.has(name('ByteRange')) ||
          (isSignatureField && (!allowUnsignedFields ||
            (object.has(name('V')) && String(object.lookup(name('V'))) !== 'null')))) throw signed()
      for (const value of object.values()) pending.push(value)
    } else if (object instanceof PDFArray) {
      for (const value of object.asArray()) pending.push(value)
    } else if (object instanceof PDFStream) pending.push(object.dict)
  }
}
