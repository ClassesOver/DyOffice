import { test } from 'node:test'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import { PDFDocument } from 'pdf-lib'
import { createHash } from 'node:crypto'

const formats = {
  docx: { path: 'word/document.xml', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml', xml: '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>' },
  xlsx: { path: 'xl/workbook.xml', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml', xml: '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets/></workbook>' },
  pptx: { path: 'ppt/presentation.xml', type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml', xml: '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst/></p:presentation>' },
}
async function office(format, mutate = () => {}, compression = 'DEFLATE') {
  const z = new JSZip(), f = formats[format]
  z.file('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${f.path}" ContentType="${f.type}"/></Types>`)
  z.file('_rels/.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${f.path}"/></Relationships>`)
  z.file(f.path, f.xml)
  mutate(z)
  return z.generateAsync({ type: 'nodebuffer', compression })
}
async function validator() { return (await import('../../server/src/modules/files/validation.ts')).validateUpload }

test('four formats are structurally validated and hashed from actual bytes without changing originals', async () => {
  const validate = await validator()
  for (const format of Object.keys(formats)) {
    const bytes = await office(format), before = Buffer.from(bytes)
    const result = await validate(bytes, '季度报告.' + format)
    assert.equal(result.format, format); assert.equal(result.size, bytes.length)
    assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'))
    assert.deepEqual(bytes, before)
  }
  const pdf = await PDFDocument.create(); pdf.addPage()
  const bytes = Buffer.from(await pdf.save())
  assert.equal((await validate(bytes, 'original.pdf')).format, 'pdf')
})

test('extension alone, fake ZIP/PDF and wrong Office main types never establish a supported file', async () => {
  const validate = await validator()
  for (const [bytes, name] of [[Buffer.from('PK fake'),'a.docx'],[Buffer.from('%PDF-1.7\n%%EOF'),'a.pdf'],[await office('docx'),'a.xlsx'],[Buffer.from('a'),'a.exe'],[Buffer.alloc(0),'a.pdf']]) {
    await assert.rejects(() => validate(bytes, name), { statusCode: 400 })
  }
})

test('names, archive traversal, aliases, encrypted flags, macros and external root relationships are rejected', async () => {
  const validate = await validator(), good = await office('docx')
  for (const name of ['../a.docx','x\\a.docx','/a.docx','a\u0000.docx','a\nb.docx','.docx','a.docx ', 'a'.repeat(260) + '.docx']) {
    await assert.rejects(() => validate(good, name), { statusCode: 400 })
  }
  for (const mutate of [
    z => z.file('../outside.xml','bad'),
    z => z.file('WORD/document.xml','duplicate alias'),
    z => z.file('word/vbaProject.bin','macro'),
    z => z.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="https://example.com/a.xml" TargetMode="External"/></Relationships>'),
    z => z.file('word/document.xml','<!DOCTYPE w:document [<!ENTITY x "expanded">]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">&x;</w:document>'),
    z => z.file('word/document.xml','<wrong/>'),
  ]) {
    const bytes = await office('docx', mutate)
    await assert.rejects(() => validate(bytes, 'a.docx'), { statusCode: 400 })
  }
  const encrypted = Buffer.from(good)
  for (let at = 0; at < encrypted.length - 46; at++) if (encrypted.readUInt32LE(at) === 0x02014b50) encrypted.writeUInt16LE(encrypted.readUInt16LE(at + 8) | 1, at + 8)
  await assert.rejects(() => validate(encrypted, 'a.docx'), { statusCode: 400 })
})

test('entry count, inflated parts and lying size declarations are bounded before acceptance', async () => {
  const validate = await validator()
  const bomb = await office('docx', z => z.file('word/large.xml','A'.repeat(300_000)))
  await assert.rejects(() => validate(bomb, 'a.docx', { maxPartBytes: 100_000 }), { statusCode: 413 })
  const many = await office('docx', z => { for (let i = 0; i < 10; i++) z.file('part' + i, 'a') })
  await assert.rejects(() => validate(many, 'a.docx', { maxEntries: 8 }), { statusCode: 413 })
  await assert.rejects(() => validate(bomb, 'a.docx', { maxInflatedBytes: 100_000 }), { statusCode: 413 })
  await assert.rejects(() => validate(bomb, 'a.docx', { maxBytes: 10 }), { statusCode: 413 })
  const largeXml = await office('docx', z => z.file('word/document.xml', formats.docx.xml.replace('<w:body/>', '<w:body>' + 'x'.repeat(1000) + '</w:body>')))
  await assert.rejects(() => validate(largeXml, 'a.docx', { maxXmlBytes: 500 }), { statusCode: 413 })
  const lying = Buffer.from(bomb)
  for (let at = 0; at < lying.length - 46; at++) if (lying.readUInt32LE(at) === 0x02014b50 && lying.subarray(at + 46, at + 60).toString() === 'word/large.xml') lying.writeUInt32LE(10, at + 24)
  await assert.rejects(() => validate(lying, 'a.docx'), { statusCode: 400 })
})

test('CRC corruption, central/local filename disagreement and broken XML are rejected', async () => {
  const validate = await validator(), bytes = await office('docx', () => {}, 'STORE')
  const corrupt = Buffer.from(bytes), pos = corrupt.indexOf(Buffer.from('<w:document'))
  assert.ok(pos > 0); corrupt[pos + 1] = 'x'.charCodeAt(0)
  await assert.rejects(() => validate(corrupt, 'a.docx'), { statusCode: 400 })
  const wrongName = Buffer.from(bytes), name = wrongName.indexOf(Buffer.from('word/document.xml'))
  wrongName[name] = 'x'.charCodeAt(0)
  await assert.rejects(() => validate(wrongName, 'a.docx'), { statusCode: 400 })
  const broken = await office('docx', z => z.file('word/document.xml','<w:document>'))
  await assert.rejects(() => validate(broken, 'a.docx'), { statusCode: 400 })
})

test('validation deadlines terminate parsing and a subsequent healthy validation still works', async () => {
  const { createFileValidator } = await import('../../server/src/modules/files/validation.ts')
  const bytes = await office('docx')
  const bounded = createFileValidator({ timeoutMs: 1 })
  await assert.rejects(() => bounded(bytes, 'a.docx'), { statusCode: 413 })
  assert.equal((await (await validator())(bytes, 'a.docx')).format, 'docx')
})

test('bounded validation concurrency rejects excess work without an unbounded wait queue', async () => {
  const validate = await validator(), bytes = await office('docx')
  const results = await Promise.allSettled([validate(bytes, 'a.docx'), validate(bytes, 'b.docx'), validate(bytes, 'c.docx')])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2)
  assert.equal(results.find(result => result.status === 'rejected').reason.statusCode, 503)
})

test('upstream Office/PDF fixtures are accepted unchanged and encrypted PDF is refused', async () => {
  const { readFile } = await import('node:fs/promises'), validate = await validator()
  for (const [path, name, expected] of [
    ['packages/docx-engine/tests/fixtures/truths/render-sectafter-no-blank/probe.docx','probe.docx','docx'],
    ['apps/shell/build/shell-new/blank.xlsx','blank.xlsx','xlsx'],
    ['packages/pptx-engine/tests/fixtures/01_standard_business.pptx','business.pptx','pptx'],
    ['apps/pdf/tests/fixtures/plain-sample.pdf','sample.pdf','pdf'],
  ]) {
    const bytes = await readFile(new URL('../../../../' + path, import.meta.url))
    assert.equal((await validate(bytes, name)).format, expected)
  }
  const encrypted = await readFile(new URL('../../../../apps/pdf/tests/fixtures/enc128.pdf', import.meta.url))
  await assert.rejects(() => validate(encrypted, 'encrypted.pdf'), { statusCode: 400 })
})

test('OPC metadata children must resolve to the package namespace, including local overrides', async () => {
  const validate = await validator()
  for (const mutate of [
    z => z.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override xmlns="urn:evil" PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    z => z.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship xmlns="urn:evil" Id="r" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    z => z.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types" xmlns:x="urn:evil"><x:Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
  ]) {
    const bytes = await office('docx', mutate)
    await assert.rejects(() => validate(bytes, 'a.docx'), { statusCode: 400 })
  }
  const prefixed = await office('docx', z => {
    z.file('[Content_Types].xml', '<ct:Types xmlns:ct="http://schemas.openxmlformats.org/package/2006/content-types"><ct:Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></ct:Types>')
    z.file('_rels/.rels', '<r:Relationships xmlns:r="http://schemas.openxmlformats.org/package/2006/relationships"><r:Relationship Id="r" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></r:Relationships>')
  })
  assert.equal((await validate(prefixed, 'prefixed.docx')).format, 'docx')
})

test('zero-byte CSV validation does not depend on the workbook worker deadline', async () => {
  const { createFileValidator } = await import('../../server/src/modules/files/validation.ts')
  const validate = createFileValidator({ timeoutMs: 1 })
  const empty = Buffer.alloc(0)
  assert.deepEqual(await validate(empty, 'empty.CSV'), {
    format: 'csv',
    mime: 'text/csv',
    size: 0,
    sha256: createHash('sha256').update(empty).digest('hex'),
    officeSignatureProtected: false,
  })
  await assert.rejects(() => validate(empty, 'empty.xlsx'), { statusCode: 400 })
})
