// Read-only QA evidence; validates downloaded bytes, not visual fidelity.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import JSZip from 'jszip'
import { JSDOM } from 'jsdom'
import { importLibreOfficeTemplateDocx } from '../packages/browser-host/src/libreoffice-template-docx.ts'
const dom = new JSDOM('')
// This QA server has no native editor/DOM; the profile needs a real XML DOMParser.
globalThis.DOMParser ??= dom.window.DOMParser
export async function verifyStoredBytes(bytes, original, ref, initialRevision) {
  const copy = new Uint8Array(bytes),
    sha256 = createHash('sha256').update(copy).digest('hex')
  assert.equal(sha256, ref.sha256)
  assert.equal(copy.byteLength, Number(ref.size))
  const profile = await importLibreOfficeTemplateDocx(copy)
  const before = await JSZip.loadAsync(original),
    after = await JSZip.loadAsync(copy)
  assert.deepEqual(Object.keys(after.files).sort(), Object.keys(before.files).sort())
  for (const name of Object.keys(before.files))
    if (name !== 'word/document.xml')
      assert.deepEqual(
        await after.file(name).async('uint8array'),
        await before.file(name).async('uint8array'),
      )
  return {
    revision: ref.revision,
    sha256,
    size: copy.byteLength,
    paragraphs: [...profile.paragraphs],
    nonDocumentPartsEqual: true,
    initial: ref.revision === initialRevision,
  }
}
