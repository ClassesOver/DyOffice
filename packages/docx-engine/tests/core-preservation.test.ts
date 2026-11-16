/** Explicit metadata preservation does not enable any restricted editor profile. */
import { it, expect } from 'vitest'
import JSZip from 'jszip'
import { buildDocx } from './helpers/build-docx'
import { parseDocx } from '../src/parse'
import { saveDocx } from '../src/patch'
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const cases: Record<string, { path?: string; xml?: string; body?: string }> = {
  core: {
    path: 'docProps/core.xml',
    xml: '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dcterms="http://purl.org/dc/terms/"><cp:revision>3</cp:revision><dcterms:modified>2020-01-01T00:00:00Z</dcterms:modified></cp:coreProperties>',
  },
  coreWithoutMutable: {
    path: 'docProps/core.xml',
    xml: '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Title</dc:title></cp:coreProperties>',
  },
  app: {
    path: 'docProps/app.xml',
    xml: '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Pages>1</Pages><Words>1</Words><Application>Fixture</Application></Properties>',
  },
  settings: {
    path: 'word/settings.xml',
    xml:
      '<w:settings xmlns:w="' +
      W +
      '"><w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/></w:settings>',
  },
  fontTable: {
    path: 'word/fontTable.xml',
    xml:
      '<w:fonts xmlns:w="' +
      W +
      '"><w:font w:name="Calibri"><w:family w:val="swiss"/></w:font></w:fonts>',
  },
  theme: {
    path: 'word/theme/theme1.xml',
    xml: '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Fixture"><a:themeElements><a:clrScheme name="Fixture"/><a:fontScheme name="Fixture"/><a:fmtScheme name="Fixture"/></a:themeElements></a:theme>',
  },
  rsid: {
    body: '<w:p w:rsidR="00112233" w:rsidRDefault="00112233"><w:r><w:t xml:space="preserve">Hello</w:t></w:r></w:p>',
  },
  pPr: {
    body: '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="120"/></w:pPr><w:r><w:t xml:space="preserve">Hello</w:t></w:r></w:p>',
  },
  rPr: {
    body: '<w:p><w:r><w:rPr><w:b/><w:rFonts w:ascii="Calibri"/><w:sz w:val="24"/></w:rPr><w:t xml:space="preserve">Hello</w:t></w:r></w:p>',
  },
}
for (const [name, c] of Object.entries(cases))
  it('engine exact preservation experiment ' + name, async () => {
    const body = c.body ?? '<w:p><w:r><w:t xml:space="preserve">Hello</w:t></w:r></w:p>'
    const z = await JSZip.loadAsync(await buildDocx({ bodyXml: body }))
    if (c.path) z.file(c.path, c.xml!)
    const bytes = await z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }),
      parsed = await parseDocx(bytes)
    const visible = parsed.blocks.filter((b) => !b.hidden)
    expect(
      await saveDocx(
        parsed,
        visible.map((b) => ({ kind: 'original', docxIndex: b.docxIndex! })),
      ),
    ).toEqual(bytes)
    const out = await JSZip.loadAsync(
      await saveDocx(
        parsed,
        [{ kind: 'xml', docxIndex: visible[0].docxIndex!, xml: body.replace('Hello', 'Changed') }],
        { savedAt: '2030-01-01T00:00:00Z' },
      ),
    )
    const changed: string[] = []
    for (const n of Object.keys(z.files).filter((n) => !z.files[n].dir)) {
      const a = await z.file(n)!.async('string'),
        b = await out.file(n)!.async('string')
      if (a !== b) changed.push(n)
      if (n === 'word/document.xml') expect(b).toBe(a.replace('Hello', 'Changed'))
    }
    expect(changed.sort()).toEqual(
      (name === 'core' ? ['word/document.xml', 'docProps/core.xml'] : ['word/document.xml']).sort(),
    )
    console.log(JSON.stringify({ experiment: name, changed }))
  })
