/** Experimental, deliberately narrow capability. Not an App/editor write entry.
 * Only plain single-run paragraphs; every export is checked against exact source
 * XML and every logical package part. Unsupported packages fail closed.
 */
import JSZip from 'jszip'
import { parseDocx } from '../../docx-engine/src/parse'
import { saveDocx } from '../../docx-engine/src/patch'
import { assertZipInflatesWithinLimits } from '../../zip-gate/src/index'
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const files = new Set([
  '[Content_Types].xml',
  '_rels/.rels',
  'word/document.xml',
  'word/styles.xml',
  'word/_rels/document.xml.rels',
])
const dirs = new Set(['_rels/', 'word/', 'word/_rels/'])
// This capability admits exactly one reviewed style table, not arbitrary styles.
// Normal has no inherited formatting; the other named styles cannot be selected
// by the profile's attribute-free paragraphs/runs. Extra defaults, character
// defaults, inheritance or namespace changes must fail before engine parsing.
const REVIEWED_STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>' +
  '<w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/>' +
  '<w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style>' +
  '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/>' +
  '<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>' +
  '</w:styles>'

function fail(): never {
  throw new Error('Unsupported or unsafe simple DOCX')
}
const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i])
const decode = (b: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(b)
function zipShape(b: Uint8Array) {
  if (b.length < 22 || b.length > 2 * 1024 * 1024) fail()
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength),
    u16 = (p: number) => v.getUint16(p, true),
    u32 = (p: number) => v.getUint32(p, true),
    end = b.length - 22
  if (
    u32(end) !== 0x06054b50 ||
    u16(end + 4) ||
    u16(end + 6) ||
    u16(end + 20) ||
    u16(end + 8) !== u16(end + 10)
  )
    fail()
  const count = u16(end + 10),
    start = u32(end + 16)
  if (count > 8 || start + u32(end + 12) !== end) fail()
  let p = start,
    local = 0
  const seen = new Set<string>()
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || u32(p) !== 0x02014b50) fail()
    const flags = u16(p + 8),
      method = u16(p + 10),
      n = u16(p + 28),
      extra = u16(p + 30),
      comment = u16(p + 32),
      off = u32(p + 42),
      csize = u32(p + 20)
    if (
      flags & ~0x800 ||
      ![0, 8].includes(method) ||
      extra ||
      comment ||
      u16(p + 34) ||
      p + 46 + n > end ||
      off !== local
    )
      fail()
    const name = decode(b.subarray(p + 46, p + 46 + n))
    if ((!files.has(name) && !dirs.has(name)) || seen.has(name)) fail()
    seen.add(name)
    if (
      off + 30 > start ||
      u32(off) !== 0x04034b50 ||
      u16(off + 6) !== flags ||
      u16(off + 8) !== method ||
      u16(off + 26) !== n ||
      u16(off + 28) ||
      !equal(b.subarray(off + 30, off + 30 + n), b.subarray(p + 46, p + 46 + n))
    )
      fail()
    for (const [a, c] of [
      [14, 16],
      [18, 20],
      [22, 24],
    ])
      if (u32(off + a) !== u32(p + c)) fail()
    local = off + 30 + n + csize
    if (local > start) fail()
    p += 46 + n
  }
  if (p !== end || local !== start || [...files].some((n) => !seen.has(n))) fail()
}
async function parts(bytes: Uint8Array) {
  zipShape(bytes)
  await assertZipInflatesWithinLimits(bytes, {
    maxParts: 8,
    maxPartBytes: 512 * 1024,
    maxTotalBytes: 1024 * 1024,
  })
  const z = await JSZip.loadAsync(bytes, { checkCRC32: true })
  const out = new Map<string, Uint8Array>()
  for (const n of Object.keys(z.files)) {
    if (!files.has(n) && !dirs.has(n)) fail()
    if (files.has(n)) out.set(n, await z.files[n].async('uint8array'))
  }
  return out
}
function xml(text: string) {
  if (/<!|<\?(?!xml\s)/.test(text)) fail()
  const d = new DOMParser().parseFromString(text, 'application/xml')
  if (d.getElementsByTagName('parsererror').length) fail()
  return d
}
function validateRels(text: string, target: string, type: string) {
  const d = xml(text),
    r = d.documentElement
  if (
    r.localName !== 'Relationships' ||
    r.namespaceURI !== 'http://schemas.openxmlformats.org/package/2006/relationships' ||
    r.children.length !== 1
  )
    fail()
  const e = r.children[0]
  if (
    e.localName !== 'Relationship' ||
    e.namespaceURI !== r.namespaceURI ||
    e.attributes.length !== 3 ||
    !e.getAttribute('Id') ||
    e.getAttribute('Target') !== target ||
    e.getAttribute('Type') !==
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships/' + type
  )
    fail()
}
function safeText(s: string) {
  if (
    typeof s !== 'string' ||
    s.length > 65536 ||
    /[\u0000-\u001f\u007f-\u009f\ufffe\uffff]/.test(s)
  )
    fail()
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const t = s.charCodeAt(++i)
      if (!(t >= 0xdc00 && t <= 0xdfff)) fail()
    } else if (c >= 0xdc00 && c <= 0xdfff) fail()
  }
}
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
export interface SimpleDocx {
  readonly paragraphs: readonly string[]
  export(texts: readonly string[]): Promise<Uint8Array>
}
export async function importSimpleDocx(input: Uint8Array): Promise<SimpleDocx> {
  if (
    !ArrayBuffer.isView(input) ||
    Object.prototype.toString.call(input) !== '[object Uint8Array]' ||
    input.byteLength > 2 * 1024 * 1024
  )
    fail()
  const bytes = new Uint8Array(input),
    source = await parts(bytes),
    document = decode(source.get('word/document.xml')!),
    d = xml(document)
  for (const [n, b] of source) if (files.has(n)) xml(decode(b))
  validateRels(decode(source.get('_rels/.rels')!), 'word/document.xml', 'officeDocument')
  validateRels(decode(source.get('word/_rels/document.xml.rels')!), 'styles.xml', 'styles')
  const types = xml(decode(source.get('[Content_Types].xml')!)).documentElement
  const expectedTypes = new Map([
    ['rels', 'application/vnd.openxmlformats-package.relationships+xml'],
    ['xml', 'application/xml'],
    [
      '/word/document.xml',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    ],
    [
      '/word/styles.xml',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
    ],
  ])
  if (
    types.localName !== 'Types' ||
    types.namespaceURI !== 'http://schemas.openxmlformats.org/package/2006/content-types' ||
    types.children.length !== 4
  )
    fail()
  for (const el of types.children) {
    const key =
      el.localName === 'Default'
        ? el.getAttribute('Extension')
        : el.localName === 'Override'
          ? el.getAttribute('PartName')
          : null
    if (
      !key ||
      el.namespaceURI !== types.namespaceURI ||
      el.attributes.length !== 2 ||
      expectedTypes.get(key) !== el.getAttribute('ContentType')
    )
      fail()
    expectedTypes.delete(key)
  }
  if (expectedTypes.size) fail()
  if (decode(source.get('word/styles.xml')!) !== REVIEWED_STYLES_XML) fail()
  const root = d.documentElement
  if (
    root.tagName !== 'w:document' ||
    root.namespaceURI !== W ||
    [...root.attributes].some((a) => a.namespaceURI !== 'http://www.w3.org/2000/xmlns/')
  )
    fail()
  // Exact lexical grammar rules out alternate namespace bindings, hidden fields,
  // formatting attributes, comments, entities with custom declarations and stories.
  const match =
    /^(?:<\?xml [^?]+\?>\s*)?<w:document\s[^>]+><w:body>([\s\S]*)<\/w:body><\/w:document>$/.exec(
      document,
    )
  if (!match) fail()
  const body = match[1],
    sect =
      /<w:sectPr><w:pgSz w:w="\d+" w:h="\d+"\/><w:pgMar w:top="\d+" w:right="\d+" w:bottom="\d+" w:left="\d+" w:header="\d+" w:footer="\d+" w:gutter="\d+"\/><\/w:sectPr>$/.exec(
        body,
      )
  if (!sect) fail()
  const content = body.slice(0, -sect[0].length),
    re = /<w:p><w:r><w:t xml:space="preserve">([^<]*)<\/w:t><\/w:r><\/w:p>/g,
    blocks = [...content.matchAll(re)]
  if (!blocks.length || blocks.length > 256 || blocks.map((m) => m[0]).join('') !== content) fail()
  const paragraphs = blocks.map((m) => {
    const el = xml('<w:t xmlns:w="' + W + '">' + m[1] + '</w:t>')
    const s = el.documentElement.textContent ?? ''
    safeText(s)
    return s
  })
  const parsed = await parseDocx(bytes),
    visible = parsed.blocks.filter((b) => !b.hidden)
  if (visible.length !== blocks.length || visible.some((b) => b.docxIndex === undefined)) fail()
  const unchanged = await saveDocx(
    parsed,
    visible.map((b) => ({ kind: 'original', docxIndex: b.docxIndex! })),
  )
  if (!equal(bytes, unchanged)) fail()
  return Object.freeze({
    paragraphs: Object.freeze(paragraphs),
    async export(texts: readonly string[]) {
      if (!Array.isArray(texts) || texts.length !== paragraphs.length) fail()
      if (Reflect.ownKeys(texts).length !== paragraphs.length + 1) fail()
      const snapshot: string[] = []
      for (let i = 0; i < paragraphs.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(texts, String(i))
        if (!descriptor || !('value' in descriptor)) fail()
        const value = descriptor.value
        safeText(value)
        snapshot.push(value)
      }
      if (snapshot.every((s, i) => s === paragraphs[i])) return new Uint8Array(bytes)
      const replacements = blocks.map((m, i) =>
        m[0].replace(
          /(<w:t xml:space="preserve">)[\s\S]*(<\/w:t>)/,
          (_, a, b) => a + escape(snapshot[i]) + b,
        ),
      )
      const expected = document.replace(content, () => replacements.join(''))
      const fresh = await parseDocx(bytes)
      const output = await saveDocx(
        fresh,
        replacements.map((s, i) => ({ kind: 'xml', xml: s, docxIndex: visible[i].docxIndex! })),
      )
      const result = await parts(output)
      if (result.size !== source.size) fail()
      for (const [n, b] of source) {
        const actual = result.get(n)
        if (
          !actual ||
          !equal(actual, n === 'word/document.xml' ? new TextEncoder().encode(expected) : b)
        )
          fail()
      }
      return output
    },
  })
}
