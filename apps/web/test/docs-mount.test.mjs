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

test('mounted docs editor rewrites a table cell and reopens the saved package', async (t) => {
  const { mountDocsEditor } = await import('../../../packages/browser-host/src/files.ts')
  const base = await start(t)
  const bytes = await sampleDocx()
  const uploaded = await fetch(base + '/api/files', { method: 'POST', headers: { Authorization: 'Bearer personal', 'X-File-Name': encodeURIComponent('表格.docx') }, body: bytes })
  assert.equal(uploaded.status, 201)
  const file = await uploaded.json()
  const host = createHttpEditorHost({
    fetchImpl: (path, init) => fetch(base + path, init),
    getAuthHeaders: () => ({ Authorization: 'Bearer personal' }),
  })
  const dom = new JSDOM('<!DOCTYPE html><div id="editor"></div>')
  const element = dom.window.document.getElementById('editor')
  const editor = await mountDocsEditor(host, element, file.id)
  const table = editor.getState().blocks.findIndex((block) => block.type === 'table')
  assert.deepEqual(editor.getState().blocks[table].cells, [['CellKeep']])
  const field = element.querySelector('textarea[data-row="0"][data-column="0"]')
  assert.equal(field.value, 'CellKeep')
  field.value = 'CellEdited'
  field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  assert.equal(editor.undo(), true)
  assert.deepEqual(editor.getState().blocks[table].cells, [['CellKeep']])
  editor.updateCell(table, 0, 0, 'CellEdited')
  const saved = await editor.save()
  assert.equal(saved.ok, true)
  editor.destroy()
  const again = await mountDocsEditor(host, element, file.id)
  assert.deepEqual(again.getState().blocks.find((block) => block.type === 'table').cells, [['CellEdited']])
  const current = Buffer.from(await (await fetch(base + '/api/files/' + file.id, { headers: { Authorization: 'Bearer personal' } })).arrayBuffer())
  const xml = await part(current, 'word/document.xml')
  assert.match(xml, /<w:tbl[\s>]/)
  assert.match(xml, /CellEdited/)
  assert.match(xml, /Keep me/)
  assert.equal(xml.includes('CellKeep'), false)
  const reopened = await import('../../../packages/docx-engine/src/index.ts').then((engine) => engine.parseDocx(current))
  assert.equal(reopened.blocks.find((block) => block.type === 'table').table.rows[0][0].paras[0], 'CellEdited')
  again.destroy()
})

test('edits typed during a save stay dirty after the server projection returns', async () => {
  const { mountDocsEditor } = await import('../../../packages/browser-host/src/files.ts')
  let release
  const pending = new Promise((resolve) => { release = resolve })
  let reads = 0
  const host = {
    acquireLease: async () => ({ leaseEpoch: 2 }),
    readDocx: async () => ({
      file: { fileId: 'file-1', revision: reads ? 'rev_b' : 'rev_a', sha256: 'ab'.repeat(32), size: 4 },
      leaseEpoch: 2,
      blocks: [{ docxIndex: 0, type: 'paragraph', text: reads++ ? 'Hello there' : 'Hello', editable: true }],
    }),
    commitDocx: async () => pending,
  }
  const dom = new JSDOM('<!DOCTYPE html><div id="editor"></div>')
  const editor = await mountDocsEditor(host, dom.window.document.getElementById('editor'), 'file-1')
  editor.updateText(0, 'Hello there')
  const saving = editor.save()
  editor.updateText(0, 'Hello there!')
  release({ fileId: 'file-1', revision: 'rev_b', sha256: 'cd'.repeat(32), size: 8 })
  const saved = await saving
  assert.equal(saved.ok, true)
  assert.equal(editor.getState().blocks[0].text, 'Hello there!')
  assert.equal(editor.getState().dirty, true)
  editor.destroy()
})

test('an expired lease is reacquired before save and renewal stops on destroy', async () => {
  const { mountDocsEditor } = await import('../../../packages/browser-host/src/files.ts')
  let renews = 0
  let acquires = 0
  let committedEpoch = 0
  const host = {
    acquireLease: async () => ({ leaseEpoch: ++acquires === 1 ? 2 : 3 }),
    renewLease: async (_id, epoch) => {
      renews += 1
      if (epoch === 2) throw Object.assign(new Error('expired'), { code: 'CONFLICT' })
      return { leaseEpoch: epoch }
    },
    readDocx: async () => ({
      file: { fileId: 'file-1', revision: 'rev_a', sha256: 'ab'.repeat(32), size: 4 },
      leaseEpoch: 2,
      blocks: [{ docxIndex: 0, type: 'paragraph', text: 'Hello', editable: true }],
    }),
    commitDocx: async (_id, input) => {
      committedEpoch = input.leaseEpoch
      return { fileId: 'file-1', revision: 'rev_b', sha256: 'cd'.repeat(32), size: 8 }
    },
  }
  const dom = new JSDOM('<!DOCTYPE html><div id="editor"></div>')
  const editor = await mountDocsEditor(host, dom.window.document.getElementById('editor'), 'file-1', { renewEveryMs: 20 })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(renews >= 1)
  editor.updateText(0, 'Hello there')
  const saved = await editor.save()
  assert.equal(saved.ok, true)
  assert.equal(committedEpoch, 3)
  editor.destroy()
  const stopped = renews
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(renews, stopped)
})
