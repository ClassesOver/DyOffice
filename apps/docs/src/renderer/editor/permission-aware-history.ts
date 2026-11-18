import { UndoRedo } from '@tiptap/extensions'
import { redo, undo } from '@tiptap/pm/history'

/**
 * History changes the body, even when its last step only changed a comment anchor.
 * Check at execution time so command chains and inherited keyboard shortcuts cannot
 * replay body edits after a permission change. Comment-only protection still permits
 * explicit comment actions, but must not unlock the body's mixed undo history.
 */
export const PermissionAwareUndoRedo = UndoRedo.extend({
  addCommands() {
    return {
      undo: () => ({ state, dispatch }) => this.editor.isEditable && undo(state, dispatch),
      redo: () => ({ state, dispatch }) => this.editor.isEditable && redo(state, dispatch),
    }
  },
})
