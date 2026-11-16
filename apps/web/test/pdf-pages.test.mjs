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

async function formWrappedText() {
  const doc = await PDFDocument.create()
  const page = doc.addPage()
  const font = doc.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' })
  const form = doc.context.flateStream('(Hello) Tj', {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [0, 0, 100, 20],
    Resources: { Font: { F1: font } },
  })
  const formRef = doc.context.register(form)
  page.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { Fm0: formRef } }))
  page.node.set(PDFName.of('Contents'), doc.context.flateStream('/Fm0 Do'))
  return Buffer.from(await doc.save())
}

async function quoteOperatorPdf() {
  const doc = await PDFDocument.create()
  const page = doc.addPage()
  page.node.set(PDFName.of('Contents'), doc.context.stream('(Hi) \''))
  return Buffer.from(await doc.save())
}

async function commentOnlyPdf() {
  const doc = await PDFDocument.create()
  const page = doc.addPage()
  page.node.set(PDFName.of('Contents'), doc.context.stream('% Tj\n'))
  return Buffer.from(await doc.save())
}

async function parentSignaturePdf() {
  const doc = await PDFDocument.create()
  const page = doc.addPage()
  const value = doc.context.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    ByteRange: [0, 10, 20, 30],
    Contents: PDFHexString.of('00'),
  })
  const parent = doc.context.obj({ FT: 'Sig', V: value, Kids: [] })
  const parentRef = doc.context.register(parent)
  const widget = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Widget',
    Rect: [0, 0, 10, 10],
    Parent: parentRef,
  })
  page.node.set(PDFName.of('Annots'), doc.context.obj([widget]))
  return Buffer.from(await doc.save())
}

test('a form XObject is classified from its own stream, and comments are not text', async () => {
  const wrapped = await inspectPdf(await formWrappedText())
  assert.equal(wrapped.pages[0].kind, 'text')
  assert.equal(wrapped.pages[0].fonts.some((entry) => entry.baseFont.includes('Helvetica') && entry.embedded === false), true)
  const quoted = await inspectPdf(await quoteOperatorPdf())
  assert.equal(quoted.pages[0].kind, 'text')
  const comment = await inspectPdf(await commentOnlyPdf())
  assert.equal(comment.pages[0].kind, 'blank')
  assert.equal(comment.capabilities.read, 'structure')
})

test('a signature stored on the widget parent is unverified', async () => {
  const report = await inspectPdf(await parentSignaturePdf())
  assert.equal(report.signatures.length, 1)
  assert.equal(report.signatures[0].status, 'present_unverified')
  assert.throws(() => requestPdfOperation(report, 'trustSignature'), { code: 'SIGNATURE_UNVERIFIED' })
})

test('a signature is reported as present and unverified', async () => {
  const report = await inspectPdf(await signedPdf())
  assert.equal(report.signatures.length, 1)
  assert.equal(report.signatures[0].status, 'present_unverified')
  assert.equal(report.capabilities.signature, 'present_unverified')
  assert.throws(() => requestPdfOperation(report, 'trustSignature'), { code: 'SIGNATURE_UNVERIFIED' })
})
