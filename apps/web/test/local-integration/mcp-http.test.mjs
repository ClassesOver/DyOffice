import assert from 'node:assert/strict'
import { test } from 'node:test'
import { backgroundDocumentBytes } from '../helpers/background-documents.mjs'
import { fileFixture, importFile } from '../helpers/files.mjs'
import { restrictedOrigin } from '../helpers/restricted.mjs'
import { createCsrfService } from '../../server/src/modules/auth/csrf.ts'

const version = '2026-07-28'
const accept = 'application/json, text/event-stream'
const management = '/api/v1/mcp/read-grants'
const requestMeta = {
  'io.modelcontextprotocol/protocolVersion': version,
  'io.modelcontextprotocol/clientInfo': { name: 'DyOffice integration', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
}
const readName = 'read_saved_document'
function ownerHeaders(f, session) {
  const csrf = createCsrfService({ db: f.db, deploymentId: f.deploymentId, origin: restrictedOrigin, key: f.csrfKey })
  return { cookie: '__Host-dyoffice-session=' + session, origin: restrictedOrigin, 'x-csrf-token': csrf.sessionToken(session) }
}
function postMcp(f, options) {
  const { token, method, params = {}, headers = {}, url = '/mcp' } = options
  return f.app.inject({
    method: 'POST', url,
    headers: {
      accept, 'mcp-protocol-version': version, 'mcp-method': method,
      ...(token && { authorization: 'Bearer ' + token }),
      ...(params.name && { 'mcp-name': params.name }),
      ...headers,
    },
    payload: { jsonrpc: '2.0', id: 1, method, params: { _meta: requestMeta, ...params } },
  })
}

test('HTTP MCP discovers its read tool and reads exact files in four formats with scoped Bearer tokens', async t => {
  const f = await fileFixture(t)
  for (const format of ['docx', 'xlsx', 'pptx', 'pdf']) {
    const marker = `Native MCP ${format} marker 917`
    const { file: { fileId, revision } } = await importFile(f, f.alice.token, await backgroundDocumentBytes(format, marker), `sample.${format}`)
    const scope = { fileId, revision }
    const sessionHeaders = ownerHeaders(f, f.alice.token)
    const grant = await f.app.inject({ method: 'POST', url: management, headers: sessionHeaders, payload: scope })
    assert.equal(grant.statusCode, 201, grant.body)
    assert.match(grant.headers['cache-control'], /no-store/)
    const { id, token } = grant.json()
    const discover = await postMcp(f, { token, method: 'server/discover' })
    assert.equal(discover.statusCode, 200, discover.body)
    assert.ok(discover.json().result.supportedVersions.includes(version))
    const list = await postMcp(f, { token, method: 'tools/list' })
    assert.deepEqual(list.json().result.tools.map(tool => tool.name), [readName])
    assert.equal(list.json().result.ttlMs, 0)
    assert.equal(list.json().result.cacheScope, 'private')
    const call = await postMcp(f, { token, method: 'tools/call', params: { name: readName, arguments: scope } })
    assert.equal(call.statusCode, 200, call.body)
    const { result } = call.json()
    assert.equal(result.resultType, 'complete')
    assert.deepEqual({ fileId: result.structuredContent.fileId, revision: result.structuredContent.revision, format: result.structuredContent.format }, { ...scope, format })
    assert.ok(result.structuredContent.text.includes(marker))
    assert.equal((await f.app.inject({ method: 'DELETE', url: `${management}/${id}`, headers: sessionHeaders })).statusCode, 204)
    assert.equal((await postMcp(f, { token, method: 'tools/list' })).statusCode, 401)
  }
})

test('HTTP MCP refuses cookies, untrusted Origin, credential URLs and mismatched protocol headers', async t => {
  const f = await fileFixture(t)
  const { file: { fileId, revision } } = await importFile(f, f.alice.token, await backgroundDocumentBytes('docx'))
  const headers = ownerHeaders(f, f.alice.token)
  const { token } = (await f.app.inject({ method: 'POST', url: management, headers, payload: { fileId, revision } })).json()
  assert.ok(token)
  const list = { token, method: 'tools/list' }
  assert.equal((await postMcp(f, { method: 'tools/list', headers })).statusCode, 401)
  assert.equal((await postMcp(f, { ...list, headers: { origin: 'https://untrusted.invalid' } })).statusCode, 403)
  assert.equal((await postMcp(f, { ...list, url: '/mcp?access_token=hidden' })).statusCode, 401)
  assert.equal((await postMcp(f, { ...list, url: '/dev/mcp' })).statusCode, 404)
  const wrongMethod = await postMcp(f, { ...list, headers: { 'mcp-method': 'tools/call' } })
  assert.equal(wrongMethod.statusCode, 400)
  assert.equal(wrongMethod.json().error.code, -32020)
  const wrongVersion = await postMcp(f, { ...list, headers: { 'mcp-protocol-version': '2025-11-25' } })
  assert.equal(wrongVersion.statusCode, 400)
  assert.equal(wrongVersion.json().error.code, -32020)
  const call = { token, method: 'tools/call', params: { name: readName, arguments: { fileId, revision } } }
  const wrongName = await postMcp(f, { ...call, headers: { 'mcp-name': 'save_document' } })
  assert.equal(wrongName.statusCode, 400)
  assert.equal(wrongName.json().error.code, -32020)
  const write = await postMcp(f, { ...call, params: { ...call.params, name: 'save_document' } })
  assert.equal(write.json().result.isError, true)
  assert.equal((await f.app.inject({ method: 'POST', url: management, headers: { origin: restrictedOrigin, authorization: 'Bearer ' + token }, payload: { fileId, revision } })).statusCode, 401)
  assert.equal((await f.app.inject({ method: 'POST', url: management, headers: { origin: restrictedOrigin, cookie: headers.cookie }, payload: { fileId, revision } })).statusCode, 403)
})

test('the MCP SDK client initializes, reads, reconnects and cannot reuse another grant’s session', async t => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const f = await fileFixture(t)
  const root = await f.app.listen({ port: 0, host: '127.0.0.1' })
  const target = new URL('/mcp', root)
  const { file: { fileId, revision } } = await importFile(f, f.alice.token, await backgroundDocumentBytes('docx', 'Legacy client marker 54'))
  const args = { fileId, revision }
  const issue = async (session, scope) => {
    const response = await f.app.inject({ method: 'POST', url: management, headers: ownerHeaders(f, session), payload: scope })
    assert.equal(response.statusCode, 201, response.body)
    return response.json().token
  }
  const token = await issue(f.alice.token, args)
  async function connect(access) {
    const transport = new StreamableHTTPClientTransport(target, { requestInit: { headers: { authorization: 'Bearer ' + access } } })
    const client = new Client({ name: 'dyoffice-sdk-test', version: '1.0.0' })
    t.after(() => client.close())
    await client.connect(transport)
    return { client, transport }
  }
  const first = await connect(token)
  assert.ok(first.transport.sessionId)
  assert.deepEqual((await first.client.listTools()).tools.map(tool => tool.name), [readName])
  const content = await first.client.callTool({ name: readName, arguments: args })
  assert.match(content.structuredContent.text, /Legacy client marker 54/)
  const { file: bob } = await importFile(f, f.bob.token, await backgroundDocumentBytes('docx', 'Separate account'))
  const outsider = await issue(f.bob.token, { fileId: bob.fileId, revision: bob.revision })
  const stolen = await fetch(target, {
    method: 'POST',
    headers: { accept, authorization: 'Bearer ' + outsider, 'content-type': 'application/json', 'mcp-session-id': first.transport.sessionId, 'mcp-protocol-version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'tools/list' }),
  })
  assert.equal(stolen.status, 404)
  await first.transport.terminateSession()
  await first.client.close()
  const second = await connect(token)
  assert.match((await second.client.callTool({ name: readName, arguments: args })).structuredContent.text, /Legacy client marker 54/)
  await second.transport.terminateSession()
  await second.client.close()
})

test('external MCP excludes hidden sheets, rows, cells and slides, and refuses ambiguous Word and PDF text', async t => {
  const { default: JSZip } = await import('jszip')
  const { PDFDocument, setTextRenderingMode } = await import('pdf-lib')
  const f = await fileFixture(t)
  const visible = 'MCP visible content 17'
  const hidden = 'Hidden marker 964'
  const modify = async (format, transform) => {
    const zip = await JSZip.loadAsync(await backgroundDocumentBytes(format, visible))
    await transform(zip)
    return zip.generateAsync({ type: 'nodebuffer' })
  }
  const replaceXml = async (zip, path, edit) => zip.file(path, edit(await zip.file(path).async('string')))
  const sheet = await modify('xlsx', async zip => {
    await replaceXml(zip, 'xl/workbook.xml', xml => xml.replace('</sheets>', '<sheet name="Hidden sheet marker" sheetId="99" state="veryHidden" r:id="hiddenSheet"/></sheets>'))
    await replaceXml(zip, 'xl/_rels/workbook.xml.rels', xml => xml.replace('</Relationships>', '<Relationship Id="hiddenSheet" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/hidden.xml"/></Relationships>'))
    await replaceXml(zip, 'xl/worksheets/sheet1.xml', xml => xml.replace('<sheetData>', '<sheetViews><sheetView workbookViewId="0" showZeros="0"/></sheetViews><cols><col min="3" max="3" hidden="1"/></cols><sheetData>')
      .replace('</row></sheetData>', `<c r="C1" t="inlineStr"><is><t>${hidden} column</t></is></c><c r="D1"><v>0</v></c></row><row r="2" hidden="true"><c r="A2" t="inlineStr"><is><t>${hidden} row</t></is></c></row></sheetData>`))
    zip.file('xl/worksheets/hidden.xml', `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${hidden} sheet</t></is></c></row></sheetData></worksheet>`)
  })
  const deck = await modify('pptx', async zip => {
    await replaceXml(zip, 'ppt/slides/slide1.xml', xml => xml.replace(/<p:sld(?=\s|>)/, '<p:sld show="0"').replace(visible, hidden))
    await replaceXml(zip, 'ppt/slides/slide2.xml', xml => xml.replace(/<a:t>[^<]+<\/a:t>/, `<a:t>${visible}</a:t>`))
  })
  const word = await modify('docx', zip => replaceXml(zip, 'word/document.xml', xml => xml.replace('</w:body>', `<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>${hidden}</w:t></w:r></w:p></w:body>`)))
  const pdf = await PDFDocument.create()
  const page = pdf.addPage()
  page.drawText(visible, { x: 20, y: 720 })
  page.pushOperators(setTextRenderingMode(3))
  page.drawText(hidden, { x: 20, y: 680 })
  const formattedSheet = await modify('xlsx', async zip => {
    await replaceXml(zip, 'xl/styles.xml', xml => xml.replace(/numFmtId="164" formatCode="[^"]+/, 'numFmtId="164" formatCode="0;0;0;'))
    await replaceXml(zip, 'xl/worksheets/sheet1.xml', xml => xml.replace('<c r="A1"', '<c r="A1" s="3"').replace(visible, hidden))
  })
  const sources = [['xlsx', sheet, true], ['xlsx', formattedSheet, false], ['pptx', deck, true], ['docx', word, false], ['pdf', Buffer.from(await pdf.save()), false]]

  for (const [format, bytes, expectVisible] of sources) {
    const { file: { fileId, revision } } = await importFile(f, f.alice.token, bytes, `visibility.${format}`)
    const args = { fileId, revision }
    const grant = await f.app.inject({ method: 'POST', url: management, headers: ownerHeaders(f, f.alice.token), payload: args })
    assert.equal(grant.statusCode, 201, grant.body)
    const call = await postMcp(f, { token: grant.json().token, method: 'tools/call', params: { name: readName, arguments: args } })
    assert.equal(call.statusCode, 200)
    const { result } = call.json()
    assert.ok(!call.body.includes(hidden), `${format} returned content hidden by the file`)
    assert.ok(!call.body.includes('Hidden sheet marker'))
    if (expectVisible) {
      assert.ok(result.structuredContent.text.includes(visible))
      if (format === 'xlsx') assert.doesNotMatch(result.structuredContent.text, /\|\s*0\s*$/m)
    }
    else assert.equal(result.isError, true)
  }
})

