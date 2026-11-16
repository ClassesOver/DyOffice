import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { JSDOM } from 'jsdom'
import { createApplication } from '../server/application.mjs'
import { createHttpEditorHost } from '../../../packages/browser-host/src/http-editor.ts'

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

async function sampleDocx() {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${NS}><w:body>
<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Hello</w:t></w:r></w:p>
<w:p><w:r><w:t>Keep me</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>CellKeep</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:sectPr><w:headerReference w:type="default" r:id="rId2"/></w:sectPr>
</w:body></w:document>`
  const header = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>SECRET-HEADER</w:t></w:r></w:p></w:hdr>`
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
</Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`)
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
</Relationships>`)
  zip.file('word/document.xml', document)
  zip.file('word/header1.xml', header)
  return Buffer.from(await zip.generateAsync({ type: 'uint8array' }))
}

async function part(bytes, path) {
  return await (await JSZip.loadAsync(bytes)).file(path).async('string')
}

async function start(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-docs-mount-'))
  const server = await createApplication({ directory, userToken: 'personal', adminToken: 'admin', encryptionKey: 'docs-mount-test' })
  server.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true, force: true }) })
  return `http://127.0.0.1:${server.address().port}`
}

test('mounted docs editor edits a paragraph, keeps the table, saves, and reopens', async (t) => {
  const { mountDocsEditor } = await import('../../../packages/browser-host/src/files.ts')
  const base = await start(t)
  const bytes = await sampleDocx()
  const uploaded = await fetch(base + '/api/files', { method: 'POST', headers: { Authorization: 'Bearer personal', 'X-File-Name': encodeURIComponent('笔记.docx') }, body: bytes })
  assert.equal(uploaded.status, 201)
  const file = await uploaded.json()
  const host = createHttpEditorHost({
    fetchImpl: (path, init) => fetch(base + path, init),
    getAuthHeaders: () => ({ Authorization: 'Bearer personal' }),
  })
  const dom = new JSDOM('<!DOCTYPE html><div id="editor"></div>')
  const element = dom.window.document.getElementById('editor')
  const editor = await mountDocsEditor(host, element, file.id)
  assert.equal(element.querySelector('[data-docs-editor="mounted"]') !== null, true)
  assert.equal(editor.getState().blocks.some((block) => block.text === 'Hello' && block.editable), true)
  assert.equal(element.querySelector('[data-preserved="table"]')?.textContent, 'CellKeep')
  assert.equal(element.querySelector('textarea[data-preserved]') , null)
  const hello = editor.getState().blocks.findIndex((block) => block.text === 'Hello')
  editor.updateText(hello, 'Hello there')
  assert.equal(editor.undo(), true)
  assert.equal(editor.getState().blocks[hello].text, 'Hello')
  editor.updateText(hello, 'Hello there')
  const saved = await editor.save()
  assert.equal(saved.ok, true)
  editor.destroy()
  const again = await mountDocsEditor(host, element, file.id)
  assert.equal(again.getState().blocks.some((block) => block.text === 'Hello there'), true)
  assert.equal(element.querySelector('[data-preserved="table"]')?.textContent, 'CellKeep')
  const current = Buffer.from(await (await fetch(base + '/api/files/' + file.id, { headers: { Authorization: 'Bearer personal' } })).arrayBuffer())
  const xml = await part(current, 'word/document.xml')
  assert.match(xml, /Hello there/)
  assert.match(xml, /CellKeep/)
  assert.match(await part(current, 'word/header1.xml'), /SECRET-HEADER/)
  again.destroy()
})
