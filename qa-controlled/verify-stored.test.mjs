import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { verifyStoredBytes } from './verify-stored.mjs'
import { importLibreOfficeTemplateDocx } from '../packages/browser-host/src/libreoffice-template-docx.ts'
test('stored QA evidence verifies initial/changed bytes and rejects wrong metadata', async () => {
  const original = await readFile('apps/docs/tests/fixtures/simple-lo-template.docx')
  const ref = (bytes, revision) => ({
    revision,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  })
  const initial = await verifyStoredBytes(original, original, ref(original, 'r1'), 'r1')
  assert.equal(initial.initial, true)
  const profile = await importLibreOfficeTemplateDocx(new Uint8Array(original)),
    changed = await profile.export(['QA saved text', 'Second paragraph'])
  const saved = await verifyStoredBytes(changed, original, ref(changed, 'r2'), 'r1')
  assert.equal(saved.initial, false)
  assert.deepEqual(saved.paragraphs, ['QA saved text', 'Second paragraph'])
  assert.equal(saved.nonDocumentPartsEqual, true)
  await assert.rejects(verifyStoredBytes(changed, original, ref(original, 'r2'), 'r1'))
})
