/**
 * Clipboard pastes started from the UI (ribbon Paste, its split menu, Paste
 * Special, the context menu). Every entry runs the editor's full paste
 * pipeline with a synthesized clipboard event, so App's handlePaste lanes and
 * the paste-mode handshake behave exactly as on a native Ctrl+V.
 */
import { pendingDocumentOperation } from './pending-document-operation'
import type { Editor } from '@tiptap/core'
import type { SelectionBookmark, Transaction } from '@tiptap/pm/state'
import { imageSizeOf, insertImageFromDataUrl, MAX_IMAGE_WIDTH_PX } from '../components/ribbon-tabs'
import {
  beginForeignPaste,
  defaultPasteMode,
  forceNextPasteMode,
  stashPastePayload,
  type PasteMode,
} from './paste-options'
import { isForeignPasteHtml } from './paste-web-html'
import { pasteTextSlice } from './paste-text'

export type ClipboardPayload = { html: string; text: string; image: Blob | null }

/** A paste-special choice: one of the paste modes, or the bitmap flavor. */
export type PasteChoice = PasteMode | 'picture'

const MAX_REMOTE_PASTE_IMAGES = 10
const MAX_REMOTE_PASTE_BASE64 = 4 * Math.ceil(16 * 1024 * 1024 / 3)

/** Load image-only clipboard URLs through the platform bridge. */
export async function pasteRemoteImages(
  editor: Editor,
  sources: string[],
  text: string,
  onFailure: () => void,
): Promise<void> {
  const { current, dispose } = pendingDocumentOperation(editor)
  try {
    let inserted = false
    let failed = false
    for (const src of sources.slice(0, MAX_REMOTE_PASTE_IMAGES)) {
      if (!current()) return
      try {
        const fetchImage = window.desktop.fetchClipboardImage ?? window.desktop.fetchImage
        const fetched = await fetchImage(src)
        if (!current()) return
        if (fetched) {
          const success = await insertImageFromDataUrl(
            editor,
            `data:${fetched.mime};base64,${fetched.base64}`,
            'Image (pasted)',
            current,
          )
          // Cancellation is not an image failure: never adopt a replacement
          // document or write the plain-text fallback into it.
          if (!current()) return
          inserted ||= success
          failed ||= !success
        } else {
          failed = true
        }
      } catch {
        failed = true
      }
    }
    if (!current()) return
    if (failed) {
      if (!inserted && text.trim()) {
        const view = editor.view
        const slice = pasteTextSlice(text, view.state.selection.$from, view)
        view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView())
      }
      onFailure()
    }
  } finally {
    dispose()
  }
}

