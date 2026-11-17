import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { importSimpleDocx } from '../../../packages/browser-host/src/simple-docx'
const plain = '<w:p><w:r><w:t xml:space="preserve">Hello</w:t></w:r></w:p>'
async function mutate(fn: (z: JSZip) => void) {
  const z = await JSZip.loadAsync(await buildDocx({ bodyXml: plain }))
  fn(z)
  return z.generateAsync({ type: 'uint8array' })
}
describe('strict simple DOCX', () => {
  it('imports engine-backed text and preserves all other parts on edit', async () => {
    const bytes = await buildDocx({ bodyXml: plain })
    const doc = await importSimpleDocx(bytes)
    expect(doc.paragraphs).toEqual(['Hello'])
    const out = await doc.export(['A & <B>'])
    const a = await JSZip.loadAsync(bytes),
      b = await JSZip.loadAsync(out)
    expect(
      Object.keys(b.files)
        .filter((n) => !b.files[n].dir)
        .sort(),
    ).toEqual(
      Object.keys(a.files)
        .filter((n) => !a.files[n].dir)
        .sort(),
    )
    for (const n of Object.keys(a.files))
      if (n !== 'word/document.xml')
        expect(await b.file(n)?.async('uint8array')).toEqual(await a.file(n)?.async('uint8array'))
    expect(await b.file('word/document.xml')!.async('string')).toContain('A &amp; &lt;B&gt;')
    expect((await importSimpleDocx(out)).paragraphs).toEqual(['A & <B>'])
  })
  it('owns Buffer input and independently copies each unchanged output', async () => {
    const original = await buildDocx({ bodyXml: plain })
    const input = Buffer.from(original)
    const doc = await importSimpleDocx(input)
    input.fill(0)
    const first = await doc.export(['Hello'])
    expect(Array.from(first)).toEqual(Array.from(original))
    first.fill(0)
    expect(Array.from(await doc.export(['Hello']))).toEqual(Array.from(original))
    expect((await importSimpleDocx(await doc.export(['Changed']))).paragraphs).toEqual(['Changed'])
  })
  it('rejects accessor, sparse and custom iterator inputs without invoking getters', async () => {
    const doc = await importSimpleDocx(await buildDocx({ bodyXml: plain }))
    let reads = 0
    const getter = ['Hello']
    Object.defineProperty(getter, '0', {
      get() {
        return ++reads === 1 ? 'Hello' : 'bad\u0000'
      },
    })
    const custom = ['Hello']
    Object.defineProperty(custom, Symbol.iterator, {
      value: function* () {
        yield 'bad\u0000'
      },
    })
    for (const value of [getter, custom, new Array(1)])
      await expect(doc.export(value)).rejects.toThrow()
    expect(reads).toBe(0)
  })
  it('returns identical original bytes for unchanged save', async () => {
    const bytes = await buildDocx({ bodyXml: plain })
    expect(await (await importSimpleDocx(bytes)).export(['Hello'])).toEqual(bytes)
  })
  for (const body of [
    '<w:tbl/>',
    '<w:p><w:pPr/><w:r><w:t xml:space="preserve">Hi</w:t></w:r></w:p>',
    plain.replace('<w:r>', '<w:r><w:rPr/>'),
    plain.replace('xml:space="preserve"', 'bogus="yes"'),
    plain.replace('Hello', '<![CDATA[Hello]]>'),
  ])
    it('rejects unsupported body ' + body, async () => {
      await expect(importSimpleDocx(await buildDocx({ bodyXml: body }))).rejects.toThrow()
    })
  it('supports empty, multiple and repeated exports without mutating source', async () => {
    const d = await importSimpleDocx(await buildDocx({ bodyXml: plain + plain }))
    for (const texts of [
      ['', 'Two'],
      ['One $&', 'Three'],
      ['Hello', 'Hello'],
    ])
      expect((await importSimpleDocx(await d.export(texts))).paragraphs).toEqual(texts)
  })
  it('rejects duplicate central entries', async () => {
    const b = await buildDocx({ bodyXml: plain })
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength),
      end = b.length - 22,
      start = v.getUint32(end + 16, true),
      len = 46 + v.getUint16(start + 28, true)
    const out = new Uint8Array(b.length + len)
    out.set(b.subarray(0, end))
    out.set(b.subarray(start, start + len), end)
    out.set(b.subarray(end), end + len)
    const x = new DataView(out.buffer),
      e = end + len
    x.setUint16(e + 8, v.getUint16(end + 8, true) + 1, true)
    x.setUint16(e + 10, v.getUint16(end + 10, true) + 1, true)
    x.setUint32(e + 12, v.getUint32(end + 12, true) + len, true)
    await expect(importSimpleDocx(out)).rejects.toThrow()
  })
  it('rejects ZIP encryption, aliases, truncation and forged sizes', async () => {
    const bytes = await buildDocx({ bodyXml: plain })
    for (const kind of ['encrypted', 'alias', 'size', 'truncated']) {
      const b = bytes.slice(),
        v = new DataView(b.buffer),
        e = b.length - 22,
        p = v.getUint32(e + 16, true)
      if (kind === 'encrypted') {
        v.setUint16(p + 8, 1, true)
        v.setUint16(6, 1, true)
      }
      if (kind === 'alias') {
        b[p + 46] = 46
        b[30] = 46
      }
      if (kind === 'size') v.setUint32(p + 24, 0x7fffffff, true)
      await expect(importSimpleDocx(kind === 'truncated' ? b.slice(0, -1) : b)).rejects.toThrow()
    }
  })
  it('rejects unknown ZIP parts', async () => {
    await expect(
      importSimpleDocx(await mutate((z) => z.file('word/unknown.xml', '<x/>'))),
    ).rejects.toThrow()
  })
  it('rejects wrong namespace and DTD', async () => {
    for (const xml of [
      '<w:document xmlns:w="evil"><w:body/></w:document>',
      '<!DOCTYPE x><w:document/>',
    ])
      await expect(
        importSimpleDocx(await mutate((z) => z.file('word/document.xml', xml))),
      ).rejects.toThrow()
  })
  it('rejects external relationships', async () => {
    await expect(
      importSimpleDocx(
        await buildDocx({
          bodyXml: plain,
          extraRels:
            '<Relationship Id="evil" Type="x" Target="https://evil" TargetMode="External"/>',
        }),
      ),
    ).rejects.toThrow()
  })
  for (const [name, styles] of [
    [
      'hidden defaults',
      '<w:docDefaults><w:rPrDefault><w:rPr><w:vanish/></w:rPr></w:rPrDefault></w:docDefaults>',
    ],
    [
      'hidden Normal',
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:rPr><w:vanish/></w:rPr></w:style>',
    ],
    [
      'hidden default character',
      '<w:style w:type="character" w:default="1" w:styleId="Hidden"><w:rPr><w:vanish/></w:rPr></w:style>',
    ],
    [
      'unreviewed inherited style',
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:basedOn w:val="Hidden"/></w:style><w:style w:type="paragraph" w:styleId="Hidden"><w:rPr><w:vanish/></w:rPr></w:style>',
    ],
  ])
    it('rejects unreviewed style profile: ' + name, async () => {
      await expect(
        importSimpleDocx(
          await buildDocx({
            bodyXml: plain,
            stylesXml:
              '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
              styles +
              '</w:styles>',
          }),
        ),
      ).rejects.toThrow('Unsupported or unsafe simple DOCX')
    })
  it('rejects extra styles even when the reviewed default profile is retained', async () => {
    await expect(
      importSimpleDocx(
        await buildDocx({
          bodyXml: plain,
          extraStylesXml:
            '<w:docDefaults><w:rPrDefault><w:rPr><w:vanish/></w:rPr></w:rPrDefault></w:docDefaults>',
        }),
      ),
    ).rejects.toThrow('Unsupported or unsafe simple DOCX')
  })
  it('rejects unsafe replacements and size', async () => {
    const d = await importSimpleDocx(await buildDocx({ bodyXml: plain }))
    for (const s of ['a\n', '\u0001', '\ud800', 'x'.repeat(65537)])
      await expect(d.export([s])).rejects.toThrow()
    await expect(importSimpleDocx(new Uint8Array(2 * 1024 * 1024 + 1))).rejects.toThrow()
  })
})
