import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { pasteRemoteImages } from '../src/renderer/editor/paste-actions'

let editor: Editor
let images: PendingImage[]
class PendingImage {
  naturalWidth = 40
  naturalHeight = 40
  onload!: () => void
  onerror!: () => void
  set src(_value: string) {
    images.push(this)
  }
}
const url = 'https://example.invalid/a.png'
const failed = vi.fn()
beforeEach(() => {
  images = []
  failed.mockClear()
  editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: '<p>Original document</p>',
  })
  vi.stubGlobal('Image', PendingImage)
  Object.defineProperty(window, 'desktop', {
    configurable: true,
    value: { fetchImage: vi.fn().mockResolvedValue({ mime: 'image/png', base64: 'aGVsbG8=' }) },
  })
})
afterEach(() => {
  editor.destroy()
  vi.unstubAllGlobals()
})
async function start() {
  const pending = pasteRemoteImages(editor, [url], url, failed)
  await Promise.resolve()
  expect(images).toHaveLength(1)
  return { pending }
}
function imageCount() {
  let count = 0
  editor.state.doc.descendants((n) => {
    if (n.type.name === 'docProtected' && n.attrs.blockType === 'image') count++
  })
  return count
}
for (const outcome of ['onload', 'onerror'] as const) {
  test(`replacement during decode cancels ${outcome} without image, text fallback, or notification`, async () => {
    const { pending } = await start()
    editor.commands.setContent('<p>Replacement document</p>')
    const replacement = editor.getJSON()
    images[0][outcome]()
    await pending
    expect(editor.getJSON()).toEqual(replacement)
    expect(failed).not.toHaveBeenCalled()
  })
  test(`destroy during decode cancels ${outcome}`, async () => {
    const { pending } = await start()
    editor.destroy()
    images[0][outcome]()
    await expect(pending).resolves.toBeUndefined()
    expect(failed).not.toHaveBeenCalled()
  })
}
test('same-document typing during fetch and decode still permits the image', async () => {
  const pending = pasteRemoteImages(editor, [url], url, failed)
  editor.commands.insertContent('typed before fetch')
  await Promise.resolve()
  expect(images).toHaveLength(1)
  editor.commands.insertContent('typed during decode')
  images[0].onload()
  await pending
  expect(imageCount()).toBe(1)
  expect(editor.getText()).toContain('typed during decode')
  expect(failed).not.toHaveBeenCalled()
})
test('ordinary decode failure keeps the text fallback', async () => {
  const { pending } = await start()
  images[0].onerror()
  await pending
  expect(editor.getText()).toContain(url)
  expect(failed).toHaveBeenCalledOnce()
})
test('same-content setContent still invalidates the pending paste', async () => {
  const { pending } = await start()
  const original = editor.getJSON()
  editor.commands.setContent(original, { emitUpdate: false })
  images[0].onload()
  await pending
  expect(editor.getJSON()).toEqual(original)
  expect(failed).not.toHaveBeenCalled()
})

test('multiple decoded images remain in the original document', async () => {
  const pending = pasteRemoteImages(editor, [url, url], url, failed)
  await Promise.resolve()
  images[0].onload()
  await vi.waitFor(() => expect(images).toHaveLength(2))
  images[1].onload()
  await pending
  expect(imageCount()).toBe(2)
  expect(failed).not.toHaveBeenCalled()
})
