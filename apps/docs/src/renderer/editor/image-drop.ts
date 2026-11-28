import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import type { Node as PmNode } from '@tiptap/pm/model'
import { bytesBase64 } from '../../../../../packages/browser-host/src/analysis-image'
import { imageSize } from '../../../../../packages/cli/src/formats/image-size'
import { insertImageFromDataUrl } from '../components/ribbon-tabs'
import { t } from '../i18n/locale'
import { pendingDocumentOperation } from './pending-document-operation'

/** same formats as Insert > Picture and the clipboard lane */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
}
const ACCEPTED = new Set(Object.values(IMAGE_MIME))

function hasUnknownType(type: string): boolean {
  return type === '' || type === 'application/octet-stream'
}

export function droppedImageMime(file: { name: string; type: string }): string | null {
  if (ACCEPTED.has(file.type)) return file.type
  if (!hasUnknownType(file.type)) return null
  const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase()
  return ext ? (IMAGE_MIME[ext] ?? null) : null
}

export function imageFilesFromDataTransfer(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return []
  return [...dt.files].filter((file) => droppedImageMime(file) !== null)
}

/** dragover sees no File objects yet — only the item kinds and types */
export function isImageFileDrag(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false
  return [...dt.items].some((item) =>
    item.kind === 'file' && (ACCEPTED.has(item.type) || hasUnknownType(item.type)),
  )
}

export function nearestTextSelection(doc: PmNode, pos: number): TextSelection | null {
  const clamped = Math.max(0, Math.min(pos, doc.content.size))
  const sel = TextSelection.near(doc.resolve(clamped))
  return sel instanceof TextSelection ? sel : null
}

export async function insertImageFilesAt(
  editor: Editor,
  files: File[],
  pos: number,
): Promise<number> {
  if (editor.isDestroyed) return 0
  const { current, dispose } = pendingDocumentOperation(editor)
  let inserted = 0
  try {
    const sel = nearestTextSelection(editor.state.doc, pos)
    if (!sel) return 0
    editor.view.dispatch(editor.state.tr.setSelection(sel))
    for (const file of files) {
      if (!current()) break
      const mime = droppedImageMime(file)
      if (!mime) continue
      const dataUrl = await readImageDataUrl(file, mime)
      if (!current()) break
      if (!dataUrl) continue
      if (await insertImageFromDataUrl(
        editor, dataUrl, t('ribbonPictureLabel', { name: file.name }), current,
      )) inserted++
    }
    return inserted
  } finally {
    dispose()
  }
}

export function insertImageFilesAtCoords(
  editor: Editor,
  files: File[],
  coords: { left: number; top: number },
): boolean {
  if (!editor.isEditable || files.length === 0) return false
  const hit = editor.view.posAtCoords(coords)
  if (!hit) return false
  insertImageFilesAt(editor, files, hit.pos).catch((err) => console.error('image drop failed', err))
  return true
}

function readImageDataUrl(file: File, mime: string): Promise<string | null> {
  if (hasUnknownType(file.type)) return readUntypedImageDataUrl(file)
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      const payload = typeof reader.result === 'string' ? reader.result.split(',')[1] : undefined
      resolve(payload ? `data:${mime};base64,${payload}` : null)
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

async function readUntypedImageDataUrl(file: File): Promise<string | null> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const image = imageSize(bytes)
    return image ? `data:${image.mime};base64,${bytesBase64(bytes)}` : null
  } catch {
    return null
  }
}