test('the legacy MCP SDK cancels a verified object read in flight', { timeout: 20_000 }, async t => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const reading = Promise.withResolvers()
  const cancelled = Promise.withResolvers()
  let block = false
  const f = await fileFixture(t, { wrapObjects: store => ({
    ...store,
    async readVerified(reference, signal) {
      if (!block) return store.readVerified(reference, signal)
      reading.resolve()
      return new Promise((resolve, reject) => {
        const abort = () => {
          cancelled.resolve()
          reject(signal.reason)
        }
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      })
    },
  }) })
  const root = await f.app.listen({ port: 0, host: '127.0.0.1' })
  const { file: { fileId, revision } } = await importFile(f, f.alice.token, await backgroundDocumentBytes('docx'))
  const args = { fileId, revision }
  const issued = await f.app.inject({ method: 'POST', url: management, headers: ownerHeaders(f, f.alice.token), payload: args })
  assert.equal(issued.statusCode, 201)
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', root), {
    requestInit: { headers: { authorization: 'Bearer ' + issued.json().token } },
  })
  const client = new Client({ name: 'dyoffice-sdk-cancel-test', version: '1.0.0' })
  t.after(() => client.close())
  await client.connect(transport)
  block = true
  const controller = new AbortController()
  const call = assert.rejects(client.callTool({ name: readName, arguments: args }, undefined, { signal: controller.signal }))
  await reading.promise
  controller.abort()
  await call
  await Promise.race([
    cancelled.promise,
    import('node:timers/promises').then(({ setTimeout }) => setTimeout(5000, undefined, { ref: false })).then(() => assert.fail('MCP cancellation never reached storage')),
  ])
  block = false
  assert.ok((await client.callTool({ name: readName, arguments: args })).structuredContent.text)
  await transport.terminateSession()
})

