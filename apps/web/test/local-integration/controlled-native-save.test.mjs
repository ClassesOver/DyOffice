import { readFile, writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { fileFixture, importFile } from '../helpers/files.mjs'
import { createLeaseService } from '../../server/src/modules/leases/service.ts'
import { createCommandRequestFactory } from '../../server/src/modules/commands/http-service.ts'
import { registerCommandRoutes } from '../../server/src/modules/commands/routes.ts'
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
async function setup(t, bytes) {
  const f = await fileFixture(t),
    initial = (await importFile(f, f.alice.token, Buffer.from(bytes))).file,
    editorId = randomUUID()
  const leases = createLeaseService({ transactions: f.transactions }),
    lease = await leases.acquireLease(f.alice.token, initial.fileId, { editorId })
  const envelope = {
    commandId: randomUUID(),
    fileId: initial.fileId,
    baseRevision: initial.revision,
    editorGeneration: 0,
    leaseEpoch: lease.leaseEpoch,
    argsHash: commandHash({ from: 1, to: 6, expectedText: 'Hello', replacement: 'Welcome' }),
    payload: {
      toolName: 'docs.replace_text.v1',
      arguments: { from: 1, to: 6, expectedText: 'Hello', replacement: 'Welcome' },
    },
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
      payload: { editorId, currentGeneration: 0, envelope, ...extra },
    })
  return { ...f, commandApp: app, csrf, post, envelope, leases, editorId, lease, initial }
}
import { JSDOM } from 'jsdom'
import React from 'react'
import JSZip from 'jszip'
import { createRequire } from 'node:module'
import { importLibreOfficeTemplateDocx } from '../../../../packages/browser-host/src/libreoffice-template-docx.ts'
import { createDocumentMutationFence } from '../../../docs/src/renderer/document-mutation-fence.ts'
import { createToolExecutor } from '../../../../packages/browser-host/src/tool-executor.ts'
import { createSessionFileHost } from '../../../../packages/browser-host/src/session-files.ts'
import { createHttpCommandClient } from '../../../../packages/browser-host/src/http-commands.ts'
import { createCommandSaveCoordinator } from '../../../../packages/browser-host/src/command-save.ts'
const dom = new JSDOM('<html><body></body></html>')
Object.assign(globalThis, {
  window: dom.window,
  DOMParser: dom.window.DOMParser,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  getComputedStyle: dom.window.getComputedStyle,
})
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
// Node/tsx has no static asset loader. Stub assets ONLY during module loading;
// no DocParagraph, ProseMirror, editor adapter, profile or other logic is mocked.
// This is jsdom logic + real PostgreSQL/T06, NOT a GUI/render/visual assertion.
const require = createRequire(import.meta.url),
  assetExtensions = ['.css', '.png', '.svg', '.jpg', '.woff', '.woff2'],
  prior = new Map(assetExtensions.map((ext) => [ext, require.extensions[ext]])),
  priorReact = globalThis.React
