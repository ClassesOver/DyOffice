/**
 * File actions extracted from App.tsx: save / save-as, image & PDF
 * export. Each function takes the ActionCtx built fresh per call.
 * (Printing lives in components/PrintDialog.tsx — preview + options dialog.)
 */
import type { RenderSlide } from '@genoffice/pptx-render'
import type { ExportPdfLink } from '../shared/ipc'
import { baseName } from '../shared/base-name'
import { modelSaveAsName } from './file-naming'
import type { ActionCtx } from './action-context'
import { collectExportPdfLinks } from './export-links'
import { renderSlidesToPdfPages } from './export-pages'
import { renderSlidesToImageBase64 } from './export-render'
import {
  exportVideo,
  type VideoExportOptions,
  type VideoExportResult,
} from './video-export/export-video'
import { t } from './i18n/locale'
import { showToast } from './components/toast-bus'

/**
 * If a text box/table is still being edited on ⌘S/close-save, blur first so the
 * overlay commits (blur→commitEdit), and save only after the commit lands —
 * otherwise we save pre-edit content and get a dirty-close prompt again.
 */
export async function flushActiveEdit(ctx: ActionCtx): Promise<boolean> {
  const active = document.activeElement as HTMLElement | null
  if (active?.isContentEditable) active.blur()
  // A button click can move focus before the asynchronous blur commit finishes.
  // The editing ref, not the currently focused node, owns the pending state.
  for (let i = 0; i < 40 && ctx.editingActiveRef.current; i++) {
    await new Promise((r) => setTimeout(r, 50))
  }
  if (ctx.editingActiveRef.current) {
    const pending = t('appEditCommitPending')
    ctx.setStatus(pending)
    showToast(pending, 'error')
    return false
  }
  return true
}

/**
 * After save, the main process reopens the file with all-new element ids: swap
 * the render tree, mapping selection/edit state to new ids by per-page node ordinal.
 */
export function adoptSavedSlides(ctx: ActionCtx, next: RenderSlide[]): void {
  const page = ctx.slides[ctx.current]
  const remap = (id: string) => {
    const i = page?.nodes.findIndex((n) => n.sourceId === id) ?? -1
    return i >= 0 ? (next[ctx.current]?.nodes[i]?.sourceId ?? null) : null
  }
  ctx.setSelectedIds((ids) => ids.map(remap).filter((x): x is string => x !== null))
  ctx.setEnteredGroupId(null) // Group children ids can't be mapped by top-level ordinal; exit in-group editing after save
  // A stale edit target (page gone, deck shrunk) cannot be mapped: drop it rather than keep an id no node owns
  ctx.setEditing((e) => {
    const id = e && remap(e.sourceId)
    return id ? { sourceId: id } : null
  })
  ctx.setEditingCell((c) => {
    const id = c && remap(c.sourceId)
    return id && c ? { ...c, sourceId: id } : null
  })
  ctx.setSlides(next)
}

/**
 * Serializes save passes: a call that arrives while a save is in flight waits
 * for it instead of running concurrently. Two overlapping saves write the
 * same file with two `createWriteStream` pipes — interleaved zip streams,
 * truncated pptx, or EPERM/EBUSY on Windows. The queue is a simple promise
 * chain: each caller awaits the previous tail, then runs its own pass.
 */
let saveTail: Promise<unknown> | null = null

async function flushNotesForSave(ctx: ActionCtx): Promise<boolean> {
  const error = await ctx.flushNotes()
  if (!error) return true
  const failed = t('appStatusSaveFailed', { error })
  ctx.setStatus(failed)
  showToast(failed, 'error')
  return false
}

/**
 * Runs `pass` after the in-flight save (if any) finishes, and becomes the
 * tail subsequent saves wait on. A pass that throws still releases the
 * queue; the error propagates to its own caller only.
 */
