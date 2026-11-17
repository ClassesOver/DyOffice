import type { Editor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import { pendingDocumentOperation } from './pending-document-operation'
import { imageSizeOf } from '../components/ribbon-tabs'

export async function applyPictureBytes(
  editor: Editor,
  dataUrl: string,
  canEdit = editor.isEditable,
) {
  if (!canEdit || editor.isDestroyed || !editor.isEditable) return
  const m = /^data:(image\/(?:png|jpeg|gif));base64,(.*)$/s.exec(dataUrl)
  if (!m) return
  const selection = editor.state.selection
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== 'docProtected') return
  const target = selection.node
  const attrs = target.attrs
  if (attrs?.blockType !== 'image') return
  const operation = pendingDocumentOperation(editor)
  try {
    const natural = await imageSizeOf(dataUrl)
    // Never apply decoded bytes to another document or another selected picture.
    // Node identity survives unrelated typing/position mapping but not target edits.
    const currentSelection = editor.state.selection
    if (
      !operation.current() ||
      !(currentSelection instanceof NodeSelection) ||
      currentSelection.node !== target
    )
      return
    const currentW = Number(attrs.imageWidthPx) || Math.min(natural.width, 620)
    const w = Math.max(1, Math.round(currentW))
    const h = Math.max(1, Math.round((currentW * natural.height) / natural.width))
    const isOriginal = attrs.docxIndex !== null && attrs.docxIndex !== undefined
    editor
      .chain()
      .focus()
      .updateAttributes('docProtected', {
        imageDataUrl: dataUrl,
        imageWidthPx: w,
        imageHeightPx: h,
        // The new bytes are the full picture (crop/cutout bake destructively) and
        // the replace pipeline strips a:srcRect on save — drop a Word-authored
        // crop/fill window or it would keep clipping the new image until reload
        imageCrop: null,
        imageFillRect: null,
        ...(isOriginal
          ? { imageReplace: { base64: m[2], mime: m[1] } }
          : { genImage: { base64: m[2], mime: m[1], widthPx: w, heightPx: h } }),
      })
      .run()
  } catch {
    /* image decode failed: keep the original untouched */
  } finally {
    operation.dispose()
  }
}
