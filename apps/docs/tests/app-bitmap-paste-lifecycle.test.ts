import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import {
  insertImageFromDataUrl,
  insertImageViaDialog,
} from '../src/renderer/components/ribbon-tabs'
import * as pasteActions from '../src/renderer/editor/paste-actions'

// Execute the actual bitmap lane from App's native handlePaste, not a copy or
// mock of its async implementation. The real Editor and image helper are used.
const app = readFileSync('src/renderer/App.tsx', 'utf8')
const start = app.indexOf('        if (imageFile && (!text.trim() || imageOnlyHtml)) {')
const end = app.indexOf('        // bitmap-less web image copy:', start)
if (start < 0 || end < 0) throw Error('Native bitmap paste lane not found')
const nativePaste = new Function(
  'editorRef',
  'imageFile',
  'text',
  'imageOnlyHtml',
  'insertImageFromDataUrl',
  'insertBlobImage',
  app.slice(start, end),
)
let editor: Editor
let ref: { current: Editor | null }
let reader: ControlledReader
let decode: ((error?: boolean) => void) | undefined
class ControlledReader {
  result: string | null = null
  onload: (() => unknown) | null = null
  onerror: (() => unknown) | null = null
  onabort: (() => unknown) | null = null
  constructor() {
    reader = this
  }
  readAsDataURL() {}
  async finish() {
    this.result = 'data:image/png;base64,cHJpdmF0ZQ=='
    await this.onload?.()
  }
}
const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'docParagraph', content: [{ type: 'text', text }] }],
})
const paste = (text = '', imageOnly = false) =>
  nativePaste(
    ref,
    new Blob(['private']),
    text,
    imageOnly,
    insertImageFromDataUrl,
    pasteActions.insertBlobImage,
  )
const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
const finish = async () => {
  const pending = reader.finish()
  await tick()
  decode?.()
  await pending
  await tick()
}
beforeEach(() => {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: doc('original'),
  })
  ref = { current: editor }
  decode = undefined
  vi.stubGlobal('FileReader', ControlledReader)
  vi.stubGlobal(
    'Image',
    class {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      naturalWidth = 120
      naturalHeight = 60
      set src(_value: string) {
        decode = (error) => (error ? this.onerror?.() : this.onload?.())
      }
    },
  )
})
afterEach(() => {
  editor.destroy()
  vi.unstubAllGlobals()
})
it.each([true, false])(
  'native bitmap paste cancels replacement while reading (emitUpdate %s)',
  async (emitUpdate) => {
    expect(paste()).toBe(true)
    editor.commands.setContent(doc('replacement'), { emitUpdate })
    const before = editor.getJSON()
    await finish()
    expect(editor.getJSON()).toEqual(before)
  },
)
it('native bitmap paste cancels replacement during decode', async () => {
  paste()
  const pending = reader.finish()
  await tick()
  editor.commands.setContent(doc('replacement'))
  const before = editor.getJSON()
  decode?.()
  await pending
  await tick()
  expect(editor.getJSON()).toEqual(before)
})
it('does not adopt a different editorRef while reading', async () => {
  paste()
  const replacement = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: doc('replacement'),
  })
  const before = replacement.getJSON()
  editor.destroy()
  ref.current = replacement
  try {
    await finish()
    expect(replacement.getJSON()).toEqual(before)
  } finally {
    replacement.destroy()
  }
})
it('preserves normal edits and image-only HTML source URL paste', async () => {
  expect(paste('https://example.test/picture.png', true)).toBe(true)
  editor.commands.insertContent('one')
  const pending = reader.finish()
  await tick()
  editor.commands.insertContent('two')
  decode?.()
  await pending
  await tick()
  let count = 0
  editor.state.doc.descendants((n) => {
    if (n.attrs.blockType === 'image') count++
  })
  expect(count).toBe(1)
  expect(editor.getText()).toContain('one')
  expect(editor.getText()).toContain('two')
})
it('leaves ordinary mixed text/bitmap to the remaining paste lanes', () => {
  expect(paste('plain text')).toBeUndefined()
})
it.each(['error', 'abort'])(
  'native bitmap read %s preserves document and releases listener',
  async (event) => {
    const on = vi.spyOn(editor, 'on')
    const off = vi.spyOn(editor, 'off')
    const before = editor.getJSON()
    paste()
    await (event === 'error' ? reader.onerror?.() : reader.onabort?.())
    expect(editor.getJSON()).toEqual(before)
    const callback = on.mock.calls.find(([name]) => name === 'transaction')?.[1]
    expect(callback).toBeTypeOf('function')
    expect(off).toHaveBeenCalledWith('transaction', callback)
  },
)

