import { it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import JSZip from 'jszip'
import { importLibreOfficeTemplateDocx } from '../../../packages/browser-host/src/libreoffice-template-docx'
async function archive(z: JSZip) {
  for (const [n, e] of Object.entries(z.files)) if (e.dir) delete z.files[n]
  return z.generateAsync({ type: 'uint8array' })
}
const fixture = () => new Uint8Array(readFileSync('tests/fixtures/simple-lo-template.docx'))
it('imports actual LO-generated template and edits only exact body text', async () => {
  const bytes = fixture(),
    doc = await importLibreOfficeTemplateDocx(bytes)
  expect(doc.paragraphs).toEqual(['Hello world', 'Second paragraph'])
  expect(await doc.export(doc.paragraphs)).toEqual(bytes)
  const output = await doc.export(['Changed & text', 'Second paragraph'])
  const before = await JSZip.loadAsync(bytes),
    after = await JSZip.loadAsync(output)
  for (const name of Object.keys(before.files)) {
    const b = await before.file(name)!.async('string'),
      a = await after.file(name)!.async('string')
    expect(a).toBe(
      name === 'word/document.xml' ? b.replace('Hello world', 'Changed &amp; text') : b,
    )
  }
  expect((await importLibreOfficeTemplateDocx(output)).paragraphs[0]).toBe('Changed & text')
})
for (const [name, from, to] of [
  ['word/document.xml', 'xmlns:w="', 'xmlns:evil="'],
  ['_rels/.rels', 'Target="word/document.xml"', 'Target="https://evil"'],
  ['word/settings.xml', '</w:settings>', '<w:documentProtection w:edit="readOnly"/></w:settings>'],
  ['word/styles.xml', 'PreformattedText', 'OtherStyle'],
  ['word/document.xml', 'w:bidi w:val="0"', 'w:bidi w:val="1"'],
  ['docProps/core.xml', '<dc:title>', '<dc:title evil="1">'],
])
  it('rejects unknown template mutation ' + name + from, async () => {
    const z = await JSZip.loadAsync(fixture())
    z.file(name, (await z.file(name)!.async('string')).replace(from, to))
    await expect(importLibreOfficeTemplateDocx(await archive(z))).rejects.toThrow()
  })
it('isolates Buffer and rejects accessor/iterator text arrays', async () => {
  const input = Buffer.from(fixture()),
    doc = await importLibreOfficeTemplateDocx(input)
  input.fill(0)
  const a = await doc.export(doc.paragraphs)
  a.fill(0)
  expect(
    (await importLibreOfficeTemplateDocx(await doc.export(doc.paragraphs))).paragraphs,
  ).toEqual(doc.paragraphs)
  const texts = ['Hello world', 'Second paragraph']
  Object.defineProperty(texts, '0', {
    get() {
      throw Error('must not read')
    },
  })
  await expect(doc.export(texts)).rejects.toThrow()
})
it('allows metadata leaf text changes but preserves it exactly', async () => {
  const z = await JSZip.loadAsync(fixture())
  z.file(
    'docProps/core.xml',
    (await z.file('docProps/core.xml')!.async('string')).replace(
      '<dc:title></dc:title>',
      '<dc:title>Safe &amp; title</dc:title>',
    ),
  )
  const b = await archive(z),
    d = await importLibreOfficeTemplateDocx(b)
  const out = await JSZip.loadAsync(await d.export(['Changed', 'Second paragraph']))
  expect(await out.file('docProps/core.xml')!.async('string')).toBe(
    await z.file('docProps/core.xml')!.async('string'),
  )
})
it('rejects extra parts, DTD, descriptor corruption and oversized input', async () => {
  const z = await JSZip.loadAsync(fixture())
  z.file('word/unknown.xml', '<x/>')
  await expect(importLibreOfficeTemplateDocx(await archive(z))).rejects.toThrow()
  const b = fixture(),
    v = new DataView(b.buffer),
    cd = v.getUint32(b.length - 6, true),
    off = v.getUint32(cd + 42, true),
    data = off + 30 + v.getUint16(off + 26, true) + v.getUint16(off + 28, true),
    end = data + v.getUint32(cd + 20, true)
  b[end + 4] ^= 1
  await expect(importLibreOfficeTemplateDocx(b)).rejects.toThrow()
  await expect(importLibreOfficeTemplateDocx(new Uint8Array(2 * 1024 * 1024 + 1))).rejects.toThrow()
  const x = await JSZip.loadAsync(fixture())
  x.file('docProps/core.xml', '<!DOCTYPE x>' + (await x.file('docProps/core.xml')!.async('string')))
  await expect(importLibreOfficeTemplateDocx(await archive(x))).rejects.toThrow()
})
it('rejects sparse/decorated/iterator and unsafe text', async () => {
  const d = await importLibreOfficeTemplateDocx(fixture()),
    custom = ['Hello world', 'Second paragraph']
  Object.defineProperty(custom, Symbol.iterator, {
    value: function* () {
      yield 'bad\0'
      yield 'Second paragraph'
    },
  })
  for (const value of [
    custom,
    new Array(2),
    ['bad\0', 'Second paragraph'],
    ['\ud800', 'Second paragraph'],
    [' Leading', 'Second paragraph'],
    ['Trailing ', 'Second paragraph'],
    ['Double  space', 'Second paragraph'],
  ])
    await expect(d.export(value)).rejects.toThrow()
})

it('rejects imported whitespace-sensitive paragraphs', async () => {
  for (const text of [' Leading', 'Trailing ', 'Double  space']) {
    const z = await JSZip.loadAsync(fixture())
    z.file(
      'word/document.xml',
      (await z.file('word/document.xml')!.async('string')).replace('Hello world', text),
    )
    await expect(importLibreOfficeTemplateDocx(await archive(z))).rejects.toThrow()
  }
})
it('rejects invalid numeric metadata and empty paragraphs', async () => {
  for (const [part, from, to] of [
    ['docProps/core.xml', '<cp:revision>0', '<cp:revision>NaN'],
    ['docProps/app.xml', '<TotalTime>0', '<TotalTime>-1'],
    ['docProps/app.xml', '<AppVersion>15.0000', '<AppVersion>nonsense'],
  ]) {
    const z = await JSZip.loadAsync(fixture())
    z.file(part, (await z.file(part)!.async('string')).replace(from, to))
    await expect(importLibreOfficeTemplateDocx(await archive(z))).rejects.toThrow()
  }
  const doc = await importLibreOfficeTemplateDocx(fixture())
  await expect(doc.export(['', 'Second paragraph'])).rejects.toThrow()
  const z = await JSZip.loadAsync(fixture())
  z.file(
    'word/document.xml',
    (await z.file('word/document.xml')!.async('string')).replace('Hello world', ''),
  )
  await expect(importLibreOfficeTemplateDocx(await archive(z))).rejects.toThrow()
})
