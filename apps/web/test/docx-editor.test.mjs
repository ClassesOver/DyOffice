import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { createApplication } from '../server/application.mjs'
import { applyDocxTextEdits, projectDocx } from '../server/docx-session.mjs'

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

async function sampleDocx() {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${NS}><w:body>
<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Hello</w:t></w:r></w:p>
<w:p><w:r><w:t>Keep me</w:t></w:r></w:p>
<w:p><w:r><w:tab/></w:r><w:r><w:t>Tabbed</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>CellKeep</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:sectPr><w:headerReference w:type="default" r:id="rId2"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>
</w:body></w:document>`
  const header = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>SECRET-HEADER</w:t></w:r></w:p></w:hdr>`
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
</Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`)
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
</Relationships>`)
  zip.file('word/document.xml', document)
  zip.file('word/styles.xml', styles)
  zip.file('word/header1.xml', header)
  return { bytes: Buffer.from(await zip.generateAsync({ type: 'uint8array' })), styles, header }
}

async function part(bytes, path) {
  return await (await JSZip.loadAsync(bytes)).file(path).async('string')
}

test('docx-engine text edit keeps bold, untouched paragraphs, tables, styles and headers', async () => {
  const { bytes, styles, header } = await sampleDocx()
  const projected = await projectDocx(bytes)
  assert.equal(projected.find(block => block.text === 'Hello').editable, true)
  assert.equal(projected.find(block => block.text.includes('Tabbed')).editable, false)
  assert.equal(projected.find(block => block.type === 'table').editable, false)
  const edited = await applyDocxTextEdits(bytes, projected.map(block => (
    block.text === 'Hello' ? { docxIndex: block.docxIndex, text: 'Hello there' } : { docxIndex: block.docxIndex }
  )))
  const again = await projectDocx(edited)
  assert.equal(again.find(block => block.docxIndex === projected[0].docxIndex).text, 'Hello there')
  assert.equal(again.some(block => block.text === 'Keep me'), true)
  assert.equal(again.some(block => block.text === 'CellKeep'), true)
  const saved = Buffer.from(edited)
  assert.equal(await part(saved, 'word/styles.xml'), styles)
  assert.equal(await part(saved, 'word/header1.xml'), header)
  const xml = await part(saved, 'word/document.xml')
  assert.equal(xml.includes('Hello there'), true)
  assert.equal(xml.includes('<w:b'), true)
  assert.equal(xml.includes('CellKeep'), true)
  assert.equal(xml.includes('Keep me'), true)
  await assert.rejects(applyDocxTextEdits(bytes, projected.map(block => (
    block.text.includes('Tabbed') ? { docxIndex: block.docxIndex, text: 'Changed' } : { docxIndex: block.docxIndex }
  ))), error => error.publicCode === 'INVALID_DOCUMENT')
})

async function start(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-docx-'))
  const server = await createApplication({ directory, userToken: 'personal', adminToken: 'admin', encryptionKey: 'docx-editor-test' })
  server.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }) })
  return `http://127.0.0.1:${server.address().port}`
}

