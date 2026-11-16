import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { PDFDocument, PDFName } from 'pdf-lib'
import { inspectPdf } from '../server/src/pdf/capabilities.mjs'

async function pdfWithContent(content) {
  const doc = await PDFDocument.create()
  const page = doc.addPage()
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(content)))
  return Buffer.from(await doc.save())
}

// A child process bounds the regression: the old tokenizer blocks the event loop.
for (const content of [')', 'BT (hello) Tj ) ET']) {
  test(`stray closing literal delimiter fails closed: ${content}`, async () => {
    const bytes = await pdfWithContent(content)
    const moduleUrl = new URL('../server/src/pdf/capabilities.mjs', import.meta.url).href
    const script = `import {inspectPdf} from ${JSON.stringify(moduleUrl)}; try { await inspectPdf(Buffer.from(process.argv[1], 'base64')); console.log('accepted') } catch (error) { console.log(error.code) }`
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script, bytes.toString('base64')], { timeout: 5000, encoding: 'utf8' })
    assert.equal(output.trim(), 'UNREADABLE')
  })
}

test('valid nested/escaped literals and comment parentheses stay readable', async () => {
  const report = await inspectPdf(await pdfWithContent('% ) comment\nBT (outer(inner) escaped\\)) Tj ET'))
  assert.equal(report.pages[0].kind, 'text')
})