async function runSerialized<T>(pass: () => Promise<T>): Promise<T> {
  const prior = saveTail
  const current = (async (): Promise<T> => {
    if (prior) await prior.catch(() => undefined)
    return pass()
  })()
  const tail = current.then(
    () => undefined,
    () => undefined,
  )
  saveTail = tail
  void current.then(
    () => {
      if (saveTail === tail) saveTail = null
    },
    () => {
      if (saveTail === tail) saveTail = null
    },
  )
  return current
}

export async function save(getCtx: () => ActionCtx, quiet = false): Promise<boolean> {
  return runSerialized(async () => {
    // resolved only now: a queued pass must remap selection against the tree the prior save adopted
    const ctx = getCtx()
    if (!await flushActiveEdit(ctx)) return false
    if (!await flushNotesForSave(ctx)) return false
    // No name is proposed here: a save never waits on a model round-trip. An
    // untitled deck keeps the app's own name, the localized "Untitled
    // presentation" the main process produces in `pickDraftPath`.
    const r = await window.slidesApi.save()
    if (r.ok) {
      if (r.slides) adoptSavedSlides(ctx, r.slides)
      if (r.path) ctx.setPath(r.path)
      ctx.setDirty(false)
      if (ctx.notesDraftsPending()) {
        ctx.setStatus(t('appEditCommitPending'))
        return false
      }
      const saved = t('appStatusSaved')
      ctx.setStatus(saved)
      if (!quiet) showToast(saved)
    } else {
      const failed = t('appStatusSaveFailed', { error: r.error ?? t('appErrorCanceled') })
      ctx.setStatus(failed)
      // quiet suppresses the success toast only — a failed save (incl. the 30s
      // auto-save) must surface, or edits silently stop reaching disk
      showToast(failed, 'error')
    }
    return r.ok
  })
}

export async function saveAs(getCtx: () => ActionCtx): Promise<void> {
  await saveAsWithName(getCtx, null)
}

/**
 * Ask the model to name this deck, on request, then open Save As with its
 * answer prefilled.
 *
 * The stem goes into the dialog rather than renaming the file on disk: a deck
 * that may be open elsewhere, presented from another machine, or synced is not
 * something to move behind the reader's back. A declined or empty answer
 * leaves the dialog on the deck's current name, so this is a no-op rather than
 * a failure.
 */
export type SlidesNamedCopy = {
  suggest(input: {content:string}): Promise<string>
  save(stem:string): Promise<void>
}
export async function nameWithAi(getCtx: () => ActionCtx, copy?: SlidesNamedCopy): Promise<void> {
  const ctx = getCtx()
  // the model reads the deck, so an edit still being typed has to land first
  const editing = ctx.editingActiveRef.current
  if (!await flushActiveEdit(ctx)) return
  // that commit can replace the deck, so read it again rather than from the
  // snapshot taken before the flush
  const deck = editing ? getCtx() : ctx
  const stem = await modelSaveAsName(deck.slides, copy?.suggest)
  if (!stem) return
  if (copy) {
    await runSerialized(async () => {
      const current = getCtx()
      if (!await flushActiveEdit(current)) return
      if (!await flushNotesForSave(current)) return
      await copy.save(stem)
    })
    return
  }
  await saveAsWithName(getCtx, `${stem}.pptx`)
}

/**
 * Save As with a name the reader (or the model, via `nameWithAi`) chose.
 *
 * A null name means "the deck's current name", which is read inside the queue:
 * a save that landed while this call was waiting may have changed it.
 */