test('HTTP docx editing commits one revision and preserves history, leases and idempotency', async t => {
  const base = await start(t)
  const { bytes, styles, header } = await sampleDocx()
  const headers = { Authorization: 'Bearer personal' }
  const uploaded = await fetch(base + '/api/files', { method: 'POST', headers: { ...headers, 'X-File-Name': encodeURIComponent('笔记.docx') }, body: bytes })
  assert.equal(uploaded.status, 201)
  const file = await uploaded.json()
  assert.equal((await fetch(base + '/api/v1/capabilities', { headers })).status, 200)
  assert.equal((await (await fetch(base + '/api/v1/capabilities', { headers })).json()).docx, 'editable')
  assert.equal((await fetch(base + `/api/v1/files/${file.id}/docx`, { headers: { Authorization: 'Bearer admin' } })).status, 403)
  const opened = await (await fetch(base + `/api/v1/files/${file.id}/docx`, { headers })).json()
  assert.equal(opened.blocks.find(block => block.text === 'Hello').editable, true)
  const lease = await (await fetch(base + `/api/v1/files/${file.id}/lease`, { method: 'POST', headers })).json()
  assert.equal(lease.leaseEpoch, 2)
  const payload = JSON.stringify({
    baseRevision: opened.file.revision,
    leaseEpoch: lease.leaseEpoch,
    idempotencyKey: 'docx-save-001',
    blocks: opened.blocks.map(block => block.text === 'Hello' ? { docxIndex: block.docxIndex, text: 'Hello there' } : { docxIndex: block.docxIndex }),
  })
  const save = async body => fetch(base + `/api/v1/files/${file.id}/docx`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body })
  const saved = await save(payload)
  assert.equal(saved.status, 200)
  const revision = await saved.json()
  assert.notEqual(revision.revision, opened.file.revision)
  const replay = await save(payload)
  assert.equal(replay.status, 200)
  assert.equal((await replay.json()).revision, revision.revision)
  const conflict = await save(payload.replace('Hello there', 'Hello twice'))
  assert.equal(conflict.status, 409)
  assert.equal((await conflict.json()).code, 'IDEMPOTENCY_CONFLICT')
  const stale = await save(JSON.stringify({ baseRevision: opened.file.revision, leaseEpoch: 2, idempotencyKey: 'docx-save-002', blocks: opened.blocks.map(block => ({ docxIndex: block.docxIndex })) }))
  assert.equal(stale.status, 409)
  assert.equal((await stale.json()).code, 'REVISION_CONFLICT')
  const oldLease = await fetch(base + `/api/v1/files/${file.id}/docx`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ baseRevision: revision.revision, leaseEpoch: 1, idempotencyKey: 'docx-save-003', blocks: opened.blocks.map(block => ({ docxIndex: block.docxIndex, ...(block.text === 'Hello' ? { text: 'Hello there' } : {}) })) }) })
  assert.equal(oldLease.status, 409)
  assert.equal((await oldLease.json()).code, 'LEASE_CONFLICT')
  const current = Buffer.from(await (await fetch(base + '/api/files/' + file.id, { headers })).arrayBuffer())
  assert.equal(await part(current, 'word/styles.xml'), styles)
  assert.equal(await part(current, 'word/header1.xml'), header)
  assert.equal((await part(current, 'word/document.xml')).includes('Hello there'), true)
  const archived = await fetch(base + `/api/v1/files/${file.id}/content?revision=${encodeURIComponent(opened.file.revision)}`, { headers })
  assert.equal(archived.status, 200)
  assert.equal(Buffer.from(await archived.arrayBuffer()).compare(bytes), 0)
  const pdf = await fetch(base + '/api/files', { method: 'POST', headers: { ...headers, 'X-File-Name': 'note.pdf' }, body: '%PDF-1.7 sample' })
  const pdfId = (await pdf.json()).id
  assert.equal((await fetch(base + `/api/v1/files/${pdfId}/docx`, { headers })).status, 400)
})

test('HTTP lease renewal, takeover, and restore publish one new current revision', async (t) => {
  const base = await start(t)
  const { bytes } = await sampleDocx()
  const headers = { Authorization: 'Bearer personal', 'Content-Type': 'application/json' }
  const uploaded = await fetch(base + '/api/files', { method: 'POST', headers: { Authorization: 'Bearer personal', 'X-File-Name': encodeURIComponent('笔记.docx') }, body: bytes })
  const file = await uploaded.json()
  assert.equal((await fetch(base + `/api/v1/files/${file.id}/leases/acquire`, { method: 'POST', headers: { Authorization: 'Bearer admin' }, body: '{}' })).status, 403)
  const opened = await (await fetch(base + `/api/v1/files/${file.id}/docx`, { headers })).json()
  const acquired = await (await fetch(base + `/api/v1/files/${file.id}/leases/acquire`, { method: 'POST', headers, body: '{}' })).json()
  assert.equal(acquired.leaseEpoch, 1)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const renewed = await (await fetch(base + `/api/v1/files/${file.id}/leases/renew`, { method: 'POST', headers, body: JSON.stringify({ leaseEpoch: acquired.leaseEpoch }) })).json()
  assert.equal(renewed.leaseEpoch, 1)
  assert.ok(renewed.expiresAt > acquired.expiresAt)
  const save = await fetch(base + `/api/v1/files/${file.id}/docx`, { method: 'POST', headers, body: JSON.stringify({
    baseRevision: opened.file.revision,
    leaseEpoch: renewed.leaseEpoch,
    idempotencyKey: 'docx-lease-001',
    blocks: opened.blocks.map((block) => block.text === 'Hello' ? { docxIndex: block.docxIndex, text: 'Hello there' } : { docxIndex: block.docxIndex }),
  }) })
  assert.equal(save.status, 200)
  const revision = await save.json()
  const taken = await (await fetch(base + `/api/v1/files/${file.id}/leases/takeover`, { method: 'POST', headers, body: '{}' })).json()
  assert.equal(taken.leaseEpoch, 2)
  const stale = await fetch(base + `/api/v1/files/${file.id}/docx`, { method: 'POST', headers, body: JSON.stringify({
    baseRevision: revision.revision,
    leaseEpoch: 1,
    idempotencyKey: 'docx-lease-002',
    blocks: opened.blocks.map((block) => ({ docxIndex: block.docxIndex })),
  }) })
  assert.equal(stale.status, 409)
  assert.equal((await stale.json()).code, 'LEASE_CONFLICT')
  const restored = await fetch(base + `/api/v1/files/${file.id}/restore`, { method: 'POST', headers, body: JSON.stringify({
    sourceRevision: opened.file.revision,
    baseRevision: revision.revision,
    leaseEpoch: taken.leaseEpoch,
    idempotencyKey: 'docx-restore-1',
  }) })
  assert.equal(restored.status, 200)
  const restoredRef = await restored.json()
  assert.notEqual(restoredRef.revision, opened.file.revision)
  assert.equal(restoredRef.sha256, opened.file.sha256)
  const replay = await fetch(base + `/api/v1/files/${file.id}/restore`, { method: 'POST', headers, body: JSON.stringify({
    sourceRevision: opened.file.revision,
    baseRevision: revision.revision,
    leaseEpoch: 1,
    idempotencyKey: 'docx-restore-1',
  }) })
  assert.equal(replay.status, 200)
  assert.equal((await replay.json()).revision, restoredRef.revision)
  const current = Buffer.from(await (await fetch(base + '/api/files/' + file.id, { headers })).arrayBuffer())
  assert.equal(current.compare(bytes), 0)
  const rejected = await fetch(base + `/api/v1/files/${file.id}/commits`, { method: 'POST', headers, body: JSON.stringify({ ownerId: 'someone-else', fileId: file.id, uploadId: file.id, baseRevision: restoredRef.revision, idempotencyKey: 'docx-commit-01', leaseEpoch: taken.leaseEpoch }) })
  assert.equal(rejected.status, 400)
})

