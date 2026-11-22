import assert from 'node:assert/strict'
import { test } from 'node:test'
import JSZip from 'jszip'
import { buildBlankDocx, parseDocx } from '../../../../packages/docx-engine/src/index.ts'
import { createCsrfService } from '../../server/src/modules/auth/csrf.ts'
import { fileFixture, importFile } from '../helpers/files.mjs'
import { restrictedOrigin } from '../helpers/restricted.mjs'

const version = '2026-07-28'
const name = 'replace_docx_paragraph_text'
const route = '/api/v1/mcp/docx-paragraph-grants'
const main = 'word/document.xml'

test('approved DOCX replacement preserves native runs and publishes one revision', { timeout: 120_000 }, async t => {
  const f = await fileFixture(t)
  const source = await JSZip.loadAsync(await buildBlankDocx())
  const xml = await source.file(main).async('string')
  const lead = '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Before </w:t></w:r><w:r><w:t>OL</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">D after</w:t></w:r></w:p>'
  const neighbor = '<w:p><w:r><w:t>Before OLD after</w:t></w:r></w:p>'
  source.file(main, xml.replace('<w:body>', '<w:body>' + lead + neighbor))
  const original = await source.generateAsync({ type: 'nodebuffer' })
  const { file: { fileId, revision } } = await importFile(f, f.alice.token, original, 'native.docx')
  const csrf = createCsrfService({ db: f.db, origin: restrictedOrigin, deploymentId: f.deploymentId, key: f.csrfKey })
  const issue = (token, payload) => f.app.inject({ method: 'POST', url: route, payload,
    headers: { origin: restrictedOrigin, cookie: '__Host-dyoffice-session=' + token, 'x-csrf-token': csrf.sessionToken(token) },
  })
  const rpc = async (token, method, params = {}) => (await f.app.inject({
    method: 'POST', url: '/mcp',
    headers: { authorization: 'Bearer ' + token, accept: 'application/json, text/event-stream',
      'mcp-protocol-version': version, 'mcp-method': method, ...(params.name && { 'mcp-name': params.name }) },
    payload: { jsonrpc: '2.0', id: 1, method, params: { ...params,
      _meta: { 'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientCapabilities': {} } } },
  })).json().result
  const write = (token, args) => rpc(token, 'tools/call', { name, arguments: args })
  const args = { fileId, revision, docxIndex: 0, expectedText: 'Before OLD after', replacement: 'Before 新 & <值> 📎 after' }
  const issued = await issue(f.alice.token, args)
  assert.equal(issued.statusCode, 201, issued.body)
  assert.equal((await issue(f.bob.token, args)).statusCode, 404)
  for (const replacement of ['\u0000', '\uD800', 'split\nparagraph']) {
    assert.equal((await issue(f.alice.token, { ...args, replacement })).statusCode, 400)
  }
  const { token } = issued.json()
  assert.deepEqual((await rpc(token, 'tools/list')).tools.map(tool => tool.name), ['read_saved_document', name])
  assert.equal((await write(token, { ...args, docxIndex: 1 })).isError, true)
  assert.equal((await write(token, { ...args, replacement: 'unapproved' })).isError, true)
  const stale = { ...args, expectedText: 'wrong paragraph' }
  const staleGrant = await issue(f.alice.token, stale)
  assert.equal(staleGrant.statusCode, 201)
  assert.equal((await write(staleGrant.json().token, stale)).isError, true)
  assert.equal((await f.files.openFile(f.alice.token, fileId)).file.revision, revision)

  const result = await write(token, args)
  const receipt = result.structuredContent
  assert.ok(receipt, JSON.stringify(result))
  assert.notEqual(receipt.revision, revision)
  assert.deepEqual((await write(token, args)).structuredContent, receipt)
  const saved = await f.files.readFile(f.alice.token, fileId, receipt.revision)
  assert.deepEqual(await f.files.readFile(f.alice.token, fileId, revision), original)
  const output = await JSZip.loadAsync(saved)
  const changedXml = await output.file(main).async('string')
  assert.ok(changedXml.includes(neighbor))
  assert.ok(changedXml.includes('<w:rPr><w:b/></w:rPr>'))
  assert.ok(changedXml.includes('<w:rPr><w:i/></w:rPr><w:t xml:space="preserve"> after</w:t>'))
  const unchangedParts = zip => Object.values(zip.files).filter(file => !file.dir && file.name !== main).map(file => file.name).sort()
  assert.deepEqual(unchangedParts(output), unchangedParts(source))
  for (const path of unchangedParts(source)) {
    assert.deepEqual(await output.file(path).async('nodebuffer'), await source.file(path).async('nodebuffer'), path)
  }
  const reopened = await parseDocx(saved)
  const texts = reopened.blocks.slice(0, 2).map(block => block.runs.map(run => run.text).join(''))
  assert.deepEqual(texts, [args.replacement, args.expectedText])
  const read = await rpc(token, 'tools/call', { name: 'read_saved_document', arguments: { fileId, revision: receipt.revision } })
  assert.match(read.structuredContent.text, /新 & <值>/)

  async function rejectsDocument(zip, filename, edit = {}) {
    const { file } = await importFile(f, f.alice.token, await zip.generateAsync({ type: 'nodebuffer' }), filename)
    const target = { ...args, fileId: file.fileId, revision: file.revision, ...edit }
    const grant = await issue(f.alice.token, target)
    assert.equal(grant.statusCode, 201, grant.body)
    assert.equal((await write(grant.json().token, target)).isError, true, filename)
    assert.equal((await f.files.openFile(f.alice.token, file.fileId)).file.revision, file.revision)
  }
  const hidden = await JSZip.loadAsync(original)
  hidden.file(main, (await hidden.file(main).async('string')).replace('<w:b/>', '<w:b/><w:vanish/>'))
  await rejectsDocument(hidden, 'hidden.docx')
  const relationshipBase = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
  const documentRels = 'word/_rels/document.xml.rels'
  const contentTypes = '[Content_Types].xml'
  for (const [filename, target, protection] of [
    ['protected.docx', 'settings.xml', '<w:documentProtection w:edit="readOnly" w:enforcement="1"/>'],
    ['settings-alias.docx', 'guard.xml', '<alt:documentProtection alt:edit="readOnly" alt:enforcement = "1"/>'],
  ]) {
    const protectedZip = await JSZip.loadAsync(original)
    const settingsPath = 'word/' + target
    protectedZip.file(settingsPath, `<w:settings xmlns:w="${wordNamespace}" xmlns:alt="${wordNamespace}">${protection}</w:settings>`)
    const rel = `<Relationship Id="rIdSettingsGuard" Type="${relationshipBase}/settings" Target="${target}"/>`
    protectedZip.file(documentRels, (await protectedZip.file(documentRels).async('string')).replace('</Relationships>', rel + '</Relationships>'))
    const override = `<Override PartName="/${settingsPath}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>`
    protectedZip.file(contentTypes, (await protectedZip.file(contentTypes).async('string')).replace('</Types>', override + '</Types>'))
    await rejectsDocument(protectedZip, filename)
  }
  const field = await JSZip.loadAsync(original)
  field.file(main, (await field.file(main).async('string')).replace(
    '<w:r><w:t>OL</w:t></w:r>', '<w:fldSimple w:instr="DATE"><w:r><w:t>OL</w:t></w:r></w:fldSimple>',
  ))
  await rejectsDocument(field, 'field.docx')

  const spanning = await JSZip.loadAsync(original)
  const spanningBegin = '<w:p><w:r><w:fldChar w:fldCharType = "begin"/></w:r><w:r><w:instrText>DATE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r></w:p>'
  const spanningEnd = '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
  spanning.file(main, (await spanning.file(main).async('string')).replace(lead, spanningBegin + lead + spanningEnd))
  await rejectsDocument(spanning, 'spanning-field.docx', { docxIndex: 1 })

  const deceptive = await JSZip.loadAsync(original)
  const relationships = '_rels/.rels'
  deceptive.file('word/real.xml', (await deceptive.file(main).async('string')).replaceAll('OLD', 'VISIBLE'))
  deceptive.file(relationships, (await deceptive.file(relationships).async('string')).replace('word/document.xml', 'word/real.xml'))
  const deceptiveBytes = await deceptive.generateAsync({ type: 'nodebuffer' })
  await assert.rejects(() => importFile(f, f.alice.token, deceptiveBytes, 'different-main.docx'), { statusCode: 400 })

  const rebound = await JSZip.loadAsync(original)
  rebound.file(main, (await rebound.file(main).async('string')).replace('<w:body>', '<w:body xmlns:w="urn:unrelated">'))
  await rejectsDocument(rebound, 'rebound-namespace.docx')

  const literal = await JSZip.loadAsync(original)
  literal.file(main, (await literal.file(main).async('string')).replace(lead, '<w:p><w:r><w:t>&amp;#65;</w:t></w:r></w:p>'))
  await rejectsDocument(literal, 'literal-anchor.docx', { expectedText: 'A' })
  const replaceLiteral = { fileId, revision: receipt.revision, docxIndex: 0, expectedText: args.replacement, replacement: 'literal &#65; &lt; and &#x41;' }
  const literalGrant = await issue(f.alice.token, replaceLiteral)
  assert.equal(literalGrant.statusCode, 201, literalGrant.body)
  const literalResponse = await write(literalGrant.json().token, replaceLiteral)
  assert.ok(literalResponse.structuredContent, JSON.stringify(literalResponse))
  const reopenedLiteral = await parseDocx(await f.files.readFile(f.alice.token, fileId, literalResponse.structuredContent.revision))
  assert.equal(reopenedLiteral.blocks[0].runs.map(run => run.text).join(''), replaceLiteral.replacement)
})