export async function saveAsWithName(getCtx: () => ActionCtx, name: string | null): Promise<void> {
  // Same queue as save(): Save + Save As (or double Save As) write through
  // the same main-process pipe and would interleave without it.
  await runSerialized(async () => {
    const ctx = getCtx()
    if (!await flushActiveEdit(ctx)) return
    if (!await flushNotesForSave(ctx)) return
    const target = name ?? (baseName(ctx.path ?? '') || 'presentation.pptx')
    const r = await window.slidesApi.saveAs(target)
    if (r.ok) {
      if (r.slides) adoptSavedSlides(ctx, r.slides)
      ctx.setPath(r.path ?? ctx.path)
      ctx.setDirty(false)
      if (ctx.notesDraftsPending()) {
        ctx.setStatus(t('appEditCommitPending'))
        return
      }
      const saved = t('appStatusSavedAs')
      ctx.setStatus(saved)
      showToast(saved)
    } else if (r.error) {
      // a canceled dialog returns ok:false without error — only real write
      // failures surface, matching the docs/sheets save-as feedback
      const failed = t('appStatusSaveFailed', { error: r.error })
      ctx.setStatus(failed)
      showToast(failed, 'error')
    }
  })
}

/** Export base name: file name without the .pptx extension */
export function exportBaseName(ctx: ActionCtx): string {
  return (baseName(ctx.path ?? '') || t('appUntitledPresentation')).replace(/\.pptx$/i, '')
}

export type SlideImageDownload = (baseName: string, format: 'png' | 'jpg', pages: string[]) => Promise<string>

/** Render visible slides at 2x, then hand the output to the host. */
export async function exportImages(ctx: ActionCtx, format: 'png' | 'jpg' = 'png', download?: SlideImageDownload): Promise<void> {
  const visible = ctx.slides.filter((s) => !s.hidden)
  if (visible.length === 0) {
    ctx.setStatus(t('appExportNoSlides'))
    return
  }
  try {
    if (download) {
      if (visible.some(slide => slide.widthPx > 4096 || slide.heightPx > 4096 || slide.widthPx * slide.heightPx > 4 * 1024 * 1024)) {
        throw new Error('Slide dimensions exceed the image export limit')
      }
      ctx.setStatus(t('appExportImagesProgress', { count: visible.length }))
      const pages = await renderSlidesToImageBase64(visible, ctx.images, {format, maxOutputChars:64 * 1024 * 1024})
      const archive = await download(exportBaseName(ctx), format, pages)
      ctx.setStatus(t('appExportImagesDone', {count:pages.length, dir:archive}))
      return
    }
    const dir = await window.slidesApi.pickExportDir()
    if (!dir) return
    ctx.setStatus(t('appExportImagesProgress', { count: visible.length }))
    const pages = await renderSlidesToImageBase64(visible, ctx.images, { format })
    const r = await window.slidesApi.exportImages({
      dir,
      baseName: exportBaseName(ctx),
      format,
      pngsBase64: pages,
    })
    ctx.setStatus(
      r.ok
        ? t('appExportImagesDone', { count: r.paths?.length ?? 0, dir })
        : t('appExportImagesFailed', { error: r.error ?? t('appUnknownError') }),
    )
  } catch (err) {
    ctx.setStatus(t('appExportImagesFailed', { error: String(err) }))
  }
}

