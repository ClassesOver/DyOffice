import type { Editor } from '@tiptap/core'

/** Tie an async operation to the current document, not to ordinary edits. */
export function pendingDocumentOperation(editor: Editor) {
  // setContent marks its transaction even with emitUpdate:false. Unlike doc
  // object identity this boundary does not invalidate ordinary typing/selection.
  // All open/new/reload/save-rebase paths use setContent (including phased loads).
  let replaced = false
  const onTransaction = ({
    transaction,
  }: {
    transaction: import('@tiptap/pm/state').Transaction
  }) => {
    if (transaction.getMeta('preventUpdate') !== undefined) replaced = true
  }
  const current = () => !replaced && !editor.isDestroyed && editor.isEditable
  editor.on('transaction', onTransaction)
  return { current, dispose: () => editor.off('transaction', onTransaction) }
}
