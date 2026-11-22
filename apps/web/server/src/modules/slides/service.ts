import type { RevisionService } from '../revisions/service.ts'
import type { LeaseService } from '../leases/service.ts'
import { createHash } from 'node:crypto'
import { sniffImageMime } from '../../../../../slides/src/main/media-mime.ts'
import type { createFileService } from '../files/service.ts'
import { authError } from '../auth/sessions.ts'
import type { PptxChildSession, SlidesApplyView, SlidesCreatedEntryView, SlidesImageCommand, SlidesRenderSlideLike, SlidesStepView } from '../../../../worker/src/native/pptx-session-host.ts'

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
export interface SlidesApplyInput extends SlidesReadInput { ops: unknown; isolation?: 'atomic' | 'per_op'; dryRun?: boolean }
export interface SlidesChartEditInput extends SlidesReadInput {slide:number;sourceId:string;patch:Record<string,unknown>;confirmed?:boolean}
export interface SlidesGeneratedImageInput {url:string;bytesBase64:string;ext:string}
export interface SlidesGeneratePageInput extends SlidesReadInput {specJson:string;images:SlidesGeneratedImageInput[]}
export interface SlidesLandPagesInput extends SlidesReadInput {markers:string[];mode:'replace'|'append'|'replace_at'|'insert_at';atIndex?:number}
export type SlidesImageInput = SlidesReadInput & {slide:number;bytesBase64:string;ext:string} & (
  {mode:'insert';placement:'natural';xPx?:never;yPx?:never;wPx?:never;hPx?:never;fitWidthPx?:never}
  | {mode:'insert';placement?:never;xPx:number;yPx:number;wPx:number;hPx:number;fitWidthPx:number}
  | {mode:'replace';sourceId:string;keepSrcRect?:boolean;placement?:never}
)
export interface SlidesSaveExportInput extends SlidesAuthority { revision: string; generation: number }
export interface SlidesOpenView { generation: number; dirty: boolean; size: { cx: number; cy: number }; defaultFont: string; slides: SlidesRenderSlideLike[]; history: { canUndo: boolean; canRedo: boolean }; writeProtected?: true }
export interface SlidesSlidesView { generation: number; slides: SlidesRenderSlideLike[] }
export interface SlidesStepResponse { generation: number; dirty: boolean; size: {cx:number;cy:number}; slides: SlidesRenderSlideLike[] | null; history: { canUndo: boolean; canRedo: boolean } }
type SlidesTransaction = SlidesApplyView['transaction']
type SlidesTransactionRecord = NonNullable<SlidesTransaction['records']>[number] & {slidePath?: string}
export interface SlidesApplyResponse { generation: number; dirty: boolean; changed: number[]; created: SlidesCreatedEntryView[]; size: {cx:number;cy:number}; order?: string[]; index?: number; sections?: string[]; history: { canUndo: boolean; canRedo: boolean }; transaction: Omit<SlidesTransaction, 'records'> & {records?: SlidesTransactionRecord[]} }

