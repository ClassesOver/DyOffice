/** Restricted LibreOfficeDev 26.8 template profile. Not general DOCX support.
 * Fixed audited template bytes, never learned from untrusted input. */
import JSZip from 'jszip'
import { parseDocx } from '../../docx-engine/src/parse'
import { saveDocx } from '../../docx-engine/src/patch'
import { assertZipInflatesWithinLimits } from '../../zip-gate/src/index'
import type { SimpleDocx } from './simple-docx'
const template: Readonly<Record<string, string>> = {
  '_rels/.rels':
    '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>\n</Relationships>',
  'docProps/core.xml':
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator></dc:creator><dc:description></dc:description><dc:language>en-US</dc:language><cp:lastModifiedBy></cp:lastModifiedBy><cp:revision>0</cp:revision><dc:subject></dc:subject><dc:title></dc:title></cp:coreProperties>',
  'docProps/app.xml':
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Template></Template><TotalTime>0</TotalTime><Application>LibreOfficeDev/26.8.0.0.alpha0$Linux_X86_64 LibreOffice_project/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5</Application><AppVersion>15.0000</AppVersion></Properties>',
  'word/_rels/document.xml.rels':
    '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>\n</Relationships>',
  'word/document.xml':
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" mc:Ignorable="w14 wp14 w15"><w:body><w:p><w:pPr><w:pStyle w:val="PreformattedText"/><w:bidi w:val="0"/><w:rPr></w:rPr></w:pPr><w:r><w:rPr></w:rPr><w:t>Hello world</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="PreformattedText"/><w:bidi w:val="0"/><w:rPr></w:rPr></w:pPr><w:r><w:rPr></w:rPr><w:t>Second paragraph</w:t></w:r></w:p><w:sectPr><w:type w:val="nextPage"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:left="1134" w:right="1134" w:gutter="0" w:header="0" w:top="1134" w:footer="0" w:bottom="1134"/><w:pgNumType w:fmt="decimal"/><w:formProt w:val="false"/><w:textDirection w:val="lrTb"/></w:sectPr></w:body></w:document>',
  'word/styles.xml':
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Liberation Serif" w:hAnsi="Liberation Serif" w:eastAsia="Noto Serif CJK SC" w:cs="Noto Sans"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="en-US" w:eastAsia="zh-CN" w:bidi="hi-IN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:suppressAutoHyphens w:val="true"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:widowControl w:val="false"/><w:bidi w:val="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Liberation Serif" w:hAnsi="Liberation Serif" w:eastAsia="Noto Serif CJK SC" w:cs="Noto Sans"/><w:color w:val="auto"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="en-US" w:eastAsia="zh-CN" w:bidi="hi-IN"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading"><w:name w:val="Heading"/><w:basedOn w:val="Normal"/><w:next w:val="BodyText"/><w:qFormat/><w:pPr><w:keepNext w:val="true"/><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:rFonts w:ascii="Liberation Sans" w:hAnsi="Liberation Sans" w:eastAsia="Noto Sans CJK SC" w:cs="Noto Sans"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="BodyText"><w:name w:val="Body Text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:lineRule="auto" w:line="276" w:before="0" w:after="140"/></w:pPr><w:rPr></w:rPr></w:style><w:style w:type="paragraph" w:styleId="List"><w:name w:val="List"/><w:basedOn w:val="BodyText"/><w:pPr></w:pPr><w:rPr><w:rFonts w:cs="Noto Sans"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:suppressLineNumbers/><w:spacing w:before="120" w:after="120"/></w:pPr><w:rPr><w:rFonts w:cs="Noto Sans"/><w:i/><w:iCs/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Index"><w:name w:val="Index"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:suppressLineNumbers/></w:pPr><w:rPr><w:rFonts w:cs="Noto Sans"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="PreformattedText"><w:name w:val="Preformatted Text"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Liberation Mono" w:hAnsi="Liberation Mono" w:eastAsia="Noto Sans Mono CJK SC" w:cs="Liberation Mono"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style></w:styles>',
  'word/fontTable.xml':
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:font w:name="Times New Roman"><w:charset w:val="00"/><w:family w:val="roman"/><w:pitch w:val="variable"/></w:font><w:font w:name="Symbol"><w:charset w:val="02"/><w:family w:val="roman"/><w:pitch w:val="variable"/></w:font><w:font w:name="Arial"><w:charset w:val="00"/><w:family w:val="swiss"/><w:pitch w:val="variable"/></w:font><w:font w:name="Liberation Serif"><w:altName w:val="Times New Roman"/><w:charset w:val="01"/><w:family w:val="roman"/><w:pitch w:val="variable"/></w:font><w:font w:name="Liberation Sans"><w:altName w:val="Arial"/><w:charset w:val="01"/><w:family w:val="swiss"/><w:pitch w:val="variable"/></w:font><w:font w:name="Liberation Mono"><w:altName w:val="Courier New"/><w:charset w:val="01"/><w:family w:val="modern"/><w:pitch w:val="fixed"/></w:font></w:fonts>',
  'word/settings.xml':
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:zoom w:percent="100"/><w:defaultTabStop w:val="709"/><w:autoHyphenation w:val="true"/><w:hyphenationZone w:val="0"/><w:compat><w:adjustLineHeightInTable/><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/><w:compatSetting w:name="useWord2013TrackBottomHyphenation" w:uri="http://schemas.microsoft.com/office/word" w:val="1"/><w:compatSetting w:name="allowHyphenationAtTrackBottom" w:uri="http://schemas.microsoft.com/office/word" w:val="1"/></w:compat></w:settings>',
  'word/theme/theme1.xml':
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" name="Office"><a:themeElements><a:clrScheme name="LibreOffice"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="000000"/></a:dk2><a:lt2><a:srgbClr val="FFFFFF"/></a:lt2><a:accent1><a:srgbClr val="18A303"/></a:accent1><a:accent2><a:srgbClr val="0369A3"/></a:accent2><a:accent3><a:srgbClr val="A33E03"/></a:accent3><a:accent4><a:srgbClr val="8E03A3"/></a:accent4><a:accent5><a:srgbClr val="C99C00"/></a:accent5><a:accent6><a:srgbClr val="C9211E"/></a:accent6><a:hlink><a:srgbClr val="0000EE"/></a:hlink><a:folHlink><a:srgbClr val="551A8B"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Arial" pitchFamily="0" charset="1"/><a:ea typeface="DejaVu Sans" pitchFamily="0" charset="1"/><a:cs typeface="DejaVu Sans" pitchFamily="0" charset="1"/></a:majorFont><a:minorFont><a:latin typeface="Arial" pitchFamily="0" charset="1"/><a:ea typeface="DejaVu Sans" pitchFamily="0" charset="1"/><a:cs typeface="DejaVu Sans" pitchFamily="0" charset="1"/></a:minorFont></a:fontScheme><a:fmtScheme><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"></a:schemeClr></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:prstDash val="solid"/><a:miter/></a:ln><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:prstDash val="solid"/><a:miter/></a:ln><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:prstDash val="solid"/><a:miter/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"></a:schemeClr></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>',
  '[Content_Types].xml':
    '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="fntdata" ContentType="application/x-fontdata"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="png" ContentType="image/png"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>\n</Types>',
}
const files = new Set(Object.keys(template)),
  dirs = new Set<string>()
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
  if (count !== 10 || start + u32(end + 12) !== end) fail()
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
      flags & ~0x808 ||
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
    const descriptor = !!(flags & 8)
    for (const [a, c] of [
      [14, 16],
      [18, 20],
      [22, 24],
    ]) {
      if (descriptor ? u32(off + a) !== 0 : u32(off + a) !== u32(p + c)) fail()
    }
    local = off + 30 + n + csize
    if (descriptor) {
      if (
        local + 16 > start ||
        u32(local) !== 0x08074b50 ||
        u32(local + 4) !== u32(p + 16) ||
        u32(local + 8) !== csize ||
        u32(local + 12) !== u32(p + 24)
      )
        fail()
      local += 16
    }
    if (local > start) fail()
    p += 46 + n
  }
  if (p !== end || local !== start || [...files].some((n) => !seen.has(n))) fail()
}
async function parts(bytes: Uint8Array) {
  zipShape(bytes)
  await assertZipInflatesWithinLimits(bytes, {
    maxParts: 10,
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
const paragraphStart =
  '<w:p><w:pPr><w:pStyle w:val="PreformattedText"/><w:bidi w:val="0"/><w:rPr></w:rPr></w:pPr><w:r><w:rPr></w:rPr><w:t>'
const paragraphEnd = '</w:t></w:r></w:p>'
const prefix = template['word/document.xml'].split('<w:body>')[0] + '<w:body>'
const suffix = template['word/document.xml'].slice(
  template['word/document.xml'].indexOf('<w:sectPr>'),
)
function safeParagraph(s: string) {
  safeText(s)
  if (!s.length || s.trim() !== s || s.includes('  ')) fail()
}
function metadataShape(source: string, baseline: string) {
  const doc = xml(source)
  for (const [tag, pattern] of [
    ['cp:revision', /^\d{1,10}$/],
    ['TotalTime', /^\d{1,9}$/],
    ['AppVersion', /^\d{1,3}\.\d{1,4}$/],
  ] as const) {
    for (const el of doc.getElementsByTagName(tag)) if (!pattern.test(el.textContent ?? '')) fail()
  }
  // Only direct leaf element text may vary; exact root/namespaces/elements and
  // attributes/order remain fixed. No inserted markup, processing instructions,
  // declarations, entities with custom declarations, or nested content.
  const mask = (s: string) =>
    s.replace(/>([^<>]*)<\/([^>]+)>/g, (_, text, tag) => {
      safeText(xml('<x>' + text + '</x>').documentElement.textContent ?? '')
      return '></' + tag + '>'
    })
  if (mask(source) !== mask(baseline)) fail()
}
export async function importLibreOfficeTemplateDocx(input: Uint8Array): Promise<SimpleDocx> {
  if (
    !ArrayBuffer.isView(input) ||
    Object.prototype.toString.call(input) !== '[object Uint8Array]' ||
    input.byteLength > 2 * 1024 * 1024
  )
    fail()
  const bytes = new Uint8Array(input),
    source = await parts(bytes)
  for (const [n, b] of source) {
    const text = decode(b)
    if (!equal(b, new TextEncoder().encode(text))) fail()
    if (n === 'word/document.xml') continue
    if (n === 'docProps/core.xml' || n === 'docProps/app.xml') metadataShape(text, template[n])
    else if (text !== template[n]) fail()
  }
  const document = decode(source.get('word/document.xml')!)
  xml(document)
  if (!document.startsWith(prefix) || !document.endsWith(suffix)) fail()
  const body = document.slice(prefix.length, -suffix.length),
    blocks: string[] = [],
    texts: string[] = []
  let remaining = body
  while (remaining) {
    if (blocks.length >= 256 || !remaining.startsWith(paragraphStart)) fail()
    const end = remaining.indexOf(paragraphEnd, paragraphStart.length)
    if (end < 0) fail()
    const raw = remaining.slice(paragraphStart.length, end)
    if (raw.includes('<')) fail()
    const text = xml('<x>' + raw + '</x>').documentElement.textContent ?? ''
    safeParagraph(text)
    texts.push(text)
    blocks.push(remaining.slice(0, end + paragraphEnd.length))
    remaining = remaining.slice(end + paragraphEnd.length)
  }
  if (!blocks.length) fail()
  const parsed = await parseDocx(bytes),
    visible = parsed.blocks.filter((b) => !b.hidden)
  if (visible.length !== blocks.length || visible.some((b) => b.docxIndex === undefined)) fail()
  const unchanged = await saveDocx(
    parsed,
    visible.map((b) => ({ kind: 'original', docxIndex: b.docxIndex! })),
    { preserveCoreProperties: true },
  )
  if (!equal(bytes, unchanged)) fail()
  const paragraphs = Object.freeze(texts)
  return Object.freeze({
    paragraphs,
    async export(values: readonly string[]) {
      if (
        !Array.isArray(values) ||
        values.length !== paragraphs.length ||
        Reflect.ownKeys(values).length !== paragraphs.length + 1
      )
        fail()
      const snapshot: string[] = []
      for (let i = 0; i < paragraphs.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(values, String(i))
        if (!descriptor || !('value' in descriptor)) fail()
        safeParagraph(descriptor.value)
        snapshot.push(descriptor.value)
      }
      if (snapshot.every((t, i) => t === paragraphs[i])) return new Uint8Array(bytes)
      const changed = snapshot.map((t) => paragraphStart + escape(t) + paragraphEnd),
        expected = prefix + changed.join('') + suffix
      const fresh = await parseDocx(bytes),
        output = await saveDocx(
          fresh,
          changed.map((s, i) => ({ kind: 'xml', docxIndex: visible[i].docxIndex!, xml: s })),
          { preserveCoreProperties: true },
        ),
        result = await parts(output)
      if (result.size !== source.size) fail()
      for (const [n, b] of source)
        if (
          !result.has(n) ||
          !equal(result.get(n)!, n === 'word/document.xml' ? new TextEncoder().encode(expected) : b)
        )
          fail()
      return output
    },
  })
}
