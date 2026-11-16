import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { fileFixture, docxBytes, importFile } from '../helpers/files.mjs'
import { createLeaseService } from '../../server/src/modules/leases/service.ts'
import { createCommandRequestFactory } from '../../server/src/modules/commands/http-service.ts'
import { registerCommandRoutes } from '../../server/src/modules/commands/routes.ts'
import { createCsrfService, SESSION_COOKIE } from '../../server/src/modules/auth/csrf.ts'
import { commandHash } from '../../server/src/modules/commands/approval.ts'
const origin = 'https://office.example'
const tool = {
  name: 'replace_text',
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
    editorId = randomUUID()
  const leases = createLeaseService({ transactions: f.transactions }),
    lease = await leases.acquireLease(f.alice.token, initial.fileId, { editorId })
  const envelope = {
    commandId: randomUUID(),
    fileId: initial.fileId,
    baseRevision: initial.revision,
    editorGeneration: 1,
    leaseEpoch: lease.leaseEpoch,
    argsHash: commandHash({ text: 'hello' }),
    payload: { toolName: 'replace_text', arguments: { text: 'hello' } },
  }
  const csrf = createCsrfService({
      db: f.db,
      deploymentId: f.deploymentId,
      origin,
      key: f.csrfKey,
    }),
    app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } })
  t.after(() => app.close())
  registerCommandRoutes(app, {
    sessions: f.sessions,
    csrf,
    createRequestCommands: createCommandRequestFactory(f.transactions, () => tool),
  })
  const post = (action, extra = {}, token = f.alice.token) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/commands/' + action,
      headers: {
        origin,
        cookie: `${SESSION_COOKIE}=${token}`,
        'x-csrf-token': csrf.sessionToken(token),
      },
      payload: { editorId, currentGeneration: 1, envelope, ...extra },
    })
  return { ...f, commandApp: app, csrf, post, envelope, leases, editorId, lease, initial }
}
test('real HTTP proposal cannot execute without approval, cross-owner cannot approve, exact approval claims once', async (t) => {
  const f = await setup(t)
  let r = await f.post('propose')
  assert.equal(r.statusCode, 200, r.body)
  const digest = r.json().digest
  r = await f.post('execute', { digest })
  assert.equal(r.statusCode, 409)
  r = await f.post('approve', { digest }, f.bob.token)
  assert.ok([403, 404].includes(r.statusCode), r.body)
  r = await f.post('approve', { digest })
  assert.equal(r.statusCode, 200, r.body)
  r = await f.post('execute', { digest })
  assert.equal(r.statusCode, 200, r.body)
  assert.equal(r.json().state, 'unknown_outcome')
  assert.equal((await f.post('execute', { digest })).statusCode, 409)
})
test('real HTTP approved command is fenced by changed editor generation and lease epoch', async (t) => {
  const f = await setup(t)
  const p = await f.post('propose'),
    digest = p.json().digest
  assert.equal((await f.post('approve', { digest })).statusCode, 200)
  assert.equal((await f.post('execute', { digest, currentGeneration: 2 })).statusCode, 409)
  await f.leases.takeoverLease(f.alice.token, f.initial.fileId, {
    editorId: randomUUID(),
    expectedEpoch: f.lease.leaseEpoch,
  })
  assert.equal((await f.post('execute', { digest })).statusCode, 409)
  assert.equal((await f.post('outcome')).json().state, 'approved')
})
for (const rejectCommit of [false, true])
  test(`real session BrowserHost ${rejectCommit ? 'rejects old base after definite commit rejection' : 'reconciles lost T06 response with exact tuple'}`, async (t) => {
    const f = await setup(t),
      { createSessionFileHost } =
        await import('../../../../packages/browser-host/src/session-files.ts'),
      { createHttpCommandClient } =
        await import('../../../../packages/browser-host/src/http-commands.ts'),
      { createCommandSaveCoordinator } =
        await import('../../../../packages/browser-host/src/command-save.ts')
    let drop = true,
      commits = [],
      stages = 0,
      generation = 1
    const fetchImpl = async (path, init = {}) => {
      if (rejectCommit && path.endsWith('/commits'))
        return Response.json({ error: 'controlled conflict' }, { status: 409 })
      const app = path.startsWith('/api/v1/commands/') ? f.commandApp : f.app
      const r = await app.inject({
        method: init.method ?? 'GET',
        url: path,
        headers: {
          ...Object.fromEntries(new Headers(init.headers)),
          origin,
          cookie: `${SESSION_COOKIE}=${f.alice.token}`,
        },
        payload: init.body,
      })
      if (path.endsWith('/uploads')) stages++
      if (path.endsWith('/commits')) {
        commits.push(JSON.parse(init.body))
        if (drop) {
          drop = false
          assert.equal(r.statusCode, 200, r.body)
          throw Error('lost commit response')
        }
      }
      return new Response(r.rawPayload, { status: r.statusCode, headers: r.headers })
    }
    const host = createSessionFileHost({ fetchImpl, editorId: f.editorId })
    t.after(() => host.dispose())
    await host.open(f.initial.fileId)
    await host.acquireLease(f.initial.fileId)
    const client = createHttpCommandClient({
      editorId: f.editorId,
      currentGeneration: () => generation,
      getCsrfToken: async () => f.csrf.sessionToken(f.alice.token),
      fetchImpl,
    })
    const p = await client.proposeCommand(f.envelope)
    await client.approveCommand(f.envelope, p.digest)
    const claim = await client.beginExecution(f.envelope, p.digest)
    generation = 2
    await client.reportApplied(f.envelope, claim.claimId, generation)
    const coordinator = createCommandSaveCoordinator({
      host,
      current: () => ({ ...f.envelope, editorGeneration: generation }),
      serialize: docxBytes,
      bind: (b) => client.bindCommandUpload(f.envelope, b),
      verifyCommitted: (e, r, d) => client.verifyCommitted(e, r, d),
    })
    await assert.rejects(coordinator.save(f.envelope, p.digest, generation))
    assert.equal(coordinator.hasPending(), true)
    if (rejectCommit) {
      await assert.rejects(coordinator.reconcile())
      assert.equal(coordinator.hasPending(), true)
      assert.equal((await client.getCommandOutcome(f.envelope)).state, 'applied_uncommitted')
      assert.equal(
        (await f.files.openFile(f.alice.token, f.initial.fileId)).file.revision,
        f.initial.revision,
      )
      return
    }
    const saved = await coordinator.reconcile()
    assert.equal(stages, 1)
    assert.deepEqual(commits[0], commits[1])
    assert.equal(commits[0].sourceCommandId, f.envelope.commandId)
    assert.equal((await client.getCommandOutcome(f.envelope)).state, 'committed')
    assert.equal(
      saved.revision,
      (await f.files.openFile(f.alice.token, f.initial.fileId)).file.revision,
    )
  })
