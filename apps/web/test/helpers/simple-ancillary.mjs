// Synthetic standards-shaped fixture, not claimed to be produced by Microsoft Word.
import JSZip from 'jszip'
import assert from 'node:assert/strict'
import { buildDocx } from '../../../../packages/docx-engine/tests/helpers/build-docx.ts'
import { parseDocx } from '../../../../packages/docx-engine/src/parse.ts'
import { saveDocx } from '../../../../packages/docx-engine/src/patch.ts'
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const body = '<w:p><w:r><w:t xml:space="preserve">Hello world</w:t></w:r></w:p>'
export async function ancillaryFixture() {
  const parts = [
    [
      'docProps/core.xml',
      'application/vnd.openxmlformats-package.core-properties+xml',
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dcterms="http://purl.org/dc/terms/"><cp:revision>3</cp:revision><dcterms:modified>2020-01-01T00:00:00Z</dcterms:modified></cp:coreProperties>',
    ],
    [
      'docProps/app.xml',
      'application/vnd.openxmlformats-officedocument.extended-properties+xml',
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Synthetic fixture</Application></Properties>',
    ],
    [
      'word/settings.xml',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml',
      `<w:settings xmlns:w="${W}"><w:defaultTabStop w:val="720"/></w:settings>`,
    ],
    [
      'word/fontTable.xml',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml',
      `<w:fonts xmlns:w="${W}"><w:font w:name="Calibri"><w:family w:val="swiss"/></w:font></w:fonts>`,
    ],
    [
      'word/theme/theme1.xml',
      'application/vnd.openxmlformats-officedocument.theme+xml',
      '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Synthetic"><a:themeElements><a:clrScheme name="Synthetic"/><a:fontScheme name="Synthetic"/><a:fmtScheme name="Synthetic"/></a:themeElements></a:theme>',
    ],
  ]
  const extraRels = ['settings', 'fontTable', 'theme']
    .map(
      (name, i) =>
        `<Relationship Id="extra${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${name}" Target="${name === 'theme' ? 'theme/theme1.xml' : name + '.xml'}"/>`,
    )
    .join('')
  const z = await JSZip.loadAsync(
    await buildDocx({
      bodyXml: body,
      extraRels,
      extraParts: parts.map(([path, contentType, xml]) => ({ path, contentType, xml })),
    }),
  )
  z.file(
    '_rels/.rels',
    (await z.file('_rels/.rels').async('string')).replace(
      '</Relationships>',
      '<Relationship Id="core" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="app" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>',
    ),
  )
  const bytes = await z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  return {
    bytes,
    async importExperiment(input) {
      const parsed = await parseDocx(input)
      return {
        paragraphs: ['Hello world'],
        async export(texts) {
          assert.deepEqual(texts, ['Welcome world'])
          const out = await saveDocx(
            parsed,
            [
              {
                kind: 'xml',
                docxIndex: parsed.blocks[0].docxIndex,
                xml: body.replace('Hello', 'Welcome'),
              },
            ],
            { preserveCoreProperties: true },
          )
          await verifyAncillary(input, out)
          return out
        },
      }
    },
  }
}
export async function verifyAncillary(source, output) {
  const a = await JSZip.loadAsync(source),
    b = await JSZip.loadAsync(output),
    names = (z) =>
      Object.keys(z.files)
        .filter((n) => !z.files[n].dir)
        .sort()
  assert.deepEqual(names(a), names(b))
  for (const name of names(a)) {
    const original = await a.file(name).async('uint8array'),
      actual = await b.file(name).async('uint8array')
    const expected =
      name === 'word/document.xml'
        ? new TextEncoder().encode(new TextDecoder().decode(original).replace('Hello', 'Welcome'))
        : original
    assert.deepEqual(actual, expected, name)
  }
  const parsed = await parseDocx(output)
  assert.equal(parsed.blocks.filter((b) => !b.hidden).length, 1)
}
