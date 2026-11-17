import type { RevisionService } from '../revisions/service.ts'
import type { LeaseService } from '../leases/service.ts'
import { createHash } from 'node:crypto'
import type { createFileService } from '../files/service.ts'
import { authError } from '../auth/sessions.ts'
import type { PptxChildSession, SlidesApplyView, SlidesCreatedEntryView, SlidesRenderSlideLike, SlidesStepView } from '../../../../worker/src/native/pptx-session-host.ts'

type Files = ReturnType<typeof createFileService>
/** Session factory contract. The application rejects PPTX mounting until a verified
 * OS-isolated host exists; unit tests inject factories with this shape. Sessions are created ONLY from revision-pinned downloaded
 * bytes that the file service already authorized. */
export interface SlidesSessionHost {
  openSession(input: { fileId: string; revision: string; bytes: Uint8Array }, signal?: AbortSignal): Promise<PptxChildSession>
}
export interface SlidesAuthority {editorId:string;leaseEpoch:number}
export interface SlidesOpenInput extends SlidesAuthority { revision: string; generation: number; fitWidthPx?: number }
export interface SlidesSlideInput extends SlidesAuthority { revision: string; generation: number; index: number; fitWidthPx?: number }
export interface SlidesReadInput extends SlidesAuthority { revision: string; generation: number }
export interface SlidesApplyInput extends SlidesReadInput { ops: unknown }
export interface SlidesSaveExportInput extends SlidesAuthority { revision: string; generation: number }
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
  preparedUploadId?: string; lastExportSha?: string; exportedGeneration?: number; exportedStateGeneration?: number
  history: { canUndo: boolean; canRedo: boolean }; lastUsed: number
}
/** Every operation reauthorizes through the file service (owner-scoped, format-checked) and
 * fences the caller's session generation. No session handle, path or revision is ever accepted
 * from the browser: the registry is keyed by fileId server-side only. */
