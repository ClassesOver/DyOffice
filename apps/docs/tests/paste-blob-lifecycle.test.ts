import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { pastePayload } from '../src/renderer/editor/paste-actions'

let editor: Editor
let reader: ControlledReader
let finishDecode: (error?: boolean) => void
class ControlledReader {
  result: string | null = null
  onload: (() => unknown) | null = null
  onerror: (() => unknown) | null = null
  onabort: (() => unknown) | null = null
  constructor() { reader = this }
  readAsDataURL() {}
  async finish() { this.result = 'data:image/png;base64,cHJpdmF0ZQ=='; await this.onload?.() }
}
const doc = (text: string) => ({ type: 'doc', content: [{ type: 'docParagraph', content: [{ type: 'text', text }] }] })
const paste = () => pastePayload(editor, { html: '', text: '', image: new Blob(['private']) }, 'picture')
const images = () => { const out: string[] = []; editor.state.doc.descendants(n => { if (n.attrs.blockType === 'image') out.push(n.attrs.imageDataUrl) }); return out }
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
beforeEach(() => {
  editor = new Editor({ element: document.createElement('div'), extensions: editorExtensions, content: doc('original') })
  vi.stubGlobal('FileReader', ControlledReader)
  vi.stubGlobal('Image', class {
    onload: (() => void) | null = null; onerror: (() => void) | null = null
    naturalWidth = 120; naturalHeight = 60
    set src(_value: string) { finishDecode = error => error ? this.onerror?.() : this.onload?.() }
  })
})
afterEach(() => { editor.destroy(); vi.unstubAllGlobals() })
it.each([true, false])('cancels replaced document while FileReader pending (emitUpdate %s)', async emitUpdate => {
  paste(); editor.commands.setContent(doc('replacement'), { emitUpdate }); const before = editor.getJSON()
  const pending = reader.finish(); await tick(); finishDecode?.(); await pending; await tick()
  expect(editor.getJSON()).toEqual(before)
})
it('cancels replacement during image decode', async () => {
  paste(); const pending = reader.finish(); await tick()
  editor.commands.setContent(doc('replacement')); const before = editor.getJSON()
  finishDecode(); await pending; await tick(); expect(editor.getJSON()).toEqual(before)
})
it('allows normal editing during both awaits', async () => {
  expect(paste()).toBe(true); editor.commands.insertContent('one')
  const pending = reader.finish(); await tick(); editor.commands.insertContent('two')
  finishDecode(); await pending; await tick(); expect(images()).toEqual(['data:image/png;base64,cHJpdmF0ZQ=='])
  expect(editor.getText()).toContain('one'); expect(editor.getText()).toContain('two')
})
it.each(['error', 'abort'])('preserves document on read %s', async event => {
  const before = editor.getJSON(); paste(); await (event === 'error' ? reader.onerror?.() : reader.onabort?.()); await tick()
  expect(editor.getJSON()).toEqual(before)
})
it('preserves document on decode failure', async () => {
  const before = editor.getJSON(); paste(); const pending = reader.finish(); await tick(); finishDecode(true)
  await pending; await tick(); expect(editor.getJSON()).toEqual(before)
})
it('cancels destroyed editor while reading', async () => {
  paste(); editor.destroy(); const before = editor.getJSON(); const pending = reader.finish(); await tick()
  finishDecode?.(); await pending; await tick(); expect(editor.getJSON()).toEqual(before)
})
it.each([true, false])('cancels even identical replacement (emitUpdate %s)', async emitUpdate => {
  paste(); editor.commands.setContent(editor.getJSON(), { emitUpdate }); const before = editor.getJSON()
  const pending = reader.finish(); await tick(); await pending; expect(editor.getJSON()).toEqual(before)
})
it('cancels destroyed editor during decode', async () => {
  paste(); const pending = reader.finish(); await tick(); editor.destroy(); const before = editor.getJSON()
  finishDecode(); await pending; expect(editor.getJSON()).toEqual(before)
})
it.each(['error', 'abort', 'success', 'decodeError', 'replacement'])('releases transaction guard after %s', async event => {
  const on = vi.spyOn(editor, 'on'); const off = vi.spyOn(editor, 'off'); paste()
  const callback = on.mock.calls.find(([name]) => name === 'transaction')?.[1]
  expect(callback).toBeTypeOf('function')
  if (event === 'error') await reader.onerror?.()
  else if (event === 'abort') await reader.onabort?.()
  else {
    if (event === 'replacement') editor.commands.setContent(doc('replacement'))
    const pending = reader.finish(); await tick()
    if (event !== 'replacement') finishDecode(event === 'decodeError')
    await pending
  }
  expect(off).toHaveBeenCalledWith('transaction', callback)
})