it('explicit core preservation keeps all five ancillary parts exact while default still updates core', async () => {
  const body = '<w:p><w:r><w:t xml:space="preserve">Hello</w:t></w:r></w:p>'
  const z = await JSZip.loadAsync(await buildDocx({ bodyXml: body }))
  for (const name of ['core', 'app', 'settings', 'fontTable', 'theme'])
    z.file(cases[name].path!, cases[name].xml!)
  const mime: Record<string, string> = {
    core: 'application/vnd.openxmlformats-package.core-properties+xml',
    app: 'application/vnd.openxmlformats-officedocument.extended-properties+xml',
    settings: 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml',
    fontTable: 'application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml',
    theme: 'application/vnd.openxmlformats-officedocument.theme+xml',
  }
  z.file(
    '[Content_Types].xml',
    (await z.file('[Content_Types].xml')!.async('string')).replace(
      '</Types>',
      Object.keys(mime)
        .map((n) => `<Override PartName="/${cases[n].path}" ContentType="${mime[n]}"/>`)
        .join('') + '</Types>',
    ),
  )
  z.file(
    '_rels/.rels',
    (await z.file('_rels/.rels')!.async('string')).replace(
      '</Relationships>',
      '<Relationship Id="core" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="app" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>',
    ),
  )
  z.file(
    'word/_rels/document.xml.rels',
    (await z.file('word/_rels/document.xml.rels')!.async('string')).replace(
      '</Relationships>',
      ['settings', 'fontTable', 'theme']
        .map(
          (n) =>
            `<Relationship Id="${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${n}" Target="${cases[n].path!.slice(5)}"/>`,
        )
        .join('') + '</Relationships>',
    ),
  )

  const bytes = await z.generateAsync({ type: 'uint8array' }),
    parsed = await parseDocx(bytes)
  const out = await JSZip.loadAsync(
    await saveDocx(
      parsed,
      [
        {
          kind: 'xml',
          docxIndex: parsed.blocks[0].docxIndex!,
          xml: body.replace('Hello', 'Changed'),
        },
      ],
      { preserveCoreProperties: true },
    ),
  )
  expect(
    Object.keys(out.files)
      .filter((n) => !out.files[n].dir)
      .sort(),
  ).toEqual(
    Object.keys(z.files)
      .filter((n) => !z.files[n].dir)
      .sort(),
  )
  for (const n of Object.keys(z.files).filter((n) => !z.files[n].dir))
    expect(await out.file(n)!.async('string')).toBe(
      (await z.file(n)!.async('string')).replace(
        n === 'word/document.xml' ? 'Hello' : 'NEVER_MATCH_SENTINEL',
        'Changed',
      ),
    )
})
it('core preservation does not bypass requested privacy scrub', async () => {
  const body = '<w:p><w:r><w:t xml:space="preserve">Hello</w:t></w:r></w:p>'
  const z = await JSZip.loadAsync(await buildDocx({ bodyXml: body }))
  z.file(
    'docProps/core.xml',
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>PrivateAuthor</dc:creator><cp:revision>3</cp:revision></cp:coreProperties>',
  )
  const parsed = await parseDocx(await z.generateAsync({ type: 'uint8array' }))
  const out = await JSZip.loadAsync(
    await saveDocx(
      parsed,
      [
        {
          kind: 'xml',
          docxIndex: parsed.blocks[0].docxIndex!,
          xml: body.replace('Hello', 'Changed'),
        },
      ],
      { preserveCoreProperties: true, removePersonalInfo: true },
    ),
  )
  const core = await out.file('docProps/core.xml')!.async('string')
  expect(core).not.toContain('PrivateAuthor')
  expect(core).toContain('<cp:revision>3</cp:revision>')
})
it('explicit false retains default modified/revision updates', async () => {
  const body = '<w:p><w:r><w:t xml:space="preserve">Hello</w:t></w:r></w:p>'
  const z = await JSZip.loadAsync(await buildDocx({ bodyXml: body }))
  z.file(cases.core.path!, cases.core.xml!)
  const parsed = await parseDocx(await z.generateAsync({ type: 'uint8array' }))
  const out = await JSZip.loadAsync(
    await saveDocx(
      parsed,
      [
        {
          kind: 'xml',
          docxIndex: parsed.blocks[0].docxIndex!,
          xml: body.replace('Hello', 'Changed'),
        },
      ],
      { preserveCoreProperties: false, savedAt: '2030-01-01T00:00:00Z' },
    ),
  )
  const core = await out.file('docProps/core.xml')!.async('string')
  expect(core).toContain('<cp:revision>4</cp:revision>')
  expect(core).toContain('2030-01-01T00:00:00Z')
})
it('true suppresses savedAt but explicit properties still take precedence', async () => {
  const body = '<w:p><w:r><w:t xml:space="preserve">Hello</w:t></w:r></w:p>'
  const z = await JSZip.loadAsync(await buildDocx({ bodyXml: body }))
  z.file(cases.core.path!, cases.core.xml!)
  const parsed = await parseDocx(await z.generateAsync({ type: 'uint8array' }))
  const out = await JSZip.loadAsync(
    await saveDocx(
      parsed,
      [
        {
          kind: 'xml',
          docxIndex: parsed.blocks[0].docxIndex!,
          xml: body.replace('Hello', 'Changed'),
        },
      ],
      {
        preserveCoreProperties: true,
        savedAt: '2030-01-01T00:00:00Z',
        properties: { core: { title: 'ExplicitTitle' } },
      },
    ),
  )
  const core = await out.file('docProps/core.xml')!.async('string')
  expect(core).toContain('ExplicitTitle')
  expect(core).toContain('<cp:revision>3</cp:revision>')
  expect(core).toContain('2020-01-01T00:00:00Z')
  expect(core).not.toContain('2030-01-01T00:00:00Z')
})
