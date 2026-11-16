import { createDocumentMutationFence } from '../../../docs/src/renderer/document-mutation-fence.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { Editor, Node } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { Document } from '@tiptap/extension-document'
import { Text } from '@tiptap/extension-text'
import * as adapter from '../../../docs/src/renderer/editor/approved-text-command.ts'
const doc = new JSDOM('<!doctype html><html><body></body></html>')
Object.assign(globalThis, {
  window: doc.window,
  document: doc.window.document,
  HTMLElement: doc.window.HTMLElement,
  Element: doc.window.Element,
  Node: doc.window.Node,
  getComputedStyle: doc.window.getComputedStyle,
})
Object.defineProperty(globalThis, 'navigator', { value: doc.window.navigator, configurable: true })
const Paragraph = Node.create({
  name: 'docParagraph',
  group: 'block',
  content: 'text*',
  parseHTML: () => [{ tag: 'p' }],
  renderHTML: () => ['p', 0],
})
function fixture(t) {
  const editor = new Editor({
    extensions: [Document, Paragraph, Text],
    content: {
      type: 'doc',
      content: [{ type: 'docParagraph', content: [{ type: 'text', text: 'hello world' }] }],
    },
  })
  t.after(() => editor.destroy())
  let authority = { fileId: 'file', baseRevision: 'r1', leaseEpoch: 1, externalGeneration: 0 }
  const fence = createDocumentMutationFence(),
    a = adapter.createApprovedTextCommandAdapter({
      editor,
      authority: () => authority,
      canWrite: () => true,
      mutationFence: fence,
    })
  t.after(() => a.dispose())
  const envelope = () => ({
    commandId: 'cmd',
    ...a.current(),
    argsHash: 'a'.repeat(64),
    payload: {
      toolName: 'docs.replace_text.v1',
      arguments: { from: 1, to: 6, expectedText: 'hello', replacement: 'goodbye' },
    },
  })
  return { editor, a, envelope, authority, fence, metadata: fence.registerOwner('metadata') }
}
test('real Tiptap state applies one text transaction and reverses only its exact batch', (t) => {
  assert.equal(typeof adapter.createApprovedTextCommandAdapter, 'function')
  const f = fixture(t),
    before = f.editor.state.doc
  const applied = f.a.applyBatch(f.envelope())
  assert.equal(f.editor.state.doc.textContent, 'goodbye world')
  assert.equal(applied.generation, 1)
  assert.equal(f.a.undoBatch(applied.undoToken), 2)
  assert.ok(f.editor.state.doc.eq(before))
  assert.throws(() => f.a.undoBatch(applied.undoToken))
})
test('user transaction or external persistent generation fences stale apply and inverse', (t) => {
  const f = fixture(t),
    e = f.envelope()
  f.editor.view.dispatch(f.editor.state.tr.insertText('!', 12))
  assert.throws(() => f.a.applyBatch(e))
  const applied = f.a.applyBatch(f.envelope())
  f.editor.view.dispatch(f.editor.state.tr.insertText('?', 1))
  assert.throws(() => f.a.undoBatch(applied.undoToken))
  const next = f.envelope()
  f.metadata.invalidate()
  assert.throws(() => f.a.applyBatch(next))
})
test('anchor mismatch newline cross-block and extra arguments fail without changing document', (t) => {
  const f = fixture(t),
    before = f.editor.state.doc
  for (const args of [
    { expectedText: 'wrong' },
    { replacement: 'two\nlines' },
    { to: 999 },
    { unsafe: true },
  ]) {
    const e = f.envelope()
    Object.assign(e.payload.arguments, args)
    assert.throws(() => f.a.applyBatch(e))
    assert.ok(f.editor.state.doc.eq(before))
  }
})
test('destroyed or disposed editor and forged inverse never mutate state', (t) => {
  const f = fixture(t),
    e = f.envelope()
  assert.throws(() => f.a.undoBatch({}))
  f.a.dispose()
  assert.throws(() => f.a.applyBatch(e))
  assert.equal(f.editor.state.doc.textContent, 'hello world')
})
test('active stored formatting cannot silently turn an approved plain replacement into styled content', async (t) => {
  const { Bold } = await import('@tiptap/extension-bold')
  const editor = new Editor({
    extensions: [Document, Paragraph, Text, Bold],
    content: '<p>hello world</p>',
  })
  t.after(() => editor.destroy())
  const a = adapter.createApprovedTextCommandAdapter({
    editor,
    authority: () => ({ fileId: 'f', baseRevision: 'r', leaseEpoch: 1, externalGeneration: 0 }),
    canWrite: () => true,
    mutationFence: createDocumentMutationFence(),
  })
  t.after(() => a.dispose())
  editor.view.dispatch(editor.state.tr.setStoredMarks([editor.schema.mark('bold')]))
  const e = {
    commandId: 'c',
    ...a.current(),
    argsHash: 'a'.repeat(64),
    payload: {
      toolName: 'docs.replace_text.v1',
      arguments: { from: 1, to: 6, expectedText: 'hello', replacement: 'bye' },
    },
  }
  const before = editor.state.doc
  assert.throws(() => a.applyBatch(e))
  assert.ok(editor.state.doc.eq(before))
})
test('replacement rejects control characters and unpaired surrogates before mutation', (t) => {
  const f = fixture(t),
    before = f.editor.state.doc
  for (const replacement of ['bad\u0001', 'bad\ud800', 'bad\t']) {
    const e = f.envelope()
    e.payload.arguments.replacement = replacement
    assert.throws(() => f.a.applyBatch(e))
    assert.ok(f.editor.state.doc.eq(before))
  }
})
test('filtered transaction has no effect; appended mutation reports unknown rather than pretending not executed', async (t) => {
  const { Plugin } = await import('@tiptap/pm/state')
  for (const kind of ['filter', 'append']) {
    const f = fixture(t),
      before = f.editor.state.doc
    f.editor.registerPlugin(
      new Plugin(
        kind === 'filter'
          ? { filterTransaction: (tr) => !tr.docChanged }
          : {
              appendTransaction: (transactions, old, state) =>
                transactions.some((tr) => tr.docChanged)
                  ? state.tr.insertText('!', state.doc.content.size - 1)
                  : null,
            },
      ),
    )
    assert.throws(() => f.a.applyBatch(f.envelope()), /not accepted exactly/)
    if (kind === 'filter') assert.ok(f.editor.state.doc.eq(before))
    else assert.equal(f.editor.state.doc.textContent, 'goodbye world!')
  }
})
test('read-only and changed external generation deny mutation and batch inverse', (t) => {
  const f = fixture(t)
  f.editor.setEditable(false)
  assert.throws(() => f.a.applyBatch(f.envelope()))
  f.editor.setEditable(true)
  const result = f.a.applyBatch(f.envelope())
  f.metadata.invalidate()
  assert.throws(() => f.a.undoBatch(result.undoToken))
  assert.equal(f.editor.state.doc.textContent, 'goodbye world')
})
test('moving the user selection invalidates a previously approved scope', (t) => {
  const f = fixture(t),
    e = f.envelope()
  f.editor.view.dispatch(
    f.editor.state.tr.setSelection(TextSelection.create(f.editor.state.doc, 3)),
  )
  assert.throws(() => f.a.applyBatch(e))
  assert.equal(f.editor.state.doc.textContent, 'hello world')
})
test('shared clock preserves stale-envelope fencing across adapter reconstruction', (t) => {
  const f = fixture(t),
    e = f.envelope()
  f.a.dispose()
  const lifecycle = f.fence.registerOwner('reload'),
    version = lifecycle.invalidate()
  lifecycle.acknowledge(version)
  const next = adapter.createApprovedTextCommandAdapter({
    editor: f.editor,
    authority: () => f.authority,
    canWrite: () => true,
    mutationFence: f.fence,
  })
  t.after(() => next.dispose())
  assert.throws(() => next.applyBatch(e))
  assert.ok(next.current().editorGeneration > e.editorGeneration)
})
test('metadata raised by a synchronous transaction listener makes apply and undo outcomes unknown', (t) => {
  for (const operation of ['apply', 'undo']) {
    const f = fixture(t)
    let result
    if (operation === 'undo') result = f.a.applyBatch(f.envelope())
    const listener = () => f.metadata.invalidate()
    f.editor.on('transaction', listener)
    t.after(() => f.editor.off('transaction', listener))
    assert.throws(() =>
      operation === 'apply' ? f.a.applyBatch(f.envelope()) : f.a.undoBatch(result.undoToken),
    )
    assert.equal(f.fence.snapshot().ready, false)
  }
})
test('a synchronous metadata mutation cannot hide behind an immediately acknowledged pending token', (t) => {
  const f = fixture(t)
  const listener = () => {
    const v = f.metadata.invalidate()
    f.metadata.acknowledge(v)
  }
  f.editor.on('transaction', listener)
  t.after(() => f.editor.off('transaction', listener))
  assert.throws(() => f.a.applyBatch(f.envelope()))
  assert.equal(f.editor.state.doc.textContent, 'goodbye world')
})
test('nested stories or protected containers are outside the supported paragraph subset', (t) => {
  const Wrapper = Node.create({
    name: 'protectedContainer',
    group: 'block',
    content: 'docParagraph+',
    renderHTML: () => ['div', 0],
  })
  const editor = new Editor({
    extensions: [Document, Paragraph, Text, Wrapper],
    content: {
      type: 'doc',
      content: [
        {
          type: 'protectedContainer',
          content: [{ type: 'docParagraph', content: [{ type: 'text', text: 'hello' }] }],
        },
      ],
    },
  })
  t.after(() => editor.destroy())
  const a = adapter.createApprovedTextCommandAdapter({
    editor,
    authority: () => ({ fileId: 'f', baseRevision: 'r', leaseEpoch: 1 }),
    canWrite: () => true,
    mutationFence: createDocumentMutationFence(),
  })
  t.after(() => a.dispose())
  const e = {
    commandId: 'c',
    ...a.current(),
    argsHash: 'a'.repeat(64),
    payload: {
      toolName: 'docs.replace_text.v1',
      arguments: { from: 2, to: 7, expectedText: 'hello', replacement: 'bye' },
    },
  }
  assert.throws(() => a.applyBatch(e))
  assert.equal(editor.state.doc.textContent, 'hello')
})
test('closing the shared host clock disables the adapter without throwing into unrelated editor input', (t) => {
  const f = fixture(t),
    e = f.envelope()
  f.fence.dispose()
  assert.doesNotThrow(() => f.editor.view.dispatch(f.editor.state.tr.insertText('!', 12)))
  assert.throws(() => f.a.applyBatch(e))
})
