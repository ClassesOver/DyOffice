import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { insertImageViaDialog } from '../src/renderer/components/ribbon-tabs'
import { setToastEmitter } from '../src/renderer/components/toast-bus'
import { t } from '../src/renderer/i18n/locale'

const pickImage = vi.fn()
const notify = vi.fn()
let editor: Editor
let decodeError = false

beforeEach(() => {
  vi.clearAllMocks()
  decodeError = false
  editor = new Editor({
    element: document.createElement('div'), extensions: editorExtensions,
    content: { type: 'doc', content: [{ type: 'docParagraph', content: [{ type: 'text', text: 'Keep this text' }] }] },
  })
  Object.defineProperty(window, 'desktop', { configurable: true, value: { pickImage } })
  setToastEmitter(notify)
  vi.stubGlobal('Image', class {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    naturalWidth = 120
    naturalHeight = 60
    set src(_value: string) { queueMicrotask(() => decodeError ? this.onerror?.() : this.onload?.()) }
  })
})
afterEach(() => { editor.destroy(); setToastEmitter(null); vi.unstubAllGlobals() })

describe('insert picture dialog feedback', () => {
  it('handles picker rejection with a visible error and preserves the document', async () => {
    pickImage.mockRejectedValue(new Error('unsupported or oversized image'))
    const before = editor.getJSON()
    await expect(insertImageViaDialog(editor)).resolves.toBeUndefined()
    expect(notify).toHaveBeenCalledWith({ text: t('ribbonImageLoadFail'), kind: 'error' })
    expect(editor.getJSON()).toEqual(before)
  })

  it('reports decode failure instead of silently doing nothing', async () => {
    pickImage.mockResolvedValue({ name: 'broken.png', mime: 'image/png', base64: 'broken' })
    decodeError = true
    const before = editor.getJSON()
    await insertImageViaDialog(editor)
    expect(notify).toHaveBeenCalledWith({ text: t('ribbonImageLoadFail'), kind: 'error' })
    expect(editor.getJSON()).toEqual(before)
  })

  it('leaves cancellation silent', async () => {
    pickImage.mockResolvedValue(null)
    await insertImageViaDialog(editor)
    expect(notify).not.toHaveBeenCalled()
    expect(editor.getText()).toBe('Keep this text')
  })

  it('keeps successful picture insertion', async () => {
    pickImage.mockResolvedValue({ name: 'picture.png', mime: 'image/png', base64: 'aGVsbG8=' })
    await insertImageViaDialog(editor)
    const images: string[] = []
    editor.state.doc.descendants(node => { if (node.attrs.blockType === 'image') images.push(node.attrs.imageDataUrl) })
    expect(images).toEqual(['data:image/png;base64,aGVsbG8='])
    expect(notify).not.toHaveBeenCalled()
  })
})


describe('independent pending local image lifecycle review', () => {
  it('must not write a picker result into a replacement document', async () => {
    let resolve!: (v: unknown) => void
    pickImage.mockReturnValue(new Promise(r => { resolve = r }))
    const pending = insertImageViaDialog(editor)
    editor.commands.setContent({ type: 'doc', content: [{ type: 'docParagraph', content: [{ type: 'text', text: 'Replacement document' }] }] })
    const replacement = editor.getJSON()
    resolve({ name: 'private-A.png', mime: 'image/png', base64: 'aGVsbG8=' })
    await pending
    expect(editor.getJSON()).toEqual(replacement)
  })
  it('must not write a decoded picture into a replacement document', async () => {
    let finish!: () => void
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null
      naturalWidth = 120; naturalHeight = 60
      set src(_v: string) { finish = () => this.onload?.() }
    })
    pickImage.mockResolvedValue({ name: 'private-A.png', mime: 'image/png', base64: 'aGVsbG8=' })
    const pending = insertImageViaDialog(editor)
    await Promise.resolve()
    editor.commands.setContent({ type: 'doc', content: [{ type: 'docParagraph', content: [{ type: 'text', text: 'Replacement document' }] }] })
    const replacement = editor.getJSON()
    finish()
    await pending
    expect(editor.getJSON()).toEqual(replacement)
  })
})


describe('local image lifecycle boundaries', () => {
  it.each([true, false])('cancels even same-content setContent (emitUpdate %s)', async (emitUpdate) => {
    let resolve!: (v: unknown) => void
    pickImage.mockReturnValue(new Promise(r => { resolve = r }))
    const before = editor.getJSON()
    const pending = insertImageViaDialog(editor)
    editor.commands.setContent(before, { emitUpdate })
    resolve({ name: 'private.png', mime: 'image/png', base64: 'aGVsbG8=' })
    await pending
    expect(editor.getJSON()).toEqual(before)
    expect(notify).not.toHaveBeenCalled()
  })
  it('allows ordinary typing during picker and decode', async () => {
    let resolve!: (v: unknown) => void
    let finish!: () => void
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null
      naturalWidth = 120; naturalHeight = 60
      set src(_v: string) { finish = () => this.onload?.() }
    })
    pickImage.mockReturnValue(new Promise(r => { resolve = r }))
    const pending = insertImageViaDialog(editor)
    editor.commands.insertContent('typed before ')
    resolve({ name: 'private.png', mime: 'image/png', base64: 'aGVsbG8=' })
    await Promise.resolve()
    editor.commands.insertContent('typed after ')
    finish()
    await pending
    expect(editor.getText()).toContain('typed before typed after ')
    expect(JSON.stringify(editor.getJSON())).toContain('data:image/png;base64,aGVsbG8=')
  })
  it('silences a stale picker rejection after document replacement', async () => {
    let reject!: (v: unknown) => void
    pickImage.mockReturnValue(new Promise((_, r) => { reject = r }))
    const pending = insertImageViaDialog(editor)
    editor.commands.setContent('<p>Replacement</p>')
    reject(new Error('stale picker'))
    await pending
    expect(notify).not.toHaveBeenCalled()
  })
  it('silences a stale decode failure after document replacement', async () => {
    let fail!: () => void
    vi.stubGlobal('Image', class {
      onerror: (() => void) | null = null
      set src(_v: string) { fail = () => this.onerror?.() }
    })
    pickImage.mockResolvedValue({ name: 'private.png', mime: 'image/png', base64: 'aGVsbG8=' })
    const pending = insertImageViaDialog(editor)
    await Promise.resolve()
    editor.commands.setContent('<p>Replacement</p>')
    fail()
    await pending
    expect(notify).not.toHaveBeenCalled()
  })
  it('does not report an insertion failure after editor destruction', async () => {
    let resolve!: (v: unknown) => void
    pickImage.mockReturnValue(new Promise(r => { resolve = r }))
    const pending = insertImageViaDialog(editor)
    editor.destroy()
    resolve({ name: 'private.png', mime: 'image/png', base64: 'aGVsbG8=' })
    await pending
    expect(notify).not.toHaveBeenCalled()
  })
})
