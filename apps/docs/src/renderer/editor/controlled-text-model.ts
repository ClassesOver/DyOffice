import { Editor, Extension } from '@tiptap/core'
import { Document } from '@tiptap/extension-document'
import { Text } from '@tiptap/extension-text'
import { Plugin, type Transaction } from '@tiptap/pm/state'
import { DocParagraph } from './extensions'
import {
  createApprovedTextCommandAdapter,
  type TextCommandAuthority,
} from './approved-text-command'
import type { DocumentMutationFence } from '../document-mutation-fence'
/** A fresh-realm, detached native model. This does not validate a DOCX profile or
 * grant a lease: the caller must supply verified paragraphs and live host checks.
 * No editor/commands/view escapes. Normal App is not mounted or modified. */
export function createControlledTextModel({
  paragraphs,
  authority,
  canWrite,
  mutationFence,
}: {
  paragraphs: readonly string[]
  authority: () => TextCommandAuthority
  canWrite: () => boolean
  mutationFence: DocumentMutationFence
}) {
  if (
    typeof canWrite !== 'function' ||
    typeof authority !== 'function' ||
    !Array.isArray(paragraphs) ||
    paragraphs.length < 1 ||
    paragraphs.length > 256 ||
    Object.keys(paragraphs).length !== paragraphs.length
  )
    throw Error('Verified bounded paragraphs and live authority required')
  let totalBytes = 0
  const encoder = new TextEncoder()
  const initial = Array.from({ length: paragraphs.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(paragraphs, String(i))
    if (
      !d ||
      !('value' in d) ||
      typeof d.value !== 'string' ||
      d.value.length < 1 ||
      d.value.length > 32768 ||
      /[\u0000-\u001f\u007f-\u009f]/.test(d.value) ||
      /[\uD800-\uDFFF]/u.test(d.value)
    )
      throw Error('Invalid verified paragraph')
    totalBytes += encoder.encode(d.value).byteLength
    if (totalBytes > 1048576) throw Error('Verified paragraphs exceed total byte limit')
    return d.value as string
  })
  let disposed = false,
    expected: Transaction | null = null,
    consumed = false,
    dispatching = false
  const exactGate = Extension.create({
    name: 'controlledExactTransaction',
    priority: 1000000,
    addProseMirrorPlugins() {
      return [
        new Plugin({
          filterTransaction(transaction) {
            if (disposed || transaction !== expected) return false
            expected = null
            consumed = true
            return true
          },
        }),
      ]
    },
  })
  const prevent = (event: Event) => {
    event.preventDefault()
    return true
  }
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [Document, DocParagraph, Text, exactGate],
    editable: true,
    autofocus: false,
    injectCSS: false,
    enableInputRules: false,
    enablePasteRules: false,
    content: {
      type: 'doc',
      content: initial.map((text) => ({ type: 'docParagraph', content: [{ type: 'text', text }] })),
    },
    editorProps: {
      attributes: { tabindex: '-1' },
      handleDOMEvents: {
        beforeinput: (_v, e) => prevent(e),
        keydown: (_v, e) => prevent(e),
        paste: (_v, e) => prevent(e),
        drop: (_v, e) => prevent(e),
      },
    },
  })
  const adapter = createApprovedTextCommandAdapter({
    editor,
    authority,
    canWrite: () => !disposed && canWrite(),
    mutationFence,
    dispatchAuthorized(transaction) {
      if (disposed || dispatching || expected !== null)
        throw Error('Closed or reentrant transaction gate')
      dispatching = true
      expected = transaction
      consumed = false
      try {
        editor.view.dispatch(transaction)
        if (!consumed) throw Error('Authorized transaction was rejected')
      } finally {
        expected = null
        dispatching = false
      }
    },
  })
  const assertLive = () => {
    if (disposed || editor.isDestroyed) throw Error('Controlled model disposed')
  }
  const tools = Object.freeze({
    current() {
      assertLive()
      return adapter.current()
    },
    applyBatch(input: Parameters<typeof adapter.applyBatch>[0]) {
      assertLive()
      return adapter.applyBatch(input)
    },
    undoBatch(token: unknown) {
      assertLive()
      return adapter.undoBatch(token)
    },
  })
  return Object.freeze({
    tools,
    current: tools.current,
    paragraphs() {
      assertLive()
      const result: string[] = []
      editor.state.doc.forEach((node) => {
        if (node.type.name !== 'docParagraph') throw Error('Unsupported model node')
        result.push(node.textContent)
      })
      return Object.freeze(result)
    },
    dispose() {
      if (disposed) return
      disposed = true
      expected = null
      adapter.dispose()
      editor.destroy()
    },
  })
}
