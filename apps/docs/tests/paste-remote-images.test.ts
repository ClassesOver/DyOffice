import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { strings } from '../src/renderer/i18n/strings'

const insertImage = vi.fn(async (..._args: unknown[]) => true)
vi.mock('../src/renderer/components/ribbon-tabs', () => ({
  insertImageFromDataUrl: (...args: unknown[]) => insertImage(...args),
}))

const { pasteRemoteImages } = await import('../src/renderer/editor/paste-actions')
const url = 'https://example.invalid/copied.png'
let editor: Editor
const fetchImage = vi.fn()
const failed = vi.fn()

beforeEach(() => {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: { type: 'doc', content: [{ type: 'docParagraph' }] },
  })
  vi.clearAllMocks()
  Object.defineProperty(window, 'desktop', { configurable: true, value: { fetchImage } })
})
afterEach(() => editor.destroy())

describe('remote image paste', () => {
  it('uses the Web clipboard reader when the AI media reader is also available', async () => {
    const fetchClipboardImage = vi.fn().mockResolvedValue({ mime: 'image/png', base64: 'aGVsbG8=' })
    Object.defineProperty(window, 'desktop', {
      configurable: true,
      value: { fetchImage, fetchClipboardImage },
    })
    await pasteRemoteImages(editor, [url], url, failed)
    expect(fetchClipboardImage).toHaveBeenCalledWith(url)
    expect(fetchImage).not.toHaveBeenCalled()
    expect(insertImage).toHaveBeenCalledOnce()
    expect(failed).not.toHaveBeenCalled()
  })

  it('handles a rejected Web bridge without rejecting and preserves the clipboard URL', async () => {
    fetchImage.mockRejectedValue(new Error('此功能当前不可用。'))
    await expect(pasteRemoteImages(editor, [url], url, failed)).resolves.toBeUndefined()
    expect(editor.getText()).toBe(url)
    expect(failed).toHaveBeenCalledOnce()
    expect(insertImage).not.toHaveBeenCalled()
  })

  it('reports failure when there is no text fallback', async () => {
    fetchImage.mockResolvedValue(null)
    await pasteRemoteImages(editor, [url], '', failed)
    expect(editor.getText()).toBe('')
    expect(failed).toHaveBeenCalledOnce()
  })

  it('preserves successful desktop image insertion without inserting its URL', async () => {
    fetchImage.mockResolvedValue({ mime: 'image/png', base64: 'aGVsbG8=' })
    await pasteRemoteImages(editor, [url], url, failed)
    expect(insertImage).toHaveBeenCalledWith(
      editor,
      'data:image/png;base64,aGVsbG8=',
      'Image (pasted)',
      expect.any(Function),
    )
    expect(editor.getText()).toBe('')
    expect(failed).not.toHaveBeenCalled()
  })

  it('does not write a delayed fallback into a replaced document', async () => {
    let reject!: (error: Error) => void
    fetchImage.mockImplementation(
      () =>
        new Promise((_resolve, rejectPromise) => {
          reject = rejectPromise
        }),
    )
    const pending = pasteRemoteImages(editor, [url], url, failed)
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'docParagraph', content: [{ type: 'text', text: 'Other document' }] }],
    })
    reject(new Error('unavailable'))
    await pending
    expect(editor.getText()).toBe('Other document')
  })

  it('provides localized recovery guidance', () => {
    expect(strings.zh.appPasteRemoteImageFailed).toMatch(/复制.*图片.*本地/)
    expect(strings.en.appPasteRemoteImageFailed).toMatch(/copy.*image.*local/i)
  })
})
