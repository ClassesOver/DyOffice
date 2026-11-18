import { inflateSync } from 'node:zlib'
import { PDFArray, PDFDict, PDFDocument, PDFName } from 'pdf-lib'

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

// Scanner-local limits, not a PDF parser or process isolation boundary.
const STREAM_BYTES = 1024 * 1024
const DOCUMENT_BYTES = 8 * STREAM_BYTES

function streamBytes(stream, budget) {
  if (!stream || typeof stream.getContents !== 'function') reject('UNREADABLE')
  const raw = stream.getContents()
  const filter = stream.dict?.get?.(PDFName.of('Filter'))
  const limit = Math.min(STREAM_BYTES, budget.remaining)
  if (limit < 0) reject('UNREADABLE')
  // Bound native decompression before allocation; checking length afterwards
  // cannot contain a highly compressed content stream. At zero remaining,
  // zlib requires a positive limit: allow only a one-byte probe, then reject
  // any nonempty result below. An empty Flate stream consumes no budget.
  const compressed = String(filter).includes('FlateDecode')
  if (!compressed && raw.length > limit) reject('UNREADABLE')
  const bytes = compressed
    ? inflateSync(raw, { maxOutputLength: Math.max(1, limit) })
    : Buffer.from(raw)
  if (bytes.length > limit) reject('UNREADABLE')
  budget.remaining -= bytes.length
  return bytes
}

function isDelim(char) {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t' || char === '\f' || char === '\0'
    || char === '%' || char === '(' || char === ')' || char === '<' || char === '>'
    || char === '[' || char === ']' || char === '/' || char === '{' || char === '}'
}

function skipLiteral(source, index) {
  let depth = 0
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') { index += 2; continue }
    if (char === '(') depth += 1
    if (char === ')') {
      depth -= 1
      index += 1
      if (depth === 0) return index
      continue
    }
    index += 1
  }
  return index
}

function tokenize(source) {
  const tokens = []
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (char === ' ' || char === '\n' || char === '\r' || char === '\t' || char === '\f' || char === '\0') { index += 1; continue }
    if (char === '%') {
      index += 1
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') index += 1
      continue
    }
    if (char === '(') { index = skipLiteral(source, index); continue }
    // A closing literal delimiter outside a string cannot advance the generic
    // token scan below. Reject malformed content instead of blocking the worker.
    if (char === ')') reject('UNREADABLE')
    if (char === '<') {
      if (source[index + 1] === '<') { index += 2; continue }
      index += 1
      while (index < source.length && source[index] !== '>') index += 1
      index += 1
      continue
    }
    if (char === '>') { index += source[index + 1] === '>' ? 2 : 1; continue }
    if (char === '[' || char === ']' || char === '{' || char === '}') { index += 1; continue }
    if (char === '/') {
      index += 1
      const start = index
      while (index < source.length && !isDelim(source[index])) index += 1
      tokens.push({ kind: 'name', value: source.slice(start, index) })
      continue
    }
    const start = index
    while (index < source.length && !isDelim(source[index])) index += 1
    const word = source.slice(start, index)
    if (word && !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(word)) tokens.push({ kind: 'op', value: word })
  }
  return tokens
}