export function createSlidesService({ files, leases, revisions, host, maxConcurrent = 2, maxSessions = 8, sessionIdleMs = 30 * 60_000 }: {
  files: Files; leases: LeaseService; revisions: Pick<RevisionService, 'verifyUploadCommit'>; host: SlidesSessionHost; maxConcurrent?: number; maxSessions?: number; sessionIdleMs?: number
}) {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) throw new Error('Invalid slides concurrency')
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 64) throw new Error('Invalid slides session bound')
  if (!Number.isSafeInteger(sessionIdleMs) || sessionIdleMs < 10_000 || sessionIdleMs > 24 * 3600_000) throw new Error('Invalid slides session idle bound')
  let active = 0
  const registry = new Map<string, SessionEntry>()
  const starting = new Set<string>()
  const sweeper = setInterval(() => {
    for (const [fileId, entry] of registry) {
      if (Date.now() - entry.lastUsed > sessionIdleMs) { registry.delete(fileId); bindings.delete(fileId); entry.handle.close() }
    }
  }, 60_000)
  sweeper.unref?.()
  function dirty(entry: SessionEntry): boolean { return entry.stateGeneration !== entry.savedGeneration }
  /** Authorize the caller, then pin/adopt the session for `revision`. Adoption keeps a live
   * session across its own T06 commit: once the head carries exactly the exported bytes, the
   * generation history continues under the new revision — with the old pin dead, in-flight
   * old-revision calls are rejected before native work, and anything else conflicts. */
  async function pinned(token: string, fileId: string, revision: string, signal?: AbortSignal) {
    const head = await files.openFile(token, fileId)
    if (head.format !== 'pptx') throw authError(415)
    if (head.file.revision !== revision) throw authError(409)
    signal?.throwIfAborted()
    const entry = registry.get(fileId)
    if (!entry) { if(head.file.revision!==revision)throw authError(409); return { head, entry: undefined } }
    if (entry.revision === revision) {
      entry.lastUsed = Date.now()
      return { head, entry }
    }
    // Equal bytes are not provenance. Only the exact server-staged upload from
    // this authenticated session may move this draft's pin to a committed head.
    if (!entry.preparedUploadId || !entry.lastExportSha || head.file.sha256 !== entry.lastExportSha) throw authError(409)
    await revisions.verifyUploadCommit(token, fileId, {
      uploadId: entry.preparedUploadId, revision: head.file.revision,
      baseRevision: entry.revision,
    })
    entry.revision = head.file.revision
    entry.savedGeneration = entry.exportedStateGeneration!
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
        const current=await files.openFile(token, fileId)
        if(current.file.revision!==revision)throw authError(409)
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
  const service = {
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
    async bindPreparedUpload(token: string, fileId: string, input: SlidesSaveExportInput & { uploadId: string }, signal?: AbortSignal) {
      const { entry } = await pinned(token, fileId, input.revision, signal)
      if (!entry || entry.exportedGeneration !== input.generation) throw authError(409)
      fence(entry, input.generation)
      entry.preparedUploadId = input.uploadId
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
     * records the exported state. Adoption additionally requires a bound upload and database commit proof. */
    async exportForSave(token: string, fileId: string, input: SlidesSaveExportInput, signal?: AbortSignal): Promise<{ generation: number; bytes: Buffer }> {
      const { entry } = await pinned(token, fileId, input.revision, signal)
      if (!entry) throw authError(409)
      fence(entry, input.generation)
      const exported = await entry.handle.exportBytes(input.generation, signal).catch(mapSessionError)
      entry.preparedUploadId = undefined
      entry.lastExportSha = createHash('sha256').update(exported.bytes).digest('hex')
      entry.exportedGeneration = exported.generation
      entry.exportedStateGeneration = entry.stateGeneration
      return { generation: exported.generation, bytes: Buffer.from(exported.bytes) }
    },
    closeAll() {
      for (const [fileId, entry] of registry) { registry.delete(fileId); bindings.delete(fileId); entry.handle.close() }
    },
  }
  // No browser-local check can grant mutation authority. Bind every live draft to
  // the authenticated token digest + exact editor/lease epoch. A new lease opens
  // a fresh persisted document, never inherits another editor's dirty child.
  const bindings=new Map<string,string>(),busy=new Set<string>()
  type Method='open'|'slide'|'slides'|'apply'|'undo'|'redo'|'exportDraft'|'exportForSave'|'bindPreparedUpload'
  function guarded<K extends Method>(method:K):typeof service[K]{
    return (async(token:string,fileId:string,input:SlidesReadInput,signal?:AbortSignal)=>{
      if(!input||typeof input.editorId!=='string'||!Number.isSafeInteger(input.leaseEpoch)||input.leaseEpoch<1)throw authError(400)
      if(busy.has(fileId))throw authError(409)
      busy.add(fileId)
      const binding=createHash('sha256').update(token).digest('hex')+':'+input.editorId+':'+input.leaseEpoch
      let entered=false,completed=false
      const discard=()=>{if(bindings.get(fileId)===binding){registry.get(fileId)?.handle.close();registry.delete(fileId);bindings.delete(fileId)}}
      try{
        signal?.throwIfAborted()
        await leases.renewLease(token,fileId,{editorId:input.editorId,leaseEpoch:input.leaseEpoch})
        signal?.throwIfAborted()
        if(bindings.has(fileId)&&bindings.get(fileId)!==binding){
          if(method!=='open')throw authError(409)
          registry.get(fileId)?.handle.close();registry.delete(fileId);bindings.delete(fileId)
        }
        if(method==='open'){
          const head=await files.openFile(token,fileId)
          if(head.file.revision!==input.revision)throw authError(409)
          const previous=registry.get(fileId)
          if(previous&&previous.revision!==head.file.revision&&previous.lastExportSha!==head.file.sha256){previous.handle.close();registry.delete(fileId)}
        }
        bindings.set(fileId,binding);entered=true
        const value=await (service[method] as Function)(token,fileId,input,signal)
        completed=true
        // Lease/session/head can change during native work; never publish its result
        // or leave a draft alive after authority loss. T06 repeats fences at commit.
        await leases.renewLease(token,fileId,{editorId:input.editorId,leaseEpoch:input.leaseEpoch})
        signal?.throwIfAborted()
        await pinned(token,fileId,input.revision,signal)
        return value
      }catch(error){
        if(entered){
          if(completed)discard()
          else try{signal?.throwIfAborted();await leases.renewLease(token,fileId,{editorId:input.editorId,leaseEpoch:input.leaseEpoch})}catch{discard()}
        }
        throw error
      }
      finally{busy.delete(fileId)}
    }) as typeof service[K]
  }
  return {bindPreparedUpload:guarded('bindPreparedUpload'),open:guarded('open'),slide:guarded('slide'),slides:guarded('slides'),apply:guarded('apply'),undo:guarded('undo'),redo:guarded('redo'),exportDraft:guarded('exportDraft'),exportForSave:guarded('exportForSave'),closeAll(){service.closeAll();bindings.clear()}}
}
export type SlidesSessions = ReturnType<typeof createSlidesService>