/** Export as video: save dialog, then the offline show encoded to MP4; the dialog shows progress and cancels */
export async function exportVideoFile(
  ctx: ActionCtx,
  opts: VideoExportOptions,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<VideoExportResult> {
  if (!ctx.slides.some((s) => !s.hidden)) {
    ctx.setStatus(t('appExportNoSlides'))
    return { ok: false, cancelled: true }
  }
  const path = await window.slidesApi.pickExportVideoPath(`${exportBaseName(ctx)}.mp4`)
  if (!path) return { ok: false, cancelled: true }
  const r = await exportVideo(
    { slides: ctx.slides, images: ctx.images, path },
    opts,
    onProgress,
    signal,
  )
  if (r.ok) {
    ctx.setStatus(t('appExportVideoDone', { path: r.path }))
    showToast(t('appExportVideoDone', { path: r.path }))
  } else if (!r.cancelled) {
    const msg = r.unsupported
      ? t('appExportVideoUnsupported')
      : t('appExportVideoFailed', { error: r.error })
    ctx.setStatus(msg)
    showToast(msg, 'error')
  }
  return r
}

/**
 * Element and text-run hyperlinks of every exported page as clickable overlay
 * rects (the pages are rasterized, so links must ride along separately). Link
 * fetch failures degrade to a link-less PDF rather than failing the export.
 */
async function collectPdfLinks(ctx: ActionCtx): Promise<ExportPdfLink[][]> {
  const modelIndexes = ctx.slides.flatMap((s, i) => (s.hidden ? [] : [i]))
  const pageOfModelIndex = new Map(modelIndexes.map((mi, page) => [mi, page] as const))
  try {
    const linkLists: Awaited<ReturnType<typeof window.slidesApi.getSlideLinks>>[] = []
    const runLinkLists: Awaited<ReturnType<typeof window.slidesApi.getRunLinks>>[] = []
    // Keep the renderer's link reads inside the browser bridge's queue limit.
    for (let offset = 0; offset < modelIndexes.length; offset += 16) {
      const batch = modelIndexes.slice(offset, offset + 16)
      const [elements, runs] = await Promise.all([
        Promise.all(batch.map(index => window.slidesApi.getSlideLinks(index))),
        Promise.all(batch.map(index => window.slidesApi.getRunLinks(index))),
      ])
      linkLists.push(...elements)
      runLinkLists.push(...runs)
    }
    const visible = modelIndexes.map((mi) => ctx.slides[mi]!)
    return collectExportPdfLinks(visible, linkLists, runLinkLists, pageOfModelIndex)
  } catch {
    return []
  }
}

export type SlidePdfDownload = (baseName: string, pages: string[], widthPx: number, heightPx: number, links: ExportPdfLink[][]) => Promise<string>

/**
 * Export as PDF: each page (skipping hidden ones) rendered to vector SVG (text
 * stays text; a page the SVG backend cannot build falls back to its 2x PNG);
 * main process printToPDF in a hidden window.
 *
 * `outPath` skips the save dialog — the headless CLI entry already knows where
 * the file goes. Resolves true only when a PDF was written.
 */
export async function exportPdf(ctx: ActionCtx, outPath?: string, download?: SlidePdfDownload): Promise<boolean> {
  const visible = ctx.slides.filter((s) => !s.hidden)
  if (visible.length === 0) {
    ctx.setStatus(t('appExportNoSlides'))
    return false
  }
  try {
    if (download) {
      if (visible.some(slide => slide.widthPx > 4096 || slide.heightPx > 4096 || slide.widthPx * slide.heightPx > 4 * 1024 * 1024)) {
        throw new Error('Slide dimensions exceed the PDF export limit')
      }
      ctx.setStatus(t('appExportPdfProgress'))
      const pages = await renderSlidesToImageBase64(visible,ctx.images,{format:'png',maxOutputChars:64 * 1024 * 1024})
      const path = await download(exportBaseName(ctx),pages,visible[0].widthPx,visible[0].heightPx,await collectPdfLinks(ctx))
      ctx.setStatus(t('appExportPdfDone',{path}))
      return true
    }
    const target = outPath ?? (await window.slidesApi.pickExportPdfPath(`${exportBaseName(ctx)}.pdf`))
    if (!target) return false
    ctx.setStatus(t('appExportPdfProgress'))
    const { pages, fontCss } = await renderSlidesToPdfPages(visible, ctx.images)
    const links = await collectPdfLinks(ctx)
    const r = await window.slidesApi.exportPdf({
      filePath: target,
      pages,
      widthPx: visible[0].widthPx,
      heightPx: visible[0].heightPx,
      links,
      fontCss,
    })
    ctx.setStatus(
      r.ok
        ? t('appExportPdfDone', { path: r.path ?? '' })
        : t('appExportPdfFailed', { error: r.error ?? t('appUnknownError') }),
    )
    return r.ok
  } catch (err) {
    ctx.setStatus(t('appExportPdfFailed', { error: String(err) }))
    return false
  }
}