function contentSource(context, contents, budget) {
  if (!contents) return ''
  const items = contents instanceof PDFArray ? contents.asArray() : [contents]
  // Decode failures must not turn a damaged/over-budget page into a successful
  // blank-page report. Let inspectPdf apply the common fail-closed error.
  return items.map((item) => streamBytes(context.lookup(item), budget).toString('latin1')).join('\n')
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

function fontsFrom(resources) {
  const fonts = resources?.lookup?.(PDFName.of('Font'))
  if (!(fonts instanceof PDFDict)) return []
  return fonts.entries().map(([key, value]) => {
    const dict = fonts.context.lookup(value)
    const base = dict instanceof PDFDict ? dict.get(PDFName.of('BaseFont')) : undefined
    const baseFont = base ? String(base).replace(/^\//, '') : String(key).replace(/^\//, '')
    return { resource: String(key), baseFont, embedded: embeddedFont(dict) }
  })
}

function uniqueFonts(fonts) {
  const seen = new Set()
  return fonts.filter((font) => {
    const key = `${font.resource}:${font.baseFont}:${font.embedded}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function xobjectNamed(resources, name) {
  const xobjects = resources?.lookup?.(PDFName.of('XObject'))
  if (!(xobjects instanceof PDFDict)) return undefined
  const key = PDFName.of(name)
  if (!xobjects.has(key)) return undefined
  return xobjects.context.lookup(xobjects.get(key))
}

function inspectStream(context, resources, source, seen, state, budget) {
  state.fonts.push(...fontsFrom(resources))
  const tokens = tokenize(source)
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.kind !== 'op') continue
    if (token.value === 'Tj' || token.value === 'TJ' || token.value === "'" || token.value === '"') state.text = true
    if (token.value !== 'Do') continue
    let name
    for (let back = index - 1; back >= 0; back -= 1) {
      if (tokens[back].kind === 'name') { name = tokens[back].value; break }
      if (tokens[back].kind === 'op') break
    }
    const object = name ? xobjectNamed(resources, name) : undefined
    const subtype = String(object?.dict?.get?.(PDFName.of('Subtype')) ?? '')
    if (subtype === '/Image') state.image = true
    if (subtype === '/Form' && object && !seen.has(object)) {
      seen.add(object)
      const formResources = object.dict.lookup(PDFName.of('Resources'))
      inspectStream(
        context,
        formResources instanceof PDFDict ? formResources : resources,
        streamBytes(object, budget).toString('latin1'),
        seen,
        state,
        budget,
      )
    }
  }
}

function inherited(dict, key) {
  const seen = new Set()
  let current = dict
  while (current instanceof PDFDict && !seen.has(current)) {
    seen.add(current)
    if (current.has(PDFName.of(key))) return current.lookup(PDFName.of(key))
    const parent = current.lookup(PDFName.of('Parent'))
    current = parent instanceof PDFDict ? parent : undefined
  }
  return undefined
}

function signaturesOn(page, pageNumber) {
  const annots = page.node.Annots()
  if (!(annots instanceof PDFArray)) return []
  const found = []
  for (const item of annots.asArray()) {
    const annot = page.node.context.lookup(item)
    if (!(annot instanceof PDFDict)) continue
    const fieldType = String(inherited(annot, 'FT') ?? '')
    const value = inherited(annot, 'V')
    const valueType = value instanceof PDFDict ? String(value.get(PDFName.of('Type')) ?? '') : ''
    if (fieldType === '/Sig' || valueType === '/Sig') found.push({ page: pageNumber, status: 'present_unverified' })
  }
  return found
}

function classify(page, pageNumber, budget) {
  const state = { text: false, image: false, fonts: [] }
  inspectStream(page.node.context, page.node.Resources(), contentSource(page.node.context, page.node.Contents(), budget), new Set(), state, budget)
  const kind = state.text ? 'text' : state.image ? 'scanned' : 'blank'
  return { page: pageNumber, kind, textOperators: state.text, image: state.image, fonts: uniqueFonts(state.fonts) }
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
  let doc
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true })
  } catch {
    reject('UNREADABLE')
  }
  // Only the parsed trailer establishes encryption, never arbitrary /Encrypt
  // bytes. ignoreEncryption permits this metadata check, not scanning/rendering:
  // encrypted documents return immediately, before getPages or stream decoding.
  if (doc.isEncrypted) return locked()
  try {
    const budget = { remaining: DOCUMENT_BYTES }
    const pages = doc.getPages().map((page, index) => classify(page, index + 1, budget))
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
  } catch {
    // The document already loaded as unencrypted: scan/decode/budget failures
    // must remain errors, never a successful password-required report.
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