it.each(['reader', 'decode'])(
  'native bitmap paste cancels read-only transition during %s',
  async (stage) => {
    paste()
    const pending = stage === 'decode' ? reader.finish() : undefined
    await tick()
    editor.setEditable(false, false)
    const before = editor.getJSON()
    if (stage === 'reader') await finish()
    else {
      decode?.()
      await pending
      await tick()
    }
    expect(editor.getJSON()).toEqual(before)
  },
)
it.each([false, true])(
  'direct image helper cannot bypass read-only with custom guard %s',
  async (custom) => {
    const pending = insertImageFromDataUrl(
      editor,
      'data:image/png;base64,cHJpdmF0ZQ==',
      'image',
      custom ? () => true : undefined,
    )
    await tick()
    editor.setEditable(false)
    const before = editor.getJSON()
    decode?.()
    expect(await pending).toBe(false)
    expect(editor.getJSON()).toEqual(before)
  },
)
it.each(['fetch', 'decodeFailure'])(
  'remote paste never writes fallback after read-only during %s',
  async (stage) => {
    let resolve!: (value: unknown) => void
    Object.defineProperty(window, 'desktop', {
      configurable: true,
      value: {
        fetchImage: () =>
          new Promise((r) => {
            resolve = r
          }),
      },
    })
    const failed = vi.fn()
    const pending = pasteActions.pasteRemoteImages(
      editor,
      ['https://example.test/image'],
      'private fallback',
      failed,
    )
    if (stage === 'decodeFailure') {
      resolve({ mime: 'image/png', base64: 'cHJpdmF0ZQ==' })
      await tick()
    }
    editor.setEditable(false, false)
    const before = editor.getJSON()
    if (stage === 'fetch') resolve(null)
    else decode?.(true)
    await pending
    expect(editor.getJSON()).toEqual(before)
    expect(failed).not.toHaveBeenCalled()
  },
)
it.each(['picker', 'decode'])(
  'local dialog does not write after read-only during %s',
  async (stage) => {
    let resolve!: (value: unknown) => void
    Object.defineProperty(window, 'desktop', {
      configurable: true,
      value: {
        pickImage: () =>
          new Promise((r) => {
            resolve = r
          }),
      },
    })
    const pending = insertImageViaDialog(editor)
    const picked = { mime: 'image/png', base64: 'cHJpdmF0ZQ==', name: 'image.png' }
    if (stage === 'decode') {
      resolve(picked)
      await tick()
    }
    editor.setEditable(false, false)
    const before = editor.getJSON()
    if (stage === 'picker') {
      resolve(picked)
      await tick()
    }
    decode?.()
    await pending
    expect(editor.getJSON()).toEqual(before)
  },
)
it('clipboard read text cannot fall back into read-only document', async () => {
  let resolve!: (value: string) => void
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      read: async () => {
        throw Error('denied')
      },
      readText: () =>
        new Promise((r) => {
          resolve = r
        }),
    },
  })
  const pending = pasteActions.pasteFromClipboard(editor)
  await tick()
  editor.setEditable(false, false)
  const before = editor.getJSON()
  resolve('private text')
  expect(await pending).toBe(false)
  expect(editor.getJSON()).toEqual(before)
})
