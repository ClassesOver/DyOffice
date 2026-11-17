/**
 * A keystroke that landed on the streaming tail of a large document while it
 * was still loading used to vanish whole. The boundary guard refused the
 * transaction, so the document never changed, no undo step was recorded, and
 * Ctrl+Z had nothing to bring back — the user could not even tell that
 * anything had happened. The guard may still refuse the *position* (an edit
 * there would land in front of blocks still to come), but the text itself is
 * held until the tail has streamed in and is then inserted as a normal,
 * undoable edit.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Extension, textInputRule, Editor } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { history } from '@tiptap/pm/history'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { PHASED_APPEND } from '../src/renderer/editor/streaming-tail-guard'
import { appendStreamedNodes } from '../src/renderer/file-actions'
import {
  PHASE1_BLOCKS,
  PHASED_MIN_BLOCKS,
  cancelPhasedContent,
  isPhasedContentPending,
  setContentPhased,
  type PhasedContentHost,
} from '../src/renderer/phased-content'

interface JsonNode {
  type: string
  attrs?: Record<string, unknown>
  content?: JsonNode[]
  text?: string
}
const para = (t: string): JsonNode => ({
  type: 'docParagraph',
  attrs: { docxIndex: null },
  content: [{ type: 'text', text: t }],
})

const liveEditors: Editor[] = []
afterEach(() => {
  cancelPhasedContent()
  for (const e of liveEditors.splice(0)) {
    const dom = e.view.dom
    e.destroy()
    dom.remove()
  }
})

function createEditor(extra: Extension[] = []): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [...editorExtensions, ...extra],
    content: { type: 'doc', content: [para('seed')] },
  })
  liveEditors.push(editor)
  return editor
}

function blockStart(editor: Editor, index: number): number {
  let pos = 0
  for (let i = 0; i < index; i++) pos += editor.state.doc.child(i).nodeSize
  return pos
}
const endOfBlock = (editor: Editor, index: number): number =>
  blockStart(editor, index) + editor.state.doc.child(index).nodeSize - 1

/** feed characters the way the browser does: through handleTextInput */
function type(editor: Editor, text: string): void {
  for (const ch of text) {
    const { view } = editor
    const { from, to } = view.state.selection
    const deflt = () => view.state.tr.insertText(ch, from, to)
    if (!view.someProp('handleTextInput', (f) => f(view, from, to, ch, deflt)))
      view.dispatch(deflt())
  }
}

/** mounts the first phase and returns the scheduled tail chunks */
function startStreamingOpen(editor: Editor, blocks: number): Array<() => void> {
  const chunks: Array<() => void> = []
  const host: PhasedContentHost = {
    setContent: (doc) =>
      editor
        .chain()
        .setMeta('addToHistory', false)
        .setMeta(PHASED_APPEND, true)
        .setContent(doc as never)
        .run(),
    appendNodes: (nodes) => appendStreamedNodes(editor, nodes as never),
    isDestroyed: () => editor.isDestroyed,
    resetHistory: () => {
      editor.unregisterPlugin('history')
      editor.registerPlugin(history())
    },
    setLoading: () => {},
    getDirty: () => false,
    setDirty: () => {},
  }
  const doc = { type: 'doc', content: Array.from({ length: blocks }, (_, i) => para(`block ${i}`)) }
  setContentPhased(host, doc as never, (cb) => chunks.push(cb))
  return chunks
}

const TAIL_DOC = PHASED_MIN_BLOCKS + 10