test('legacy Streamable HTTP negotiates 2025-06-18 and pins each request to that session version', async t => {
  const f = await fileFixture(t)
  const { file: { fileId, revision } } = await importFile(f, f.alice.token, await backgroundDocumentBytes('docx'))
  const { token } = (await f.app.inject({ method: 'POST', url: management, headers: ownerHeaders(f, f.alice.token), payload: { fileId, revision } })).json()
  assert.ok(token)
  const suppliedVersion = '2025-06-18'
  const headers = { authorization: 'Bearer ' + token, accept }
  const initialized = await f.app.inject({
    method: 'POST', url: '/mcp', headers,
    payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: suppliedVersion, capabilities: {}, clientInfo: { name: 'legacy fixture', version: '1' } } },
  })
  assert.equal(initialized.statusCode, 200, initialized.body)
  const data = reply => JSON.parse(reply.body.split('\n').find(line => line.startsWith('data: ')).slice(6))
  assert.equal(data(initialized).result.protocolVersion, suppliedVersion)
  const session = initialized.headers['mcp-session-id']
  assert.ok(session)
  const send = (method, negotiated, id) => f.app.inject({
    method: 'POST', url: '/mcp', headers: { ...headers, 'mcp-session-id': session, 'mcp-protocol-version': negotiated },
    payload: { jsonrpc: '2.0', ...(id !== undefined && { id }), method },
  })
  assert.equal((await send('notifications/initialized', suppliedVersion)).statusCode, 202)
  assert.equal((await send('tools/list', '2025-11-25', 2)).statusCode, 400)
  const listed = await send('tools/list', suppliedVersion, 3)
  assert.deepEqual(data(listed).result.tools.map(tool => tool.name), ['read_saved_document'])
})
