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
  assert.deepEqual(projected.find(block => block.type === 'table').cells, [['CellKeep']])
  assert.equal(projected.find(block => block.type === 'table').editable, true)
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

test('legacy DOCX parser routes fail closed after authentication and leave original bytes unchanged', async t => {
  const base=await start(t),{bytes}=await sampleDocx(),headers={Authorization:'Bearer personal'}
  const upload=await fetch(base+'/api/files',{method:'POST',headers:{...headers,'X-File-Name':'retired.docx'},body:bytes})
  assert.equal(upload.status,201);const file=await upload.json()
  assert.equal((await (await fetch(base+'/api/v1/capabilities',{headers})).json()).docx,'unsupported')
  const info=await (await fetch(base+`/api/v1/files/${file.id}`,{headers})).json()
  assert.equal(info.capabilities.docx,'unsupported')
  for(const [method,action,body] of [['GET','docx',undefined],['POST','docx','{}'],['POST','uploads',Buffer.from('PK malicious')]]) {
    const url=base+`/api/v1/files/${file.id}/${action}`
    assert.equal((await fetch(url,{method,body})).status,401)
    assert.equal((await fetch(url,{method,headers:{Authorization:'Bearer admin'},body})).status,403)
    const denied=await fetch(url,{method,headers,body});assert.equal(denied.status,501)
    assert.equal((await denied.json()).code,'DOCUMENT_ISOLATION_UNAVAILABLE')
  }
  for(const [method,action] of [['DELETE','docx'],['GET','uploads'],['PUT','uploads']])assert.equal((await fetch(base+`/api/v1/files/${file.id}/${action}`,{method,headers})).status,405)
  const current=await fetch(base+'/api/files/'+file.id,{headers});assert.equal(current.status,200);assert.deepEqual(Buffer.from(await current.arrayBuffer()),bytes)
  const original=await fetch(base+info.downloadEndpoint+'?revision='+encodeURIComponent(info.file.revision),{headers});assert.equal(original.status,200);assert.deepEqual(Buffer.from(await original.arrayBuffer()),bytes)
})

test('retiring DOCX parser routes preserves independent lease and restore routes', async t => {
  const base=await start(t),{bytes}=await sampleDocx(),headers={Authorization:'Bearer personal','Content-Type':'application/json'}
  const uploaded=await fetch(base+'/api/files',{method:'POST',headers:{Authorization:'Bearer personal','X-File-Name':'leases.docx'},body:bytes});const file=await uploaded.json()
  const opened=await (await fetch(base+`/api/v1/files/${file.id}`,{headers})).json()
  const acquire=await fetch(base+`/api/v1/files/${file.id}/leases/acquire`,{method:'POST',headers,body:'{}'});assert.equal(acquire.status,200);const first=await acquire.json()
  await new Promise(resolve=>setTimeout(resolve,20))
  const renew=await fetch(base+`/api/v1/files/${file.id}/leases/renew`,{method:'POST',headers,body:JSON.stringify({leaseEpoch:first.leaseEpoch})});assert.equal(renew.status,200);assert.ok((await renew.json()).expiresAt>first.expiresAt)
  const takeover=await fetch(base+`/api/v1/files/${file.id}/leases/takeover`,{method:'POST',headers,body:'{}'});assert.equal(takeover.status,200);const second=await takeover.json();assert.equal(second.leaseEpoch,first.leaseEpoch+1)
  const input={sourceRevision:opened.file.revision,baseRevision:opened.file.revision,leaseEpoch:second.leaseEpoch,idempotencyKey:'retired-restore-1'}
  const restore=()=>fetch(base+`/api/v1/files/${file.id}/restore`,{method:'POST',headers,body:JSON.stringify(input)})
  const saved=await restore();assert.equal(saved.status,200);const ref=await saved.json();assert.notEqual(ref.revision,opened.file.revision)
  const replay=await restore();assert.equal(replay.status,200);assert.equal((await replay.json()).revision,ref.revision)
  const original=await fetch(base+`/api/v1/files/${file.id}/content?revision=`+encodeURIComponent(opened.file.revision),{headers});assert.equal(original.status,200);assert.deepEqual(Buffer.from(await original.arrayBuffer()),bytes)
  const badCommit=await fetch(base+`/api/v1/files/${file.id}/commits`,{method:'POST',headers,body:JSON.stringify({ownerId:'other'})});assert.equal(badCommit.status,400)
})

test('retired parser path matching does not capture unrelated uploads or malformed IDs', async t => {
  const base=await start(t),headers={Authorization:'Bearer personal'},id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  for(const path of [`/api/v1/files/${id}/uploads/child`,`/api/v1/files/${id}/docx/child`,'/api/v1/files/not-a-uuid/docx'])assert.equal((await fetch(base+path,{headers})).status,404)
  const staged=await fetch(base+'/api/v1/objects',{method:'POST',headers:{...headers,'X-File-Name':'original.pdf'},body:Buffer.from('%PDF-1.7 opaque')});assert.equal(staged.status,201);assert.ok((await staged.json()).uploadId)
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

test('a plain table cell is rewritten in place and the package reopens with the new text', async () => {
  const { bytes, styles, header } = await sampleDocx()
  const projected = await projectDocx(bytes)
  const table = projected.find(block => block.type === 'table')
  assert.deepEqual(table.cells, [['CellKeep']])
  const edited = await applyDocxTextEdits(bytes, projected.map(block => (
    block.type === 'table' ? { docxIndex: block.docxIndex, cells: [['CellEdited']] } : { docxIndex: block.docxIndex }
  )))
  const again = await projectDocx(edited)
  assert.deepEqual(again.find(block => block.type === 'table').cells, [['CellEdited']])
  assert.equal(again.some(block => block.text === 'Keep me'), true)
  const saved = Buffer.from(edited)
  assert.equal(await part(saved, 'word/styles.xml'), styles)
  assert.equal(await part(saved, 'word/header1.xml'), header)
  const xml = await part(saved, 'word/document.xml')
  assert.match(xml, /<w:tbl[\s>]/)
  assert.match(xml, /<w:tc[\s>]/)
  assert.match(xml, /CellEdited/)
  assert.equal(xml.includes('CellKeep'), false)
  assert.match(xml, /Keep me/)
  await assert.rejects(applyDocxTextEdits(bytes, projected.map(block => (
    block.type === 'table' ? { docxIndex: block.docxIndex, text: 'flattened' } : { docxIndex: block.docxIndex }
  ))), error => error.publicCode === 'INVALID_DOCUMENT')
})
