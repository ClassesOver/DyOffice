import { test, expect } from 'vitest'
import assert from 'node:assert/strict'
import { randomUUID, webcrypto } from 'node:crypto'
import Fastify from 'fastify'
import JSZip from 'jszip'
import { Editor } from '@tiptap/core'
import { parseDocx, readSections, saveDocx } from '@genoffice/docx-engine'
import { editorExtensions } from '../../../docs/src/renderer/editor/extensions'
import { blocksToPmDoc, pmDocToSavePlan } from '../../../docs/src/renderer/editor/convert'
import { buildDocx } from '../../../../packages/docx-engine/tests/helpers/build-docx'
import { fileFixture, importFile } from '../helpers/files.mjs'
import { s3Fixture } from '../helpers/s3.mjs'
import { createLeaseService } from '../../server/src/modules/leases/service.ts'
import { createCommandRequestFactory } from '../../server/src/modules/commands/http-service.ts'
import { registerCommandRoutes } from '../../server/src/modules/commands/routes.ts'
import { createCsrfService, SESSION_COOKIE } from '../../server/src/modules/auth/csrf.ts'
import { commandHash } from '../../server/src/modules/commands/approval.ts'
import { createApprovedTextCommandAdapter } from '../../../docs/src/renderer/editor/approved-text-command'
import { createDocumentMutationFence } from '../../../docs/src/renderer/document-mutation-fence'
import { createToolExecutor } from '../../../../packages/browser-host/src/tool-executor'
import { createSessionFileHost } from '../../../../packages/browser-host/src/session-files'
import { createHttpCommandClient } from '../../../../packages/browser-host/src/http-commands'
import { createCommandSaveCoordinator } from '../../../../packages/browser-host/src/command-save'
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
const origin = 'https://office.example'
import type { ToolDescriptor } from '../../../../packages/web-contracts/src/tools'
const tool: ToolDescriptor = {
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
async function setup(t: any, bytes: Uint8Array) {
  const s3 = await s3Fixture(t)
  const f = await fileFixture(t, { objectStore: s3.store })
  assert.ok(f.alice)
  const alice = f.alice
  const initial = (await importFile(f, f.alice.token, Buffer.from(bytes))).file,
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
  const post = (action: string, extra = {}, token = alice.token) =>
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
  return { ...f, alice, commandApp: app, csrf, post, envelope, leases, editorId, lease, initial }
}
for (const mode of ['normal', 'lost', 'takeover', 'serialize-edit', 'stage-edit', 'commit-edit']) {
  test(`real native command to PostgreSQL and RustFS: ${mode}`, async () => {
    const failures: unknown[] = [],
      cleanup: Array<() => unknown> = [],
      t = { after: (fn: () => unknown) => cleanup.push(fn) }
    try {
      const input = await buildDocx({
        bodyXml:
          '<w:p><w:r><w:t>Hello world</w:t></w:r></w:p><w:p><w:r><w:t>Untouched paragraph</w:t></w:r></w:p>',
        headerXml: '<w:p><w:r><w:t>Untouched header</w:t></w:r></w:p>',
        extraParts: [
          {
            path: 'customXml/probe.xml',
            xml: '<probe>untouched</probe>',
            contentType: 'application/xml',
          },
        ],
      })
      const parsed = await parseDocx(input),
        f = await setup(t, input)
      let stages = 0,
        commits = 0,
        drop = mode === 'lost',
        editor: Editor,
        output: Uint8Array | undefined
      const fetchImpl: typeof fetch = async (path: any, init: any = {}) => {
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
        if (path.endsWith('/uploads')) {
          stages++
          if (mode === 'stage-edit') editor.view.dispatch(editor.state.tr.insertText('!', 1))
        }
        if (path.endsWith('/commits')) {
          commits++
          if (drop) {
            drop = false
            assert.equal(r.statusCode, 200, r.body)
            throw Error('lost actual T06 response')
          }
          if (mode === 'commit-edit' && commits === 1)
            editor.view.dispatch(editor.state.tr.insertText('!', 1))
        }
        return new Response(new Uint8Array(r.rawPayload).buffer, {
          status: r.statusCode,
          headers: r.headers as any,
        })
      }
      const host = createSessionFileHost({ fetchImpl, editorId: f.editorId })
      t.after(() => host.dispose())
      await host.open(f.initial.fileId)
      await host.acquireLease(f.initial.fileId)
      editor = new Editor({
        extensions: editorExtensions,
        content: blocksToPmDoc(parsed.blocks, readSections(parsed)) as any,
      })
      t.after(() => editor.destroy())
      const fence = createDocumentMutationFence()
      t.after(() => fence.dispose())
      const adapter = createApprovedTextCommandAdapter({
        editor,
        mutationFence: fence,
        canWrite: () => !!host.getState(f.initial.fileId).lease,
        authority: () => {
          const s = host.getState(f.initial.fileId)
          return {
            fileId: f.initial.fileId,
            baseRevision: s.revision!.revision,
            leaseEpoch: s.lease?.leaseEpoch ?? 0,
          }
        },
      })
      t.after(() => adapter.dispose())
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
      await expect(executor.executeAuthorizedTool(f.envelope, proposal.digest)).rejects.toThrow()
      expect(editor.state.doc.textContent).toContain('Hello world')
      await client.approveCommand(f.envelope, proposal.digest)
      if (mode === 'takeover') {
        await f.leases.takeoverLease(f.alice.token, f.initial.fileId, {
          editorId: randomUUID(),
          expectedEpoch: f.lease.leaseEpoch,
        })
        await expect(executor.executeAuthorizedTool(f.envelope, proposal.digest)).rejects.toThrow()
        expect(stages).toBe(0)
        expect(commits).toBe(0)
        expect(editor.state.doc.textContent).toContain('Hello world')
        return
      }
      expect((await executor.executeAuthorizedTool(f.envelope, proposal.digest)).status).toBe(
        'applied_uncommitted',
      )
      await expect(executor.executeAuthorizedTool(f.envelope, proposal.digest)).rejects.toThrow()
      const applied = adapter.current().editorGeneration
      const coordinator = createCommandSaveCoordinator({
        host,
        current: adapter.current,
        serialize: async () => {
          const plan = pmDocToSavePlan(editor.getJSON() as any, parsed.blocks)
          output = await saveDocx(parsed, plan.saveBlocks, {})
          if (mode === 'serialize-edit') editor.view.dispatch(editor.state.tr.insertText('!', 1))
          return output
        },
        bind: (b) => client.bindCommandUpload(f.envelope, b),
        verifyCommitted: (e, r, d) => client.verifyCommitted(e, r, d),
      })
      t.after(() => coordinator.dispose())
      let saved
      if (mode === 'serialize-edit' || mode === 'stage-edit') {
        await expect(coordinator.save(f.envelope, proposal.digest, applied)).rejects.toThrow(
          /Editor changed/,
        )
        expect(commits).toBe(0)
        expect(stages).toBe(mode === 'serialize-edit' ? 0 : 1)
        expect((await f.files.openFile(f.alice.token, f.initial.fileId)).file.revision).toBe(
          f.initial.revision,
        )
        expect(editor.state.doc.textContent).toContain('!Welcome world')
        return
      }
      if (mode === 'lost') {
        await expect(coordinator.save(f.envelope, proposal.digest, applied)).rejects.toThrow()
        expect(host.getState(f.initial.fileId).status).toBe('unknown')
        saved = await coordinator.reconcile()
        expect(commits).toBe(2)
      } else saved = await coordinator.save(f.envelope, proposal.digest, applied)
      expect(stages).toBe(1)
      expect(saved.revision).not.toBe(f.initial.revision)
      const durable = await f.files.readFile(f.alice.token, saved.fileId, saved.revision)
      expect(Buffer.from(durable)).toEqual(Buffer.from(output!))
      const reopened = await parseDocx(new Uint8Array(durable))
      expect(reopened.blocks.flatMap((b) => b.runs?.map((r) => r.text) ?? []).join('')).toContain(
        'Untouched paragraph',
      )
      expect(reopened.blocks.flatMap((b) => b.runs?.map((r) => r.text) ?? []).join('')).toContain(
        'Welcome world',
      )
      const reopenedEditor = new Editor({
        extensions: editorExtensions,
        content: blocksToPmDoc(reopened.blocks, readSections(reopened)) as any,
      })
      try {
        expect(reopenedEditor.state.doc.textContent).toContain('Welcome world')
      } finally {
        reopenedEditor.destroy()
      }
      const before = await JSZip.loadAsync(input),
        after = await JSZip.loadAsync(durable)
      for (const name of ['word/header1.xml', 'word/styles.xml', 'customXml/probe.xml'])
        expect(await after.file(name)!.async('string')).toBe(
          await before.file(name)!.async('string'),
        )
      const state = await f.post('outcome')
      expect(state.statusCode).toBe(200)
      expect(state.json().state).toBe('committed')
      expect(state.json().revision).toEqual(saved)
      const counts = await f.transactions.withPrincipalTransaction(
        { kind: 'session', token: f.alice.token },
        async (connection: any) => ({
          receipts: (await connection.query('SELECT * FROM revision_commits')).rowCount,
          bindings: (await connection.query('SELECT * FROM command_upload_bindings')).rowCount,
        }),
      )
      expect(counts).toEqual({ receipts: 1, bindings: 1 })
      if (mode === 'commit-edit') {
        expect(adapter.current().editorGeneration).toBeGreaterThan(applied)
        expect(editor.state.doc.textContent).toContain('!Welcome world')
        expect(
          reopened.blocks.flatMap((b) => b.runs?.map((r) => r.text) ?? []).join(''),
        ).not.toContain('!Welcome world')
      }
    } catch (error) {
      failures.push(error)
    } finally {
      for (const fn of cleanup.reverse()) {
        try {
          await fn()
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length)
        throw new AggregateError(failures, 'Native persistence case or cleanup failed')
    }
  })
}