let createControlledTextModel
try {
  globalThis.React = React // tsx's current classic JSX transform needs the real React runtime.
  for (const ext of assetExtensions)
    require.extensions[ext] = (module) => {
      module.exports = ''
    }
  ;({ createControlledTextModel } =
    await import('../../../docs/src/renderer/editor/controlled-text-model.ts'))
} finally {
  for (const [ext, loader] of prior) {
    if (loader) require.extensions[ext] = loader
    else delete require.extensions[ext]
  }
  if (priorReact === undefined) delete globalThis.React
  else globalThis.React = priorReact
}
test('actual controlled native model loads with real DocParagraph and restored asset hooks', () => {
  assert.equal(typeof createControlledTextModel, 'function')
  for (const [ext, loader] of prior) assert.equal(require.extensions[ext], loader)
  const fence = createDocumentMutationFence(),
    model = createControlledTextModel({
      paragraphs: ['Hello world', 'Second paragraph'],
      authority: () => ({ fileId: 'file', baseRevision: 'revision', leaseEpoch: 1 }),
      canWrite: () => true,
      mutationFence: fence,
    })
  try {
    assert.deepEqual(model.paragraphs(), ['Hello world', 'Second paragraph'])
    assert.equal(model.current().editorGeneration, 0)
  } finally {
    model.dispose()
  }
})
for (const mode of ['normal', 'lost', 'takeover', 'late-dispose'])
  test('controlled native model real LO to durable T06: ' + mode, async (t) => {
    const input = new Uint8Array(
        await readFile(
          new URL('../../../docs/tests/fixtures/simple-lo-template.docx', import.meta.url),
        ),
      ),
      profile = await importLibreOfficeTemplateDocx(input),
      f = await setup(t, input)
    let model,
      coordinator,
      executor,
      host,
      client,
      drop = mode === 'lost',
      stages = 0,
      commits = 0
    const fetchImpl = async (path, init = {}) => {
      const app = path.startsWith('/api/v1/commands/') ? f.commandApp : f.app
      const r = await app.inject({
        method: init.method ?? 'GET',
        url: path,
        headers: {
          ...Object.fromEntries(new Headers(init.headers)),
          origin,
          cookie: `${SESSION_COOKIE}=${f.alice.token}`,
        },
        payload: init.body instanceof Uint8Array ? Buffer.from(init.body) : init.body,
      })
      if (path.endsWith('/uploads')) stages++
      if (path.endsWith('/commits')) {
        commits++
        if (drop) {
          drop = false
          assert.equal(r.statusCode, 200, r.body)
          throw Error('lost actual T06 response')
        }
        if (mode === 'late-dispose') {
          assert.equal(r.statusCode, 200, r.body)
          coordinator.dispose()
          executor.dispose()
          model.dispose()
          host.dispose()
          client.dispose()
        }
      }
      return new Response(r.rawPayload, { status: r.statusCode, headers: r.headers })
    }
    host = createSessionFileHost({ fetchImpl, editorId: f.editorId })
    t.after(() => host.dispose())
    await host.open(f.initial.fileId)
    await host.acquireLease(f.initial.fileId)
    model = createControlledTextModel({
      paragraphs: profile.paragraphs,
      mutationFence: createDocumentMutationFence(),
      authority: () => {
        const state = host.getState(f.initial.fileId)
        return {
          fileId: f.initial.fileId,
          baseRevision: state.revision.revision,
          leaseEpoch: state.lease?.leaseEpoch ?? 0,
        }
      },
      canWrite: () => !!host.getState(f.initial.fileId).lease,
    })
    t.after(() => model.dispose())
    client = createHttpCommandClient({
      editorId: f.editorId,
      currentGeneration: () => model.current().editorGeneration,
      getCsrfToken: async () => f.csrf.sessionToken(f.alice.token),
      fetchImpl,
    })
    t.after(() => client.dispose())
    executor = createToolExecutor({ journal: client, editor: model.tools })
    t.after(() => executor.dispose())
    const proposal = await client.proposeCommand(f.envelope)
    await assert.rejects(executor.executeAuthorizedTool(f.envelope, proposal.digest))
    assert.deepEqual(model.paragraphs(), profile.paragraphs)
    await client.approveCommand(f.envelope, proposal.digest)
    if (mode === 'takeover') {
      await f.leases.takeoverLease(f.alice.token, f.initial.fileId, {
        editorId: randomUUID(),
        expectedEpoch: f.lease.leaseEpoch,
      })
      await assert.rejects(executor.executeAuthorizedTool(f.envelope, proposal.digest))
      assert.deepEqual(model.paragraphs(), profile.paragraphs)
      assert.equal(stages, 0)
      assert.equal(commits, 0)
      assert.equal(
        (await f.files.openFile(f.alice.token, f.initial.fileId)).file.revision,
        f.initial.revision,
      )
      return
    }
    assert.equal(
      (await executor.executeAuthorizedTool(f.envelope, proposal.digest)).status,
      'applied_uncommitted',
    )
    assert.deepEqual(model.paragraphs(), ['Welcome world', 'Second paragraph'])
    let output
    coordinator = createCommandSaveCoordinator({
      host,
      current: model.current,
      serialize: async () => {
        output = await profile.export(model.paragraphs())
        return output
      },
      bind: (b) => client.bindCommandUpload(f.envelope, b),
      verifyCommitted: (e, r, d) => client.verifyCommitted(e, r, d),
    })
    t.after(() => coordinator.dispose())
    const generation = model.current().editorGeneration
    let saved
    if (mode === 'late-dispose') {
      await assert.rejects(coordinator.save(f.envelope, proposal.digest, generation))
      const response = await f.post('outcome')
      assert.equal(response.statusCode, 200, response.body)
      const row = response.json()
      assert.equal(row.state, 'committed')
      saved = row.revision
      assert.throws(() => model.paragraphs())
      assert.equal(commits, 1)
    } else if (mode === 'lost') {
      await assert.rejects(coordinator.save(f.envelope, proposal.digest, generation))
      assert.equal(host.getState(f.initial.fileId).status, 'unknown')
      saved = await coordinator.reconcile()
      assert.equal(commits, 2)
    } else saved = await coordinator.save(f.envelope, proposal.digest, generation)
    assert.equal(stages, 1)
    assert.notEqual(saved.revision, f.initial.revision)
    const durable = new Uint8Array(
      await f.files.readFile(f.alice.token, saved.fileId, saved.revision),
    )
    assert.deepEqual(durable, output)
    assert.deepEqual((await importLibreOfficeTemplateDocx(durable)).paragraphs, [
      'Welcome world',
      'Second paragraph',
    ])
    const before = await JSZip.loadAsync(input),
      after = await JSZip.loadAsync(durable)
    assert.deepEqual(Object.keys(after.files).sort(), Object.keys(before.files).sort())
    for (const name of Object.keys(before.files))
      if (name !== 'word/document.xml')
        assert.deepEqual(
          await after.file(name).async('uint8array'),
          await before.file(name).async('uint8array'),
        )
    assert.equal(
      (await f.files.openFile(f.alice.token, f.initial.fileId)).file.revision,
      saved.revision,
    )
    if (process.env.T14_LO_PROOF_OUTPUT)
      await writeFile(
        process.env.T14_LO_PROOF_OUTPUT + '/controlled-native-' + mode + '.docx',
        durable,
      )
  })
