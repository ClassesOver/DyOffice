import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PDFDocument } from 'pdf-lib'
import { inspectPdf, requestPdfOperation } from '../server/src/pdf/capabilities.mjs'

async function pages(count) {
  const doc = await PDFDocument.create()
  for (let i = 0; i < count; i += 1) doc.addPage()
  return Buffer.from(await doc.save())
}

async function encryptedPdf() {
  const doc = await PDFDocument.create()
  doc.addPage()
  const loaded = await PDFDocument.load(await doc.save())
  loaded.context.trailerInfo.Encrypt = loaded.context.obj({ Filter: 'Standard' })
  return Buffer.from(await loaded.save({ updateMetadata: false }))
}

test('a plain PDF reports page order and refuses edits, redaction, and cover text', async () => {
  const report = await inspectPdf(await pages(2))
  assert.equal(report.encrypted, false)
  assert.deepEqual(report.pageOrder, [1, 2])
  assert.equal(report.capabilities.read, 'structure')
  assert.equal(report.capabilities.editText, 'unsupported')
  assert.equal(report.capabilities.redact, 'unsupported')
  assert.deepEqual(requestPdfOperation(report, 'read'), { operation: 'read', effect: 'read' })
  assert.throws(() => requestPdfOperation(report, 'editText'), { code: 'UNSUPPORTED' })
  assert.throws(() => requestPdfOperation(report, 'reorderPages'), { code: 'UNSUPPORTED' })
  assert.throws(() => requestPdfOperation(report, 'annotate'), { code: 'UNSUPPORTED' })
  assert.throws(() => requestPdfOperation(report, 'redact'), { code: 'UNSUPPORTED' })
  assert.throws(() => requestPdfOperation(report, 'coverText'), { code: 'COVER_IS_NOT_DELETION' })
  assert.deepEqual(report.pageOrder, [1, 2])
})

test('an encrypted PDF is not readable and a fake file is rejected', async () => {
  const locked = await inspectPdf(await encryptedPdf())
  assert.equal(locked.encrypted, true)
  assert.equal(locked.capabilities.read, 'password_required')
  assert.equal(locked.pageOrder, undefined)
  assert.throws(() => requestPdfOperation(locked, 'read'), { code: 'PASSWORD' })
  await assert.rejects(inspectPdf(Buffer.from('not a pdf')), { code: 'MAGIC_MISMATCH' })
})
