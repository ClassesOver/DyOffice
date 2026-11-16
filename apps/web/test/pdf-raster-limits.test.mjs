import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PDFDocument } from 'pdf-lib'
import { renderPdfPages } from '../server/src/pdf/raster.mjs'

async function pages(sizes) {
  const doc = await PDFDocument.create()
  for (const size of sizes) doc.addPage(size)
  return Buffer.from(await doc.save())
}

test('rejects oversized real PDF page before raster allocation', async () => {
  const bytes = await pages([[5000, 4000]])
  await assert.rejects(renderPdfPages(bytes), { code: 'PDF_RENDER_LIMIT' })
})

test('retains ordinary actual PDFium raster and PDF.js text', async () => {
  const result = await renderPdfPages(await pages([[200, 100]]))
  assert.equal(result.pages.length, 1)
  assert.equal(result.pages[0].width, 200)
  assert.equal(result.pages[0].height, 100)
  assert.equal(result.pages[0].ink, 0)
  assert.equal(result.pages[0].text, '')
})

test('rejects over 100 actual pages', async () => {
  await assert.rejects(renderPdfPages(await pages(Array.from({ length: 101 }, () => [1, 1]))), { code: 'PDF_RENDER_LIMIT' })
})

test('rejects total pixels over budget before rendering', async () => {
  await assert.rejects(renderPdfPages(await pages(Array.from({ length: 5 }, () => [4000, 4000]))), { code: 'PDF_RENDER_LIMIT' })
})

test('rejects input above the reader byte limit', async () => {
  await assert.rejects(renderPdfPages(Buffer.alloc(64 * 1024 * 1024 + 1)), { code: 'PDF_RENDER_LIMIT' })
})

test('accepts exactly 100 small pages', async () => {
  assert.equal((await renderPdfPages(await pages(Array.from({ length: 100 }, () => [1, 1])))).pages.length, 100)
})