describe('typing on the streaming tail of a phased open', () => {
  it('keeps the character and inserts it as an undoable edit once the tail lands', () => {
    const editor = createEditor()
    const chunks = startStreamingOpen(editor, TAIL_DOC)
    const mounted = editor.state.doc.childCount
    expect(mounted).toBe(PHASE1_BLOCKS)
    expect(mounted).toBeLessThan(TAIL_DOC)
    expect(isPhasedContentPending()).toBe(true)

    // the caret sits at the end of the last mounted block: the tail boundary
    editor.commands.setTextSelection(endOfBlock(editor, mounted - 1))
    type(editor, 'Z')

    // the tail has not landed, so nothing may have been inserted in its place
    expect(editor.state.doc.child(mounted - 1).textContent).toBe(`block ${mounted - 1}`)

    while (chunks.length) chunks.shift()!()
    expect(isPhasedContentPending()).toBe(false)
    expect(editor.state.doc.childCount).toBe(TAIL_DOC)

    // the character survived the stream, at the position it was typed
    expect(editor.state.doc.child(mounted - 1).textContent).toBe(`block ${mounted - 1}Z`)

    // and it is a normal edit, so Ctrl+Z brings it back
    editor.commands.undo()
    expect(editor.state.doc.child(mounted - 1).textContent).toBe(`block ${mounted - 1}`)
    expect(editor.state.doc.childCount).toBe(TAIL_DOC)
  })

  it('keeps the held character through an insert at the document start', () => {
    const editor = createEditor()
    const chunks = startStreamingOpen(editor, TAIL_DOC)
    const mounted = editor.state.doc.childCount
    editor.commands.setTextSelection(endOfBlock(editor, mounted - 1))
    type(editor, 'Z')
    // from = 0 like a remount, but it only grows the document
    editor.view.dispatch(editor.state.tr.insert(0, editor.schema.nodes.docParagraph.create()))
    while (chunks.length) chunks.shift()!()
    expect(editor.state.doc.child(mounted).textContent).toBe(`block ${mounted - 1}Z`)
  })

  it('inserts a keystroke in a mounted block immediately, without holding it', () => {
    const editor = createEditor()
    const chunks = startStreamingOpen(editor, TAIL_DOC)
    expect(isPhasedContentPending()).toBe(true)

    editor.commands.setTextSelection(endOfBlock(editor, 0))
    type(editor, 'Z')

    // typed where the guard allows it: applied at once, never queued
    expect(editor.state.doc.child(0).textContent).toBe('block 0Z')
    while (chunks.length) chunks.shift()!()
    expect(editor.state.doc.child(0).textContent).toBe('block 0Z')
    expect(editor.state.doc.childCount).toBe(TAIL_DOC)
  })
})

