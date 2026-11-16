import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PDFDocument, PDFHexString, PDFName, StandardFonts } from 'pdf-lib'
import { inspectPdf, requestPdfOperation } from '../server/src/pdf/capabilities.mjs'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

async function mixedPdf() {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const text = doc.addPage()
  text.drawText('Hello', { x: 40, y: 700, size: 18, font })
  const scan = doc.addPage()
  const image = await doc.embedPng(PNG)
  scan.drawImage(image, { x: 10, y: 10, width: 20, height: 20 })
  doc.addPage()
  return Buffer.from(await doc.save())
}

async function signedPdf() {
  const doc = await PDFDocument.create()
  const page = doc.addPage()
  const sig = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Sig',
    Rect: [0, 0, 10, 10],
    V: doc.context.obj({
      Type: 'Sig',
      Filter: 'Adobe.PPKLite',
      SubFilter: 'adbe.pkcs7.detached',
      ByteRange: [0, 10, 20, 30],
      Contents: PDFHexString.of('00'),
    }),
  })
  page.node.set(PDFName.of('Annots'), doc.context.obj([sig]))
  return Buffer.from(await doc.save())
}

test('pages are classified as text, scanned, or blank, and standard fonts are not embedded', async () => {
  const report = await inspectPdf(await mixedPdf())
  assert.deepEqual(report.pages.map((page) => page.kind), ['text', 'scanned', 'blank'])
  assert.equal(report.capabilities.read, 'text_layer')
  assert.equal(report.capabilities.editText, 'unsupported')
  const font = report.pages[0].fonts.find((entry) => entry.baseFont.includes('Helvetica'))
  assert.equal(font.embedded, false)
  assert.equal(report.pages[1].textOperators, false)
  assert.equal(report.pages[1].image, true)
})

test('a signature is reported as present and unverified', async () => {
  const report = await inspectPdf(await signedPdf())
  assert.equal(report.signatures.length, 1)
  assert.equal(report.signatures[0].status, 'present_unverified')
  assert.equal(report.capabilities.signature, 'present_unverified')
  assert.throws(() => requestPdfOperation(report, 'trustSignature'), { code: 'SIGNATURE_UNVERIFIED' })
})
