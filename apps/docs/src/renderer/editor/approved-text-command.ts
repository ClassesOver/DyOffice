import type { DocumentMutationFence } from '../document-mutation-fence'
import type { Editor } from '@tiptap/core'
import type { Node as PmNode } from '@tiptap/pm/model'
import type { Step } from '@tiptap/pm/transform'
import type { Transaction } from '@tiptap/pm/state'
import type { CommandEnvelope } from '../../../../../packages/web-contracts/src/tools.ts'
import type { AtomicEditorTools } from '../../../../../packages/browser-host/src/tool-executor.ts'
export interface TextCommandAuthority {
  fileId: string
  baseRevision: string
  leaseEpoch: number
}
/** Minimal opt-in native ProseMirror primitive, NOT automatically mounted.
 * canWrite must cover read-only/protection/review modes. mutationFence must
 * synchronously fence ALL persisted edits, pending work and document reloads.
 * Missing either trustworthy host contract means the host must keep this disabled.
 */
export function createApprovedTextCommandAdapter({
  editor,
  authority,
  canWrite,
  mutationFence,
  dispatchAuthorized,
}: {
  editor: Editor
  authority: () => TextCommandAuthority
  canWrite: () => boolean
  mutationFence: DocumentMutationFence
  /** Optional synchronous exact-transaction gate owned by an isolated host. */
  dispatchAuthorized?: (transaction: Transaction) => void
}): AtomicEditorTools & { dispose(): void } {
  let disposed = false,
    lastDoc = editor.state.doc,
    lastSelection = editor.state.selection
  if (!mutationFence?.snapshot || typeof canWrite !== 'function')
    throw Error('Live editor authority required')
  const dispatch =
    dispatchAuthorized ?? ((transaction: Transaction) => editor.view.dispatch(transaction))
  const tokens = new WeakMap<
    object,
    {
      before: PmNode
      after: PmNode
      steps: Step[]
      generation: number
      authority: TextCommandAuthority
    }
  >()
  const changed = () => {
    if (editor.state.doc !== lastDoc || !editor.state.selection.eq(lastSelection)) {
      lastDoc = editor.state.doc
      lastSelection = editor.state.selection
      try {
        mutationFence.recordEditorTransaction()
      } catch {
        disposed = true
        editor.off('transaction', changed)
      }
    }
  }
  editor.on('transaction', changed)
  function current() {
    if (disposed || editor.isDestroyed) throw Error('Editor disposed')
    changed()
    if (disposed) throw Error('Editor fence closed')
    const a = authority()
    return {
      fileId: a.fileId,
      baseRevision: a.baseRevision,
      leaseEpoch: a.leaseEpoch,
      editorGeneration: mutationFence.snapshot().generation,
    }
  }
  function exact(e: CommandEnvelope) {
    const s = current()
    if (
      !mutationFence.snapshot().ready ||
      !canWrite() ||
      !editor.isEditable ||
      s.fileId !== e.fileId ||
      s.baseRevision !== e.baseRevision ||
      s.leaseEpoch !== e.leaseEpoch ||
      s.editorGeneration !== e.editorGeneration
    )
      throw Error('Stale or read-only editor')
  }
  return {
    current,
    applyBatch(input) {
      const e = structuredClone(input)
      exact(e)
      if (
        e.payload.toolName !== 'docs.replace_text.v1' ||
        Object.keys(e.payload).sort().join(',') !== 'arguments,toolName'
      )
        throw Error('Unsupported editor tool')
      const args = e.payload.arguments as Record<string, unknown>
      if (
        !args ||
        typeof args !== 'object' ||
        Array.isArray(args) ||
        Object.keys(args).sort().join(',') !== 'expectedText,from,replacement,to'
      )
        throw Error('Invalid text replacement')
      const { from, to, expectedText, replacement } = args
      if (
        !Number.isSafeInteger(from) ||
        !Number.isSafeInteger(to) ||
        typeof from !== 'number' ||
        typeof to !== 'number' ||
        from < 1 ||
        to <= from ||
        to > editor.state.doc.content.size ||
        typeof expectedText !== 'string' ||
        typeof replacement !== 'string' ||
        expectedText === replacement ||
        expectedText.length !== to - from ||
        expectedText.length > 32768 ||
        replacement.length > 32768 ||
        /[\u0000-\u001f\u007f-\u009f]/.test(replacement) ||
        /[\uD800-\uDFFF]/u.test(replacement)
      )
        throw Error('Invalid text range')
      if (editor.state.storedMarks?.length)
        throw Error('Active formatting is not a plain-text command')
      const state = editor.state,
        $from = state.doc.resolve(from),
        $to = state.doc.resolve(to)
      if (
        $from.depth !== 1 ||
        !$from.sameParent($to) ||
        $from.parent.type.name !== 'docParagraph' ||
        state.doc.textBetween(from, to) !== expectedText
      )
        throw Error('Selection anchor changed')
      let plain = true
      state.doc.nodesBetween(from, to, (node) => {
        if (node.isInline && (!node.isText || node.marks.length)) plain = false
      })
      if (!plain) throw Error('Only unmarked plain paragraph text is supported')
      const tr = state.tr.insertText(replacement, from, to),
        steps = tr.steps.map((step, i) => step.invert(tr.docs[i])).reverse(),
        before = state.doc,
        after = tr.doc
      exact(e)
      dispatch(tr)
      const next = current()
      if (
        !mutationFence.snapshot().ready ||
        !editor.state.doc.eq(after) ||
        next.editorGeneration !== e.editorGeneration + 1
      )
        throw Error('Editor transaction not accepted exactly; reconcile')
      const token = Object.freeze({})
      tokens.set(token, {
        before,
        after,
        steps,
        generation: next.editorGeneration,
        authority: { ...authority() },
      })
      return { generation: next.editorGeneration, undoToken: token }
    },
    undoBatch(token) {
      if (!token || typeof token !== 'object') throw Error('Unknown batch inverse')
      const entry = tokens.get(token)
      if (!entry) throw Error('Unknown batch inverse')
      const s = current(),
        a = authority()
      if (
        !mutationFence.snapshot().ready ||
        !canWrite() ||
        !editor.isEditable ||
        s.editorGeneration !== entry.generation ||
        a.fileId !== entry.authority.fileId ||
        a.baseRevision !== entry.authority.baseRevision ||
        a.leaseEpoch !== entry.authority.leaseEpoch ||
        !editor.state.doc.eq(entry.after)
      )
        throw Error('Batch inverse no longer current')
      let tr = editor.state.tr
      for (const step of entry.steps) tr = tr.step(step)
      if (!tr.doc.eq(entry.before)) throw Error('Invalid batch inverse')
      tokens.delete(token)
      dispatch(tr)
      const next = current()
      if (
        !mutationFence.snapshot().ready ||
        !editor.state.doc.eq(entry.before) ||
        next.editorGeneration !== entry.generation + 1
      )
        throw Error('Inverse outcome unknown')
      return next.editorGeneration
    },
    dispose() {
      if (disposed) return
      disposed = true
      editor.off('transaction', changed)
    },
  }
}