// These are DOM/input mapping regressions, not browser IME lifecycle acceptance.
describe('streaming input selection and cancellation', () => {
  function setup() {
    const editor = createEditor()
    const chunks = startStreamingOpen(editor, TAIL_DOC)
    const last = editor.state.doc.childCount - 1
    const at = endOfBlock(editor, last)
    const finish = () => {
      while (chunks.length) chunks.shift()!()
    }
    return { editor, last, at, finish }
  }
  function input(editor: Editor, from: number, to: number, text: string) {
    const { view } = editor
    const deflt = () => view.state.tr.insertText(text, from, to)
    const handled = view.someProp('handleTextInput', (f) => f(view, from, to, text, deflt))
    if (!handled) view.dispatch(deflt())
    return handled
  }
  it('keeps the typing run and caret together across a real history reset', () => {
    const { editor, last, at, finish } = setup()
    editor.commands.setTextSelection(at)
    type(editor, 'L')
    finish()
    type(editor, 'ost response native draft')
    expect(editor.state.doc.child(last).textContent).toBe(`block ${last}Lost response native draft`)
    expect(editor.state.doc.firstChild!.textContent).toBe('block 0')
  })
  for (const inserted of ['L', '中文']) {
    it(`accepts the real DOM-diff input caret for ${inserted.length} characters`, () => {
      const { editor, last, at, finish } = setup()
      document.body.append(editor.view.dom)
      editor.commands.setTextSelection(1)
      editor.view.focus()
      let observed: unknown
      editor.setOptions({
        editorProps: {
          handleTextInput(view, from, _to, _text, deflt) {
            observed = { from, pm: view.state.selection.head, defaultHead: deflt().selection.head }
            return false
          },
        },
      })
      const paragraph = editor.view.nodeDOM(blockStart(editor, last)) as HTMLElement
      const text = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT).nextNode() as Text
      text.appendData(inserted)
      document.getSelection()!.collapse(text, text.length)
      ;(editor.view as unknown as { domObserver: { flush(): void } }).domObserver.flush()
      expect(observed).toEqual({ from: at, pm: 1, defaultHead: at + inserted.length })
      finish()
      const suffix = inserted === 'L' ? 'ost response native draft' : '后续'
      type(editor, suffix)
      expect(editor.state.doc.child(last).textContent).toBe(`block ${last}${inserted}${suffix}`)
      expect(editor.state.doc.firstChild!.textContent).toBe('block 0')
    })
  }
  it('does not pull a deliberately moved caret back to the held input', () => {
    const { editor, last, at, finish } = setup()
    editor.commands.setTextSelection(at)
    type(editor, 'L')
    editor.commands.setTextSelection(1)
    finish()
    type(editor, 'front')
    expect(editor.state.doc.firstChild!.textContent).toBe('frontblock 0')
    expect(editor.state.doc.child(last).textContent).toBe(`block ${last}L`)
  })
  it('accepts a multi-character input caret without marking buffered text dirty', () => {
    const { editor, last, at, finish } = setup()
    let updates = 0
    editor.on('update', () => updates++)
    editor.commands.setTextSelection(1)
    expect(input(editor, at, at, '中文')).toBe(true)
    expect(editor.state.selection.head).toBe(at)
    expect(updates).toBe(0)
    finish()
    expect(editor.state.selection.head).toBe(at + 2)
    expect(editor.state.doc.child(last).textContent).toBe(`block ${last}中文`)
    editor.commands.undo()
    expect(editor.state.doc.child(last).textContent).toBe(`block ${last}`)
  })
  it('releases cancelled-stream input before the next character in the same typing run', () => {
    const { editor, last, at } = setup()
    editor.commands.setTextSelection(at)
    type(editor, 'L')
    cancelPhasedContent()
    type(editor, 'ost')
    expect(editor.state.doc.child(last).textContent).toBe(`block ${last}Lost`)
  })
  it('maps a multi-character input after cancellation and preserves undo', () => {
    const { editor, last, at } = setup()
    editor.commands.setTextSelection(at)
    input(editor, at, at, '中文')
    cancelPhasedContent()
    input(editor, at, at, '字词')
    expect(editor.state.doc.child(last).textContent).toBe(`block ${last}中文字词`)
    expect(editor.state.selection.head).toBe(at + 4)
    editor.commands.undo()
    expect(editor.state.doc.child(last).textContent).toBe(`block ${last}`)
  })
  it('cancellation replay respects a caret deliberately moved before the next input', () => {
    const { editor, last, at } = setup()
    editor.commands.setTextSelection(at)
    type(editor, 'L')
    editor.commands.setTextSelection(1)
    cancelPhasedContent()
    type(editor, 'front')
    expect(editor.state.doc.firstChild!.textContent).toBe('frontblock 0')
    expect(editor.state.doc.child(last).textContent).toBe(`block ${last}L`)
    editor.commands.undo()
    expect(editor.state.doc.firstChild!.textContent).toBe('block 0')
    expect(editor.state.doc.child(last).textContent).toBe(`block ${last}L`)
    editor.commands.undo()
    expect(editor.state.doc.child(last).textContent).toBe(`block ${last}`)
  })
  it('never replays held input into a replacement document', () => {
    const { editor, at } = setup()
    editor.commands.setTextSelection(at)
    type(editor, 'L')
    cancelPhasedContent()
    editor.commands.setContent({ type: 'doc', content: [para('replacement')] })
    editor.commands.setTextSelection(1)
    type(editor, 'new ')
    expect(editor.state.doc.textContent).toBe('new replacement')
  })
  it('maps a deliberate selection replacement without consuming held text elsewhere', () => {
    const { editor, last, at } = setup()
    editor.commands.setTextSelection(at)
    type(editor, 'L')
    editor.commands.setTextSelection({ from: 1, to: 6 })
    cancelPhasedContent()
    type(editor, 'new')
    expect(editor.state.doc.firstChild!.textContent).toBe('new 0')
    expect(editor.state.doc.child(last).textContent).toBe(`block ${last}L`)
  })
})

