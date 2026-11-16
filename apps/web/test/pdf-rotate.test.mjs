import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PDFDocument, PDFName, degrees, rgb } from 'pdf-lib'
import { rotatePdfPages } from '../server/src/pdf/rotate.mjs'
import { renderPdfPages } from '../server/src/pdf/raster.mjs'

async function fixture() {
  const doc = await PDFDocument.create()
  const page = doc.addPage([200, 100])
  page.drawText('Rotation keeps text', { x: 10, y: 60, size: 12 })
  page.drawRectangle({ x: 5, y: 5, width: 20, height: 10, color: rgb(1, 0, 0) })
  doc.addPage([80, 40])
  return Buffer.from(await doc.save())
}

test('rotates real PDF bytes and preserves text and unchanged pages after PDFium reopen', async () => {
  const bytes = await fixture(), snapshot = Buffer.from(bytes)
  const before = await renderPdfPages(bytes)
  const out = await rotatePdfPages(bytes, [{ page: 1, degrees: 90 }])
  const after = await renderPdfPages(out)
  assert.deepEqual(bytes, snapshot)
  assert.equal(after.pages[0].width, 100)
  assert.equal(after.pages[0].height, 200)
  assert.equal(after.pages[0].text, before.pages[0].text)
  // Rasterizer antialiasing differs after a quarter turn; the inverse must be exact.
  assert.ok(after.pages[0].ink > 0)
  assert.deepEqual(after.pages[1], before.pages[1])
  const restored = await rotatePdfPages(out, [{ page: 1, degrees: -90 }])
  assert.deepEqual((await renderPdfPages(restored)).pages, before.pages)
})

test('composes with existing rotation and normalizes negative angles', async () => {
  const doc = await PDFDocument.load(await fixture())
  doc.getPage(0).setRotation(degrees(270))
  const out = await rotatePdfPages(Buffer.from(await doc.save()), [{ page: 1, degrees: 180 }])
  assert.equal((await PDFDocument.load(out)).getPage(0).getRotation().angle, 90)
})

test('rejects invalid or ambiguous page operations rather than partially applying', async () => {
  const bytes = await fixture()
  for (const ops of [null, [], [{page: 0,degrees:90}], [{page:3,degrees:90}], [{page:1,degrees:45}], [{page:1,degrees:NaN}], [{page:1,degrees:90,extra:true}], [{page:1,degrees:90},{page:1,degrees:180}]]) {
    await assert.rejects(rotatePdfPages(bytes, ops), { code: 'INVALID_PDF_ROTATION' })
  }
})

test('refuses forms and signatures even when the signature is not attached to a page', async () => {
  const form = await PDFDocument.load(await fixture())
  form.getForm().createTextField('field')
  await assert.rejects(rotatePdfPages(Buffer.from(await form.save()), [{page:1,degrees:90}]), { code: 'PDF_EDIT_UNSUPPORTED_STRUCTURE' })
  const signed = await PDFDocument.load(await fixture())
  signed.context.register(signed.context.obj({ Type: 'Sig', ByteRange: [0, 10, 20, 30] }))
  await assert.rejects(rotatePdfPages(Buffer.from(await signed.save()), [{page:1,degrees:90}]), { code: 'SIGNATURE_EDIT_REFUSED' })
})

test('retains page annotations and content stream bytes', async () => {
  const doc = await PDFDocument.load(await fixture())
  const page = doc.getPage(0)
  page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(doc.context.obj({ Type:'Annot', Subtype:'Text', Rect:[10,10,20,20], Contents:'note' }))]))
  const bytes = Buffer.from(await doc.save())
  const out = await PDFDocument.load(await rotatePdfPages(bytes, [{page:1,degrees:90}]))
  assert.equal(String(out.getPage(0).node.Annots()), String(page.node.Annots()))
  const ref = page.node.Contents().asArray()[0]
  assert.deepEqual(out.context.lookup(ref).getContents(), doc.context.lookup(ref).getContents())
})

test('rejects non-PDF and oversized input before parsing', async () => {
  await assert.rejects(rotatePdfPages(Buffer.from('no pdf'), [{page:1,degrees:90}]), {code:'MAGIC_MISMATCH'})
  await assert.rejects(rotatePdfPages(Buffer.alloc(64*1024*1024+1), [{page:1,degrees:90}]), {code:'PDF_EDIT_LIMIT'})
})

test('refuses direct nested signature dictionaries, not only indirect objects', async () => {
  const doc = await PDFDocument.load(await fixture())
  doc.catalog.set(PDFName.of('Custom'), doc.context.obj({ Nested: { Type: 'Sig', ByteRange: [0, 1, 2, 3] } }))
  await assert.rejects(rotatePdfPages(Buffer.from(await doc.save()), [{page:1,degrees:90}]), {code:'SIGNATURE_EDIT_REFUSED'})
})

test('snapshots caller-owned bytes and operations before async parsing', async () => {
  const bytes = await fixture()
  const ops = [{page:1,degrees:90}]
  const work = rotatePdfPages(bytes, ops)
  ops[0].page = 2
  bytes.fill(0)
  const out = await PDFDocument.load(await work)
  assert.deepEqual(out.getPages().map(p => p.getRotation().angle), [90, 0])
})

test('refuses encrypted trailer without attempting password bypass', async () => {
  const doc = await PDFDocument.load(await fixture())
  doc.context.trailerInfo.Encrypt = doc.context.obj({Filter:'Standard'})
  await assert.rejects(rotatePdfPages(Buffer.from(await doc.save()), [{page:1,degrees:90}]), {code:'PASSWORD'})
})

test('limits page count and refuses malformed source rotation', async () => {
  const doc = await PDFDocument.create()
  for (let i=0;i<101;i++) doc.addPage([1,1])
  await assert.rejects(rotatePdfPages(Buffer.from(await doc.save()), [{page:1,degrees:90}]), {code:'PDF_EDIT_LIMIT'})
  const malformed = await PDFDocument.load(await fixture())
  malformed.getPage(0).node.set(PDFName.of('Rotate'), malformed.context.obj(45))
  await assert.rejects(rotatePdfPages(Buffer.from(await malformed.save()), [{page:1,degrees:90}]), {code:'PDF_EDIT_UNSUPPORTED_STRUCTURE'})
})
