import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { renderPdfPages } from '../server/src/pdf/raster.mjs'
import { inspectPdf, requestPdfOperation } from '../server/src/pdf/capabilities.mjs'
import { createApplication } from './helpers/prototype-http.mjs'

async function sample(text) {
  const doc = await PDFDocument.create()
  const page = doc.addPage([200, 100])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  page.drawText(text, { x: 20, y: 40, size: 18, font })
  doc.addPage([200, 100])
  return Buffer.from(await doc.save())
}

async function encryptedPdf() {
  const doc = await PDFDocument.create()
  doc.addPage()
  const loaded = await PDFDocument.load(await doc.save())
  loaded.context.trailerInfo.Encrypt = loaded.context.obj({ Filter: 'Standard' })
  return Buffer.from(await loaded.save({ updateMetadata: false }))
}

test('reopening the exported bytes keeps the rendered pixels and the text', async () => {
  const original = await sample('Revenue 1500')
  const first = await renderPdfPages(original)
  assert.equal(first.encrypted, false)
  assert.equal(first.pages.length, 2)
  assert.equal(first.pages[0].text, 'Revenue 1500')
  assert.equal(first.pages[0].width, 200)
  assert.equal(first.pages[0].height, 100)
  assert.ok(first.pages[0].ink > 0)
  assert.equal(first.pages[1].text, '')
  assert.equal(first.pages[1].ink, 0)
  const exported = Buffer.from(original)
  const reopened = await renderPdfPages(exported)
  assert.equal(reopened.pages[0].pixels, first.pages[0].pixels)
  assert.equal(reopened.pages[1].pixels, first.pages[1].pixels)
  const changed = await renderPdfPages(await sample('Revenue 5100'))
  assert.equal(changed.pages[0].text, 'Revenue 5100')
  assert.notEqual(changed.pages[0].pixels, first.pages[0].pixels)
  const report = await inspectPdf(original)
  assert.throws(() => requestPdfOperation(report, 'annotate'), { code: 'UNSUPPORTED' })
  assert.throws(() => requestPdfOperation(report, 'editText'), { code: 'UNSUPPORTED' })
})

test('an encrypted PDF is not rasterized', async () => {
  const locked = await renderPdfPages(await encryptedPdf())
  assert.equal(locked.encrypted, true)
  assert.deepEqual(locked.pages, [])
  await assert.rejects(renderPdfPages(Buffer.from('not a pdf')), { code: 'MAGIC_MISMATCH' })
})

test('the prototype rejects the removed PDF viewer and its resources', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-pdf-view-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const server = await createApplication({
    directory,
    userToken: 'user',
    adminToken: 'admin',
    encryptionKey: 'test',
    assetMode: 'source',
  })
  server.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  for (const path of ['/pdf.html', '/pdf.css', '/pdfjs/cmaps/UniGB-UCS2-H.bcmap', '/pdfjs/standard_fonts/LiberationSans-Regular.ttf']) {
    assert.equal((await fetch(origin + path)).status, 404, path)
  }
})
