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
