import { EncryptedPDFError, PDFArray, PDFDict, PDFDocument, PDFName, degrees } from 'pdf-lib'

function reject(code) { throw Object.assign(new Error(code), { code, status: 400 }) }

/** Pure export core only: no route, persistence, permission bypass, or viewer capability change. */
export async function rotatePdfPages(bytes, operations) {
  if (!Buffer.isBuffer(bytes)) reject('MAGIC_MISMATCH')
  if (bytes.length > 64 * 1024 * 1024) reject('PDF_EDIT_LIMIT')
  if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) reject('MAGIC_MISMATCH')
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 100) reject('INVALID_PDF_ROTATION')
  // Capture once before the first await; callers retain ownership of both inputs.
  operations = operations.map(op => {
    if (!op || Object.keys(op).sort().join(',') !== 'degrees,page') reject('INVALID_PDF_ROTATION')
    return { page: op.page, degrees: op.degrees }
  })
  const seen = new Set()
  for (const op of operations) {
    if (!op || Object.keys(op).sort().join(',') !== 'degrees,page' || !Number.isInteger(op.page) || op.page < 1
      || !Number.isSafeInteger(op.degrees) || op.degrees % 90 !== 0 || seen.has(op.page)) reject('INVALID_PDF_ROTATION')
    seen.add(op.page)
  }
  let doc
  bytes = Buffer.from(bytes)
  try { doc = await PDFDocument.load(bytes, { updateMetadata: false }) }
  catch (error) {
    // pdf-lib's transpiled Error subclass may not preserve instanceof identity.
    // This only selects a refusal code; encryption is never bypassed.
    reject(error instanceof EncryptedPDFError || bytes.includes(Buffer.from('/Encrypt')) ? 'PASSWORD' : 'UNREADABLE')
  }
  if (doc.isEncrypted) reject('PASSWORD')
  const count = doc.getPageCount()
  if (count < 1 || count > 100) reject('PDF_EDIT_LIMIT')
  // A rewrite invalidates signatures. Scan all indirect dictionaries, including
  // orphan signatures, not only widgets visible on pages. Fail closed for forms.
  const pending = doc.context.enumerateIndirectObjects().map(([, object]) => object)
  const visited = new Set()
  while (pending.length) {
    const object = pending.pop()
    if (!object || visited.has(object)) continue
    visited.add(object)
    if (visited.size > 100_000) reject('PDF_EDIT_LIMIT')
    if (object instanceof PDFDict) {
      if (String(object.get(PDFName.of('Type'))) === '/Sig'
        || String(object.get(PDFName.of('FT'))) === '/Sig' || object.has(PDFName.of('ByteRange'))) reject('SIGNATURE_EDIT_REFUSED')
      for (const value of object.values()) pending.push(value)
    } else if (object instanceof PDFArray) { for (const value of object.asArray()) pending.push(value) }
    else if (object.dict instanceof PDFDict) pending.push(object.dict)
  }
  if (doc.catalog.has(PDFName.of('Perms'))) reject('SIGNATURE_EDIT_REFUSED')
  if (doc.catalog.has(PDFName.of('AcroForm'))) reject('PDF_EDIT_UNSUPPORTED_STRUCTURE')
  for (const op of operations) {
    if (op.page > count) reject('INVALID_PDF_ROTATION')
    const angle = doc.getPage(op.page - 1).getRotation().angle
    if (!Number.isSafeInteger(angle) || angle % 90 !== 0) reject('PDF_EDIT_UNSUPPORTED_STRUCTURE')
  }
  for (const op of operations) {
    const page = doc.getPage(op.page - 1)
    page.setRotation(degrees(((page.getRotation().angle % 360 + op.degrees % 360) % 360 + 360) % 360))
  }
  return Buffer.from(await doc.save({ updateFieldAppearances: false }))
}