const OP_REJECTED = new Set(['GENERATION_CONFLICT','OP_REJECTED','SESSION_CLOSED','INVALID_SLIDE','HISTORY_BATCH_ACTIVE'])
const OP_INVALID = new Set(['OPS_LIMIT','PAYLOAD_LIMIT','INVALID_OPS','INVALID_MEDIA','INVALID_ELEMENT','INVALID_GENERATED_PAGE','UNSUPPORTED_OP','UNSUPPORTED_FIELD','INVALID_TARGET','INVALID_PARAGRAPHS','INVALID_RUN','INVALID_FILL','INVALID_STROKE','INVALID_TABLE','INVALID_GEOMETRY','INVALID_KIND','INVALID_ROTATION','INVALID_LAYOUT','INVALID_TEXT','INVALID_FIT_WIDTH','RENDER_LIMIT','INVALID_MASTER_PART','MASTER_EDIT_REJECTED'])
const STRUCTURAL = new Set(['addBlankSlide','addSlideWithLayout','duplicateSlide','deleteSlide','moveSlide','insertSlidePptx'])
const ADDING = new Set(['addBlankSlide','addSlideWithLayout','duplicateSlide','insertSlidePptx'])
const MAX_DOWNLOAD = 32 * 1024 * 1024
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_IMAGE_BASE64 = Math.ceil(MAX_IMAGE_BYTES/3)*4
const EMU_MAX=2147483647
const IMAGE_MIME_BY_EXT:Record<string,string>={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif'}
function decodeImage(input:SlidesImageInput){
  if(typeof input.bytesBase64!=='string'||input.bytesBase64.length<4||input.bytesBase64.length>MAX_IMAGE_BASE64||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.bytesBase64))throw authError(400)
  const bytes=Buffer.from(input.bytesBase64,'base64')
  if(bytes.length<10||bytes.length>MAX_IMAGE_BYTES||bytes.toString('base64')!==input.bytesBase64)throw authError(400)
  const mime=sniffImageMime(bytes)
  const ext=input.ext.toLowerCase().replace(/^jpeg$/,'jpg').replace(/^tiff$/,'tif')
  if(!mime||({bmp:'image/bmp',tif:'image/tiff',...IMAGE_MIME_BY_EXT} as Record<string,string>)[ext]!==mime)throw authError(400)
  return {bytes,ext}
}
function decodeGeneratedImage(input:SlidesGeneratedImageInput){
  if(typeof input.url!=='string'||input.url.length<1||input.url.length>4096||!/^https?:\/\//i.test(input.url)||typeof input.bytesBase64!=='string'||input.bytesBase64.length<4||input.bytesBase64.length>MAX_IMAGE_BASE64||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.bytesBase64))throw authError(400)
  const bytes=Buffer.from(input.bytesBase64,'base64')
  if(bytes.length<10||bytes.length>MAX_IMAGE_BYTES||bytes.toString('base64')!==input.bytesBase64)throw authError(400)
  const mime=bytes[0]===0x89&&bytes[1]===0x50&&bytes[2]===0x4e&&bytes[3]===0x47?'image/png':bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff?'image/jpeg':bytes[0]===0x47&&bytes[1]===0x49&&bytes[2]===0x46&&bytes[3]===0x38?'image/gif':null
  const ext=input.ext.toLowerCase().replace(/^jpeg$/,'jpg')
  if(!mime||IMAGE_MIME_BY_EXT[ext]!==mime)throw authError(400)
  return {url:input.url,bytes,ext}
}
function mapSessionError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  if (OP_REJECTED.has(message)) throw authError(409)
  if (OP_INVALID.has(message)) throw authError(400)
  if (message==='GENERATED_PAGE_LIMIT') throw authError(413)
  if (message === 'INPUT_LIMIT') throw authError(413)
  if (message === 'PPTX_WRITE_PROTECTED') throw authError(403)
  throw error
}
interface SessionEntry {
  handle: PptxChildSession; fileId: string; revision: string; count:number; size: { cx: number; cy: number }; defaultFont: string
  generation: number; stateGeneration: number; savedGeneration: number
  writeProtected?: true
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
      const outline = await handle.outline(0, signal).catch(error => { handle.close(); throw error })
      const entry: SessionEntry = {
        handle, fileId, revision, count:outline.count, size: outline.size,
        defaultFont: outline.defaultFont ?? 'Calibri',
        ...(outline.writeProtected ? {writeProtected:true as const} : {}),
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
    entry.count = view.count
    entry.size = view.size
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
    const transaction = {...view.transaction, records: view.transaction.records?.map(record => {
      const slidePath = record.slideId ? view.paths[view.slideIds.indexOf(record.slideId)] : undefined
      return slidePath ? {...record, slidePath} : record
    })}
    return {
      generation: view.generation, dirty: dirty(entry), changed, created: view.created ?? [], size: view.size, history: entry.history, transaction,
      ...(orderChanged ? { order: view.paths, sections: [] } : {}),
      ...(index !== undefined ? { index } : {}),
    }
  }
  function stepResponse(entry: SessionEntry, view: SlidesStepView): SlidesStepResponse {
    entry.generation = view.generation
    entry.stateGeneration = view.stateGeneration
    entry.size = view.size
    entry.history = { canUndo: view.canUndo, canRedo: view.canRedo }
    return { generation: view.generation, dirty: dirty(entry), size: view.size, slides: view.slides, history: entry.history }
  }
  const service = {
    async openOutline(token: string, fileId: string, input: SlidesReadInput, signal?: AbortSignal) {
      const entry = await ensure(token, fileId, input.revision, signal)
      fence(entry, input.generation)
      return { generation: entry.generation, count: entry.count }
    },
    async open(token: string, fileId: string, input: SlidesOpenInput, signal?: AbortSignal): Promise<SlidesOpenView> {
      const entry = await ensure(token, fileId, input.revision, signal)
      fence(entry, input.generation)
      const slides = await entry.handle.renderAll(input.generation, input.fitWidthPx, signal).catch(mapSessionError)
      return { generation: entry.generation, dirty: dirty(entry), size: entry.size, defaultFont: entry.defaultFont, slides, history: entry.history,
        ...(entry.writeProtected ? {writeProtected:entry.writeProtected} : {}) }
    },
    async slide(token: string, fileId: string, input: SlidesSlideInput, signal?: AbortSignal): Promise<SlidesRenderSlideLike> {
      const { entry } = await pinned(token, fileId, input.revision, signal)
      if (!entry) throw authError(409)
      fence(entry, input.generation)
      return entry.handle.render(input.generation, input.index, input.fitWidthPx).catch(mapSessionError)
    },
    async notes(token: string, fileId: string, input: SlidesSlideInput, signal?: AbortSignal): Promise<{text:string}> {
      const { entry } = await pinned(token, fileId, input.revision, signal)
      if (!entry) throw authError(409)
      fence(entry, input.generation)
      return {text: await entry.handle.notes(input.generation, input.index, signal).catch(mapSessionError)}
    },
    async comments(token: string, fileId: string, input: SlidesSlideInput, signal?: AbortSignal) {
      const { entry } = await pinned(token, fileId, input.revision, signal)
      if (!entry) throw authError(409)
      fence(entry, input.generation)
      return entry.handle.comments(input.generation, input.index, signal).catch(mapSessionError)
    },
    async chartData(token:string,fileId:string,input:SlidesSlideInput & {sourceId:string},signal?:AbortSignal) {
      const {entry}=await pinned(token,fileId,input.revision,signal)
      if(!entry)throw authError(409)
      fence(entry,input.generation)
      return entry.handle.chartData(input.generation,input.index,input.sourceId,signal).catch(mapSessionError)
    },
    async chartColorSchemes(token:string,fileId:string,input:SlidesReadInput,signal?:AbortSignal) {
      const {entry}=await pinned(token,fileId,input.revision,signal)
      if(!entry)throw authError(409)
      fence(entry,input.generation)
      return entry.handle.chartColorSchemes(input.generation,signal).catch(mapSessionError)
    },
    async animations(token: string, fileId: string, input: SlidesSlideInput, signal?: AbortSignal) {
      const { entry } = await pinned(token, fileId, input.revision, signal)
      if (!entry) throw authError(409)
      fence(entry, input.generation)
      return entry.handle.animations(input.generation, input.index, signal).catch(mapSessionError)
    },
    async links(token: string, fileId: string, input: SlidesSlideInput, signal?: AbortSignal) {
      const { entry } = await pinned(token, fileId, input.revision, signal)
      if (!entry) throw authError(409)
      fence(entry, input.generation)
      return entry.handle.links(input.generation, input.index, signal).catch(mapSessionError)
    },
    async runLinks(token: string, fileId: string, input: SlidesSlideInput, signal?: AbortSignal) {
      const { entry } = await pinned(token, fileId, input.revision, signal)
      if (!entry) throw authError(409)
      fence(entry, input.generation)
      return entry.handle.runLinks(input.generation, input.index, signal).catch(mapSessionError)
    },
    async layouts(token: string, fileId: string, input: SlidesReadInput, signal?: AbortSignal) {
      const { entry } = await pinned(token, fileId, input.revision, signal)
      if (!entry) throw authError(409)
      fence(entry, input.generation)
      return entry.handle.layouts(input.generation, signal).catch(mapSessionError)
    },
    async masterParts(token: string, fileId: string, input: SlidesOpenInput, signal?: AbortSignal) {
      const {entry} = await pinned(token, fileId, input.revision, signal)
      if (!entry) throw authError(409)
      fence(entry, input.generation)
      const items = await entry.handle.masterParts(input.generation, input.fitWidthPx, signal).catch(mapSessionError)
      return {items}
    },
    async applyMaster(token: string, fileId: string, input: SlidesOpenInput & {partPath:string; operation:unknown}, signal?: AbortSignal) {
      const {entry} = await pinned(token, fileId, input.revision, signal)
      if (!entry) throw authError(409)
      fence(entry, input.generation)
      const result = await entry.handle.applyMaster(input.generation, input.partPath, input.operation, input.fitWidthPx, signal).catch(mapSessionError)
      entry.generation = result.generation
      entry.stateGeneration = result.stateGeneration
      entry.history = {canUndo:result.canUndo, canRedo:result.canRedo}
      return {generation:entry.generation, dirty:dirty(entry), slide:result.slide, sourceId:result.sourceId, history:entry.history}
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
      const view = await entry.handle.apply(input.generation, input.ops, signal, {isolation:input.isolation,dryRun:input.dryRun}).catch(mapSessionError)
      return applyResponse(entry, view)
    },
    async editChart(token:string,fileId:string,input:SlidesChartEditInput,signal?:AbortSignal){
      const {entry}=await pinned(token,fileId,input.revision,signal)
      if(!entry)throw authError(409)
      fence(entry,input.generation)
      if(!Number.isSafeInteger(input.slide)||input.slide<0||input.slide>=entry.count||typeof input.sourceId!=='string'||!input.sourceId||input.sourceId.length>256||!input.patch||typeof input.patch!=='object'||Array.isArray(input.patch)||input.confirmed!==undefined&&typeof input.confirmed!=='boolean')throw authError(400)
      const rendered=await entry.handle.render(input.generation,input.slide).catch(mapSessionError)
      const chart=rendered.nodes.find(node=>node.sourceId===input.sourceId)
      if(chart?.type!=='chart')throw authError(400)
      if(chart.appCreated!==true&&!input.confirmed)return {confirmationRequired:true as const}
      const result=await entry.handle.editChart(input.generation,input.slide,input.sourceId,input.patch,signal).catch(mapSessionError)
      entry.generation=result.generation;entry.stateGeneration=result.stateGeneration;entry.history={canUndo:result.canUndo,canRedo:result.canRedo}
      return {generation:entry.generation,dirty:dirty(entry),slide:result.slide,sourceId:result.sourceId,history:entry.history}
    },
    async generatePage(token:string,fileId:string,input:SlidesGeneratePageInput,signal?:AbortSignal){
      const {entry}=await pinned(token,fileId,input.revision,signal)
      if(!entry)throw authError(409)
      fence(entry,input.generation)
      if(typeof input.specJson!=='string'||input.specJson.length>256*1024||!Array.isArray(input.images)||input.images.length>3)throw authError(400)
      const seen=new Set<string>(),images=input.images.map(image=>{
        const decoded=decodeGeneratedImage(image)
        if(seen.has(decoded.url))throw authError(400)
        seen.add(decoded.url)
        return decoded
      })
      return await entry.handle.generatePage(input.generation,input.specJson,images,signal).catch(mapSessionError)
    },
    async landGeneratedPages(token:string,fileId:string,input:SlidesLandPagesInput,signal?:AbortSignal){
      const {entry}=await pinned(token,fileId,input.revision,signal)
      if(!entry)throw authError(409)
      fence(entry,input.generation)
      if(!Array.isArray(input.markers)||!input.markers.length||input.markers.length>200||!['replace','append','replace_at','insert_at'].includes(input.mode)||input.markers.some(marker=>typeof marker!=='string'||marker.length<10||marker.length>128)||input.atIndex!==undefined&&!Number.isSafeInteger(input.atIndex))throw authError(400)
      const beforeCount=entry.count
      const view=await entry.handle.landGeneratedPages(input.generation,input.markers,input.mode,input.atIndex,signal).catch(mapSessionError)
      const applied=applyResponse(entry,view)
      const slides=await entry.handle.renderAll(view.generation,960,signal).catch(mapSessionError)
      return {generation:entry.generation,dirty:dirty(entry),size:entry.size,slides,order:view.paths,history:entry.history,...(input.mode==='append'?{appendedFrom:beforeCount}:{}),...(input.mode==='insert_at'?{insertedIndex:input.atIndex}:{}),...(input.mode==='replace_at'?{replacedIndex:input.atIndex}:{}),imageFailures:[],changed:applied.changed}
    },
    async applyImage(token:string,fileId:string,input:SlidesImageInput,signal?:AbortSignal){
      const media=decodeImage(input)
      const entry=await pinned(token,fileId,input.revision,signal).then(value=>value.entry)
      if(!entry)throw authError(409)
      fence(entry,input.generation)
      let command:SlidesImageCommand
      if(input.mode==='insert'){
        if(!Number.isSafeInteger(input.slide)||input.slide<0||input.slide>=entry.count)throw authError(400)
        if(input.placement==='natural'){
          if([input.xPx,input.yPx,input.wPx,input.hPx,input.fitWidthPx].some(value=>value!==undefined))throw authError(400)
          command={mode:'insert',slide:input.slide,placement:'natural',...media}
        }else{
          if(input.placement!==undefined||![input.xPx,input.yPx,input.wPx,input.hPx,input.fitWidthPx].every(Number.isFinite)||input.wPx<=0||input.hPx<=0||input.fitWidthPx<320||input.fitWidthPx>4096)throw authError(400)
          const scale=entry.size.cx/input.fitWidthPx
          const offset={x:Math.round(input.xPx*scale),y:Math.round(input.yPx*scale),cx:Math.round(input.wPx*scale),cy:Math.round(input.hPx*scale)}
          if([offset.x,offset.y,offset.cx,offset.cy].some(value=>!Number.isSafeInteger(value)||Math.abs(value)>EMU_MAX)||offset.cx<1||offset.cy<1)throw authError(400)
          command={mode:'insert',slide:input.slide,offset,...media}
        }
      }else{
        if(input.placement!==undefined||!Number.isSafeInteger(input.slide)||input.slide<0||input.slide>=entry.count||typeof input.sourceId!=='string'||!input.sourceId||input.sourceId.length>256||input.keepSrcRect!==undefined&&typeof input.keepSrcRect!=='boolean')throw authError(400)
        command={mode:'replace',slide:input.slide,sourceId:input.sourceId,bytes:media.bytes,ext:media.ext,...(input.keepSrcRect!==undefined?{keepSrcRect:input.keepSrcRect}:{})}
      }
      const view=await entry.handle.applyImage(input.generation,command,signal).catch(mapSessionError)
      const result=applyResponse(entry,view)
      const slide=await entry.handle.render(view.generation,input.slide).catch(mapSessionError)
      return {...result,slide}
    },
    async undo(token: string, fileId: string, input: SlidesReadInput, signal?: AbortSignal): Promise<SlidesStepResponse> {
      const { entry } = await pinned(token, fileId, input.revision, signal)
      if (!entry) throw authError(409)
      fence(entry, input.generation)
      const view = await entry.handle.undo(input.generation, signal).catch(error => error instanceof Error && error.message === 'NOTHING_TO_UNDO' ? undefined : mapSessionError(error))
      if (view === undefined) return { generation: entry.generation, dirty: dirty(entry), size: entry.size, slides: null, history: entry.history }
      return stepResponse(entry, view)
    },
    async beginHistoryBatch(token:string,fileId:string,input:SlidesReadInput,signal?:AbortSignal){
      const {entry}=await pinned(token,fileId,input.revision,signal)
      if(!entry)throw authError(409)
      fence(entry,input.generation)
      return {opened:await entry.handle.beginHistoryBatch(input.generation,signal).catch(mapSessionError)}
    },
    async endHistoryBatch(token:string,fileId:string,input:SlidesReadInput,signal?:AbortSignal){
      const {entry}=await pinned(token,fileId,input.revision,signal)
      if(!entry)throw authError(409)
      fence(entry,input.generation)
      const result=await entry.handle.endHistoryBatch(input.generation,signal).catch(mapSessionError)
      entry.history={canUndo:result.canUndo,canRedo:result.canRedo}
      return {snapshotId:result.snapshotId,history:entry.history}
    },
    async restoreSnapshot(token:string,fileId:string,input:SlidesReadInput&{snapshotId:number},signal?:AbortSignal):Promise<SlidesStepResponse>{
      if(!Number.isSafeInteger(input.snapshotId)||input.snapshotId<1)throw authError(400)
      const {entry}=await pinned(token,fileId,input.revision,signal)
      if(!entry)throw authError(409)
      fence(entry,input.generation)
      const view=await entry.handle.restoreSnapshot(input.generation,input.snapshotId,signal).catch(mapSessionError)
      if(!view)return {generation:entry.generation,dirty:dirty(entry),size:entry.size,slides:null,history:entry.history}
      return stepResponse(entry,view)
    },
    async redo(token: string, fileId: string, input: SlidesReadInput, signal?: AbortSignal): Promise<SlidesStepResponse> {
      const { entry } = await pinned(token, fileId, input.revision, signal)
      if (!entry) throw authError(409)
      fence(entry, input.generation)
      const view = await entry.handle.redo(input.generation, signal).catch(error => error instanceof Error && error.message === 'NOTHING_TO_REDO' ? undefined : mapSessionError(error))
      if (view === undefined) return { generation: entry.generation, dirty: dirty(entry), size: entry.size, slides: null, history: entry.history }
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
  const bindings=new Map<string,string>(),busy=new Map<string,{method:Method;count:number}>()
  type Method='open'|'openOutline'|'slide'|'notes'|'comments'|'animations'|'links'|'runLinks'|'chartData'|'chartColorSchemes'|'layouts'|'masterParts'|'applyMaster'|'slides'|'apply'|'editChart'|'generatePage'|'landGeneratedPages'|'applyImage'|'undo'|'redo'|'beginHistoryBatch'|'endHistoryBatch'|'restoreSnapshot'|'exportDraft'|'exportForSave'|'bindPreparedUpload'
  const signedReads=new Set<Method>(['open','slide','slides','notes','comments','animations','links','runLinks','chartData','chartColorSchemes','layouts','masterParts'])
  function guarded<K extends Method>(method:K):typeof service[K]{
    const opensSession=method==='open'||method==='openOutline'
    return (async(token:string,fileId:string,input:SlidesReadInput,signal?:AbortSignal)=>{
      if(!input)throw authError(400)
      const signedRead=input.editorId===undefined&&input.leaseEpoch===undefined&&signedReads.has(method)
      if(!signedRead&&(typeof input.editorId!=='string'||!Number.isSafeInteger(input.leaseEpoch)||input.leaseEpoch<1))throw authError(400)
      const authorize=async()=>{
        if(!signedRead){await leases.renewLease(token,fileId,{editorId:input.editorId,leaseEpoch:input.leaseEpoch});return}
        const head=await files.openFile(token,fileId)
        if(head.format!=='pptx')throw authError(415)
        if(head.file.revision!==input.revision)throw authError(409)
        if(!head.officeSignatureProtected)throw authError(400)
      }
      const active=busy.get(fileId)
      if(active&&!(method==='generatePage'&&active.method==='generatePage'))throw authError(409)
      if(active)active.count++
      else busy.set(fileId,{method,count:1})
      const binding=signedRead?'signed:'+input.revision:createHash('sha256').update(token).digest('hex')+':'+input.editorId+':'+input.leaseEpoch
      let entered=false,completed=false
      const discard=()=>{if(bindings.get(fileId)===binding){registry.get(fileId)?.handle.close();registry.delete(fileId);bindings.delete(fileId)}}
      try{
        signal?.throwIfAborted()
        await authorize()
        signal?.throwIfAborted()
        if(bindings.has(fileId)&&bindings.get(fileId)!==binding){
          if(!opensSession)throw authError(409)
          registry.get(fileId)?.handle.close();registry.delete(fileId);bindings.delete(fileId)
        }
        if(opensSession){
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
        await authorize()
        signal?.throwIfAborted()
        await pinned(token,fileId,input.revision,signal)
        return value
      }catch(error){
        if(entered){
          if(completed)discard()
          else try{signal?.throwIfAborted();await authorize()}catch{discard()}
        }
        throw error
      }
      finally{const current=busy.get(fileId);if(current&&--current.count===0)busy.delete(fileId)}
    }) as typeof service[K]
  }
  return {bindPreparedUpload:guarded('bindPreparedUpload'),open:guarded('open'),openOutline:guarded('openOutline'),slide:guarded('slide'),notes:guarded('notes'),comments:guarded('comments'),chartData:guarded('chartData'),chartColorSchemes:guarded('chartColorSchemes'),animations:guarded('animations'),links:guarded('links'),runLinks:guarded('runLinks'),layouts:guarded('layouts'),masterParts:guarded('masterParts'),applyMaster:guarded('applyMaster'),slides:guarded('slides'),apply:guarded('apply'),editChart:guarded('editChart'),generatePage:guarded('generatePage'),landGeneratedPages:guarded('landGeneratedPages'),applyImage:guarded('applyImage'),undo:guarded('undo'),redo:guarded('redo'),beginHistoryBatch:guarded('beginHistoryBatch'),endHistoryBatch:guarded('endHistoryBatch'),restoreSnapshot:guarded('restoreSnapshot'),exportDraft:guarded('exportDraft'),exportForSave:guarded('exportForSave'),closeAll(){service.closeAll();bindings.clear()},dispose(){clearInterval(sweeper);service.closeAll();bindings.clear()}}
}
export type SlidesSessions = ReturnType<typeof createSlidesService>
