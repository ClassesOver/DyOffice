import { inflateSync } from 'node:zlib'
import { EncryptedPDFError, PDFArray, PDFDict, PDFDocument, PDFName } from 'pdf-lib'

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
    pages: [],
    signatures: [],
  }
}

function streamBytes(stream) {
  if (!stream || typeof stream.getContents !== 'function') return Buffer.alloc(0)
  const raw = Buffer.from(stream.getContents())
  const filter = stream.dict?.get?.(PDFName.of('Filter'))
  if (String(filter).includes('FlateDecode')) return inflateSync(raw)
  return raw
}

function contentText(page) {
  const contents = page.node.Contents()
  if (!contents) return ''
  const items = contents instanceof PDFArray ? contents.asArray() : [contents]
  return items.map((item) => {
    try { return streamBytes(page.node.context.lookup(item)).toString('latin1') }
    catch { return '' }
  }).join('\n')
}

function hasTextOperators(source) {
  return /(^|[^A-Za-z])(Tj|TJ)(?![A-Za-z])/.test(source)
}

function imageXObject(page, source) {
  if (!/(^|[^A-Za-z])Do(?![A-Za-z])/.test(source)) return false
  const xobjects = page.node.Resources()?.lookup(PDFName.of('XObject'))
  if (!(xobjects instanceof PDFDict)) return false
  return xobjects.entries().some(([, value]) => {
    const object = xobjects.context.lookup(value)
    const subtype = object?.dict?.get?.(PDFName.of('Subtype'))
    return String(subtype) === '/Image'
  })
}

function embeddedFont(dict) {
  if (!(dict instanceof PDFDict)) return false
  for (const name of ['FontFile', 'FontFile2', 'FontFile3']) {
    if (dict.has(PDFName.of(name))) return true
  }
  const descriptor = dict.lookup(PDFName.of('FontDescriptor'))
  if (descriptor instanceof PDFDict && embeddedFont(descriptor)) return true
  const descendants = dict.lookup(PDFName.of('DescendantFonts'))
  if (descendants instanceof PDFArray) {
    return descendants.asArray().some((item) => embeddedFont(descendants.context.lookup(item)))
  }
  return false
}

function fontsOn(page) {
  const fonts = page.node.Resources()?.lookup(PDFName.of('Font'))
  if (!(fonts instanceof PDFDict)) return []
  return fonts.entries().map(([key, value]) => {
    const dict = fonts.context.lookup(value)
    const base = dict instanceof PDFDict ? dict.get(PDFName.of('BaseFont')) : undefined
    const baseFont = base ? String(base).replace(/^\//, '') : String(key).replace(/^\//, '')
    return { resource: String(key), baseFont, embedded: embeddedFont(dict) }
  })
}

function signaturesOn(page, pageNumber) {
  const annots = page.node.Annots()
  if (!(annots instanceof PDFArray)) return []
  const found = []
  for (const item of annots.asArray()) {
    const annot = page.node.context.lookup(item)
    if (!(annot instanceof PDFDict)) continue
    const fieldType = String(annot.get(PDFName.of('FT')) ?? '')
    const value = annot.lookup(PDFName.of('V'))
    const valueType = value instanceof PDFDict ? String(value.get(PDFName.of('Type')) ?? '') : ''
    if (fieldType === '/Sig' || valueType === '/Sig') found.push({ page: pageNumber, status: 'present_unverified' })
  }
  return found
}

function classify(page, pageNumber) {
  const source = contentText(page)
  const textOperators = hasTextOperators(source)
  const image = imageXObject(page, source)
  const kind = textOperators ? 'text' : image ? 'scanned' : 'blank'
  return { page: pageNumber, kind, textOperators, image, fonts: fontsOn(page) }
}

/**
 * Explicit PDF capability report. Structure, page kind, font embedding,
 * and the presence of a signature are reported. Text edits, annotations,
 * page reordering, and redaction stay refused. A signature is never
 * treated as verified. This is not a browser editor and does not load
 * PDFium or WASM.
 */
export async function inspectPdf(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 5 || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    reject('MAGIC_MISMATCH')
  }
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false })
    if (doc.isEncrypted) return locked()
    const pages = doc.getPages().map((page, index) => classify(page, index + 1))
    const signatures = pages.flatMap((page, index) => signaturesOn(doc.getPages()[index], page.page))
    const capabilities = { ...OPEN_CAPABILITIES }
    if (pages.some((page) => page.kind === 'text')) capabilities.read = 'text_layer'
    if (pages.some((page) => page.kind === 'scanned')) capabilities.scanned = 'no_text_layer'
    if (signatures.length > 0) capabilities.signature = 'present_unverified'
    return {
      encrypted: false,
      pageOrder: pages.map((page) => page.page),
      pages,
      signatures,
      capabilities,
    }
  } catch (error) {
    if (error instanceof EncryptedPDFError || bytes.includes(Buffer.from('/Encrypt'))) return locked()
    reject('UNREADABLE')
  }
}

export function requestPdfOperation(report, operation) {
  if (!report || report.encrypted || report.capabilities?.read === 'password_required') reject('PASSWORD', 403)
  if (operation === 'coverText') reject('COVER_IS_NOT_DELETION')
  if (operation === 'trustSignature') {
    if (report.signatures?.length) reject('SIGNATURE_UNVERIFIED')
    reject('UNSUPPORTED')
  }
  if (operation !== 'read') reject('UNSUPPORTED')
  return { operation: 'read', effect: 'read' }
}
