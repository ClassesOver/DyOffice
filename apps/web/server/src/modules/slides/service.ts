import { createHash } from 'node:crypto'
import type { createFileService } from '../files/service.ts'
import { authError } from '../auth/sessions.ts'
import type { PptxChildSession, SlidesApplyView, SlidesCreatedEntryView, SlidesRenderSlideLike, SlidesStepView } from '../../../../worker/src/native/pptx-session-host.ts'

type Files = ReturnType<typeof createFileService>
/** One forked-session factory. Production wires the T10 child-process host; tests may inject
 * any factory with the same shape. Sessions are created ONLY from revision-pinned downloaded
 * bytes that the file service already authorized. */
export interface SlidesSessionHost {
  openSession(input: { fileId: string; revision: string; bytes: Uint8Array }, signal?: AbortSignal): Promise<PptxChildSession>
}
export interface SlidesOpenInput { revision: string; generation: number; fitWidthPx?: number }
export interface SlidesSlideInput { revision: string; generation: number; index: number; fitWidthPx?: number }
export interface SlidesReadInput { revision: string; generation: number }
export interface SlidesApplyInput extends SlidesReadInput { ops: unknown }
export interface SlidesSaveExportInput { revision: string; generation: number }
export interface SlidesOpenView { generation: number; dirty: boolean; size: { cx: number; cy: number }; defaultFont: string; slides: SlidesRenderSlideLike[]; history: { canUndo: boolean; canRedo: boolean } }
export interface SlidesSlidesView { generation: number; slides: SlidesRenderSlideLike[] }
export interface SlidesStepResponse { generation: number; dirty: boolean; slides: SlidesRenderSlideLike[] | null; history: { canUndo: boolean; canRedo: boolean } }
export interface SlidesApplyResponse { generation: number; dirty: boolean; changed: number[]; created: SlidesCreatedEntryView[]; order?: string[]; index?: number; sections?: string[]; history: { canUndo: boolean; canRedo: boolean } }

const OP_REJECTED = new Set(['GENERATION_CONFLICT','OP_REJECTED','SESSION_CLOSED','INVALID_SLIDE'])
const OP_INVALID = new Set(['OPS_LIMIT','PAYLOAD_LIMIT','INVALID_OPS','UNSUPPORTED_OP','UNSUPPORTED_FIELD','INVALID_TARGET','INVALID_PARAGRAPHS','INVALID_RUN','INVALID_FILL','INVALID_STROKE','INVALID_GEOMETRY','INVALID_KIND','INVALID_ROTATION','INVALID_LAYOUT','INVALID_TEXT','INVALID_FIT_WIDTH','RENDER_LIMIT'])
const STRUCTURAL = new Set(['addBlankSlide','addSlideWithLayout','duplicateSlide','deleteSlide','moveSlide'])
const ADDING = new Set(['addBlankSlide','addSlideWithLayout','duplicateSlide'])
const MAX_DOWNLOAD = 32 * 1024 * 1024
function mapSessionError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  if (OP_REJECTED.has(message)) throw authError(409)
  if (OP_INVALID.has(message)) throw authError(400)
  if (message === 'INPUT_LIMIT') throw authError(413)
  throw error
}
interface SessionEntry {
  handle: PptxChildSession; fileId: string; revision: string; size: { cx: number; cy: number }; defaultFont: string
  generation: number; stateGeneration: number; savedGeneration: number
  lastExportSha?: string; exportedGeneration?: number
  history: { canUndo: boolean; canRedo: boolean }; lastUsed: number
}
/** Every operation reauthorizes through the file service (owner-scoped, format-checked) and
 * fences the caller's session generation. No session handle, path or revision is ever accepted
 * from the browser: the registry is keyed by fileId server-side only. */
