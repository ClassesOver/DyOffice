import type { Editor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import { pendingDocumentOperation } from './pending-document-operation'
import { getActiveSubEditor, subscribeSubEditorState } from './active-editor'

// The document guard covers replacement/read-only/destroy; node identity binds
// the result to the picture originally selected, not a later selection.
export function pendingPictureOperation(editor: Editor, activeEditor = editor) {
  if (
    editor.isDestroyed ||
    activeEditor.isDestroyed ||
    !editor.isEditable ||
    !activeEditor.isEditable
  )
    return null
  const isActive = () => (getActiveSubEditor() ?? editor) === activeEditor
  if (!isActive()) return null
  const selected = activeEditor.state.selection
  if (!(selected instanceof NodeSelection)) return null
  const target = selected.node
  if (
    !(target.type.name === 'docProtected' && target.attrs.blockType === 'image') &&
    target.type.name !== 'docInlineImage'
  )
    return null
  // Switching ribbon targets cancels permanently, even if focus returns before
  // decoding finishes. Ordinary sub-editor transactions keep the same target.
  let switched = false
  const unsubscribe = subscribeSubEditorState(() => {
    if (!isActive()) switched = true
  })
  const document = pendingDocumentOperation(editor)
  const active = activeEditor === editor ? document : pendingDocumentOperation(activeEditor)
  return {
    current: () =>
      !switched &&
      isActive() &&
      document.current() &&
      active.current() &&
      activeEditor.state.selection instanceof NodeSelection &&
      activeEditor.state.selection.node === target,
    dispose: () => {
      unsubscribe()
      document.dispose()
      if (active !== document) active.dispose()
    },
  }
}
