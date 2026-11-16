import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { fileFixture, docxBytes, importFile } from '../helpers/files.mjs'
import { createLeaseService } from '../../server/src/modules/leases/service.ts'
import { createCommandRequestFactory } from '../../server/src/modules/commands/http-service.ts'
import { registerCommandRecoveryRoutes } from '../../server/src/modules/commands/recovery-routes.ts'
import { createPostgresCommandRecovery } from '../../server/src/modules/commands/postgres-recovery.ts'
import { createPostgresCommandRecoveryActions } from '../../server/src/modules/commands/postgres-recovery-actions.ts'
import { createCsrfService, SESSION_COOKIE } from '../../server/src/modules/auth/csrf.ts'
import { commandHash } from '../../server/src/modules/commands/approval.ts'
const origin = 'https://office.example'
const tool = {
  name: 'docs.replace_text.v1',
  schemaVersion: 1,
  effect: 'document_write',
  executionMode: 'live_editor',
  requiresActiveEditor: true,
  requiredScopes: ['files:write'],
  maxDurationMs: 1000,
  inputSchema: {},
  outputSchema: {},
}
async function setup(t) {
  const f = await fileFixture(t),
    initial = (await importFile(f, f.alice.token, await docxBytes())).file,
    editorId = randomUUID(),
    lease = await createLeaseService({ transactions: f.transactions }).acquireLease(
      f.alice.token,
      initial.fileId,
      { editorId },
    ),
    envelope = {
      commandId: randomUUID(),
      fileId: initial.fileId,
      baseRevision: initial.revision,
      editorGeneration: 1,
      leaseEpoch: lease.leaseEpoch,
      argsHash: commandHash({ text: 'hello' }),
      payload: { toolName: tool.name, arguments: { text: 'hello' } },
    },
    service = createCommandRequestFactory(
      f.transactions,
      () => tool,
    )({ token: f.alice.token, editorId, editorGeneration: 1 }).service,
    proposal = await service.proposeCommand(envelope)
  const csrf = createCsrfService({
      db: f.db,
      deploymentId: f.deploymentId,
      origin,
      key: f.csrfKey,
    }),
    app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } })
  t.after(() => app.close())
  registerCommandRecoveryRoutes(app, {
    sessions: f.sessions,
    csrf,
    createRequestRecovery: (token) => ({
      lookup: createPostgresCommandRecovery({ transactions: f.transactions, token }).lookup,
      abandon: createPostgresCommandRecoveryActions({
        transactions: f.transactions,
        token,
        lookupTool: () => tool,
      }).abandon,
    }),
  })
  const post = (action, extra = {}, token = f.alice.token, headers = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/command-recovery/' + action,
      headers: {
        origin,
        cookie: `${SESSION_COOKIE}=${token}`,
        'x-csrf-token': csrf.sessionToken(token),
        ...headers,
      },
      payload: { fileId: initial.fileId, commandId: envelope.commandId, ...extra },
    })
  return { ...f, post, proposal, service, envelope, app }
}
test('real recovery HTTP only returns minimal projection; explicit digest abandonment is terminal', async (t) => {
  const f = await setup(t)
  let r = await f.post('lookup')
  assert.equal(r.statusCode, 200, r.body)
  assert.deepEqual(Object.keys(r.json()).sort(), ['commandId', 'digest', 'fileId', 'state'])
  assert.equal(r.headers['cache-control'], 'private, no-store')
  r = await f.post('abandon', { observedDigest: f.proposal.digest })
  assert.equal(r.statusCode, 200, r.body)
  assert.equal(r.json().state, 'abandoned_uncommitted')
  assert.equal((await f.post('lookup')).json().state, 'abandoned_uncommitted')
  await assert.rejects(f.service.approveCommand(f.envelope, f.proposal.digest))
})
test('real recovery HTTP rejects CSRF origin and widened payload before mutation', async (t) => {
  const f = await setup(t)
  for (const headers of [{ origin: 'https://evil.example' }, { 'x-csrf-token': 'wrong' }])
    assert.equal(
      (await f.post('abandon', { observedDigest: f.proposal.digest }, f.alice.token, headers))
        .statusCode,
      403,
    )
  assert.equal(
    (await f.post('abandon', { observedDigest: f.proposal.digest, editorId: randomUUID() }))
      .statusCode,
    400,
  )
  assert.equal((await f.post('abandon', { observedDigest: 'b'.repeat(64) })).statusCode, 409)
  assert.equal((await f.post('lookup')).json().state, 'pending_approval')
})
test('real recovery HTTP denies cross-owner and new same-owner session without leaking record', async (t) => {
  const f = await setup(t),
    other = await f.sessions.login('alice', (await import('../helpers/identity.mjs')).password)
  for (const token of [other.token, f.bob.token])
    for (const action of ['lookup', 'abandon']) {
      const r = await f.post(
        action,
        action === 'abandon' ? { observedDigest: f.proposal.digest } : {},
        token,
      )
      assert.equal(r.statusCode, 404, r.body)
      assert.equal(r.body.includes(f.proposal.digest), false)
    }
})