test('a lost structural DOCX save retries from its base and a later edit stays current', async (t) => {
  const base = await start(t)
  const { bytes } = await sampleDocx()
  const headers = { Authorization: 'Bearer personal', 'Content-Type': 'application/json' }
  const uploaded = await fetch(base + '/api/files', { method: 'POST', headers: { Authorization: 'Bearer personal', 'X-File-Name': encodeURIComponent('笔记.docx') }, body: bytes })
  const file = await uploaded.json()
  const opened = await (await fetch(base + `/api/v1/files/${file.id}/docx`, { headers })).json()
  const lease = await (await fetch(base + `/api/v1/files/${file.id}/lease`, { method: 'POST', headers })).json()
  const inserted = {
    baseRevision: opened.file.revision,
    leaseEpoch: lease.leaseEpoch,
    idempotencyKey: 'docx-insert-01',
    blocks: [...opened.blocks.map((block) => ({ docxIndex: block.docxIndex })), { text: 'Added line' }],
  }
  const save = (body) => fetch(base + `/api/v1/files/${file.id}/docx`, { method: 'POST', headers, body: JSON.stringify(body) })
  const first = await save(inserted)
  assert.equal(first.status, 200)
  const revision = await first.json()
  const retry = await save(inserted)
  assert.equal(retry.status, 200)
  assert.equal((await retry.json()).revision, revision.revision)
  const reread = await (await fetch(base + `/api/v1/files/${file.id}/docx`, { headers })).json()
  assert.equal(reread.blocks.some((block) => block.text === 'Added line'), true)
  const later = await save({
    baseRevision: reread.file.revision,
    leaseEpoch: lease.leaseEpoch,
    idempotencyKey: 'docx-insert-02',
    blocks: reread.blocks.map((block) => block.text === 'Added line' ? { docxIndex: block.docxIndex, text: 'Added line kept' } : { docxIndex: block.docxIndex }),
  })
  assert.equal(later.status, 200)
  const staleRetry = await save(inserted)
  assert.equal(staleRetry.status, 200)
  assert.equal((await staleRetry.json()).revision, revision.revision)
  const current = await part(Buffer.from(await (await fetch(base + '/api/files/' + file.id, { headers })).arrayBuffer()), 'word/document.xml')
  assert.match(current, /Added line kept/)
})

test('edited and inserted text never writes characters that are illegal in XML 1.0', async () => {
  const { bytes } = await sampleDocx()
  const projected = await projectDocx(bytes)
  const edited = await applyDocxTextEdits(bytes, [
    ...projected.map(block => (block.text === 'Hello' ? { docxIndex: block.docxIndex, text: 'A￾B￿C\uD800D\u0001E 😀' } : { docxIndex: block.docxIndex })),
    { text: 'new\uDC00para' },
  ])
  const xml = await part(edited, 'word/document.xml')
  // XML 1.0 Char: #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]
  const illegal = [...xml].filter(c => { const n = c.codePointAt(0); return (n < 0x20 && n !== 9 && n !== 10 && n !== 13) || (n >= 0xD800 && n <= 0xDFFF) || n === 0xFFFE || n === 0xFFFF })
  assert.deepEqual(illegal, [])
  assert.match(xml, /ABCDE 😀/)
  assert.match(xml, /newpara/)
})