/** Materialize remote pictures before replaying a rich paste at its original selection. */
export async function pasteHtmlWithRemoteImages(
  editor: Editor,
  html: string,
  text: string,
  mode: PasteMode,
  fetchImage: NonNullable<Window['desktop']['fetchClipboardImage']>,
  onFailure: () => void,
): Promise<void> {
  const fragment = document.createElement('template')
  fragment.innerHTML = html
  const pictures = [...fragment.content.querySelectorAll<HTMLImageElement>('img[src]')]
    .filter(img => /^https?:\/\//i.test(img.getAttribute('src')?.trim() ?? ''))
  const { current, dispose } = pendingDocumentOperation(editor)
  let insertion = editor.state.selection.getBookmark()
  let laterSelection: SelectionBookmark | undefined
  const mapSelections = ({ transaction, appendedTransactions = [] }: {
    transaction: Transaction
    appendedTransactions?: Transaction[]
  }) => {
    for (const tr of [transaction, ...appendedTransactions]) {
      insertion = insertion.map(tr.mapping)
      laterSelection = laterSelection?.map(tr.mapping)
    }
  }
  editor.on('transaction', mapSelections)
  const fetched = new Map<string, { dataUrl: string; width: number; height: number } | null>()
  let remaining = MAX_REMOTE_PASTE_BASE64
  let failed = false
  try {
    for (const [index, img] of pictures.entries()) {
      if (!current()) return
      const src = img.getAttribute('src')!.trim()
      if (!fetched.has(src) && index < MAX_REMOTE_PASTE_IMAGES && remaining > 0) {
        let picture = null
        try {
          const result = await fetchImage(src)
          if (!current()) return
          if (result && /^image\/(png|jpeg|gif)$/.test(result.mime) &&
              result.base64 && result.base64.length <= remaining) {
            const dataUrl = `data:${result.mime};base64,${result.base64}`
            picture = { dataUrl, ...await imageSizeOf(dataUrl) }
          }
        } catch {
          // The rest of the copied fragment is still pasteable.
        }
        fetched.set(src, picture)
      }
      const picture = fetched.get(src)
      if (index >= MAX_REMOTE_PASTE_IMAGES || !picture || picture.dataUrl.length > remaining) {
        img.remove()
        failed = true
        continue
      }
      remaining -= picture.dataUrl.length
      const declaredWidth = Number(img.getAttribute('width'))
      const declaredHeight = Number(img.getAttribute('height'))
      const width = Number.isFinite(declaredWidth) && declaredWidth > 0 ? declaredWidth : picture.width
      const height = Number.isFinite(declaredHeight) && declaredHeight > 0
        ? declaredHeight : picture.height * width / picture.width
      const scale = Math.min(1, MAX_IMAGE_WIDTH_PX / width)
      img.removeAttribute('srcset')
      img.setAttribute('src', picture.dataUrl)
      img.setAttribute('width', String(Math.max(1, Math.round(width * scale))))
      img.setAttribute('height', String(Math.max(1, Math.round(height * scale))))
    }
    if (!current()) return
    const target = insertion.resolve(editor.state.doc)
    if (!target.eq(editor.state.selection)) {
      laterSelection = editor.state.selection.getBookmark()
      editor.view.dispatch(editor.state.tr.setSelection(target))
    }
    pasteForeignHtml(editor, fragment.innerHTML, text, mode)
    if (failed) onFailure()
  } finally {
    editor.off('transaction', mapSelections)
    dispose()
    if (laterSelection && current()) {
      editor.view.dispatch(editor.state.tr.setSelection(laterSelection.resolve(editor.state.doc)))
    }
  }
}

export async function readClipboardPayload(): Promise<ClipboardPayload> {
  const payload: ClipboardPayload = { html: '', text: '', image: null }
  try {
    for (const item of await navigator.clipboard.read()) {
      if (!payload.text && item.types.includes('text/plain')) {
        payload.text = await (await item.getType('text/plain')).text()
      }
      if (!payload.html && item.types.includes('text/html')) {
        payload.html = await (await item.getType('text/html')).text()
      }
      const imageType = item.types.find((type) => type.startsWith('image/'))
      if (!payload.image && imageType) payload.image = await item.getType(imageType)
    }
  } catch {
    try {
      payload.text = await navigator.clipboard.readText()
    } catch {
      /* clipboard unavailable or denied */
    }
  }
  return payload
}

function clipboardEvent(html: string | null, text: string): ClipboardEvent {
  const data = new DataTransfer()
  if (html) data.setData('text/html', html)
  if (text) data.setData('text/plain', text)
  return new ClipboardEvent('paste', { clipboardData: data })
}

function pasteForeignHtml(editor: Editor, html: string, text: string, mode?: PasteMode): boolean {
  if (mode) forceNextPasteMode(mode)
  if (!beginForeignPaste(html)) return false
  stashPastePayload({ html, text, mode: mode ?? defaultPasteMode() })
  editor.view.pasteHTML(html, clipboardEvent(html, text))
  return true
}

function htmlText(html: string): string {
  try {
    const body = new window.DOMParser().parseFromString(html, 'text/html').body
    for (const block of body.querySelectorAll('p,div,li,tr,h1,h2,h3,h4,h5,h6,br')) {
      block.after(body.ownerDocument.createTextNode('\n'))
    }
    return (body.textContent ?? '').replace(/\n{2,}/g, '\n').trim()
  } catch {
    return ''
  }
}

export function insertBlobImage(editor: Editor, blob: Blob): void {
  const { current, dispose } = pendingDocumentOperation(editor)
  const reader = new FileReader()
  reader.onerror = reader.onabort = () => dispose()
  reader.onload = async () => {
    try {
      if (current() && typeof reader.result === 'string') {
        await insertImageFromDataUrl(editor, reader.result, 'Image (pasted)', current)
      }
    } finally {
      dispose()
    }
  }
  try {
    reader.readAsDataURL(blob)
  } catch (error) {
    dispose()
    throw error
  }
}

/**
 * Paste an already-read payload. Without a mode the user's default applies
 * (plain Ctrl+V); a mode pastes like picking that entry on the paste-options
 * chip. Returns false when the payload has nothing the choice can paste.
 */
export function pastePayload(
  editor: Editor,
  payload: ClipboardPayload,
  mode?: PasteChoice,
): boolean {
  const { html, text, image } = payload
  if (mode === 'picture') {
    if (!image) return false
    insertBlobImage(editor, image)
    return true
  }
  if (html) {
    // Only the document editor installs the transformPasted / handlePaste
    // lanes that consume the mode handshake; text-box and header/footer
    // sub-editors must not arm it (the mode would leak into the next paste)
    const consumes = Boolean(editor.view.someProp('transformPasted'))
    if (consumes && pasteForeignHtml(editor, html, text, mode)) {
      editor.commands.focus()
      return true
    }
    // the default mode only ever applies to HTML from other programs
    const textOnly = mode
      ? mode === 'text'
      : !consumes && isForeignPasteHtml(html) && defaultPasteMode() === 'text'
    // our own clipboard HTML keeps its exact runs; Keep Text Only still
    // strips them like Word does for an in-document copy
    if (!textOnly) {
      editor.view.pasteHTML(html, clipboardEvent(html, text))
      editor.commands.focus()
      return true
    }
    const plain = text || htmlText(html)
    if (!plain) return false
    editor.view.pasteText(plain, clipboardEvent(null, plain))
    editor.commands.focus()
    return true
  }
  // image priority mirrors Ctrl+V: a bitmap wins over missing or
  // whitespace-only plain text (OS clipboards often advertise an empty
  // text/plain beside image/png)
  if (image && !text.trim() && mode !== 'text') {
    insertBlobImage(editor, image)
    return true
  }
  if (!text) return false
  editor.view.pasteText(text, clipboardEvent(null, text))
  editor.commands.focus()
  return true
}

export async function pasteFromClipboard(editor: Editor, mode?: PasteMode): Promise<boolean> {
  const { current, dispose } = pendingDocumentOperation(editor)
  try {
    const payload = await readClipboardPayload()
    return current() ? pastePayload(editor, payload, mode) : false
  } finally {
    dispose()
  }
}
