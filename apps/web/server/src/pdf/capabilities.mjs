import { EncryptedPDFError, PDFDocument } from 'pdf-lib'

function reject(code, status = 400) {
  throw Object.assign(new Error(code), { code, status })
}

const OPEN_CAPABILITIES = Object.freeze({
  read: 'structure',
  annotate: 'unsupported',
  editText: 'unsupported',
  reorderPages: 'unsupported',
  redact: 'unsupported',
})

function locked() {
  return {
    encrypted: true,
    capabilities: { ...OPEN_CAPABILITIES, read: 'password_required' },
  }
}

/**
 * Explicit PDF capability report. Reading structure is allowed.
 * Text edits, annotations, page reordering, and redaction are refused.
 * Covering text is not treated as deletion of the original content.
 * This is not a browser editor and does not use a worker.
 */
export async function inspectPdf(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 5 || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    reject('MAGIC_MISMATCH')
  }
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false })
    if (doc.isEncrypted) return locked()
    const pageCount = doc.getPageCount()
    return {
      encrypted: false,
      pageOrder: Array.from({ length: pageCount }, (_, index) => index + 1),
      capabilities: OPEN_CAPABILITIES,
    }
  } catch (error) {
    if (error instanceof EncryptedPDFError || bytes.includes(Buffer.from('/Encrypt'))) return locked()
    reject('UNREADABLE')
  }
}

export function requestPdfOperation(report, operation) {
  if (!report || report.encrypted || report.capabilities?.read === 'password_required') reject('PASSWORD', 403)
  if (operation === 'coverText') reject('COVER_IS_NOT_DELETION')
  if (operation !== 'read') reject('UNSUPPORTED')
  return { operation: 'read', effect: 'read' }
}
