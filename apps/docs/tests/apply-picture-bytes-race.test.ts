import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { setToastEmitter } from '../src/renderer/components/toast-bus'
import { t } from '../src/renderer/i18n/locale'
import { applyPictureBytes } from '../src/renderer/editor/apply-picture-bytes'

const notify = vi.fn()
let editor: Editor
let images: PendingImage[]
class PendingImage {
  naturalWidth = 40
  naturalHeight = 20
  onload!: () => void
  onerror!: () => void
  set src(_value: string) {
    images.push(this)
  }
}
const replacement = 'data:image/png;base64,bmV3'
const picture = (index: number) => ({
  type: 'docProtected',
  attrs: {
    blockType: 'image',
    docxIndex: index,
    imageDataUrl: `old-${index}`,
    imageWidthPx: 100,
    imageHeightPx: 100,
    imageCrop: { l: 100 },
    imageFillRect: { t: 200 },
  },
})
beforeEach(() => {
  notify.mockReset(); setToastEmitter(notify)
  images = []
  editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: { type: 'doc', content: [picture(0), picture(1), { type: 'docParagraph' }] },
  })
  editor.commands.setNodeSelection(0)
  vi.stubGlobal('Image', PendingImage)
})
afterEach(() => {
  editor.destroy()
  setToastEmitter(null)
  vi.unstubAllGlobals()
})
for (const change of ['document', 'readonly', 'selection', 'destroy'] as const) {
  test(`does not change a different target after ${change} during decode`, async () => {
    const pending = applyPictureBytes(editor, replacement)
    expect(images).toHaveLength(1)
    if (change === 'document') {
      editor.commands.setContent({ type: 'doc', content: [picture(2)] })
      editor.commands.setNodeSelection(0)
    } else if (change === 'readonly') editor.setEditable(false)
    else if (change === 'selection')
      editor.commands.setNodeSelection(editor.state.doc.firstChild!.nodeSize)
    else editor.destroy()
    const expected = editor.getJSON()
    images[0].onload()
    await pending
    expect(editor.getJSON()).toEqual(expected)
  })
}
test('normal apply preserves identity and width, bakes crop and updates aspect ratio', async () => {
  const pending = applyPictureBytes(editor, replacement)
  images[0].onload()
  await pending
  expect(editor.state.doc.firstChild!.attrs).toMatchObject({
    docxIndex: 0,
    imageDataUrl: replacement,
    imageWidthPx: 100,
    imageHeightPx: 50,
    imageCrop: null,
    imageFillRect: null,
    imageReplace: { base64: 'bmV3', mime: 'image/png' },
  })
})
test('failed decoding keeps the original untouched', async () => {
  const expected = editor.getJSON()
  const pending = applyPictureBytes(editor, replacement)
  images[0].onerror()
  await pending
  expect(editor.getJSON()).toEqual(expected)
})
test('unrelated same-document edits still allow applying to the original selected picture', async () => {
  const pending = applyPictureBytes(editor, replacement)
  const end = editor.state.doc.content.size - 1
  editor.view.dispatch(editor.state.tr.insertText('typed', end))
  images[0].onload()
  await pending
  expect(editor.state.doc.firstChild!.attrs.imageDataUrl).toBe(replacement)
  expect(editor.getText()).toContain('typed')
})
test('a newer edit of the target is not overwritten', async () => {
  const pending = applyPictureBytes(editor, replacement)
  editor.commands.updateAttributes('docProtected', { imageDataUrl: 'newer' })
  const expected = editor.getJSON()
  images[0].onload()
  await pending
  expect(editor.getJSON()).toEqual(expected)
})
test('new unsaved image keeps the genImage save payload', async () => {
  editor.commands.updateAttributes('docProtected', { docxIndex: null })
  const pending = applyPictureBytes(editor, replacement)
  images[0].onload()
  await pending
  expect(editor.state.doc.firstChild!.attrs.genImage).toEqual({
    base64: 'bmV3',
    mime: 'image/png',
    widthPx: 100,
    heightPx: 50,
  })
})
test('readonly at entry does not start decoding even with stale canEdit', async () => {
  editor.setEditable(false)
  await applyPictureBytes(editor, replacement, true)
  expect(images).toHaveLength(0)
})

test('decode failure reports an error while keeping the original picture', async () => {
  const before = editor.getJSON()
  const pending = applyPictureBytes(editor, replacement)
  images[0].onerror(); await pending
  expect(editor.getJSON()).toEqual(before)
  expect(notify).toHaveBeenCalledExactlyOnceWith({ text: t('ribbonImageLoadFail'), kind: 'error' })
})
test('obsolete decode failure stays silent after selecting another picture', async () => {
  const pending = applyPictureBytes(editor, replacement)
  editor.commands.setNodeSelection(editor.state.doc.firstChild!.nodeSize)
  images[0].onerror(); await pending
  expect(notify).not.toHaveBeenCalled()
})
