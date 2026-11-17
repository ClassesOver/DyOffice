import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { pendingDocumentOperation } from '../src/renderer/editor/pending-document-operation'
import { applyPictureBytes as replacePictureBytes } from '../src/renderer/editor/apply-picture-bytes'
import { imageSizeOf } from '../src/renderer/components/ribbon-tabs'

// Run Ribbon's actual image replacement handlers with a real Editor. Control only
// the picker and image decoder to expose user selection/document changes.
const source = readFileSync('src/renderer/components/Ribbon.tsx', 'utf8')
const start = source.indexOf('  const pendingPictureOperation = ')
const end = source.indexOf('  const rotatePicture = ', start)
if (start < 0 || end < 0) throw Error('Ribbon picture handlers not found')
const handlers = new Function('editor', 'canEdit', 'imageSizeOf', 'pendingDocumentOperation', 'replacePictureBytes',
  ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + ';return { applyPictureBytes, replacePicture }')
let editor: Editor
let decode: () => void
const pickImage = vi.fn()
const picture = (id: string) => ({ type: 'docProtected', attrs: {
  blockType: 'image', imageDataUrl: `data:image/png;base64,${id}`, imageWidthPx: 120, imageHeightPx: 60,
  genImage: { base64: id, mime: 'image/png', widthPx: 120, heightPx: 60 },
} })
const content = () => ({ type: 'doc', content: [picture('first'), picture('second')] })
const api = () => handlers(editor, true, imageSizeOf, pendingDocumentOperation, replacePictureBytes)
beforeEach(() => {
  pickImage.mockReset(); decode = () => {}
  editor = new Editor({ element: document.createElement('div'), extensions: editorExtensions, content: content() })
  editor.commands.setNodeSelection(0)
  Object.defineProperty(window, 'desktop', { configurable: true, value: { pickImage } })
  vi.stubGlobal('Image', class {
    onload?: () => void
    naturalWidth = 60; naturalHeight = 30
    set src(_value: string) { decode = () => this.onload?.() }
  })
})
afterEach(() => { editor.destroy(); vi.unstubAllGlobals() })
it('does not apply decoded bytes to a different selected picture', async () => {
  const pending = api().applyPictureBytes('data:image/png;base64,new')
  editor.commands.setNodeSelection(editor.state.doc.child(0).nodeSize)
  const before = editor.getJSON()
  decode(); await pending
  expect(editor.getJSON()).toEqual(before)
})
it.each([true, false])('does not apply to a replacement document (emitUpdate %s)', async emitUpdate => {
  const pending = api().applyPictureBytes('data:image/png;base64,new')
  editor.commands.setContent(content(), { emitUpdate }); editor.commands.setNodeSelection(0)
  const before = editor.getJSON()
  decode(); await pending
  expect(editor.getJSON()).toEqual(before)
})
it('does not apply after the editor becomes read only', async () => {
  const pending = api().applyPictureBytes('data:image/png;base64,new')
  editor.setEditable(false)
  const before = editor.getJSON()
  decode(); await pending
  expect(editor.getJSON()).toEqual(before)
})
it('does not replace a newly selected picture while the file picker was open', async () => {
  let resolve!: (value: unknown) => void
  pickImage.mockReturnValue(new Promise(r => { resolve = r }))
  const pending = api().replacePicture()
  editor.commands.setNodeSelection(editor.state.doc.child(0).nodeSize)
  const before = editor.getJSON()
  resolve({ mime: 'image/png', base64: 'new' }); await Promise.resolve()
  decode?.(); await pending
  expect(editor.getJSON()).toEqual(before)
})
it('preserves normal replacement and the other picture', async () => {
  const other = editor.state.doc.child(1).toJSON()
  const pending = api().applyPictureBytes('data:image/png;base64,new')
  decode(); await pending
  expect(editor.state.doc.child(0).attrs.imageDataUrl).toBe('data:image/png;base64,new')
  expect(editor.state.doc.child(1).toJSON()).toEqual(other)
})

it('does not overwrite an intervening edit to the same picture', async () => {
  const pending = api().applyPictureBytes('data:image/png;base64,new')
  editor.commands.updateAttributes('docProtected', { imageDataUrl: 'data:image/png;base64,newer' })
  const before = editor.getJSON()
  decode(); await pending
  expect(editor.getJSON()).toEqual(before)
})
it('discards decoded results after the editor is destroyed', async () => {
  const pending = api().applyPictureBytes('data:image/png;base64,new')
  editor.destroy()
  decode(); await expect(pending).resolves.toBeUndefined()
})
it.each([true, false])('discards picker results after same-content replacement (emitUpdate %s)', async emitUpdate => {
  let resolve!: (value: unknown) => void
  pickImage.mockReturnValue(new Promise(r => { resolve = r }))
  const pending = api().replacePicture()
  editor.commands.setContent(content(), { emitUpdate }); editor.commands.setNodeSelection(0)
  const before = editor.getJSON()
  resolve({ mime: 'image/png', base64: 'new' }); await Promise.resolve()
  decode(); await pending
  expect(editor.getJSON()).toEqual(before)
})
it('keeps a normal file-picker replacement', async () => {
  pickImage.mockResolvedValue({ mime: 'image/png', base64: 'picked' })
  const pending = api().replacePicture()
  await Promise.resolve(); decode(); await pending
  expect(editor.state.doc.child(0).attrs.imageDataUrl).toBe('data:image/png;base64,picked')
})

const resetStart = source.indexOf('  const resetPictureSize = async ')
const resetEnd = source.indexOf('  const runTableCommand = ', resetStart)
if (resetStart < 0 || resetEnd < 0) throw Error('Ribbon reset picture handler not found')
const resetHandler = new Function('editor', 'ed', 'canEdit', 'inImage', 'fs', 'imageSizeOf', 'setPicturePx', 'inlinePictureHostWidthPx', 'pendingDocumentOperation',
  ts.transpileModule(source.slice(start, source.indexOf('  const applyPictureBytes = ', start)) + source.slice(resetStart, resetEnd),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + ';return resetPictureSize')
it.each([true, false])('reset size only updates its unchanged target (switch target %s)', async switchTarget => {
  const resize = vi.fn()
  const pending = resetHandler(editor, editor, true, true, { imageDataUrl: 'data:image/png;base64,first' }, imageSizeOf, resize, () => 600, pendingDocumentOperation)()
  if (switchTarget) editor.commands.setNodeSelection(editor.state.doc.child(0).nodeSize)
  decode(); await pending
  if (switchTarget) expect(resize).not.toHaveBeenCalled()
  else expect(resize).toHaveBeenCalledExactlyOnceWith(60, 30)
})

it('reset size checks the actual inline-picture subeditor target', async () => {
  const subeditor = new Editor({ element: document.createElement('div'), extensions: editorExtensions, content: content() })
  try {
    subeditor.commands.setNodeSelection(0)
    const resize = vi.fn()
    const pending = resetHandler(editor, subeditor, true, true, { imageDataUrl: 'data:image/png;base64,first' }, imageSizeOf, resize, () => 600, pendingDocumentOperation)()
    subeditor.commands.setNodeSelection(subeditor.state.doc.child(0).nodeSize)
    decode(); await pending
    expect(resize).not.toHaveBeenCalled()
  } finally { subeditor.destroy() }
})
