import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { backgroundDocumentBytes } from '../helpers/background-documents.mjs'
import { fileFixture, importFile } from '../helpers/files.mjs'

const bearer = token => ({ kind: 'external-token', token })
const signal = new AbortController().signal

test('MCP read grants are durable and limited to one owner, file and revision', async t => {
  const f = await fileFixture(t, { buildApp: false })
  const { createMcpReadGrants } = await import('../../server/src/modules/mcp-server/read-grants.ts')
  const { createOfficeReadTool } = await import('../../server/src/modules/mcp-server/office-read.ts')
  const createGrants = () => createMcpReadGrants(f.transactions)
  const grants = createGrants()
  const read = createOfficeReadTool(f.files)
  const bytes = await backgroundDocumentBytes('docx', 'MCP private budget 73')
  const { file: { fileId, revision } } = await importFile(f, f.alice.token, bytes)
  const { file: bobFile } = await importFile(f, f.bob.token, bytes)
  const { file: another } = await importFile(f, f.alice.token, bytes, 'another.docx')
  const input = { fileId, revision }

  await assert.rejects(() => grants.issue(f.bob.token, input), { statusCode: 404 })
  await assert.rejects(() => grants.issue(f.alice.token, { fileId, revision: another.revision }), { statusCode: 404 })
  const grant = await grants.issue(f.alice.token, input)
  assert.match(grant.token, /^[A-Za-z0-9_-]{43}$/)
  assert.match((await read(bearer(grant.token), input, signal)).text, /MCP private budget 73/)
  await assert.rejects(() => read(bearer(f.alice.token), input, signal), { statusCode: 401 })
  await assert.rejects(() => read(bearer(grant.token), bobFile, signal), { statusCode: 400 })
  await assert.rejects(() => read(bearer(grant.token), { fileId: bobFile.fileId, revision: bobFile.revision }, signal), { statusCode: 404 })
  await assert.rejects(() => read(bearer(grant.token), { fileId: another.fileId, revision: another.revision }, signal), { statusCode: 404 })
  await assert.rejects(() => read(bearer(grant.token), { fileId, revision: randomUUID() }, signal), { statusCode: 404 })
  await assert.rejects(() => f.files.trashFile(bearer(grant.token), fileId), { statusCode: 401 })
  await assert.rejects(() => createGrants().revoke(f.bob.token, grant.id), { statusCode: 404 })
  assert.match((await read(bearer(grant.token), input, signal)).text, /MCP private budget 73/)
  await createGrants().revoke(f.alice.token, grant.id)
  await assert.rejects(() => read(bearer(grant.token), input, signal), { statusCode: 401 })
})

test('MCP read grants expire and lose authority when the signing-in session ends', async t => {
  const f = await fileFixture(t, { buildApp: false })
  const { createMcpReadGrants } = await import('../../server/src/modules/mcp-server/read-grants.ts')
  const { createOfficeReadTool } = await import('../../server/src/modules/mcp-server/office-read.ts')
  const { createPrincipalTransactions } = await import('../../server/src/db/context.ts')
  const grants = createMcpReadGrants(f.transactions)
  const read = createOfficeReadTool(f.files)
  const token = f.alice.token
  const { file: { fileId, revision } } = await importFile(f, token, await backgroundDocumentBytes('docx'))
  const input = { fileId, revision }
  const expired = await grants.issue(token, input)
  const active = await grants.issue(token, input)
  assert.notEqual(active.token, expired.token)

  for (const pool of [f.authPool, f.businessPool]) {
    await assert.rejects(() => pool.query('SELECT * FROM mcp_read_grants'), { code: '42501' })
  }
  const stored = await f.ownerPool.query('SELECT token_hash FROM mcp_read_grants WHERE id=$1', [active.id])
  assert.match(stored.rows[0].token_hash, /^[a-f0-9]{64}$/)
  assert.notEqual(stored.rows[0].token_hash, active.token)
  await f.ownerPool.query("UPDATE mcp_read_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expired.id])
  await assert.rejects(() => read(bearer(expired.token), input, signal), { statusCode: 401 })

  const otherDeployment = createPrincipalTransactions({ pool: f.businessPool, deploymentId: randomUUID() })
  await assert.rejects(() => createMcpReadGrants(otherDeployment).inspect(bearer(active.token)), { statusCode: 401 })
  await f.sessions.logout(token)
  await assert.rejects(() => read(bearer(active.token), input, signal), { statusCode: 401 })
})
