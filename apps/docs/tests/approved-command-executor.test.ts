import { test, expect } from 'vitest'
import { commandHash } from '../../web/server/src/modules/commands/approval'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { createDocumentMutationFence } from '../src/renderer/document-mutation-fence'
import { createApprovedTextCommandAdapter } from '../src/renderer/editor/approved-text-command'
import { createToolExecutor } from '../../../packages/browser-host/src/tool-executor'
import { createCommandService } from '../../web/server/src/modules/commands/service'

function fixture() {
  const fence = createDocumentMutationFence()
  const editor = new Editor({
    extensions: editorExtensions,
    content: {
      type: 'doc',
      content: [{ type: 'docParagraph', content: [{ type: 'text', text: 'hello world' }] }],
    },
  })
  const authority = () => ({ fileId: 'file', baseRevision: 'r1', leaseEpoch: 1 })
  const adapter = createApprovedTextCommandAdapter({
    editor,
    authority,
    canWrite: () => true,
    mutationFence: fence,
  })
  let row: any = null,
    before = () => {}
  const service = createCommandService({
    journal: {
      async withAuthorizedCommand(_file: any, _id: any, fn: any) {
        before()
        const r = await fn(
          {
            authority: {
              ...authority(),
              editorGeneration: adapter.current().editorGeneration,
              deploymentId: 'dep',
              userId: 'user',
              sessionId: 'session',
              scopes: ['files:write'],
            },
            verifyCommit: async () => false,
          },
          structuredClone(row),
        )
        if (r.next) row = structuredClone(r.next)
        return structuredClone(r.value)
      },
    },
    lookupTool: () => ({
      name: 'docs.replace_text.v1',
      schemaVersion: 1,
      effect: 'document_write',
      executionMode: 'live_editor',
      requiresActiveEditor: true,
      requiredScopes: ['files:write'],
      maxDurationMs: 1000,
      inputSchema: {},
      outputSchema: {},
    }),
    now: () => 1000,
  })
  const requireClaim = async (pending: ReturnType<typeof service.beginExecution>) => {
    const row = await pending
    if (typeof row.claimId !== 'string') throw Error('Missing execution claim')
    return { ...row, claimId: row.claimId }
  }
  const executor = createToolExecutor({
    journal: {
      beginExecution: (e, d) => requireClaim(service.beginExecution(e, d)),
      beginUndo: (e) => requireClaim(service.beginUndo(e)),
      reportApplied: service.reportApplied,
      reportUndone: service.reportUndone,
    },
    editor: adapter,
  })
  const args = { from: 1, to: 6, expectedText: 'hello', replacement: 'welcome' }
  const envelope = {
    commandId: 'command',
    ...adapter.current(),
    argsHash: commandHash(args),
    payload: { toolName: 'docs.replace_text.v1', arguments: args },
  }
  return {
    editor,
    fence,
    adapter,
    service,
    executor,
    envelope,
    authority,
    before: (f: () => void) => (before = f),
    close() {
      executor.dispose()
      adapter.dispose()
      editor.destroy()
      fence.dispose()
    },
  }
}
async function approve(f: ReturnType<typeof fixture>) {
  const p = await f.service.proposeCommand(f.envelope)
  return f.service.approveCommand(f.envelope, p.digest)
}

test('actual native stack requires approval, applies one batch and uses its exact inverse', async () => {
  const f = fixture()
  try {
    const p = await f.service.proposeCommand(f.envelope)
    await expect(f.executor.executeAuthorizedTool(f.envelope, p.digest)).rejects.toThrow()
    expect(f.editor.state.doc.textContent).toBe('hello world')
    await f.service.approveCommand(f.envelope, p.digest)
    expect((await f.executor.executeAuthorizedTool(f.envelope, p.digest)).status).toBe(
      'applied_uncommitted',
    )
    expect(f.editor.state.doc.textContent).toBe('welcome world')
    await expect(f.executor.executeAuthorizedTool(f.envelope, p.digest)).rejects.toThrow()
    expect((await f.executor.undoCommand(f.envelope)).status).toBe('cancelled')
    expect(f.editor.state.doc.textContent).toBe('hello world')
  } finally {
    f.close()
  }
})
test('unacknowledged metadata owner blocks native mutation even with a fresh generation', async () => {
  const f = fixture()
  try {
    const owner = f.fence.registerOwner('metadata')
    owner.invalidate()
    const e = { ...f.envelope, editorGeneration: f.adapter.current().editorGeneration }
    const p = await f.service.proposeCommand(e)
    await f.service.approveCommand(e, p.digest)
    expect((await f.executor.executeAuthorizedTool(e, p.digest)).status).toBe('unknown_outcome')
    expect(f.editor.state.doc.textContent).toBe('hello world')
  } finally {
    f.close()
  }
})
test('later native transaction cannot be overwritten by the earlier command inverse', async () => {
  const f = fixture()
  try {
    const p = await approve(f)
    await f.executor.executeAuthorizedTool(f.envelope, p.digest)
    f.editor.view.dispatch(f.editor.state.tr.insertText('!', 1))
    expect((await f.executor.undoCommand(f.envelope)).status).toBe('conflict')
    expect(f.editor.state.doc.textContent).toBe('!welcome world')
  } finally {
    f.close()
  }
})
test('host lifecycle fence survives adapter reconstruction and rejects old approval', async () => {
  const f = fixture()
  let next: ReturnType<typeof createApprovedTextCommandAdapter> | undefined
  try {
    await approve(f)
    f.adapter.dispose()
    const owner = f.fence.registerOwner('reload')
    const v = owner.invalidate()
    owner.acknowledge(v)
    next = createApprovedTextCommandAdapter({
      editor: f.editor,
      authority: f.authority,
      canWrite: () => true,
      mutationFence: f.fence,
    })
    expect(next.current().editorGeneration).toBeGreaterThan(f.envelope.editorGeneration)
    expect(() => next!.applyBatch(f.envelope)).toThrow(/Stale/)
    expect(f.editor.state.doc.textContent).toBe('hello world')
  } finally {
    next?.dispose()
    f.close()
  }
})
