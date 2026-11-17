import { readFile, writeFile } from 'node:fs/promises'
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
import { Editor, Node as TiptapNode } from '@tiptap/core'
import { Document } from '@tiptap/extension-document'
import { Text } from '@tiptap/extension-text'
import { buildDocx } from '../../../../packages/docx-engine/tests/helpers/build-docx.ts'
import { importLibreOfficeTemplateDocx as importSimpleDocx } from '../../../../packages/browser-host/src/libreoffice-template-docx.ts'
import { createApprovedTextCommandAdapter } from '../../../docs/src/renderer/editor/approved-text-command.ts'
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
const Paragraph = TiptapNode.create({
  name: 'docParagraph',
  group: 'block',
  content: 'text*',
  parseHTML: () => [{ tag: 'p' }],
  renderHTML: () => ['p', 0],
})
for (const mode of ['normal', 'lost', 'user-edit', 'takeover', 'save-edit'])
  test(`restricted real DOCX PM approval to durable T06: ${mode}`, async (t) => {
    const lost = mode === 'lost' || mode === 'metadata-lost'
    const input = await readFile(
      new URL('../../../docs/tests/fixtures/simple-lo-template.docx', import.meta.url),
    )
    const imported = await importSimpleDocx(input),
      f = await setup(t, input)
    const editor = new Editor({
      extensions: [Document, Paragraph, Text],
      content: {
        type: 'doc',
        content: imported.paragraphs.map((text) => ({
          type: 'docParagraph',
          content: text ? [{ type: 'text', text }] : [],
        })),
      },
    })
    const adapter = createApprovedTextCommandAdapter({
      editor,
      authority: () => f.envelope,
      canWrite: () => true,
      mutationFence: createDocumentMutationFence(),
    })
    t.after(() => {
      adapter.dispose()
      editor.destroy()
    })
    let drop = lost,
      stages = 0
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
      if (path.endsWith('/commits') && drop) {
        drop = false
        assert.equal(r.statusCode, 200, r.body)
        throw Error('lost T06 response')
      }
      return new Response(r.rawPayload, { status: r.statusCode, headers: r.headers })
    }
    const host = createSessionFileHost({ fetchImpl, editorId: f.editorId })
    t.after(() => host.dispose())
    await host.open(f.initial.fileId)
    await host.acquireLease(f.initial.fileId)
    const client = createHttpCommandClient({
      editorId: f.editorId,
      currentGeneration: () => adapter.current().editorGeneration,
      getCsrfToken: async () => f.csrf.sessionToken(f.alice.token),
      fetchImpl,
    })
    t.after(() => client.dispose())
    const executor = createToolExecutor({ journal: client, editor: adapter })
    t.after(() => executor.dispose())
    const proposal = await client.proposeCommand(f.envelope)
    await assert.rejects(executor.executeAuthorizedTool(f.envelope, proposal.digest))
    assert.equal(editor.state.doc.textContent, 'Hello worldSecond paragraph')
    await client.approveCommand(f.envelope, proposal.digest)
    if (mode === 'user-edit' || mode === 'takeover') {
      if (mode === 'user-edit') editor.view.dispatch(editor.state.tr.insertText('!', 12))
      else
        await f.leases.takeoverLease(f.alice.token, f.initial.fileId, {
          editorId: randomUUID(),
          expectedEpoch: f.lease.leaseEpoch,
        })
      await assert.rejects(executor.executeAuthorizedTool(f.envelope, proposal.digest))
      assert.equal(
        editor.state.doc.textContent,
        mode === 'user-edit' ? 'Hello world!Second paragraph' : 'Hello worldSecond paragraph',
      )
      assert.equal(stages, 0)
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
    assert.equal(editor.state.doc.textContent, 'Welcome worldSecond paragraph')
    let output
    const coordinator = createCommandSaveCoordinator({
      host,
      current: adapter.current,
      serialize: async () => {
        const texts = []
        editor.state.doc.forEach((p) => texts.push(p.textContent))
        output = await imported.export(texts)
        if (mode === 'save-edit') editor.view.dispatch(editor.state.tr.insertText('!', 1))
        return output
      },
      bind: (b) => client.bindCommandUpload(f.envelope, b),
      verifyCommitted: (e, r, d) => client.verifyCommitted(e, r, d),
    })
    const generation = adapter.current().editorGeneration
    let saved
    if (mode === 'save-edit') {
      await assert.rejects(coordinator.save(f.envelope, proposal.digest, generation))
      assert.equal(stages, 0)
      assert.equal(coordinator.hasPending(), false)
      assert.equal(
        (await f.files.openFile(f.alice.token, f.initial.fileId)).file.revision,
        f.initial.revision,
      )
      assert.equal((await client.getCommandOutcome(f.envelope)).state, 'applied_uncommitted')
      return
    }
    if (lost) {
      await assert.rejects(coordinator.save(f.envelope, proposal.digest, generation))
      saved = await coordinator.reconcile()
    } else saved = await coordinator.save(f.envelope, proposal.digest, generation)
    assert.equal(stages, 1)
    assert.notEqual(saved.revision, f.initial.revision)
    assert.equal((await client.getCommandOutcome(f.envelope)).state, 'committed')
    const durable = await host.readBytes(saved.fileId, saved.revision)
    assert.deepEqual(durable, output)
    assert.deepEqual((await importSimpleDocx(durable)).paragraphs, [
      'Welcome world',
      'Second paragraph',
    ])
    if (process.env.T14_LO_PROOF_OUTPUT)
      await writeFile(process.env.T14_LO_PROOF_OUTPUT + '/' + mode + '.docx', durable)
    assert.equal(
      (await f.files.openFile(f.alice.token, f.initial.fileId)).file.revision,
      saved.revision,
    )
  })
