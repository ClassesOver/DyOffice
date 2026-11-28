import { createHash } from 'node:crypto'
import { PDFDocument } from 'pdf-lib'

/** Check a protected PDF's container without receiving a password. */
async function validateEncryptedPdf(bytes) {
  const startXref = /startxref\s+([0-9]+)\s+%%EOF\s*$/.exec(bytes.subarray(-1024).toString('latin1'))
  const offset = Number(startXref?.[1])
  if (!Number.isSafeInteger(offset) || offset < 1 || offset >= bytes.length ||
      !/^(?:xref\b|[0-9]+\s+[0-9]+\s+obj\b)/.test(bytes.subarray(offset, offset + 64).toString('latin1'))) {
    throw Error('Invalid PDF cross-reference')
  }
  const { getDocument, PasswordException, PasswordResponses } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = getDocument({
    data: new Uint8Array(bytes), stopAtErrors: true, enableXfa: false, useWasm: false, disableFontFace: true,
  })
  try {
    const document = await task.promise
    // Owner-only protection opens with the implicit empty user password.
    if (document.numPages < 1 || await document.getPermissions() === null) throw Error('Invalid protected PDF')
  } catch (error) {
    if (!(error instanceof PasswordException) || error.code !== PasswordResponses.NEED_PASSWORD) throw error
  } finally {
    await task.destroy()
  }
}

/** @param {Buffer} bytes */
export async function validatePdf(bytes, allowEncryptedPdf = false) {
  if (!/^%PDF-(?:1\.[0-9]|2\.0)/.test(bytes.subarray(0, 9).toString('ascii')) ||
      !/%%EOF\s*$/.test(bytes.subarray(-1024).toString('latin1'))) throw Error('Invalid PDF header or trailer')
  let pdfEncrypted = false
  try {
    const document = await PDFDocument.load(bytes, { throwOnInvalidObject: true, updateMetadata: false })
    if (document.getPageCount() < 1) throw Error('PDF has no pages')
  } catch (error) {
    if (!allowEncryptedPdf) throw error
    // Encrypted object streams cannot be decoded by the plaintext validator.
    await validateEncryptedPdf(bytes)
    pdfEncrypted = true
  }
  return {
    format: /** @type {const} */ ('pdf'), mime: 'application/pdf', size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), officeSignatureProtected: false, pdfEncrypted,
  }
}
