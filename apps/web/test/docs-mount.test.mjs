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

test('legacy HTTP DOCX editor cannot mount a retired parser route or replace original bytes', async t => {
  const {mountDocsEditor}=await import('../../../packages/browser-host/src/files.ts')
  const base=await start(t),bytes=await sampleDocx(),headers={Authorization:'Bearer personal'}
  const upload=await fetch(base+'/api/files',{method:'POST',headers:{...headers,'X-File-Name':'retired.docx'},body:bytes})
  assert.equal(upload.status,201);const file=await upload.json()
  const host=createHttpEditorHost({fetchImpl:(path,init)=>fetch(base+path,init),getAuthHeaders:()=>headers})
  const dom=new JSDOM('<!DOCTYPE html><div id="editor"></div>'),element=dom.window.document.getElementById('editor')
  await assert.rejects(mountDocsEditor(host,element,file.id),error=>error.code==='UNAVAILABLE')
  assert.equal(element.querySelector('[data-docs-editor="mounted"]'),null)
  assert.equal(element.querySelector('textarea'),null)
  const download=await fetch(base+'/api/files/'+file.id,{headers})
  assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes)
})

test('legacy HTTP editor host refuses direct read and commit instead of falling back locally', async t => {
  const base=await start(t),bytes=await sampleDocx(),headers={Authorization:'Bearer personal'}
  const upload=await fetch(base+'/api/files',{method:'POST',headers:{...headers,'X-File-Name':'table.docx'},body:bytes})
  const file=await upload.json()
  const host=createHttpEditorHost({fetchImpl:(path,init)=>fetch(base+path,init),getAuthHeaders:()=>headers})
  const info=await (await fetch(base+`/api/v1/files/${file.id}`,{headers})).json()
  await assert.rejects(host.readDocx(file.id),error=>error.code==='UNAVAILABLE')
  await assert.rejects(host.commitDocx(file.id,{baseRevision:info.file.revision,leaseEpoch:1,idempotencyKey:'retired-save-01',blocks:[]}),error=>error.code==='UNAVAILABLE')
  const download=await fetch(base+'/api/files/'+file.id,{headers})
  assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes)
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
