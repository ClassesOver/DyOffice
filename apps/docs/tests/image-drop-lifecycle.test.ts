import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { insertImageFilesAt } from '../src/renderer/editor/image-drop'
let editor: Editor
let readers: Reader[]
let images: Decode[]
class Reader {
  result: string | null = null
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  readAsDataURL() { readers.push(this) }
  finish() { this.result = 'data:image/png;base64,aGVsbG8='; this.onload?.() }
}
class Decode {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  naturalWidth = 100; naturalHeight = 50
  set src(_v: string) { images.push(this) }
}
const file = () => new File(['image'], 'private.png', { type: 'image/png' })
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
beforeEach(() => {
  readers = []; images = []
  vi.stubGlobal('FileReader', Reader); vi.stubGlobal('Image', Decode)
  editor = new Editor({ element: document.createElement('div'), extensions: editorExtensions,
    content: { type: 'doc', content: [{ type: 'docParagraph', content: [{ type: 'text', text: 'Original' }] }] } })
})
afterEach(() => { editor.destroy(); vi.unstubAllGlobals() })
it.each(['read', 'decode'])('does not insert after replacement during %s', async phase => {
  const pending = insertImageFilesAt(editor, [file()], 1)
  if (phase === 'decode') { readers[0].finish(); await flush() }
  editor.commands.setContent('<p>Replacement</p>')
  const expected = editor.getJSON()
  if (phase === 'read') { readers[0].finish(); await flush() }
  images[0]?.onload?.()
  expect(await pending).toBe(0)
  expect(editor.getJSON()).toEqual(expected)
})
it.each([true, false])('cancels same-content replacement emitUpdate=%s', async emitUpdate => {
  const before = editor.getJSON()
  const pending = insertImageFilesAt(editor, [file()], 1)
  editor.commands.setContent(before, { emitUpdate })
  readers[0].finish(); await flush(); images[0]?.onload?.()
  expect(await pending).toBe(0); expect(editor.getJSON()).toEqual(before)
})
it('preserves ordinary typing, selection changes, and normal multiple images', async () => {
  const pending = insertImageFilesAt(editor, [file(), file()], 1)
  editor.commands.insertContent('typed ')
  readers[0].finish(); await flush()
  editor.commands.setTextSelection(2)
  images[0].onload?.(); await flush()
  expect(readers).toHaveLength(2)
  readers[1].finish(); await flush(); images[1].onload?.()
  expect(await pending).toBe(2)
  expect(editor.getText()).toContain('Original')
  const found: string[] = []
  editor.state.doc.descendants(n => { if(n.attrs.blockType === 'image') found.push(n.attrs.imageDataUrl) })
  expect(found).toHaveLength(2)
})
it.each(['read', 'decode'])('stops after destroy during %s', async phase => {
  const pending = insertImageFilesAt(editor, [file(), file()], 1)
  if (phase === 'decode') { readers[0].finish(); await flush() }
  editor.destroy()
  if (phase === 'read') { readers[0].finish(); await flush() }
  images[0]?.onload?.()
  expect(await pending).toBe(0); expect(readers).toHaveLength(1)
})
it.each(['read', 'decode'])('continues after a current %s error and disposes listener', async phase => {
  const on = vi.spyOn(editor, 'on'); const off = vi.spyOn(editor, 'off')
  const pending = insertImageFilesAt(editor, [file(), file()], 1)
  if (phase === 'read') readers[0].onerror?.()
  else { readers[0].finish(); await flush(); images[0].onerror?.() }
  await flush(); readers[1].finish(); await flush(); images.at(-1)?.onload?.()
  expect(await pending).toBe(1)
  const listener = on.mock.calls.find(c => c[0] === 'transaction')?.[1]
  expect(off).toHaveBeenCalledWith('transaction', listener)
})
it('stops the rest of the batch if the document changes after the first image', async () => {
  const pending = insertImageFilesAt(editor, [file(), file(), file()], 1)
  readers[0].finish(); await flush(); images[0].onload?.(); await flush()
  editor.commands.setContent('<p>New document</p>'); const before = editor.getJSON()
  readers[1].finish(); await flush(); images[1]?.onload?.()
  expect(await pending).toBe(1); expect(editor.getJSON()).toEqual(before)
  expect(readers).toHaveLength(2)
})
it('releases its listener if readAsDataURL throws synchronously', async () => {
  const on = vi.spyOn(editor, 'on'); const off = vi.spyOn(editor, 'off')
  vi.spyOn(Reader.prototype, 'readAsDataURL').mockImplementationOnce(() => { throw new Error('read failed') })
  await expect(insertImageFilesAt(editor, [file()], 1)).rejects.toThrow('read failed')
  expect(off).toHaveBeenCalledWith('transaction', on.mock.calls.find(c => c[0] === 'transaction')?.[1])
})
it.each(['success', 'replacement', 'destroy', 'read-error', 'decode-error'])('releases the document listener after %s', async outcome => {
  const on = vi.spyOn(editor, 'on'); const off = vi.spyOn(editor, 'off')
  const pending = insertImageFilesAt(editor, [file()], 1)
  if (outcome === 'replacement') editor.commands.setContent('<p>New</p>')
  if (outcome === 'destroy') editor.destroy()
  if (outcome === 'read-error') readers[0].onerror?.()
  else { readers[0].finish(); await flush(); if (outcome === 'decode-error') images[0]?.onerror?.(); else images[0]?.onload?.() }
  await pending
  expect(off).toHaveBeenCalledWith('transaction', on.mock.calls.find(c => c[0] === 'transaction')?.[1])
})