export function createSlidesService({ files, host, maxConcurrent = 2, maxSessions = 8, sessionIdleMs = 30 * 60_000 }: {
  files: Files; host: SlidesSessionHost; maxConcurrent?: number; maxSessions?: number; sessionIdleMs?: number
}) {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) throw new Error('Invalid slides concurrency')
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 64) throw new Error('Invalid slides session bound')
  if (!Number.isSafeInteger(sessionIdleMs) || sessionIdleMs < 10_000 || sessionIdleMs > 24 * 3600_000) throw new Error('Invalid slides session idle bound')
  let active = 0
  const registry = new Map<string, SessionEntry>()
  const starting = new Set<string>()
  const sweeper = setInterval(() => {
    for (const [fileId, entry] of registry) {
      if (Date.now() - entry.lastUsed > sessionIdleMs) { registry.delete(fileId); entry.handle.close() }
    }
  }, 60_000)
  sweeper.unref?.()
  function dirty(entry: SessionEntry): boolean { return entry.stateGeneration !== entry.savedGeneration }
  /** Authorize the caller, then pin/adopt the session for `revision`. Adoption keeps a live
   * session across its own T06 commit: once the head carries exactly the exported bytes, the
   * generation history continues under the new revision — with the old pin dead, in-flight
   * old-revision calls re-pin transparently, and anything else conflicts. */
  async function pinned(token: string, fileId: string, revision: string, signal?: AbortSignal) {
    const head = await files.openFile(token, fileId)
    if (head.format !== 'pptx') throw authError(415)
    signal?.throwIfAborted()
    const entry = registry.get(fileId)
    if (!entry) return { head, entry: undefined }
    const committedOwnExport = entry.lastExportSha !== undefined
      && head.file.revision !== entry.revision
      && head.file.sha256 === entry.lastExportSha
    if (entry.revision !== revision) {
      if (!(revision === head.file.revision && entry.lastExportSha !== undefined && head.file.sha256 === entry.lastExportSha)) throw authError(409)
    } else if (!committedOwnExport) {
      entry.lastUsed = Date.now()
      return { head, entry }
    }
    entry.revision = head.file.revision
    entry.savedGeneration = entry.exportedGeneration!
    entry.lastUsed = Date.now()
    return { head, entry }
  }
  function fence(entry: SessionEntry, generation: number) {
    entry.lastUsed = Date.now()
    if (!Number.isSafeInteger(generation) || generation !== entry.generation) throw authError(409)
  }
  async function downloadPinned(token: string, fileId: string, revision: string, signal?: AbortSignal) {
    if (active >= maxConcurrent) throw Object.assign(authError(429), { retryAfter: 1 })
    active++
    try {
      signal?.throwIfAborted()
      const source = await files.download(token, fileId, revision)
      if (source.format !== 'pptx') throw authError(415)
      signal?.throwIfAborted()
      if (source.bytes.byteLength > MAX_DOWNLOAD) throw authError(413)
      await files.openFile(token, fileId)
      signal?.throwIfAborted()
      return source.bytes
    } finally { active-- }
  }
  async function start(token: string, fileId: string, revision: string, signal?: AbortSignal): Promise<SessionEntry> {
    if (registry.has(fileId) || starting.has(fileId)) throw authError(409)
    if (registry.size + starting.size >= maxSessions) throw Object.assign(authError(429), { retryAfter: 5 })
    starting.add(fileId)
    try {
      const bytes = await downloadPinned(token, fileId, revision, signal)
      const handle = await host.openSession({ fileId, revision, bytes }, signal).catch(mapSessionError)
      const outline = await handle.outline(0).catch(error => { handle.close(); throw error })
      const entry: SessionEntry = {
        handle, fileId, revision, size: outline.size,
        defaultFont: outline.defaultFont ?? 'Calibri',
        generation: 0, stateGeneration: 0, savedGeneration: 0,
        history: { canUndo: false, canRedo: false }, lastUsed: Date.now(),
      }
      registry.set(fileId, entry)
      try {
        // The forked session is expensive state: reauthorize after all native work and
        // destroy the child when the caller lost access in the meantime.
        await files.openFile(token, fileId)
        return entry
      } catch (error) {
        registry.delete(fileId)
        entry.handle.close()
        throw error
      }
    } finally { starting.delete(fileId) }
  }
  async function ensure(token: string, fileId: string, revision: string, signal?: AbortSignal): Promise<SessionEntry> {
    const { entry } = await pinned(token, fileId, revision, signal)
    if (entry) return entry
    return start(token, fileId, revision, signal)
  }
  function applyResponse(entry: SessionEntry, view: SlidesApplyView): SlidesApplyResponse {
    entry.generation = view.generation
    entry.stateGeneration = view.stateGeneration
    entry.history = { canUndo: view.canUndo, canRedo: view.canRedo }
    const changed: number[] = []
    let orderChanged = false, index: number | undefined
    for (const rec of view.records) {
      const name = typeof rec.op === 'string' ? rec.op : String(rec.op?.op ?? '')
      if (STRUCTURAL.has(name)) {
        orderChanged = true
        if (ADDING.has(name)) {
          const created = rec.created?.[0]
          let at = created ? view.slideIds.indexOf(created) : -1
          const after = rec.after as { index?: unknown } | undefined
          if (at < 0 && typeof after?.index === 'number') at = after.index
          if (at >= 0) { index = at; if (!changed.includes(at)) changed.push(at) }
        }
        continue
      }
      if (typeof rec.slideId === 'string') {
        const at = view.slideIds.indexOf(rec.slideId)
        if (at >= 0 && !changed.includes(at)) changed.push(at)
      }
    }
    changed.sort((left, right) => left - right)
    return {
      generation: view.generation, dirty: dirty(entry), changed, created: view.created ?? [], history: entry.history,
      ...(orderChanged ? { order: view.paths, sections: [] } : {}),
      ...(index !== undefined ? { index } : {}),
    }
  }
  function stepResponse(entry: SessionEntry, view: SlidesStepView): SlidesStepResponse {
    entry.generation = view.generation
    entry.stateGeneration = view.stateGeneration
    entry.history = { canUndo: view.canUndo, canRedo: view.canRedo }
    return { generation: view.generation, dirty: dirty(entry), slides: view.slides, history: entry.history }
  }
  return {
    async open(token: string, fileId: string, input: SlidesOpenInput, signal?: AbortSignal): Promise<SlidesOpenView> {
      const entry = await ensure(token, fileId, input.revision, signal)
      fence(entry, input.generation)
      const slides = await entry.handle.renderAll(input.generation, input.fitWidthPx).catch(mapSessionError)
      return { generation: entry.generation, dirty: dirty(entry), size: entry.size, defaultFont: entry.defaultFont, slides, history: entry.history }
    },
    async slide(token: string, fileId: string, input: SlidesSlideInput, signal?: AbortSignal): Promise<SlidesRenderSlideLike> {
      const { entry } = await pinned(token, fileId, input.revision, signal)
      if (!entry) throw authError(409)
      fence(entry, input.generation)
      return entry.handle.render(input.generation, input.index, input.fitWidthPx).catch(mapSessionError)
    },
    async slides(token: string, fileId: string, input: SlidesReadInput, signal?: AbortSignal): Promise<SlidesSlidesView> {
      const { entry } = await pinned(token, fileId, input.revision, signal)
      if (!entry) throw authError(409)
      fence(entry, input.generation)
      const slides = await entry.handle.renderAll(input.generation).catch(mapSessionError)
      return { generation: entry.generation, slides }
    },
    async apply(token: string, fileId: string, input: SlidesApplyInput, signal?: AbortSignal): Promise<SlidesApplyResponse> {
      const { entry } = await pinned(token, fileId, input.revision, signal)
      if (!entry) throw authError(409)
      fence(entry, input.generation)
      const view = await entry.handle.apply(input.generation, input.ops, signal).catch(mapSessionError)
      return applyResponse(entry, view)
    },
    async undo(token: string, fileId: string, input: SlidesReadInput, signal?: AbortSignal): Promise<SlidesStepResponse> {
      const { entry } = await pinned(token, fileId, input.revision, signal)
      if (!entry) throw authError(409)
      fence(entry, input.generation)
      const view = await entry.handle.undo(input.generation, signal).catch(error => error instanceof Error && error.message === 'NOTHING_TO_UNDO' ? undefined : mapSessionError(error))
      if (view === undefined) return { generation: entry.generation, dirty: dirty(entry), slides: null, history: entry.history }
      return stepResponse(entry, view)
    },
    async redo(token: string, fileId: string, input: SlidesReadInput, signal?: AbortSignal): Promise<SlidesStepResponse> {
      const { entry } = await pinned(token, fileId, input.revision, signal)
      if (!entry) throw authError(409)
      fence(entry, input.generation)
      const view = await entry.handle.redo(input.generation, signal).catch(error => error instanceof Error && error.message === 'NOTHING_TO_REDO' ? undefined : mapSessionError(error))
      if (view === undefined) return { generation: entry.generation, dirty: dirty(entry), slides: null, history: entry.history }
      return stepResponse(entry, view)
    },
    /** Current draft bytes for a direct download; never marks anything saved. */
    async exportDraft(token: string, fileId: string, input: SlidesSaveExportInput, signal?: AbortSignal): Promise<{ generation: number; bytes: Buffer }> {
      const { entry } = await pinned(token, fileId, input.revision, signal)
      if (!entry) throw authError(409)
      fence(entry, input.generation)
      const exported = await entry.handle.exportBytes(input.generation, signal).catch(mapSessionError)
      return { generation: exported.generation, bytes: Buffer.from(exported.bytes) }
    },
    /** Save-path export for the T06 upload preparation: fences the caller's generation and
     * records the exported sha so the service can adopt the session once that upload commits. */
    async exportForSave(token: string, fileId: string, input: SlidesSaveExportInput, signal?: AbortSignal): Promise<{ generation: number; bytes: Buffer }> {
      const { entry } = await pinned(token, fileId, input.revision, signal)
      if (!entry) throw authError(409)
      fence(entry, input.generation)
      const exported = await entry.handle.exportBytes(input.generation, signal).catch(mapSessionError)
      entry.lastExportSha = createHash('sha256').update(exported.bytes).digest('hex')
      entry.exportedGeneration = exported.generation
      return { generation: exported.generation, bytes: Buffer.from(exported.bytes) }
    },
    closeAll() {
      for (const [fileId, entry] of registry) { registry.delete(fileId); entry.handle.close() }
    },
  }
}
export type SlidesSessions = ReturnType<typeof createSlidesService>