it('late input rule still applies on cancel next key', () => {
  const editor = createEditor([
    Extension.create({
      name: 'lateRule',
      priority: 1,
      addInputRules() {
        return [textInputRule({ find: /x$/, replace: 'RULE' })]
      },
    }),
  ])
  startStreamingOpen(editor, TAIL_DOC)
  const mounted = editor.state.doc.childCount
  editor.commands.setTextSelection(endOfBlock(editor, mounted - 1))
  type(editor, 'L')
  editor.commands.setTextSelection(1)
  cancelPhasedContent()
  type(editor, 'x')
  expect(editor.state.doc.firstChild!.textContent).toBe('RULEblock 0')
})
it('real DOM composition metadata survives cancellation', () => {
  const editor = createEditor()
  editor.setOptions({ editorProps: { handleScrollToSelection: () => true } })
  startStreamingOpen(editor, TAIL_DOC)
  document.body.append(editor.view.dom)
  const mounted = editor.state.doc.childCount
  editor.commands.setTextSelection(endOfBlock(editor, mounted - 1))
  type(editor, 'L')
  editor.commands.setTextSelection(1)
  cancelPhasedContent()
  editor.view.focus()
  const seen: unknown[] = []
  editor.on('transaction', ({ transaction }) => {
    if (transaction.docChanged) seen.push(transaction.getMeta('composition'))
  })
  const paragraph = editor.view.nodeDOM(0) as HTMLElement
  const text = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT).nextNode() as Text
  ;(
    editor.view as unknown as { input: { compositionPendingChanges: number } }
  ).input.compositionPendingChanges = 17
  text.insertData(0, '文')
  document.getSelection()!.collapse(text, 1)
  ;(editor.view as unknown as { domObserver: { flush(): void } }).domObserver.flush()
  expect(editor.state.doc.firstChild!.textContent).toBe('文block 0')
  expect(seen).toContain(17)
})

it('preserves a DOM parsed caret inside multi-character input on cancellation', () => {
  const editor = createEditor()
  editor.setOptions({ editorProps: { handleScrollToSelection: () => true } })
  startStreamingOpen(editor, TAIL_DOC)
  document.body.append(editor.view.dom)
  editor.commands.setTextSelection(endOfBlock(editor, editor.state.doc.childCount - 1))
  type(editor, 'L')
  editor.commands.setTextSelection(1)
  cancelPhasedContent()
  editor.view.focus()
  const text = document
    .createTreeWalker(editor.view.nodeDOM(0) as HTMLElement, NodeFilter.SHOW_TEXT)
    .nextNode() as Text
  text.insertData(0, '中文')
  document.getSelection()!.collapse(text, 1)
  ;(editor.view as unknown as { domObserver: { flush(): void } }).domObserver.flush()
  expect(editor.state.doc.firstChild!.textContent).toBe('中文block 0')
  expect(editor.state.selection.head).toBe(2)
})

it('maps through a plugin transaction appended to the held replay', () => {
  let enabled = false
  const editor = createEditor([
    Extension.create({
      name: 'replayAppend',
      addProseMirrorPlugins() {
        return [
          new Plugin({
            appendTransaction(trs, _old, state) {
              if (!enabled || !trs.some((tr) => tr.docChanged)) return null
              enabled = false
              return state.tr.insertText('prefix', 1)
            },
          }),
        ]
      },
    }),
  ])
  startStreamingOpen(editor, TAIL_DOC)
  const last = editor.state.doc.childCount - 1
  editor.commands.setTextSelection(endOfBlock(editor, last))
  type(editor, 'L')
  cancelPhasedContent()
  enabled = true
  type(editor, 'ost')
  expect(editor.state.doc.firstChild!.textContent).toBe('prefixblock 0')
  expect(editor.state.doc.child(last).textContent).toBe(`block ${last}Lost`)
})

it('retains default marks/time/scroll and does not re-run earlier handlers', () => {
  const editor = createEditor()
  startStreamingOpen(editor, TAIL_DOC)
  const last = editor.state.doc.childCount - 1
  editor.commands.setTextSelection(endOfBlock(editor, last))
  type(editor, 'L')
  cancelPhasedContent()
  let visits = 0
  editor.setOptions({
    editorProps: {
      handleTextInput() {
        visits++
        return false
      },
      handleScrollToSelection: () => true,
    },
  })
  const { view } = editor,
    { from, to } = view.state.selection
  const mark = editor.schema.marks.bold.create()
  let applied: import('@tiptap/pm/state').Transaction | undefined
  editor.on('transaction', ({ transaction }) => {
    if (transaction.time === 321) applied = transaction
  })
  const deflt = () =>
    view.state.tr.insertText('中文', from, to).setStoredMarks([mark]).setTime(321).scrollIntoView()
  expect(view.someProp('handleTextInput', (f) => f(view, from, to, '中文', deflt))).toBe(true)
  expect(visits).toBe(1)
  expect(editor.state.doc.child(last).textContent).toBe(`block ${last}L中文`)
  expect(applied?.storedMarks).toEqual([mark])
  expect(applied?.scrolledIntoView).toBe(true)
})
