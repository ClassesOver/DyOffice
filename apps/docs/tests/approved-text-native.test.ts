import { createDocumentMutationFence } from '../src/renderer/document-mutation-fence'
import { test, expect } from 'vitest'
import { Editor } from '@tiptap/core'
import { Document } from '@tiptap/extension-document'
import { Text } from '@tiptap/extension-text'
import { DocParagraph } from '../src/renderer/editor/extensions'
import { createApprovedTextCommandAdapter } from '../src/renderer/editor/approved-text-command'
test('native DocParagraph single plain-text transaction and exact batch inverse', () => {
  const editor = new Editor({
    extensions: [Document, DocParagraph, Text],
    content: {
      type: 'doc',
      content: [{ type: 'docParagraph', content: [{ type: 'text', text: 'hello world' }] }],
    },
  })
  const a = createApprovedTextCommandAdapter({
    editor,
    authority: () => ({ fileId: 'file', baseRevision: 'r1', leaseEpoch: 1, externalGeneration: 0 }),
    canWrite: () => true,
    mutationFence: createDocumentMutationFence(),
  })
  try {
    const e = {
      commandId: 'c',
      ...a.current(),
      argsHash: 'a'.repeat(64),
      payload: {
        toolName: 'docs.replace_text.v1',
        arguments: { from: 1, to: 6, expectedText: 'hello', replacement: 'welcome' },
      },
    }
    const result = a.applyBatch(e)
    expect(editor.state.doc.textContent).toBe('welcome world')
    a.undoBatch(result.undoToken)
    expect(editor.state.doc.textContent).toBe('hello world')
  } finally {
    a.dispose()
    editor.destroy()
  }
})
test('complete native editor extension stack preserves the approved plain-text transaction', async () => {
  const { editorExtensions } = await import('../src/renderer/editor/extensions')
  const editor = new Editor({
    extensions: editorExtensions,
    content: {
      type: 'doc',
      content: [{ type: 'docParagraph', content: [{ type: 'text', text: 'hello world' }] }],
    },
  })
  const a = createApprovedTextCommandAdapter({
    editor,
    authority: () => ({ fileId: 'file', baseRevision: 'r1', leaseEpoch: 1, externalGeneration: 0 }),
    canWrite: () => true,
    mutationFence: createDocumentMutationFence(),
  })
  try {
    const e = {
      commandId: 'c',
      ...a.current(),
      argsHash: 'a'.repeat(64),
      payload: {
        toolName: 'docs.replace_text.v1',
        arguments: { from: 1, to: 6, expectedText: 'hello', replacement: 'welcome' },
      },
    }
    const result = a.applyBatch(e)
    expect(editor.state.doc.textContent).toBe('welcome world')
    a.undoBatch(result.undoToken)
    expect(editor.state.doc.textContent).toBe('hello world')
  } finally {
    a.dispose()
    editor.destroy()
  }
})
