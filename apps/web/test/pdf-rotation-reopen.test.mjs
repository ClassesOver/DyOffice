import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {PDFDocument, PDFName, PDFString, degrees, rgb} from 'pdf-lib'
import {createPdfRotationJob} from '../server/src/pdf/rotation-job.mjs'
import {renderPdfPages} from '../server/src/pdf/raster.mjs'

// Candidate byte-processing verification only. No HTTP save, durable receipt,
// authenticated worker or Docker isolation is exercised by this test.
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const command = operations => JSON.stringify({version:1,action:'rotatePages',operations})

test('multiple rotations survive serialized reopen and inverse with exact original pixels and text', async () => {
  const doc = await PDFDocument.create()
  const first = doc.addPage([240, 120])
  first.drawText('First page stays first', {x:10,y:80,size:12})
  first.drawRectangle({x:8,y:8,width:30,height:10,color:rgb(1,0,0)})
  first.setRotation(degrees(90))
  const second = doc.addPage([100,160])
  second.drawText('Second', {x:8,y:100,size:12})
  const third = doc.addPage([180,90])
  third.drawText('Untouched', {x:8,y:60,size:12})
  third.setRotation(degrees(180))
  third.node.set(PDFName.of('Annots'),doc.context.obj([doc.context.register(doc.context.obj({
    Type:'Annot',Subtype:'Text',Rect:[10,10,20,20],Contents:PDFString.of('Retained note'),
  }))]))
  const original = Buffer.from(await doc.save()), originalHash = digest(original)
  const before = await renderPdfPages(original)
  const job = createPdfRotationJob()
  const rotated = await job.execute(original,command([{page:1,degrees:90},{page:2,degrees:-90}]))
  assert.equal(digest(original), originalHash)
  assert.equal(rotated.inputSha256,originalHash)
  assert.equal(rotated.sha256,digest(rotated.bytes))
  assert.equal(rotated.size,rotated.bytes.length)
  const reopened = await PDFDocument.load(Buffer.from(rotated.bytes))
  assert.deepEqual(reopened.getPages().map(page=>page.getRotation().angle),[180,270,180])
  const after = await renderPdfPages(rotated.bytes)
  assert.deepEqual(after.pages.map(({width,height})=>[width,height]),[[240,120],[160,100],[180,90]])
  assert.deepEqual(after.pages.map(page=>page.text),before.pages.map(page=>page.text))
  assert.deepEqual(after.pages[2],before.pages[2])
  const annotation = reopened.context.lookup(reopened.getPage(2).node.Annots().get(0))
  assert.equal(annotation.get(PDFName.of('Contents')).decodeText(),'Retained note')
  // The next operation consumes reserialized bytes, not the original document.
  const serialized = Buffer.from(await reopened.save({updateFieldAppearances:false}))
  const restored = await job.execute(serialized,command([{page:1,degrees:-90},{page:2,degrees:90}]))
  assert.equal(restored.inputSha256,digest(serialized))
  assert.deepEqual((await renderPdfPages(restored.bytes)).pages,before.pages)
})
