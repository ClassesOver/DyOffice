import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection, type Transaction } from '@tiptap/pm/state'
import { Mapping } from '@tiptap/pm/transform'
import type { EditorView } from '@tiptap/pm/view'
import { PHASED_CONTENT_SETTLED_EVENT, isPhasedContentPending } from '../phased-content'

/** set on the transactions that append a streamed chunk */
export const PHASED_APPEND = 'phasedAppend'

/**
 * A phased open streams the document tail in behind the first screens. The
 * editor stays editable meanwhile; only the append boundary is off limits:
 * an edit inside or after the last mounted block would land in front of the
 * blocks still to come. Saves already wait for the full content.
 *
 * Refusing that position must not swallow the keystroke with it. A filtered
 * transaction leaves nothing behind — no state change, no undo step, nothing
 * on screen — so a character typed at the boundary simply disappeared and
 * Ctrl+Z had nothing to bring back. Typed text is therefore held here until
 * the tail has landed and then inserted as an ordinary, undoable edit at the
 * position it was typed. Everything else still goes through the guard as
 * before.
 */
export function touchesStreamingTail(tr: Transaction): boolean {
  if (!tr.docChanged || tr.getMeta(PHASED_APPEND)) return false
  const last = tr.before.lastChild
  const tailStart = tr.before.content.size - (last?.nodeSize ?? 0)
  let touches = false
  // only the first step's ranges are in `before` coordinates; a multi-step
  // transaction is judged on its earliest step (later steps build on it)
  tr.mapping.maps[0]?.forEach((_oldStart, oldEnd) => {
    if (oldEnd >= tailStart) touches = true
  })
  if (tr.mapping.maps.length === 0 && tr.steps.length > 0) touches = true
  return touches
}

/** text typed at the boundary while the tail was still streaming */
interface HeldText {
  /** insertion point, remapped as later edits shift the document */
  at: number
  text: string
}

/**
 * True when a step replaces the whole document — a remount after a refused
 * chunk, or a different file. Typed text cannot survive one of those, and
 * replaying it would paste it into whatever document took its place. An
 * insert at the document start also has from = 0, so the step must reach the
 * end of the document it was applied to.
 */
function replacesWholeDocument(tr: Transaction): boolean {
  return tr.steps.some((step, i) => {
    const s = step as { from?: unknown; to?: unknown }
    return (
      typeof s.from === 'number' &&
      typeof s.to === 'number' &&
      s.from === 0 &&
      s.to >= tr.docs[i]!.content.size
    )
  })
}

export const StreamingTailGuardExtension = Extension.create({
  name: 'streamingTailGuard',
  addProseMirrorPlugins() {
    // per editor: held text belongs to one document, never to two
    const guardKey = new PluginKey()
    let held: HeldText | null = null
    let replayMapping: Mapping | null = null
    const insertHeld = (view: EditorView): Mapping | null => {
      const pending = held
      held = null
      if (!pending || view.isDestroyed) return null
      // the stream only ever added blocks after this point, so the recorded
      // position still addresses the same text; clamp for a short document
      const at = Math.min(pending.at, view.state.doc.content.size)
      const tr = view.state.tr.insertText(pending.text, at)
      const mapping = new Mapping()
      replayMapping = mapping
      try {
        view.dispatch(tr)
      } finally {
        replayMapping = null
      }
      return mapping
    }
    return [
      new Plugin({
        key: guardKey,
        filterTransaction: (tr) => !isPhasedContentPending() || !touchesStreamingTail(tr),
        appendTransaction: (trs) => {
          if (replayMapping) for (const tr of trs) replayMapping.appendMapping(tr.mapping)
          if (!held) return null
          for (const tr of trs) {
            if (!tr.docChanged) continue
            // the document this text was typed into is gone: drop it rather
            // than paste it into whatever replaced it
            if (replacesWholeDocument(tr)) {
              held = null
              return null
            }
            // otherwise follow the text the caret was on as an edit shifts it
            held.at = tr.mapping.map(held.at)
          }
          return null
        },
        props: {
          handleTextInput: function handleTextInput(view, from, to, text, deflt) {
            if (!isPhasedContentPending()) {
              // a cancelled stream never announces itself, so release what it
              // held the next time the user types in this editor
              if (!held) return false
              // Capture the DOM input before replay changes its coordinate space.
              const original = deflt()
              const released = insertHeld(view)!
              const start = released.map(from),
                end = released.map(to)
              const mappedDefault = () => {
                const tr = view.state.tr.setTime(original.time)
                let mapping = released
                for (const step of original.steps) {
                  const mapped = step.map(mapping)
                  if (mapped) tr.step(mapped)
                  const next = new Mapping([step.getMap().invert()])
                  next.appendMapping(mapping)
                  if (mapped) next.appendMap(mapped.getMap(), 0)
                  mapping = next
                }
                tr.setSelection(original.selection.map(tr.doc, mapping))
                if (original.storedMarksSet) tr.setStoredMarks(original.storedMarks)
                // ProseMirror's DOM-input default sets composition and scroll.
                const composition = original.getMeta('composition')
                if (composition !== undefined) tr.setMeta('composition', composition)
                if (original.scrolledIntoView) tr.scrollIntoView()
                return tr
              }
              // Continue only the handlers after this guard. Restarting the full
              // chain would run higher-priority handlers twice for one input.
              let afterGuard = false
              const handled = view.someProp('handleTextInput', (handler) => {
                if (handler === guardKey.get(view.state)?.props.handleTextInput) {
                  afterGuard = true
                  return false
                }
                return afterGuard ? handler(view, start, end, text, mappedDefault) : false
              })
              if (!handled) view.dispatch(mappedDefault())
              return true
            }
            // a keystroke the guard would allow takes the normal path
            if (!touchesStreamingTail(view.state.tr.insertText(text, from, to))) return false
            // a selection replace is a deletion: replaying it once the tail has
            // landed could cut streamed blocks out, so it stays refused
            if (from !== to) return false
            // consecutive characters share a position, so they read as one word
            held = held?.at === from ? { at: from, text: held.text + text } : { at: from, text }
            // DOM-diff input may arrive before selectionchange updates PM.
            // The default transaction would accept that input's caret too;
            // buffering its text must not leave subsequent keys at the old
            // selection. This selection-only transaction is not an edit.
            if (view.state.selection.from !== from || !view.state.selection.empty) {
              view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from)))
            }
            return true
          },
        },
        view: (view) => {
          const onSettled = (): void => {
            insertHeld(view)
          }
          document.addEventListener(PHASED_CONTENT_SETTLED_EVENT, onSettled)
          return {
            destroy: () => document.removeEventListener(PHASED_CONTENT_SETTLED_EVENT, onSettled),
          }
        },
      }),
    ]
  },
})
