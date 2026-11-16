import { afterEach, expect, test, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { Plugin, TextSelection } from '@tiptap/pm/state'
import { createDocumentMutationFence } from '../src/renderer/document-mutation-fence'
const modelModule = (await import('../src/renderer/editor/controlled-text-model').catch(
  () => ({}),
)) as any
let captured: Editor
const models: { dispose(): void }[] = []
afterEach(() => {
  for (const m of models.splice(0)) m.dispose()
  vi.restoreAllMocks()
})
function setup() {
  expect(typeof modelModule.createControlledTextModel).toBe('function')
  const mount = Editor.prototype.mount
  vi.spyOn(Editor.prototype, 'mount').mockImplementation(function (this: Editor, el) {
    captured = this
    return mount.call(this, el)
  })
  let writable = true
  const model = modelModule.createControlledTextModel({
    paragraphs: ['hello world', 'second paragraph'],
    authority: () => ({ fileId: 'f', baseRevision: 'r1', leaseEpoch: 1 }),
    canWrite: () => writable,
    mutationFence: createDocumentMutationFence(),
  })
  models.push(model)
  return { model, editor: captured, setWritable: (v: boolean) => (writable = v) }
}
function envelope(model: any) {
  return {
    commandId: 'c',
    ...model.current(),
    argsHash: 'a'.repeat(64),
    payload: {
      toolName: 'docs.replace_text.v1',
      arguments: { from: 1, to: 6, expectedText: 'hello', replacement: 'welcome' },
    },
  }
}
test('real native detached model applies once without exposing editor', () => {
  const { model, editor } = setup()
  expect(Object.keys(model).sort()).toEqual(['current', 'dispose', 'paragraphs', 'tools'])
  expect(editor.state.doc.firstChild?.type.name).toBe('docParagraph')
  expect('docxIndex' in editor.state.doc.firstChild!.attrs).toBe(true)
  expect(document.body.contains(editor.view.dom)).toBe(false)
  expect(editor.isEditable).toBe(true)
  const e = envelope(model),
    r = model.tools.applyBatch(e)
  expect(r.generation).toBe(1)
  expect(model.paragraphs()).toEqual(['welcome world', 'second paragraph'])
  expect(() => model.tools.applyBatch(e)).toThrow()
})
test('foreign document selection and stored-mark dispatches are all rejected', () => {
  const { model, editor } = setup(),
    initial = editor.state
  editor.view.dispatch(editor.state.tr.insertText('evil', 1))
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 2)))
  editor.view.dispatch(editor.state.tr.setStoredMarks([]))
  expect(editor.state).toBe(initial)
  expect(model.current().editorGeneration).toBe(0)
  expect(model.paragraphs()[0]).toBe('hello world')
})
test('appendTransaction cannot consume an authorized transaction capability', () => {
  const { model, editor } = setup()
  editor.registerPlugin(
    new Plugin({
      appendTransaction: (trs) =>
        trs.some((t) => t.docChanged) ? editor.state.tr.insertText('evil', 1) : null,
    }),
  )
  model.tools.applyBatch(envelope(model))
  expect(model.paragraphs()[0]).toBe('welcome world')
  expect(model.current().editorGeneration).toBe(1)
})
test('reentrant foreign dispatch and reusing accepted transaction are rejected', () => {
  const { model, editor } = setup()
  let accepted: any
  editor.on('transaction', ({ transaction }) => {
    accepted = transaction
    editor.view.dispatch(editor.state.tr.insertText('evil', 1))
  })
  model.tools.applyBatch(envelope(model))
  expect(model.paragraphs()[0]).toBe('welcome world')
  expect(() => editor.view.dispatch(accepted)).not.toThrow()
  expect(model.paragraphs()[0]).toBe('welcome world')
  expect(model.current().editorGeneration).toBe(1)
})
test('async late dispatch has no capability', async () => {
  const { model, editor } = setup()
  model.tools.applyBatch(envelope(model))
  await Promise.resolve()
  editor.view.dispatch(editor.state.tr.insertText('evil', 1))
  expect(model.paragraphs()[0]).toBe('welcome world')
})
test('host canWrite and disposed model fail closed', () => {
  const { model, setWritable } = setup(),
    e = envelope(model)
  setWritable(false)
  expect(() => model.tools.applyBatch(e)).toThrow()
  setWritable(true)
  model.dispose()
  expect(() => model.tools.applyBatch(e)).toThrow()
  expect(() => model.paragraphs()).toThrow()
})
test('nested adapter application inside a transaction listener is refused', () => {
  const { model, editor } = setup()
  let nestedError: unknown
  let once = false
  editor.on('transaction', () => {
    if (once) return
    once = true
    try {
      model.tools.applyBatch({
        ...envelope(model),
        commandId: 'nested',
        payload: {
          toolName: 'docs.replace_text.v1',
          arguments: { from: 1, to: 8, expectedText: 'welcome', replacement: 'evil' },
        },
      })
    } catch (e) {
      nestedError = e
    }
  })
  model.tools.applyBatch(envelope(model))
  expect(nestedError).toBeInstanceOf(Error)
  expect(model.paragraphs()[0]).toBe('welcome world')
  expect(model.current().editorGeneration).toBe(1)
})
test('throwing dispatch clears exact capability before a later retry', () => {
  const { model, editor } = setup(),
    e = envelope(model)
  const spy = vi.spyOn(editor.view, 'dispatch').mockImplementationOnce(() => {
    throw Error('synthetic dispatch failure')
  })
  expect(() => model.tools.applyBatch(e)).toThrow('synthetic')
  spy.mockRestore()
  editor.view.dispatch(editor.state.tr.insertText('evil', 1))
  expect(model.paragraphs()[0]).toBe('hello world')
  model.tools.applyBatch(e)
  expect(model.paragraphs()[0]).toBe('welcome world')
})
test('detached model blocks DOM input and does not mutate verified input strings', () => {
  const { model, editor } = setup()
  for (const type of ['beforeinput', 'keydown', 'paste', 'drop']) {
    const event = new Event(type, { bubbles: true, cancelable: true })
    editor.view.dom.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  }
  expect(model.paragraphs()).toEqual(['hello world', 'second paragraph'])
  expect(Object.isFrozen(model.paragraphs())).toBe(true)
})
test('model caps total UTF-8 bytes while retaining valid astral text', () => {
  const options = {
    authority: () => ({ fileId: 'f', baseRevision: 'r1', leaseEpoch: 1 }),
    canWrite: () => true,
    mutationFence: createDocumentMutationFence(),
  }
  expect(() =>
    modelModule.createControlledTextModel({
      ...options,
      paragraphs: Array(129).fill('x'.repeat(8192)),
    }),
  ).toThrow(/total|limit|large/i)
  const model = modelModule.createControlledTextModel({ ...options, paragraphs: ['😀 hello'] })
  models.push(model)
  expect(model.paragraphs()).toEqual(['😀 hello'])
})
