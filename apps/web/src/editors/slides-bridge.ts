import type {SessionFileHost} from '../../../../packages/browser-host/src/files.ts'
import {CitedRevisionChanged} from '../../../../packages/browser-host/src/session-files'
import {hostError} from '../../../../packages/web-contracts/src/errors.ts'
import {mapScriptOpsForWidth} from '../../../../packages/pptx-ops/src/ops/script-map.ts'
import {parsePageSpec} from '../../../../packages/pipelines/src/slides/page-spec-parser.ts'
import {planSlideMoves} from '../../../slides/src/shared/slide-selection.ts'
import {pictureFrame} from '../../../slides/src/main/picture-frame.ts'
import {sniffImageMime} from '../../../slides/src/main/media-mime.ts'
import {imageDpiFromBytes, imageSizeFromBytes} from '../../../../packages/pptx-render/src/image-dpi.ts'
import {normalizeLang} from '@genoffice/i18n'
import {tMain} from '../../../slides/src/main/i18n-main.ts'
import {messages} from './messages.ts'
import {browserFileName, decodeBrowserBase64, downloadBrowserFile} from './browser-download'
import {createDocumentImageApi} from './web-ai-media-api.ts'
import type {AiPanelPrefs} from '@genoffice/ui'
import type {
  SlidesApi, OpenResult, SlideUpdate, SectionInfo, UiTheme, AutoSaveDefault, ApplyTxnOp, ApplyTxnResult,
  AiSettings, TransitionKind, ShowTiming, GetLayoutsResult, SlideComment, AnimationItem, ShapeKey,
  ApplyEditScriptOp,
  EditTextOp, AddSlideOp, AddBlankSlideOp, MoveSlideOp, AddElementOp, DeleteElementOp,
  DeleteElementsOp, EditTransformOp, EditTransformMultiOp, BatchEditTransformOp, ReorderElementOp,
  GroupElementsOp, UngroupElementOp, SetElementFontOp, SetElementParagraphFormatOp,
  FindReplaceOp, SetNotesOp, SetTransitionOp, SetSlideHiddenOp, SetSlideLayoutOp,
  AddSectionOp, RenameSectionOp, RemoveSectionOp, RemoveSectionSlidesOp, MoveSectionOp,
  HeaderFooterOp, AddSlideWithLayoutOp, LinkTargetOp,
  MasterPartItem, PasteSlideMode, PasteSlideResult, SaveRecordingOp,
} from '../../../slides/src/shared/ipc'

type Preferences = Awaited<ReturnType<SessionFileHost['getPreferences']>>
type SaveResult = {ok: boolean; path?: string; error?: string}
type SaveReceipt = Awaited<ReturnType<SessionFileHost['saveSlides']>>
type Recovery = {saved?: SaveReceipt; resolve(value: SaveResult): void; reject(error: unknown): void}
/** The server pptx session: pinned to the file revision, fenced by generation. */
type Session = {nameCandidate?:string;authority?:{editorId:string;leaseEpoch:number};revision: string; generation: number; dirty: boolean; size: {cx: number; cy: number}; defaultFont: string; writeProtected: boolean}
type ApplyResponse = {generation: number; dirty: boolean; changed?: number[]; created?: Array<{id:string;slide:number;index:number}>; size?: {cx:number;cy:number}; order?: string[]; index?: number; sections?: SectionInfo[] | null; history?: {canUndo: boolean; canRedo: boolean}; slide?: OpenResult['slides'][number]; transaction?: {applied:boolean;dryRun?:boolean;plan?:string[];failures?:Array<{index:number;error:string}>;records?:Array<{op:{op:string};slidePath?:string;created?:string[];after?:unknown}>}}
type HistoryState = {canUndo: boolean; canRedo: boolean}
const SLIDE_IMAGE_LIMIT = 6990508
const CLIPBOARD_KEY = 'dyoffice.pptx.clipboard'
const CLIPBOARD_MIME = 'application/x-dyoffice-slide-reference'
const CLIPBOARD_FORMAT = 'web '+CLIPBOARD_MIME
const CLIPBOARD_ID_BYTES = 36
const CLIPBOARD_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i
type ClipboardMarker = {id:string;kind:'slides'|'elements';published?:true}
let localClipboard:ClipboardMarker|null=null
function clipboardMarker():ClipboardMarker|null {
  try {
    if(typeof window==='undefined')return localClipboard
    const value=JSON.parse(window.sessionStorage.getItem(CLIPBOARD_KEY)??'null')
    return typeof value?.id==='string'&&(value.kind==='slides'||value.kind==='elements')?value:null
  }catch{return localClipboard}
}
function setClipboardMarker(marker:ClipboardMarker) {
  localClipboard=marker
  try { if(typeof window!=='undefined')window.sessionStorage.setItem(CLIPBOARD_KEY,JSON.stringify(marker)) }catch { /* In-memory fallback for restricted embeds. */ }
}
async function writeSystemClipboard(marker:ClipboardMarker,png?:string):Promise<boolean> {
  try {
    if(!globalThis.navigator?.clipboard?.write || typeof ClipboardItem==='undefined')return false
    const reference=`${marker.kind}:${marker.id}`
    const formats:Record<string,Blob>={[CLIPBOARD_FORMAT]:new Blob([reference],{type:CLIPBOARD_MIME})}
    if(png){
      if(png.length>SLIDE_IMAGE_LIMIT||!png.startsWith('iVBORw0KGgo'))return false
      formats['image/png']=new Blob([decodeBrowserBase64(png)],{type:'image/png'})
    }
    await navigator.clipboard.write([new ClipboardItem(formats)])
    if(clipboardMarker()?.id===marker.id)setClipboardMarker({...marker,published:true})
    return true
  }catch{return false}
}

async function readClipboard(allowPermissionPrompt=true):Promise<{marker:ClipboardMarker|null;items:ClipboardItem[];markerItem?:ClipboardItem}> {
  const local=clipboardMarker()
  const clipboard=globalThis.navigator?.clipboard
  let items:ClipboardItem[]
  try {
    if(!clipboard?.read)return {marker:local,items:[]}
    if(!allowPermissionPrompt){
      // Chromium keeps read() pending while the site permission prompt is open.
      const permission=await navigator.permissions?.query({name:'clipboard-read' as PermissionName}).catch(()=>null)
      if(permission&&permission.state!=='granted')return {marker:local,items:[]}
    }
    items=await clipboard.read()
  }catch{return {marker:local,items:[]}}
  for(const item of items){
    if(!item.types.includes(CLIPBOARD_FORMAT))continue
    try {
      const blob=await item.getType(CLIPBOARD_FORMAT)
      if(local&&blob.size===CLIPBOARD_ID_BYTES&&await blob.text()===local.id){
        // A bare reference needs the originating tab to supply its kind.
        return {marker:local,items,markerItem:item}
      }
      if(blob.size!=='slides:'.length+CLIPBOARD_ID_BYTES&&blob.size!=='elements:'.length+CLIPBOARD_ID_BYTES)continue
      const reference=await blob.text()
      const separator=reference.indexOf(':')
      const kind=reference.slice(0,separator)
      const id=reference.slice(separator+1)
      if((kind==='slides'||kind==='elements')&&id.length===CLIPBOARD_ID_BYTES&&CLIPBOARD_ID.test(id))return {marker:{kind,id},items,markerItem:item}
    }catch{ /* Other clipboard formats may still be available. */ }
  }
  return {marker:items.length===0&&!local?.published?local:null,items}
}

async function readClipboardPng(item:ClipboardItem):Promise<string> {
  if(!item.types.includes('image/png'))return ''
  const blob=await item.getType('image/png')
  if(blob.size>5*1024*1024)return ''
  return new Promise<string>((resolve,reject)=>{
    const reader=new FileReader()
    reader.onerror=()=>reject(reader.error)
    reader.onload=()=>resolve(String(reader.result).split(',')[1]??'')
    reader.readAsDataURL(blob)
  })
}

async function readSystemClipboard():ReturnType<SlidesApi['clipboardExternal']> {
  const {marker,items}=await readClipboard()
  if(marker?.kind==='slides')return {kind:'slide'}
  if(marker?.kind==='elements')return {kind:'internal',elementReference:marker.id}
  try {
    for(const item of items){
      const data=await readClipboardPng(item)
      if(data)return {kind:'image',base64:data,ext:'png'}
      if(item.types.includes('text/plain')){
        const blob=await item.getType('text/plain')
        const text=await blob.slice(0,4*1024*1024).text()
        if(text.trim())return {kind:'text',text}
      }
    }
  }catch{ /* The clipboard data is unavailable. */ }
  return {kind:'none'}
}
const isGeneratedImage = (url: string) => url.startsWith('https://generated-image.invalid/')
const WEBP_DATA_PREFIX = 'data:image/webp;base64,'
async function normalizeWebp(base64: string) {
  const {normalizePdfGeneratedImage} = await import('./pdf-generated-image')
  return normalizePdfGeneratedImage({mime:'image/webp',base64})
}
type ImageEdit = {slideIndex:number;url?:string;base64?:string;ext?:string} & (
  {mode:'insert';xPx:number;yPx:number;wPx:number;hPx:number;fitWidthPx:number} |
  {mode:'insert';placement:'natural'} |
  {mode:'replace';sourceId:string;keepSrcRect?:boolean}
)

function choosePicture(signal: AbortSignal): Promise<File | null> {
  if (signal.aborted) return Promise.resolve(null)
  return new Promise(resolve => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.png,.jpg,.jpeg,.gif,.bmp,.webp,.tif,.tiff'
    input.hidden = true
    const finish = (file: File | null) => {
      signal.removeEventListener('abort', cancel)
      input.remove()
      resolve(file)
    }
    const cancel = () => finish(null)
    input.onchange = () => finish(input.files?.[0] ?? null)
    input.oncancel = cancel
    signal.addEventListener('abort', cancel, {once:true})
    document.body.append(input)
    try { input.click() } catch { cancel() }
  })
}

export function createSlidesBridge(host: SessionFileHost, fileId: string, prefs: Preferences, {fetchImpl = fetch, onChange = () => {}, searchApi, mediaApi, skillsApi, pickPicture = choosePicture, confirmImportedChart = () => typeof window !== 'undefined' && window.confirm('Editing this imported chart may remove number formats, trendlines, error bars, and per-point styles. Continue?')}: {fetchImpl?: typeof fetch; onChange?: () => void; searchApi?: {webSearch: (query: string, maxResults?: number) => Promise<Awaited<ReturnType<SlidesApi['webSearch']>>>; imageSearch: (query: string, maxResults?: number) => Promise<Awaited<ReturnType<SlidesApi['imageSearch']>>>}; mediaApi?: {generateImage: SlidesApi['generateImage']; analyzeMedia: SlidesApi['analyzeMedia'];fetchImage?:(url:string)=>Promise<{base64:string;mime:string}|null>}; skillsApi?: Pick<SlidesApi, 'skillsList' | 'skillText'>; pickPicture?: (signal: AbortSignal) => Promise<File|null>; confirmImportedChart?:()=>boolean} = {}) {
  let saveFence:(()=>boolean)|null=null,applyFence:(()=>boolean)|null=null
  let committed:import('../../../../packages/web-contracts/src/api').RevisionRef|null=null
  async function guardedSave(check:()=>boolean,action:()=>Promise<boolean>){
    if(saveFence||!check())return false
    saveFence=check;try{return await action()}finally{saveFence=null}
  }
  async function guardedApply(check:()=>boolean,action:()=>Promise<boolean>){
    if(applyFence||!check())return false
    applyFence=check;try{return await action()}finally{applyFence=null}
  }
  let session: Session | null = null
  let elementImageCopy:{token:string;marker:ClipboardMarker}|null=null
  let lastClipboardPaste:{session:Session;id:string;index:number;generation:number}|null=null
  let master: {session:Session; partPath:string; width:number; slide:MasterPartItem['slide']} | null = null
  let openEpoch=0,opening=0,changing=0
  const controllers = new Set<AbortController>()
  const text = messages[prefs.language === 'en' ? 'en' : 'zh']
  let recovery: Recovery | null = null, confirming = false
  const inFlight = {count: 0}
  const waiting: (() => void)[] = []
  const historyHandlers = new Set<(state: HistoryState) => void>()
  const openedHandlers = new Set<(result: OpenResult) => void>()
  type SlideInfo = {
    transition: TransitionKind
    timing: ShowTiming
    headerFooter: Awaited<ReturnType<SlidesApi['getHeaderFooter']>>
    shapeKeys: ShapeKey[]
  }
  let inkQueue: { session: Session; revision: string; generation: number; done: Promise<void> } | undefined
  let slideInfo: { session: Session; generation: number; revision: string; result: Promise<SlideInfo[]> } | undefined
  let sections: SectionInfo[] = []
  let csrf: string | undefined, disposed = false
  let pendingOpen: Promise<OpenResult> | null = null
  const noEvent = () => () => {}
  const mediaUrls = new Set<string>()
  const unavailable = async (): Promise<never> => { throw new Error(text.unavailable) }
  const slideImages = mediaApi && createDocumentImageApi({
    async generateImage(input) {
      const result = await mediaApi.generateImage(input)
      if (result.url?.startsWith(WEBP_DATA_PREFIX)) {
        try {
          const image = await normalizeWebp(result.url.slice(WEBP_DATA_PREFIX.length))
          return {url:`data:${image.mime};base64,${image.base64}`}
        } catch { return {error:'The generated WebP image could not be converted for PowerPoint.'} }
      }
      if (result.url?.startsWith('data:') && result.url.length > SLIDE_IMAGE_LIMIT + 'data:image/jpeg;base64,'.length) {
        return {error: 'The generated image exceeds the slide image size limit.'}
      }
      return result
    },
    async fetchImage(url) {
      const image = await mediaApi.fetchImage?.(url)
      if (image?.mime !== 'image/webp') return image ?? null
      try { return await normalizeWebp(image.base64) } catch { return null }
    },
  })
  async function generatedPreview(url: string) {
    const image = await slideImages?.fetchImage(url)
    return image ? `data:${image.mime};base64,${image.base64}` : null
  }
  async function mediaReferences(urls: string[]) {
    const result = await Promise.all(urls.map(url => isGeneratedImage(url) ? generatedPreview(url) : url))
    return result.every(url => url !== null) ? result : null
  }
  const graceful = async (): Promise<null> => null

  function requireSession(): Session {
    if (disposed || !session) throw hostError('INVALID_REVISION', 'slides session')
    return session
  }
  function emitHistory(state: HistoryState | undefined) {
    if (!state) return
    for (const handler of historyHandlers) { try { handler(state) } catch { /* renderer listeners cannot change durable results */ } }
  }
  async function requestPath(path:string,httpMethod:'GET'|'POST'|'PUT',payload?:object) {
    if (disposed) throw hostError('UNAVAILABLE', 'disposed')
    const controller = new AbortController(); controllers.add(controller)
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!csrf) {
          const response = await fetchImpl('/api/v1/auth/csrf', {credentials: 'same-origin', cache: 'no-store', signal: controller.signal})
          if (!response.ok) throw hostError('UNAUTHORIZED', 'session')
          const body = await response.json()
          if (typeof body?.csrfToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.csrfToken)) throw hostError('INVALID_RESPONSE', 'csrf')
          csrf = body.csrfToken
        }
        if(saveFence&&/\/(apply|media|generated-pages|snapshot-restore|undo|redo|chart-edit|master-edit|clipboard-paste|clipboard-duplicate|recording)$/.test(path))throw hostError('UNAVAILABLE','analysis save in progress')
        if(path.endsWith('/apply')&&applyFence&&!applyFence())throw hostError('UNAVAILABLE','analysis target changed')
        const proof = csrf
        const response = await fetchImpl(path, {method:httpMethod,credentials:'same-origin',cache:'no-store',signal:controller.signal,headers:{...(payload?{'content-type':'application/json'}:{}),'x-csrf-token':proof!},...(payload?{body:JSON.stringify(payload)}:{})})
        if (response.status === 403 && attempt === 0) { if (csrf === proof) csrf = undefined; continue }
        if (!response.ok) throw hostError(response.status === 401 || response.status === 403 ? 'UNAUTHORIZED' : response.status === 409 ? 'CONFLICT' : 'UNAVAILABLE', 'slides call')
        if (!response.headers.get('content-type')?.includes('application/json')) throw hostError('INVALID_RESPONSE', 'slides call')
        return await response.json()
      }
    } finally { controllers.delete(controller) }
  }
  async function request(revision: string, generation: number, method: string, input: object = {}) {
    return requestPath(`/api/v1/files/${fileId}/slides/${method}`,'POST',{revision,generation,...input,editorId:host.getState(fileId).lease?.editorId,leaseEpoch:host.getState(fileId).lease?.leaseEpoch})
  }
  async function acquireSlot(){
    if (inFlight.count >= 1) await new Promise<void>(resolve => waiting.push(resolve))
    else inFlight.count++
  }
  function releaseSlot(){const next = waiting.shift(); if (next) next(); else inFlight.count--}
  async function call(revision: string, generation: number, method: string, input: object = {}) {
    if(method!=='open'&&opening)throw hostError('CONFLICT','slides session reopening')
    if (waiting.length >= 64) throw hostError('UNAVAILABLE', 'read capacity')
    const captured=session,epoch=openEpoch
    const readOnly=['slide','slides','notes','comments','animations','slide-info','media-data','links','run-links','layouts','chart-data','chart-color-schemes','master-parts','clipboard-copy'].includes(method)
    if(method!=='open'&&!readOnly&&captured?.writeProtected)throw hostError('UNAVAILABLE','write-protected presentation')
    if(!readOnly)changing++
    await acquireSlot()
    try {
      if(method!=='open'&&(opening||disposed||session!==captured||epoch!==openEpoch||!captured||captured.revision!==revision))throw hostError('CONFLICT','stale slides session')
      if(readOnly){
        if(disposed||session!==captured||!captured||captured.revision!==revision)throw hostError('CONFLICT','stale slides read')
        if(method!=='clipboard-copy')generation=captured.generation
      }
      const result=await request(revision,generation,method,input)
      // 先采用代数再唤醒排队读取；写操作仍使用调用时捕获的代数，绝不自动重试。
      if (!readOnly && method !== 'open' && !disposed && epoch === openEpoch && session === captured && captured?.revision === revision && typeof result?.generation === 'number') {
        captured.generation = result.generation
        if (Array.isArray(result.sections)) sections = result.sections
      }
      return result
    }
    finally { if(!readOnly)changing--;releaseSlot() }
  }
  /** Reopen (or idempotently refresh) the revision-pinned pptx session. `fire` pushes onOpened like the desktop main process does for externally opened files. */
  async function openSession(fire: boolean): Promise<OpenResult> {
    openEpoch++;opening++
    master=null
    try{
    const state = host.getState(fileId)
    const generation = session && session.revision === state.revision.revision ? session.generation : 0
    const raw = await call(state.revision.revision, generation, 'open') as {generation: number; dirty: boolean; size?: {cx: number; cy: number}; defaultFont?: string; slides: OpenResult['slides']; sections?: SectionInfo[]; writeProtected?: true}
    if (disposed) throw hostError('UNAVAILABLE', 'disposed')
    session = {...(state.lease?{authority:{editorId:state.lease.editorId,leaseEpoch:state.lease.leaseEpoch}}:{}),revision: state.revision.revision, generation: raw.generation, dirty: !!raw.dirty, size: raw.size ?? {cx: 12192000, cy: 6858000}, defaultFont: raw.defaultFont ?? 'Calibri',writeProtected: raw.writeProtected===true}
    sections = raw.sections ?? []
    const result: OpenResult = {path: state.name, slides: raw.slides, size: session.size, defaultFont: session.defaultFont}
    if (fire) for (const handler of openedHandlers) { try { handler(result) } catch { /* renderer listeners cannot change durable results */ } }
    return result
    }finally{opening--}
  }
  /** Every body carries the pinned {revision, generation}; a moved head or a stale generation conflicts. */
  async function applyOps(ops: unknown[], options: Pick<ApplyTxnOp, 'isolation' | 'dryRun'> = {}): Promise<ApplyResponse | null> {
    const current = requireSession()
    // No lease, no mutation: unowned edits never reach the server session.
    // An unconfirmed receipt parks mutations too: the pinned revision may be
    // dead once the staged commit landed, so edits wait for the confirmation
    // that adopts the committed head.
    if (opening || recovery || !host.getState(fileId).lease) return null
    const raw = await call(current.revision, current.generation, 'apply', {ops,...options}) as ApplyResponse
    current.generation = raw.generation
    current.dirty = !!raw.dirty
    if (raw.size) current.size = raw.size
    emitHistory(raw.history)
    return raw
  }
  async function fetchSlideInfo(index: number): Promise<SlideInfo> {
    const current = requireSession()
    const {generation, revision} = current
    if (!slideInfo || slideInfo.session !== current || slideInfo.generation !== generation || slideInfo.revision !== revision) {
      const info = {session:current, generation, revision, result:call(revision,generation,'slide-info') as Promise<SlideInfo[]>}
      slideInfo = info
      void info.result.catch(() => { if (slideInfo === info) slideInfo = undefined })
    }
    const active = slideInfo
    const info = (await active.result)[index]
    if (disposed || current !== session || !info) throw hostError('INVALID_RESPONSE','slide presentation settings')
    return info
  }
  async function editRecording(input:({kind:'save'}&SaveRecordingOp)|{kind:'clear';indexes:number[]}) {
    const current=session
    if(disposed||!current||opening||recovery||!host.getState(fileId).lease)return null
    const result=await call(current.revision,current.generation,'recording',input) as ApplyResponse & {slides:OpenResult['slides']|null}
    if(disposed||session!==current||!result.slides)return null
    current.dirty=result.dirty
    emitHistory(result.history)
    onChange()
    return result.slides
  }
  async function fetchSlide(index: number): Promise<OpenResult['slides'][number]> {
    const current = requireSession()
    return await call(current.revision, current.generation, 'slide', {index}) as OpenResult['slides'][number]
  }
  async function fetchDeck(): Promise<{slides: OpenResult['slides']}> {
    const current = requireSession()
    return await call(current.revision, current.generation, 'slides') as {slides: OpenResult['slides']}
  }
  async function readMasterParts(current:Session, width:number) {
    if (recovery || opening || !host.getState(fileId).lease) return null
    return await call(current.revision, current.generation, 'master-parts', {fitWidthPx:width}) as {items:MasterPartItem[]}
  }
  async function editMaster(operation:unknown) {
    const selected = master
    if (!selected || selected.session !== session || opening || recovery || !host.getState(fileId).lease) return null
    const current = selected.session
    const result = await call(current.revision, current.generation, 'master-edit', {
      partPath:selected.partPath, fitWidthPx:selected.width, operation,
    }) as ApplyResponse & {sourceId?:string}
    if (session !== current || disposed) return null
    current.dirty = result.dirty
    emitHistory(result.history)
    onChange()
    if (!result.slide || master !== selected) return null
    selected.slide = result.slide
    return result
  }
  async function fetchComments(index: number): Promise<SlideComment[]> {
    const current = requireSession()
    return await call(current.revision, current.generation, 'comments', {index}) as SlideComment[]
  }
  /** fitWidthPx viewport coordinates map linearly onto the slide's EMU width. */
  function emuBox(current: Session, fitWidthPx: number, xPx: number, yPx: number, wPx: number, hPx: number) {
    const scale = current.size.cx / Math.max(1, fitWidthPx)
    return {x: Math.round(xPx * scale), y: Math.round(yPx * scale), cx: Math.round(wPx * scale), cy: Math.round(hPx * scale)}
  }
  function createdId(raw:ApplyResponse){const value=raw.created?.[0];return typeof value==='string'?value:value?.id??''}
  async function imageBytes(input:{url?:string;base64?:string;ext?:string}){
    let base64=input.base64, mime=''
    if(!base64&&input.url?.startsWith('data:')){
      const match=/^data:(image\/(?:png|jpeg|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(input.url)
      if(!match)return null
      mime=match[1]!;base64=match[2]
    }else if(!base64&&input.url&&/^https?:\/\//i.test(input.url)){
      const fetched=await slideImages?.fetchImage(input.url)
      if(!fetched)return null
      base64=fetched.base64;mime=fetched.mime
    }
    if(!base64||base64.length>SLIDE_IMAGE_LIMIT||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))return null
    const ext=(input.ext??({ 'image/png':'png','image/jpeg':'jpg','image/gif':'gif'} as Record<string,string>)[mime]??'').toLowerCase().replace(/^jpeg$/,'jpg').replace(/^tiff$/,'tif')
    if(ext==='webp'&&input.base64){
      try {
        const image=await normalizeWebp(base64)
        return {bytesBase64:image.base64,ext:'png'}
      } catch { return null }
    }
    if(!['png','jpg','gif','bmp','tif'].includes(ext))return null
    return {bytesBase64:base64,ext}
  }
  function applyImage(input: Extract<ImageEdit, {mode:'insert'}>): ReturnType<SlidesApi['insertImageUrl']>
  function applyImage(input: Extract<ImageEdit, {mode:'replace'}>): ReturnType<SlidesApi['replacePictureUrl']>
  async function applyImage(input: ImageEdit){
    const current=requireSession()
    const stillCurrent = captureImageTarget(current)
    if (!stillCurrent()) return null
    const image=await imageBytes(input)
    if(!image || image.bytesBase64.length > SLIDE_IMAGE_LIMIT || !stillCurrent())return null
    const target = input.mode==='replace'
      ? {sourceId:input.sourceId,keepSrcRect:input.keepSrcRect}
      : 'placement' in input ? {placement:input.placement}
      : {xPx:input.xPx,yPx:input.yPx,wPx:input.wPx,hPx:input.hPx,fitWidthPx:input.fitWidthPx}
    const raw=await editPictureMedia(current,{mode:input.mode,slide:input.slideIndex,...image,...target})
    if(!raw?.slide)return null
    return input.mode==='insert'?{slide:raw.slide,sourceId:createdId(raw)}:raw.slide
  }

  async function editPictureMedia(current:Session,input:object):Promise<ApplyResponse|null> {
    const result=await call(current.revision,current.generation,'media',input) as ApplyResponse
    if(disposed||session!==current)return null
    current.generation=result.generation
    current.dirty=result.dirty
    emitHistory(result.history)
    onChange()
    return result
  }

  function captureImageTarget(current: Session) {
    const {revision, generation} = current
    const lease = host.getState(fileId).lease
    return () => {
      if (!lease || disposed || session !== current || current.revision !== revision || current.generation !== generation || recovery) return false
      const activeLease = host.getState(fileId).lease
      return activeLease?.editorId === lease.editorId && activeLease.leaseEpoch === lease.leaseEpoch
    }
  }

  async function pickLocalPicture() {
    const stillCurrent = captureImageTarget(requireSession())
    if (!stillCurrent()) return null
    const controller = new AbortController()
    controllers.add(controller)
    try {
      const file = await pickPicture(controller.signal)
      if (!file || !stillCurrent()) return null
      const ext = file.name.split('.').pop()?.toLowerCase().replace(/^jpeg$/, 'jpg').replace(/^tiff$/, 'tif') ?? ''
      const expectedMime = ({png:'image/png',jpg:'image/jpeg',gif:'image/gif',bmp:'image/bmp',webp:'image/webp',tif:'image/tiff'} as Record<string,string>)[ext]
      if (!expectedMime || !file.size || file.size > 5 * 1024 * 1024) return {base64:'', ext}
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (!stillCurrent()) return null
      if (sniffImageMime(bytes) !== expectedMime) return {base64:'', ext}
      const header = String.fromCharCode(...bytes.subarray(0, 8))
      if ((ext === 'png' && header !== '\x89PNG\r\n\x1a\n') || (ext === 'gif' && !/^GIF8[79]a/.test(header))) return {base64:'', ext}
      let binary = ''
      for (let offset = 0; offset < bytes.length; offset += 32768) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768))
      }
      return {base64:btoa(binary), ext}
    } finally { controllers.delete(controller) }
  }

  const addImageBytes: SlidesApi['addImageBytes'] = async input => {
    let {base64, ext} = input
    const current = requireSession()
    const stillCurrent = captureImageTarget(current)
    if (!stillCurrent()) return null
    if (!base64 || base64.length > SLIDE_IMAGE_LIMIT) return {error:'unsupported', ext}
    if (ext === 'webp') {
      const image = await imageBytes(input)
      if (!image || image.bytesBase64.length > SLIDE_IMAGE_LIMIT) return {error:'unsupported', ext}
      if (!stillCurrent()) return null
      base64 = image.bytesBase64
      ext = image.ext
    }
    if ('xPx' in input) return applyImage({mode:'insert', ...input, base64, ext})
    let bytes: Uint8Array
    try { bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0)) } catch { return {error:'unsupported', ext} }
    const scale = input.fitWidthPx / current.size.cx
    const size = imageSizeFromBytes(bytes)
    const gif = ext === 'gif' && bytes.length >= 10
      ? {width: bytes[6]! + bytes[7]! * 256, height: bytes[8]! + bytes[9]! * 256}
      : null
    const frame = pictureFrame({width:current.size.cx, height:current.size.cy}, size ? {width:size.w, height:size.h} : gif ?? input.naturalPx, imageDpiFromBytes(bytes), 96,
      input.centerPx ? {center:{x:input.centerPx.x/scale,y:input.centerPx.y/scale}} : undefined)
    return applyImage({mode:'insert', slideIndex:input.slideIndex, fitWidthPx:input.fitWidthPx, base64, ext, xPx:frame.x*scale,yPx:frame.y*scale,wPx:frame.cx*scale,hPx:frame.cy*scale})
  }
  async function copyClipboard(kind:ClipboardMarker['kind'], input:object) {
    const current=requireSession()
    const result=await call(current.revision,current.generation,'clipboard-copy',{kind,...input})
      .catch(()=>null) as {id:string;count:number}|null
    if(disposed||session!==current||!result?.id)return null
    const marker={kind,id:result.id}
    setClipboardMarker(marker)
    await writeSystemClipboard(marker)
    return {marker,count:result.count}
  }
  type ClipboardResult = PasteSlideResult & {generation:number;dirty:boolean;history:HistoryState;sourceIds:string[]}
  async function clipboardEdit(method:'clipboard-paste'|'clipboard-duplicate',input:object):Promise<ClipboardResult|null|undefined> {
    const current=requireSession()
    if(!captureImageTarget(current)()||current.writeProtected)return undefined
    const result=await call(current.revision,current.generation,method,input).catch(()=>undefined) as ClipboardResult|null|undefined
    if(disposed||session!==current)return undefined
    if(!result)return result
    current.dirty=result.dirty
    emitHistory(result.history)
    onChange()
    return result
  }
  async function pasteSlideClipboard(index:number,fitWidthPx:number,mode:PasteSlideMode,replace=false):Promise<PasteSlideResult|null> {
    const current=requireSession()
    const stillCurrent=captureImageTarget(current)
    if(!stillCurrent()||current.writeProtected)return null
    const {marker}=await readClipboard(false)
    if(marker?.kind!=='slides'||!stillCurrent())return null
    if(replace&&(!lastClipboardPaste||lastClipboardPaste.session!==current||lastClipboardPaste.id!==marker.id||lastClipboardPaste.generation!==current.generation))return null
    const result=await clipboardEdit('clipboard-paste',{kind:'slides',clipboardId:marker.id,index,fitWidthPx,mode,...(replace?{replace:true}:{})})
    if(!result)return null
    lastClipboardPaste={session:current,id:marker.id,index,generation:result.generation}
    return {order:result.order,slides:result.slides,index:result.index,count:result.count,sourceIds:result.sourceIds}
  }
  const slideUpdateFrom = (order: string[], deck: {slides: OpenResult['slides']}) => ({order, slides: deck.slides})
  const op = (name: string, fields: Record<string, unknown>) => ({op: name, ...fields})

  const api = {
    getLanguage: async () => prefs.language === 'en' ? 'en' as const : 'zh' as const,
    getTheme: async (): Promise<UiTheme> => prefs.theme,
    getAutoSaveDefault: async (): Promise<AutoSaveDefault> => ({on: prefs.autoSave === true, updatedAt: 1}),
    getAiPanelPrefs: async (): Promise<AiPanelPrefs> => ({side: 'left', fontSize: 'default', customFontSize: 14, spellcheck: true, showAiSidebar: false, showAiAskTrigger: true} as AiPanelPrefs),
    setAiPanelPrefs: async (patch: Partial<AiPanelPrefs>) => ({side: 'left', fontSize: 'default', customFontSize: 14, spellcheck: true, showAiSidebar: false, showAiAskTrigger: true, ...patch} as AiPanelPrefs),
    getAiSettings: async () => ({provider: 'genspark', providers: {}}) as unknown as AiSettings,
    setAiSettings: async () => {},
    onLanguageChanged: noEvent, onThemeChanged: noEvent, onAutoSaveDefaultChanged: noEvent,
    onAiPanelPrefsChanged: noEvent, onAiSettingsChanged: noEvent,
    onChromePressed: noEvent, onFontsChanged: noEvent, onMenuCommand: noEvent, onRenamed: noEvent,
    onCloseSaveRequest: noEvent, onDeckChanged: noEvent, onAiStream: noEvent,
    reportCloseSaveResult() {}, setAutoSavePref() {}, headlessExportDone() {},
    consumeHeadlessExport: async () => null,
    openPptx: async (_fitWidthPx: number) => await openSession(true),
    consumePendingOpen: async (_fitWidthPx: number) => { pendingOpen ??= openSession(false); return await pendingOpen },
    openPptxPath: unavailable, newBlank: unavailable, saveAs: unavailable,
    async localGeneratePage({specJson}: Parameters<SlidesApi['localGeneratePage']>[0]) {
      const current = requireSession()
      if (recovery || !host.getState(fileId).lease) return {ok: false, error: text.saveFailed}
      const parsed = parsePageSpec(specJson)
      if (!parsed.ok) return {ok: false, error: parsed.error}
      const urls = [...new Set(parsed.spec.elements.flatMap(element => element.type === 'image' ? [element.url] : []))].slice(0, 3)
      const {revision, generation} = current
      const images = (await Promise.all(urls.map(async url => {
        // Resolve remote images through the shared media API.
        if (url.length > 4096) return null
        const image = await imageBytes({url}).catch(() => null)
        return image ? {url, ...image} : null
      }))).filter(image => image !== null)
      if (recovery || current !== session || !host.getState(fileId).lease) return {ok: false, error: text.saveFailed}
      const result = await call(revision, generation, 'generate-page', {specJson, images}) as {marker: string; imageFailures: string[]}
      return {ok: true, marker: result.marker, imageFailures: result.imageFailures}
    },
    async landGeneratedPages(markers: string[], _fitWidthPx: number, mode: NonNullable<Parameters<SlidesApi['landGeneratedPages']>[2]> = 'replace', atIndex?: number,deckName?:string) {
      const current = requireSession()
      if (recovery || !host.getState(fileId).lease) return {error: text.saveFailed}
      const result = await call(current.revision, current.generation, 'generated-pages', {markers, mode, atIndex}) as ApplyResponse & {
        slides: OpenResult['slides']; appendedFrom?: number; insertedIndex?: number; replacedIndex?: number
      }
      const {slides, appendedFrom, insertedIndex, replacedIndex} = result
      if (result.dirty && host.getState(fileId).autoNamePending) {
        if (deckName?.trim() && (!current.nameCandidate || mode === 'replace')) current.nameCandidate = deckName
        else if (mode === 'replace') current.nameCandidate = undefined
      }
      current.generation = result.generation
      current.dirty = result.dirty
      if (result.size) current.size = result.size
      emitHistory(result.history)
      onChange()
      // A path would tell the renderer that generation has already saved a new file.
      return {path: '', slides, appendedFrom, insertedIndex, replacedIndex, size: current.size, defaultFont: current.defaultFont}
    },
    pickExportDir: unavailable, pickExportPdfPath: unavailable,
    pickExportVideoPath: unavailable,
    async pickPictureFile() {
      const picture = await pickLocalPicture()
      return picture?.base64 ? picture : null
    },
    async insertImage(slideIndex, fitWidthPx) {
      const picture = await pickLocalPicture()
      if (picture?.base64 && picture.ext==='tif') return applyImage({mode:'insert',placement:'natural',...picture,slideIndex})
      return picture ? addImageBytes({...picture, slideIndex, fitWidthPx, naturalPx:{width:0,height:0}}) : null
    },
    insertMedia: unavailable, addMediaBytes: unavailable,
    async getMediaData(index,sourceId){
      const current=session
      if(!current)return null
      try{
        const {media}=await call(current.revision,current.generation,'media-data',{index,sourceId})
        if(disposed||session!==current||!media||(media.kind!=='audio'&&media.kind!=='video')||
          typeof media.dataUrl!=='string')return null
        const prefix=/^data:((?:audio|video)\/[a-z0-9-]+);base64,/i.exec(media.dataUrl)
        if(!prefix)return null
        const bytes=decodeBrowserBase64(media.dataUrl.slice(prefix[0].length))
        if(!bytes.byteLength||typeof URL.createObjectURL!=='function')return null
        const dataUrl=URL.createObjectURL(new Blob([bytes],{type:prefix[1]!}))
        mediaUrls.add(dataUrl)
        return {kind:media.kind as 'audio'|'video',dataUrl}
      }catch{return null}
    },
    releaseMediaData(url:string) {
      if(mediaUrls.delete(url))URL.revokeObjectURL(url)
    },
    pickModel3d: unavailable, addModel3d: unavailable, setModel3dView: graceful, getModel3dData: graceful,
    videoFileOpen: unavailable, videoFileWrite: unavailable, videoFileClose: unavailable,
    async savePicture({pngBase64,defaultName}) {
      if(!pngBase64.startsWith('iVBORw0KGgo'))return {ok:false,error:text.unavailable}
      const bytes=decodeBrowserBase64(pngBase64)
      const name=browserFileName(defaultName.replace(/\.png$/i,''),'Picture')+'.png'
      downloadBrowserFile(new Blob([bytes],{type:'image/png'}),name)
      return {ok:true,path:name}
    },
    exportImages: unavailable, exportPdf: unavailable,
    printSlides: unavailable, listPrinters: unavailable, printerOptions: unavailable,
    fontCatalog: unavailable, fontDownload: unavailable, fontInstallLocal: unavailable,
    privateFontFaces: async () => [], privateFontData: async () => null, fontMissing: async () => <string[]>[],
    // Browser permission is requested by the recorder's getUserMedia call.
    microphoneAccess: async () => typeof window!=='undefined'&&window.isSecureContext&&
      typeof navigator.mediaDevices?.getUserMedia==='function'&&typeof MediaRecorder==='function',
    // 24 kHz 16-bit mono WAV at 48 KB/s, below the per-part and per-take service caps.
    recordingLimits: {
      slideMs:170_000,
      totalMs:250_000,
      notice:prefs.language==='zh'?'录音已达到网页保存上限，已停止录制。可以保存本次录音。':
        'Recording stopped at the Web recording limit. You can save this take.',
    },
    getRecentFiles: async () => <string[]>[],
    setShowFullScreen: async () => {}, nativeClipboard: async () => {},
    clipboardExternal:readSystemClipboard,
    clipboardProbe:async()=>clipboardMarker()!==null||Boolean(globalThis.navigator?.clipboard?.read),
    hasSlideClipboard:async()=>(await readClipboard(false)).marker?.kind==='slides',
    async copySlides({slideIndexes,pngs,cut}) {
      const indexes=[...new Set(slideIndexes)].sort((a,b)=>a-b)
      const bitmaps=indexes.length===slideIndexes.length&&indexes.every((value,i)=>value===slideIndexes[i])&&
        pngs?.length===indexes.length&&pngs.reduce((size,png)=>size+png.length,0)<=SLIDE_IMAGE_LIMIT?pngs:undefined
      return Boolean(await copyClipboard('slides',{indexes,...(cut?{cut:true}:{}),...(bitmaps?{pngs:bitmaps}:{})}))
    },
    async copyElements({slideIndex,sourceIds,cut,clipboardToken}){
      const result=await copyClipboard('elements',{index:slideIndex,sourceIds:[...new Set(sourceIds)],...(cut?{cut:true}:{})})
      if(!result)return 0
      elementImageCopy=clipboardToken?{token:clipboardToken,marker:result.marker}:null
      return result.count
    },
    async copyElementsImage(token,png){
      const copy=elementImageCopy
      if(!copy||copy.token!==token||clipboardMarker()?.id!==copy.marker.id||disposed)return false
      const {marker}=await readClipboard(false)
      if(disposed||elementImageCopy!==copy||clipboardMarker()?.id!==copy.marker.id)return false
      elementImageCopy=null
      if(marker?.kind!=='elements'||marker.id!==copy.marker.id)return false
      return writeSystemClipboard(copy.marker,png)
    },
    async pasteElements({slideIndex,fitWidthPx,elementReference}) {
      const current=session
      if(!current)return null
      const stillCurrent=captureImageTarget(current)
      if(!stillCurrent()||current.writeProtected)return null
      const {marker}=await readClipboard(false)
      if(marker?.kind!=='elements'||(elementReference&&marker.id!==elementReference)||!stillCurrent())return null
      const result=await clipboardEdit('clipboard-paste',{kind:'elements',clipboardId:marker.id,index:slideIndex,fitWidthPx})
      if(result?.slides[0])return {slide:result.slides[0],sourceIds:result.sourceIds}
      // A successful null reply means the editable copy is unavailable. A failed
      // request may have applied the edit, so retrying as a picture is unsafe.
      if(result!==null||!elementReference||!stillCurrent())return null
      const {marker:latest,markerItem}=await readClipboard(false)
      if(latest?.kind!=='elements'||latest.id!==elementReference||!markerItem||!stillCurrent())return null
      const base64=await readClipboardPng(markerItem).catch(()=>'')
      if(!base64||!stillCurrent())return null
      const image=await addImageBytes({slideIndex,fitWidthPx,base64,ext:'png',naturalPx:{width:320,height:240}}).catch(()=>null)
      return image&&'slide' in image?{slide:image.slide,sourceIds:[image.sourceId]}:null
    },
    async duplicateElements({slideIndex,sourceIds,fitWidthPx,dxPx,dyPx}) {
      const result=await clipboardEdit('clipboard-duplicate',{index:slideIndex,sourceIds:[...new Set(sourceIds)],fitWidthPx,dxPx,dyPx})
      return result?.slides[0]?{slide:result.slides[0],sourceIds:result.sourceIds}:null
    },
    pasteSlide:({afterIndex,fitWidthPx,mode='theme'})=>pasteSlideClipboard(afterIndex,fitWidthPx,mode),
    repasteSlide:({mode,fitWidthPx})=>lastClipboardPaste?pasteSlideClipboard(lastClipboardPaste.index,fitWidthPx,mode,true):Promise.resolve(null),
    async beginHistoryBatch(){
      const current=requireSession()
      if(recovery||!host.getState(fileId).lease)return false
      const result=await call(current.revision,current.generation,'history-batch-begin') as {opened:boolean}
      return result.opened===true
    },
    async endHistoryBatch(){
      const current=requireSession()
      if(recovery||!host.getState(fileId).lease)throw hostError('CONFLICT','history batch closure unavailable')
      const result=await call(current.revision,current.generation,'history-batch-end') as {snapshotId:number|null;history:HistoryState}
      emitHistory(result.history)
      return typeof result.snapshotId==='number'?result.snapshotId:null
    },
    async applyEditScript(input: ApplyEditScriptOp) {
      const current = requireSession()
      const ops = mapScriptOpsForWidth(current.size.cx, input)
      if (ops.length === 0) return null
      const applied = await applyOps(ops)
      if (!applied?.changed?.includes(input.slideIndex)) return null
      return {slide: await fetchSlide(input.slideIndex)}
    },
    async applyTxn(input: ApplyTxnOp): Promise<ApplyTxnResult | null> {
      const raw = await applyOps(input.ops, {isolation:input.isolation,dryRun:input.dryRun})
      if (!raw?.transaction) return null
      const transaction = raw.transaction
      const slides = transaction.applied && !transaction.dryRun ? (await fetchDeck()).slides : undefined
      const records = (transaction.records ?? []).map(record => {
        const page = record.slidePath ? slides?.findIndex(slide => slide.partPath === record.slidePath) ?? -1 : -1
        return {op:record.op.op,...(page >= 0 ? {target:String(page)} : {}),...(record.created ? {created:record.created} : {})}
      })
      return {applied:transaction.applied,...(transaction.dryRun ? {dryRun:true} : {}),...(transaction.plan ? {plan:transaction.plan} : {}),...(transaction.failures ? {failures:transaction.failures} : {}),...(records.length ? {records} : {}),...(slides ? {slides} : {})}
    },
    async aiSnapshotRestore(snapshotId:number){
      const current=requireSession()
      if(recovery||!host.getState(fileId).lease)return null
      const raw=await call(current.revision,current.generation,'snapshot-restore',{snapshotId}) as {generation:number;dirty:boolean;size?:{cx:number;cy:number};slides:OpenResult['slides']|null;history:HistoryState}
      if (raw.slides) current.nameCandidate = undefined
      current.generation=raw.generation;current.dirty=!!raw.dirty
      if(raw.size)current.size=raw.size
      emitHistory(raw.history);onChange()
      return raw.slides??null
    },
    async getRenderSlides() {
      const current = session
      if (disposed || !current) return null
      const raw = await call(current.revision, current.generation, 'slides') as {slides: OpenResult['slides']}
      return raw.slides
    },
    async getSlideSize() { return session ? {...session.size} : null },
    async isDirty() { return session?.dirty ?? false },
    async editText(input: EditTextOp) {
      const payload = op('setText', {target: {slide: input.slideIndex, el: input.sourceId}, paragraphs: input.paragraphs, ...(input.groupId ? {group: input.groupId} : {})})
      const raw = await applyOps([payload])
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async addElement(input: AddElementOp) {
      const current = requireSession()
      const paragraphs = input.paragraphs ?? (input.text !== undefined ? String(input.text).split('\n').map(line => ({runs: [{text: line}]})) : [])
      const payload = op('addElement', {target: {slide: input.slideIndex}, kind: input.kind, offset: emuBox(current, input.fitWidthPx, input.xPx, input.yPx, input.wPx, input.hPx), ...(paragraphs.length ? {paragraphs} : {}), ...(input.fillColor ? {fill: input.fillColor} : {}), ...(input.stroke ? {stroke: input.stroke} : {}), ...(input.bodyPr ? {bodyPr: input.bodyPr} : {})})
      const raw = await applyOps([payload])
      if (!raw?.changed?.length) return null
      return {slide: await fetchSlide(raw.changed[0]!), sourceId: createdId(raw)}
    },
    async deleteElement(input: DeleteElementOp) {
      const raw = await applyOps([op('deleteElement', {target: {slide: input.slideIndex, el: input.sourceId}})])
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async deleteElements(input: DeleteElementsOp) {
      const ops = input.sourceIds.map(id => op('deleteElement', {target: {slide: input.slideIndex, el: id}}))
      const raw = await applyOps(ops)
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async editTransform(input: EditTransformOp) {
      // Drag previews stay local (each server transaction is an undo step); the release commit lands as one transaction.
      if (input.preview) return null
      const current = requireSession()
      const payload = op('setTransform', {target: {slide: input.slideIndex, el: input.sourceId}, box: emuBox(current, input.fitWidthPx, input.xPx, input.yPx, input.wPx, input.hPx), rotDeg: input.rotationDeg, ...(input.groupId ? {group: input.groupId} : {})})
      const raw = await applyOps([payload])
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async editTransformMulti(input: EditTransformMultiOp) {
      const current = requireSession()
      const ops = input.items.map(item => op('setTransform', {target: {slide: input.slideIndex, el: item.sourceId}, box: emuBox(current, input.fitWidthPx, item.xPx, item.yPx, item.wPx, item.hPx), rotDeg: item.rotationDeg, ...(item.groupId ? {group: item.groupId} : {})}))
      const raw = await applyOps(ops)
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async batchEditTransform(input: BatchEditTransformOp) {
      const current = requireSession()
      const ops = input.items.map(item => op('setTransform', {target: {slide: input.slideIndex, el: item.sourceId}, box: emuBox(current, input.fitWidthPx, item.xPx, item.yPx, item.wPx, item.hPx), rotDeg: item.rotationDeg}))
      const raw = await applyOps(ops)
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async addSlide(input: AddSlideOp) {
      const raw = await applyOps([op('duplicateSlide', {target: {slide: input.sourceIndex}, ...(input.clearText ? {clearText: true} : {})})])
      if (!raw?.order) return null
      const deck = await fetchDeck()
      return {...slideUpdateFrom(raw.order, deck), index: raw.index ?? -1, sections: raw.sections ?? []} as SlideUpdate & {index: number}
    },
    async addBlankSlide(input: AddBlankSlideOp) {
      const raw = await applyOps([op('addBlankSlide', {target: {slide: input.sourceIndex}})])
      if (!raw?.order) return null
      const deck = await fetchDeck()
      return {...slideUpdateFrom(raw.order, deck), index: raw.index ?? -1, sections: raw.sections ?? []} as SlideUpdate & {index: number}
    },
    async addSlideWithLayout(input: AddSlideWithLayoutOp) {
      const raw = await applyOps([op('addSlideWithLayout', {target: {slide: input.sourceIndex}, layoutPath: input.layoutPath})])
      if (!raw?.order) return null
      const deck = await fetchDeck()
      return {...slideUpdateFrom(raw.order, deck), index: raw.index ?? -1, sections: raw.sections ?? []} as SlideUpdate & {index: number}
    },
    async deleteSlide(slideIndex: number) {
      const raw = await applyOps([op('deleteSlide', {target: {slide: slideIndex}})])
      if (!raw?.order) return null
      const deck = await fetchDeck()
      return slideUpdateFrom(raw.order, deck)
    },
    async moveSlide(input: MoveSlideOp) {
      const raw = await applyOps([op('moveSlide', {target: {slide: input.fromIndex}, to: input.toIndex})])
      if (!raw?.order) return null
      const deck = await fetchDeck()
      return {...slideUpdateFrom(raw.order, deck), sections: raw.sections ?? []}
    },
    async reorderElement(input: ReorderElementOp) {
      const raw = await applyOps([op('reorderElement', {target: {slide: input.slideIndex, el: input.sourceId}, dir: input.dir})])
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async groupElements(input: GroupElementsOp) {
      const raw = await applyOps([op('groupElements', {target: {slide: input.slideIndex}, els: input.sourceIds})])
      if (!raw?.changed?.length) return null
      return {slide: await fetchSlide(raw.changed[0]!), groupId: createdId(raw)}
    },
    async ungroupElement(input: UngroupElementOp) {
      const raw = await applyOps([op('ungroupElement', {target: {slide: input.slideIndex, el: input.sourceId}})])
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async setElementFont(input: SetElementFontOp) {
      const font = {...(input.fontFamily !== undefined ? {fontFamily: input.fontFamily} : {}), ...(input.fontSizePt !== undefined ? {fontSizePt: input.fontSizePt} : {}), ...(input.fontSizeStep !== undefined ? {fontSizeStep: input.fontSizeStep} : {}), ...(input.bold !== undefined ? {bold: input.bold} : {}), ...(input.italic !== undefined ? {italic: input.italic} : {}), ...(input.underline !== undefined ? {underline: input.underline} : {}), ...(input.strike !== undefined ? {strike: input.strike} : {}), ...(input.color !== undefined ? {color: input.color} : {})}
      const raw = await applyOps([op('setFont', {target: {slide: input.slideIndex, el: input.sourceIds[0] ?? ''}, font, ...(input.groupId ? {group: input.groupId} : {})})])
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async setElementParagraphFormat(input: SetElementParagraphFormatOp) {
      const format: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(input) as [keyof SetElementParagraphFormatOp, unknown][]) {
        if (['slideIndex', 'sourceIds', 'groupId'].includes(key)) continue
        if (value !== undefined) format[key] = value
      }
      const raw = await applyOps([op('setParagraphFormat', {target: {slide: input.slideIndex, el: input.sourceIds[0] ?? ''}, format, ...(input.groupId ? {group: input.groupId} : {})})])
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async findReplace(input: FindReplaceOp) {
      const raw = await applyOps([op('findReplace', {find: input.find, replace: input.replace, ...(input.matchCase !== undefined ? {matchCase: input.matchCase} : {}), ...(input.firstOnly !== undefined ? {firstOnly: input.firstOnly} : {}), ...(input.slideIndex !== undefined ? {slideIndex: input.slideIndex} : {}), ...(input.elementId !== undefined ? {elementId: input.elementId} : {})})])
      if (!raw?.changed?.length) return {count: 0, update: null}
      const deck = await fetchDeck()
      return {count: raw.changed.length, update: {order: deck.slides.map(slide => slide.partPath ?? ''), slides: deck.slides}}
    },
    async setSlideLayout(input: SetSlideLayoutOp) {
      const raw = await applyOps([op('setSlideLayout', {target: {slide: input.slideIndex}, ...(input.layoutPath ? {layout: input.layoutPath} : {})})])
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async applyHeaderFooter(input: HeaderFooterOp) {
      const raw = await applyOps([op('applyHeaderFooter', {settings: {footer: input.footer ?? null, slideNum: input.slideNum === true, date: input.date ?? null, ...(input.dateAuto !== undefined ? {dateAuto: input.dateAuto} : {})}})])
      if (!raw) return null
      const deck = await fetchDeck()
      return deck.slides
    },
    async setNotes(input: SetNotesOp) {
      const raw = await applyOps([op('setNotes', {target: {slide: input.slideIndex}, text: input.text})])
      return raw !== null && raw.transaction?.applied !== false
    },
    async getNotes(slideIndex: number) {
      const current = session
      // Sessions opened without a lease are server-authorized reads of signed packages.
      if (disposed || !current || (current.authority && !host.getState(fileId).lease)) return ''
      const result = await call(current.revision, current.generation, 'notes', {index: slideIndex})
      if (typeof result?.text !== 'string') throw hostError('INVALID_RESPONSE', 'speaker notes')
      return result.text
    },
    async setTransition(input: SetTransitionOp) {
      const targets=input.slideIndex===-1?(await fetchDeck()).slides.map((_,index)=>index):[input.slideIndex]
      const raw = await applyOps(targets.map(slide=>op('setTransition',{target:{slide},kind:input.kind})))
      return raw!==null&&raw.transaction?.applied!==false
    },
    async getTransition(slideIndex: number) { return (await fetchSlideInfo(slideIndex)).transition },
    async setSlideHidden(input: SetSlideHiddenOp) {
      const raw = await applyOps([op('setHidden', {target: {slide: input.slideIndex}, hidden: input.hidden})])
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async getSections() { return sections },
    async setSections(input: SectionInfo[]) {
      const raw = await applyOps([op('setSections', {sections: input})])
      return raw && raw.transaction?.applied !== false ? raw.sections ?? sections : null
    },
    async addSection(input: AddSectionOp) {
      const raw = await applyOps([op('addSection', {atSlideIndex: input.atSlideIndex, name: input.name})])
      return raw && raw.transaction?.applied !== false ? raw.sections ?? sections : null
    },
    async renameSection(input: RenameSectionOp) {
      const raw = await applyOps([op('renameSection', {id: input.id, name: input.name})])
      return raw && raw.transaction?.applied !== false ? raw.sections ?? sections : null
    },
    async removeSection(input: RemoveSectionOp) {
      const raw = await applyOps([op('removeSection', {id: input.id})])
      return raw && raw.transaction?.applied !== false ? raw.sections ?? sections : null
    },
    async removeSectionSlides(input: RemoveSectionSlidesOp) {
      const raw = await applyOps([op('removeSectionSlides', {id: input.id})])
      if (!raw?.order) return null
      return {...slideUpdateFrom(raw.order, await fetchDeck()), sections: raw.sections ?? sections}
    },
    async moveSection(input: MoveSectionOp) {
      const raw = await applyOps([op('moveSection', {id: input.id, dir: input.dir})])
      if (!raw?.order) return null
      const deck = await fetchDeck()
      return {...slideUpdateFrom(raw.order, deck), sections: raw.sections ?? sections}
    },
    async undo() {
      const current = session
      if (disposed || !current || recovery) return null
      if (!host.getState(fileId).lease) return null
      const raw = await call(current.revision, current.generation, 'undo') as {generation: number; dirty: boolean; size?: {cx:number;cy:number}; slides: OpenResult['slides'] | null; history: HistoryState}
      if (raw.slides) current.nameCandidate = undefined
      current.generation = raw.generation
      current.dirty = !!raw.dirty
      if (raw.size) current.size = raw.size
      emitHistory(raw.history)
      return raw.slides ?? null
    },
    async redo() {
      const current = session
      if (disposed || !current || recovery) return null
      if (!host.getState(fileId).lease) return null
      const raw = await call(current.revision, current.generation, 'redo') as {generation: number; dirty: boolean; size?: {cx:number;cy:number}; slides: OpenResult['slides'] | null; history: HistoryState}
      if (raw.slides) current.nameCandidate = undefined
      current.generation = raw.generation
      current.dirty = !!raw.dirty
      if (raw.size) current.size = raw.size
      emitHistory(raw.history)
      return raw.slides ?? null
    },
    async save() {
      if (disposed) throw hostError('UNAVAILABLE', 'disposed')
      const current = session
      if(saveFence&&!saveFence())return {ok:false as const,error:text.saveFailed}
      if (!current) return {ok: false as const, error: text.failed}
      if (!host.getState(fileId).lease) return {ok: false as const, error: text.saveFailed}
      // A clean deck saves nothing: no export, no redundant revision. The renderer's
      // flushActiveEdit runs before this point, so an overlay edit that just committed
      // has already marked the session dirty and takes the full receipt path.
      if (!current.dirty) return {ok: true as const, path: host.getState(fileId).name}
      let saved: SaveReceipt | undefined
      await acquireSlot()
      try {
        if(disposed||session!==current||saveFence&&!saveFence())return {ok:false as const,error:text.saveFailed}
        saved = await host.saveSlides(fileId, {revision: current.revision, generation: current.generation},saveFence??(()=>true))
        committed=saved
      } catch (error) {
        // A dispatched commit can outlive this view. Keep its outcome in the
        // host, but never resurrect recovery for an already disposed renderer.
        if (disposed) throw hostError('UNAVAILABLE', 'disposed')
        if (!saved && host.getState(fileId).status !== 'unknown') return {ok: false as const, error: text.saveFailed}
        // The receipt is unknown: the renderer's save promise stays pending and
        // its exact journal survives until the entry's Confirm save outcome resolves it.
        return new Promise<SaveResult>((resolve, reject) => { recovery = {resolve, reject}; onChange() })
      } finally {releaseSlot()}
      if (disposed) throw hostError('UNAVAILABLE', 'disposed')
      // Adopt the committed head: the pinned revision moved, the generation continues.
      current.revision = saved.revision
      current.dirty = false
      if(current.nameCandidate)await host.nameSavedBlank?.(fileId,saved.revision,current.nameCandidate).catch(()=>undefined)
      return {ok: true as const, path: host.getState(fileId).name}
    },
    onHistoryChanged(handler: (state: HistoryState) => void) {
      historyHandlers.add(handler)
      return () => { historyHandlers.delete(handler) }
    },
    onOpened(handler: (result: OpenResult) => void) {
      openedHandlers.add(handler)
      return () => { openedHandlers.delete(handler) }
    },
    async getLayouts(): Promise<GetLayoutsResult | null> {
      if (!session) return null
      const current = requireSession()
      return await call(current.revision, current.generation, 'layouts') as GetLayoutsResult
    },
    getComments: fetchComments,
    async getAnimations(index:number):Promise<AnimationItem[]>{const current=requireSession();return await call(current.revision,current.generation,'animations',{index}) as AnimationItem[]},
    async getShapeKeys(slideIndex: number) { return (await fetchSlideInfo(slideIndex)).shapeKeys },
    async getShowTiming(slideIndex: number) { return (await fetchSlideInfo(slideIndex)).timing },
    async getHeaderFooter(slideIndex: number) { return (await fetchSlideInfo(slideIndex)).headerFooter },
    async getLink(index:number,sourceId:string):Promise<LinkTargetOp|null>{
      const current=requireSession(),generation=current.generation
      const links=await api.getSlideLinks(index)
      const direct=links.find(link=>link.sourceId===sourceId)
      if(direct)return direct.target
      if(!links.length||!sourceId.startsWith('e_'))return null
      // Editor hit testing uses canvas IDs. API clients can also pass a durable shape ID.
      const slide=await fetchSlide(index)
      if(session!==current||current.generation!==generation)return null
      const nodes=[...slide.nodes]
      for(let i=0;i<nodes.length;i++){
        const node=nodes[i]!
        if(node.durableId===sourceId)return links.find(link=>link.sourceId===node.sourceId)?.target??null
        if(node.type==='group')nodes.push(...node.children)
      }
      return null
    },
    async getSlideLinks(index:number){const current=requireSession();return await call(current.revision,current.generation,'links',{index}) as Array<{sourceId:string;target:LinkTargetOp}>},
    async getRunLinks(index:number){const current=requireSession();return await call(current.revision,current.generation,'run-links',{index}) as Awaited<ReturnType<SlidesApi['getRunLinks']>>},
    async getChartData(index:number,sourceId:string){const current=requireSession();return await call(current.revision,current.generation,'chart-data',{index,sourceId}) as Awaited<ReturnType<SlidesApi['getChartData']>>},
    async getChartColorSchemes(){
      const current=requireSession(),language=normalizeLang(prefs.language)
      const schemes=await call(current.revision,current.generation,'chart-color-schemes') as Array<{key:string;colors:string[]}>
      return schemes.map(scheme=>({...scheme,label:scheme.key==='default'?tMain(language,'schemeThemeDefault'):scheme.key==='colorful'?tMain(language,'schemeColorful'):scheme.key==='colorful2'?tMain(language,'schemeColorful2'):tMain(language,'schemeMono',{n:Number(scheme.key.slice(-1))})}))
    },
    skillsList: async () => skillsApi ? skillsApi.skillsList() : [],
    gskStatus: async () => ({available: false as const}),
    audienceReady: async () => null, audienceNav() {}, presenterSync() {}, presenterInk() {},
    // Format edits, shape styles, and table operations mapped to the server op whitelist.
    async editFill(input) {
      const fill = typeof input.fill === 'string'
        ? input.fill
        : {stops: input.fill.gradient.stops ?? [{pos: 0, color: input.fill.gradient.from}, {pos: 1, color: input.fill.gradient.to}], ...(input.fill.gradient.angleDeg !== undefined ? {angle: input.fill.gradient.angleDeg} : {})}
      const raw = await applyOps([op('setFill', {target: {slide: input.slideIndex, el: input.sourceId}, fill, ...(input.groupId ? {group: input.groupId} : {})})])
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async editStroke(input) {
      const stroke = input.stroke === null
        ? null
        : {color: input.stroke.color, widthEmu: Math.max(1, Math.round(input.stroke.widthPt * 12700)), ...(input.stroke.gradient ? {gradient: {stops: input.stroke.gradient.stops, angle: input.stroke.gradient.angleDeg}} : {})}
      const raw = await applyOps([op('setStroke', {target: {slide: input.slideIndex, el: input.sourceId}, stroke, ...(input.groupId ? {group: input.groupId} : {})})])
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async editBackground(input) {
      const current=requireSession()
      if(input.kind==='image'){
        const stillCurrent=captureImageTarget(current)
        if(!stillCurrent())return null
        let source:{sourceSlide:number}|{bytesBase64:string;ext:string}
        if(input.pick===false)source={sourceSlide:input.sourceSlideIndex??input.slideIndex}
        else{
          const picked=await pickLocalPicture()
          const image=picked&&await imageBytes(picked)
          if(!image||image.bytesBase64.length>SLIDE_IMAGE_LIMIT||!stillCurrent())return null
          source=image
        }
        const raw=await editPictureMedia(current,{mode:'background',slide:input.slideIndex,tile:input.mode==='tile',...source})
        if(!raw?.changed?.length)return null
        const {slides}=await fetchDeck()
        return {order:slides.map(slide=>slide.partPath??''),slides:raw.changed.map(index=>slides[index]!).filter(Boolean)}
      }
      const slides = input.slideIndex === -1 ? (await fetchDeck()).slides.map((_, index) => index) : [input.slideIndex]
      const ops = slides.map(slide => input.kind === 'hideGraphics'
        ? op('setBackground', {target: {slide}, kind: 'graphics', hidden: input.hidden})
        : input.kind === 'solid'
          ? op('setBackground', {target: {slide}, kind: 'solid', color: input.color})
          : input.kind === 'gradient'
            ? op('setBackground', {target: {slide}, kind: 'gradient', from: input.from, to: input.to, ...(input.angleDeg !== undefined ? {angleDeg: input.angleDeg} : {}), ...(input.radial ? {radial: true} : {})})
            : op('setBackground', {target: {slide}, kind: 'reset'}))
      const raw = await applyOps(ops)
      if (!raw?.changed?.length) return null
      const deck = await fetchDeck()
      return {order: deck.slides.map(slide => slide.partPath ?? ''), slides: await Promise.all(raw.changed.map(fetchSlide))}
    },
    async editImageFill(input) {
      if(!input.targets.length)return null
      const current=requireSession(),stillCurrent=captureImageTarget(current)
      if(!stillCurrent())return null
      const picked=input.source??await pickLocalPicture()
      const image=picked&&await imageBytes(picked)
      if(!image||image.bytesBase64.length>SLIDE_IMAGE_LIMIT||!stillCurrent())return null
      const result=await editPictureMedia(current,{mode:'fill',slide:input.slideIndex,tile:input.mode==='tile',targets:input.targets,...image})
      return result?.slide??null
    },
    async editPictureSrcRect(input) {
      const current = requireSession()
      const box = input.boxPx && input.fitWidthPx
        ? emuBox(current, input.fitWidthPx, input.boxPx.x, input.boxPx.y, input.boxPx.w, input.boxPx.h)
        : undefined
      const raw = await applyOps([op('setPictureSrcRect', {target: {slide: input.slideIndex, el: input.sourceId}, srcRect: input.srcRect, ...(box ? {box} : {})})])
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async editPictureOpacity(input) {
      const raw = await applyOps([op('setPictureOpacity', {target: {slide: input.slideIndex, el: input.sourceId}, opacity: input.opacity})])
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async changeShape(input) {
      const raw = await applyOps([op('setShapeGeometry', {target: {slide: input.slideIndex, el: input.sourceId}, prst: input.prst, ...(input.groupId ? {group: input.groupId} : {})})])
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async setShapeAdjust(input) {
      if (input.preview) return null
      const raw = await applyOps([op('setShapeAdjust', {target: {slide: input.slideIndex, el: input.sourceId}, adjust: input.adjust, ...(input.groupId ? {group: input.groupId} : {})})])
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async setShapeGeometry(input) {
      if(input.preview)return null
      const scale=requireSession().size.cx/Math.max(1,input.fitWidthPx)
      const toEmu=(value:number)=>Math.round(value*scale)
      const {w,h,cmds}=input.pathPx
      const raw=await applyOps([op('setShapeCustomGeometry',{
        target:{slide:input.slideIndex,el:input.sourceId},
        path:{w:toEmu(w),h:toEmu(h),cmds:cmds.map(command=>({op:command.op,pts:command.pts.map(toEmu)}))},
        ...(input.groupId?{group:input.groupId}:{}),
      })])
      return raw?.changed?.length?await fetchSlide(raw.changed[0]!):null
    },
    async setTextAnchor(input) {
      const raw = await applyOps([op('setTextAnchor', {target: {slide: input.slideIndex, el: input.sourceId}, anchor: input.anchor})])
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async setTextBodyProps(input) {
      const raw = await applyOps([op('setTextBodyProps', {target: {slide: input.slideIndex, el: input.sourceId}, props: input.props})])
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async setEffects(input) {
      const raw = await applyOps([op('setEffects', {target: {slide: input.slideIndex, el: input.sourceId}, effects: input.effects})])
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async editConnectorEndpoints(input) {
      const scale=requireSession().size.cx/Math.max(1,input.fitWidthPx)
      const point=(x:number,y:number)=>({x:Math.round(x*scale),y:Math.round(y*scale)})
      const raw=await applyOps([op('setConnectorEndpoints',{
        target:{slide:input.slideIndex,el:input.sourceId},
        p1:point(input.x1Px,input.y1Px),p2:point(input.x2Px,input.y2Px),
        start:input.start,end:input.end,
      })])
      return raw?.changed?.length?await fetchSlide(raw.changed[0]!):null
    },
    cancelTransformPreview: graceful,
    async setSlideSize(input) {
      const raw=await applyOps([op('setSlideSize',{cx:input.cx,cy:input.cy})])
      if(!raw)return null
      const deck=await fetchDeck()
      onChange()
      return deck.slides
    },
    async setAnimations(input){const raw=await applyOps([op('setAnimations',{target:{slide:input.slideIndex},items:input.items})]);if(!raw)return false;onChange();return true},
    async setAdvanceTimes(input) {
      const current = requireSession()
      const count = (await fetchDeck()).slides.length
      const times = input.times.filter(time => Number.isSafeInteger(time.slideIndex) && time.slideIndex >= 0 && time.slideIndex < count)
      if (!times.length) return false
      const raw = await applyOps(times.map(time => op('setAdvanceTime', {target: {slide: time.slideIndex}, ms: time.ms})))
      return raw !== null && session === current
    },
    saveRecording: (input:SaveRecordingOp) => editRecording({kind:'save',slides:input.slides}),
    clearNarration: (indexes:number[]) => editRecording({kind:'clear',indexes}),
    async setLink(input){const raw=await applyOps([op('setLink',{target:{slide:input.slideIndex,el:input.sourceId},link:input.target})]);if(!raw?.changed?.length)return null;onChange();return await fetchSlide(input.slideIndex)},
    async addTable(input) {
      const current = requireSession()
      const box = emuBox(current, input.fitWidthPx, input.xPx, input.yPx, input.wPx, input.hPx)
      const offset = input.rowHeightEmu ? {...box, cy: input.rows * input.rowHeightEmu} : box
      const raw = await applyOps([op('addTable', {target: {slide: input.slideIndex}, offset, rows: input.rows, cols: input.cols})])
      if (!raw?.changed?.length) return null
      return {slide: await fetchSlide(raw.changed[0]!), sourceId: createdId(raw)}
    },
    async addChart(input) {
      const current = requireSession()
      const raw = await applyOps([op('addChart', {
        target: {slide: input.slideIndex},
        kind: input.kind === 'barH' ? 'bar' : input.kind,
        ...(input.kind === 'barH' ? {barDir: 'bar'} : {}),
        ...(input.title ? {title: input.title} : {}),
        categories: input.categories,
        series: input.series,
        offset: emuBox(current, input.fitWidthPx, input.xPx, input.yPx, input.wPx, input.hPx),
      })])
      if (!raw?.changed?.length) return null
      return {slide: await fetchSlide(raw.changed[0]!), sourceId: createdId(raw)}
    },
    async addSmartArt(input) {
      const current = requireSession()
      const raw = await applyOps([op('addSmartArt', {
        target: {slide: input.slideIndex},
        layout: input.layout,
        items: input.items,
        offset: emuBox(current, input.fitWidthPx, input.xPx, input.yPx, input.wPx, input.hPx),
      })])
      if (!raw?.changed?.length) return null
      return {slide: await fetchSlide(raw.changed[0]!), sourceId: createdId(raw)}
    },
    async addInk(input) {
      const current=requireSession()
      const {base64,slideIndex,xPx,yPx,wPx,hPx,fitWidthPx,payload}=input
      if(!base64||base64.length>SLIDE_IMAGE_LIMIT)return null
      if(!inkQueue||inkQueue.session!==current||inkQueue.revision!==current.revision||inkQueue.generation!==current.generation){
        inkQueue={session:current,revision:current.revision,generation:current.generation,done:Promise.resolve()}
      }
      const queue=inkQueue, lease=host.getState(fileId).lease
      const write=queue.done.then(async()=>{
        const active=host.getState(fileId).lease
        if(disposed||session!==current||opening||recovery||current.revision!==queue.revision||
          current.generation!==queue.generation||!lease||active?.editorId!==lease.editorId||
          active.leaseEpoch!==lease.leaseEpoch)return null
        const result=await editPictureMedia(current,{mode:'ink',slide:slideIndex,ext:'png',bytesBase64:base64,
          xPx,yPx,wPx,hPx,fitWidthPx,inkPayload:payload})
        if(!result?.slide)return null
        queue.generation=result.generation
        const sourceId=createdId(result)
        return sourceId?{slide:result.slide,sourceId}:null
      })
      queue.done=write.then(()=>{},()=>{})
      return write
    },
    addImageBytes,
    async replacePictureBytes(input) {
      if (!input.base64 || input.base64.length > SLIDE_IMAGE_LIMIT) return {error:'unsupported' as const, ext:input.ext}
      return applyImage({mode:'replace', ...input})
    },
    async editTableCell(input) {
      const raw = await applyOps([op('setTableCell', {target: {slide: input.slideIndex, el: input.sourceId}, row: input.row, col: input.col, paragraphs: input.paragraphs})])
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async tableStructure(input) {
      const raw = await applyOps([op('tableStructure', {target: {slide: input.slideIndex, el: input.sourceId}, kind: input.kind, index: input.index, ...(input.before !== undefined ? {before: input.before} : {})})])
      if (!raw?.changed?.length) return null
      return {slide: await fetchSlide(raw.changed[0]!), sourceId: createdId(raw) || input.sourceId}
    },
    async tableMerge(input) {
      const raw = await applyOps([op('tableMerge', {target: {slide: input.slideIndex, el: input.sourceId}, kind: input.kind, row: input.row, col: input.col})])
      if (!raw?.changed?.length) return null
      return {slide: await fetchSlide(raw.changed[0]!), sourceId: createdId(raw) || input.sourceId}
    },
    async setTableColWidth(input) {
      const current = requireSession()
      const wEmu = Math.round(input.wPx * (current.size.cx / Math.max(1, input.fitWidthPx)))
      const raw = await applyOps([op('setTableColWidth', {target: {slide: input.slideIndex, el: input.sourceId}, col: input.col, wEmu})])
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async setTableRowHeight(input) {
      const current = requireSession()
      const hEmu = Math.round(input.hPx * (current.size.cx / Math.max(1, input.fitWidthPx)))
      const raw = await applyOps([op('setTableRowHeight', {target: {slide: input.slideIndex, el: input.sourceId}, row: input.row, hEmu})])
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async setTableCellAnchor(input) {
      const raw = await applyOps([op('setTableCellAnchor', {target: {slide: input.slideIndex, el: input.sourceId}, row: input.row, col: input.col, anchor: input.anchor})])
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async editTableStyle(input) {
      const {slideIndex, sourceId, ...styleFields} = input
      const raw = await applyOps([op('setTableStyle', {target: {slide: slideIndex, el: sourceId}, ...styleFields})])
      if (!raw?.changed?.length) return null
      return {slide: await fetchSlide(raw.changed[0]!), sourceId: createdId(raw) || sourceId}
    },
    async editChart(input) {
      const current=requireSession()
      const {slideIndex,sourceId,...patch}=input
      const send=(confirmed?:boolean)=>call(current.revision,current.generation,'chart-edit',{slide:slideIndex,sourceId,patch,...(confirmed?{confirmed:true}:{})})
      let raw=await send() as {confirmationRequired?:boolean;generation?:number;dirty?:boolean;slide?:OpenResult['slides'][number];sourceId?:string;history?:HistoryState}
      if(raw.confirmationRequired){if(!confirmImportedChart())return null;raw=await send(true) as typeof raw}
      if(!raw.slide||typeof raw.generation!=='number'||typeof raw.sourceId!=='string')return null
      current.generation=raw.generation;current.dirty=!!raw.dirty;emitHistory(raw.history);onChange()
      return {slide:raw.slide,sourceId:raw.sourceId}
    },
    async addComment(input) {
      const current = requireSession()
      const result = await applyOps([op('addComment', {target:{slide:input.slideIndex},author:prefs.authorName?.trim()||'Web User',text:input.text})])
      if (!result?.changed?.includes(input.slideIndex) || session !== current) return null
      return fetchComments(input.slideIndex)
    },
    async deleteComment(input) {
      const current = requireSession()
      const result = await applyOps([op('deleteComment', {target:{slide:input.slideIndex},authorId:input.authorId,idx:input.idx})])
      if (!result?.changed?.includes(input.slideIndex) || session !== current) return null
      return fetchComments(input.slideIndex)
    },
    async setSlidesHidden(input) {
      const ops = input.slideIndexes.map((slide: number) => op('setHidden', {target: {slide}, hidden: input.hidden}))
      const raw = await applyOps(ops)
      if (!raw?.changed?.length) return null
      const slides = await Promise.all(raw.changed.map(index => fetchSlide(index)))
      return {order: raw.order ?? [], slides}
    },
    async deleteSlides(input) {
      const ops = [...input.slideIndexes].sort((a, b) => b - a).map((slide: number) => op('deleteSlide', {target: {slide}}))
      const raw = await applyOps(ops)
      if (!raw?.order) return null
      const deck = await fetchDeck()
      return {...slideUpdateFrom(raw.order, deck), sections: raw.sections ?? []}
    },
    async duplicateSlides(input) {
      const sorted = [...input.slideIndexes].sort((a, b) => a - b)
      const ops = sorted.map((slide: number, idx: number) => op('duplicateSlide', {target: {slide: slide + idx}}))
      const raw = await applyOps(ops)
      if (!raw?.order) return null
      const deck = await fetchDeck()
      return {...slideUpdateFrom(raw.order, deck), index: (sorted[0] ?? 0) + 1, sections: raw.sections ?? []}
    },
    async moveSlides(input) {
      const current = requireSession()
      const indexes = [...new Set(input.slideIndexes)].sort((a, b) => a - b)
      if (!indexes.length || !Number.isSafeInteger(input.insertAt)) return null
      const count = (await fetchDeck()).slides.length
      if (indexes.some(index => !Number.isSafeInteger(index) || index < 0 || index >= count)) return null
      if (input.insertAt < 0 || input.insertAt > count) return null
      const steps = planSlideMoves(count, indexes, input.insertAt)
      if (!steps.length) return null
      const raw = await applyOps(steps.map(step => op('moveSlide', {target: {slide: step.from}, to: step.to})))
      if (!raw?.order || session !== current) return null
      const deck = await fetchDeck()
      return {...slideUpdateFrom(raw.order, deck), sections: raw.sections ?? []}
    },
    insertImageUrl: (input:Parameters<SlidesApi['insertImageUrl']>[0])=>applyImage({mode:'insert',...input}),
    replacePictureUrl: (input:Parameters<SlidesApi['replacePictureUrl']>[0])=>applyImage({mode:'replace',...input}),
    async applyTheme(input) {
      const current = requireSession()
      const {fitWidthPx: _fitWidthPx, ...theme} = input
      const raw = await applyOps([op('applyTheme', theme)])
      if (!raw?.changed?.length || session !== current) return null
      return (await fetchDeck()).slides
    },
    async flipElements(input) {
      const raw = await applyOps([op('flipElements', {target: {slide: input.slideIndex}, els: input.sourceIds, axis: input.axis, ...(input.groupId ? {group: input.groupId} : {})})])
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async masterEnter(fitWidthPx) {
      const current = requireSession()
      const result = await readMasterParts(current, fitWidthPx)
      const first = result?.items[0]
      if (!first || session !== current || disposed) return null
      master = {session:current, partPath:first.partPath, width:fitWidthPx, slide:first.slide}
      return result
    },
    async masterOpen(partPath) {
      const previous = master
      if (!previous) return null
      const result = await readMasterParts(previous.session, previous.width)
      const item = result?.items.find(value => value.partPath === partPath)
      if (!item || master !== previous || session !== previous.session || disposed) return null
      master = {...previous, partPath, slide:item.slide}
      return item.slide
    },
    async masterClose() {
      const previous = master
      master = null
      return previous?.session === session && !disposed ? (await fetchDeck()).slides : null
    },
    async masterEditText(input) {
      return (await editMaster(op('setText', {target:{el:input.sourceId},paragraphs:input.paragraphs})))?.slide ?? null
    },
    async masterEditTransform(input) {
      const selected = master
      if (!selected || selected.session !== session || !host.getState(fileId).lease) return null
      if (input.preview) {
        // Drag frames belong to the canvas. Only the final frame is journaled.
        const slide = structuredClone(selected.slide)
        const node = slide.nodes.find(value => value.sourceId === input.sourceId && !value.decoration)
        if (!node) return null
        const scale = slide.widthPx / input.fitWidthPx
        const x = input.xPx*scale, y = input.yPx*scale, w = input.wPx*scale, h = input.hPx*scale
        node.box = {...node.box,x,y,w,h,centerX:x+w/2,centerY:y+h/2,rotationDeg:input.rotationDeg}
        return slide
      }
      const box = emuBox(selected.session,input.fitWidthPx,input.xPx,input.yPx,input.wPx,input.hPx)
      return (await editMaster(op('setTransform',{target:{el:input.sourceId},box,rotDeg:input.rotationDeg})))?.slide ?? null
    },
    async masterEditFill(input) {
      const fill = typeof input.fill === 'string' ? input.fill : {
        stops:input.fill.gradient.stops ?? [{pos:0,color:input.fill.gradient.from},{pos:1,color:input.fill.gradient.to}],
        ...(input.fill.gradient.path ? {path:input.fill.gradient.path}
          : input.fill.gradient.radial ? {path:'circle'} : {angle:Math.round((input.fill.gradient.angleDeg ?? 0)*60000)}),
      }
      return (await editMaster(op('setFill',{target:{el:input.sourceId},fill})))?.slide ?? null
    },
    async masterEditStroke(input) {
      const stroke = input.stroke ? {color:input.stroke.color,widthEmu:Math.round(input.stroke.widthPt*12700)} : null
      return (await editMaster(op('setStroke',{target:{el:input.sourceId},stroke})))?.slide ?? null
    },
    async masterDeleteElement(input) {
      return (await editMaster(op('deleteElement',{target:{el:input.sourceId}})))?.slide ?? null
    },
    async masterAddElement(input) {
      if (!master) return null
      const offset = emuBox(master.session,input.fitWidthPx,input.xPx,input.yPx,input.wPx,input.hPx)
      const result = await editMaster(op('addElement', {
        kind:input.kind, offset, paragraphs:input.paragraphs, fill:input.fillColor, bodyPr:input.bodyPr,
        ...(input.stroke ? {stroke:{color:input.stroke.color,widthEmu:Math.round(input.stroke.widthPt*12700)}} : {}),
      }))
      return result?.slide && result.sourceId ? {slide:result.slide,sourceId:result.sourceId} : null
    },
    presenterStart: async () => ({audience:false}), presenterSwap: async () => false, presenterEnd: async () => {},
    onShowSync: noEvent, onShowInk: noEvent, onAudienceNav: noEvent,
    async openAiModelSettings() {
      const open = (window.parent as Window & {dyofficeOpenEditorSettings?: (target: 'models' | 'skills', caller: Window) => void}).dyofficeOpenEditorSettings
      if (!open) throw new Error(text.unavailable)
      open('models', window)
    },
    async openSkillsSettings() {
      const open = (window.parent as Window & {dyofficeOpenEditorSettings?: (target: 'models' | 'skills', caller: Window) => void}).dyofficeOpenEditorSettings
      if (!open) throw new Error(text.unavailable)
      open('skills', window)
    },
    skillText: skillsApi ? skillsApi.skillText : unavailable, aiStream: unavailable, aiStreamCancel: async () => {},
    aiGskStatus: unavailable, aiGskLogin: unavailable, aiLogRunFailure: async () => {},
    webSearch: searchApi?.webSearch ?? unavailable, imageSearch: searchApi?.imageSearch ?? unavailable,
    async analyzeMedia({mediaUrls,requirements}: Parameters<SlidesApi['analyzeMedia']>[0]) {
      if (!mediaApi) return unavailable()
      const urls = await mediaReferences(mediaUrls)
      return urls ? mediaApi.analyzeMedia({mediaUrls:urls,requirements}) : {error: 'The generated image is no longer available.'}
    },
    async generateImage({prompt,aspectRatio,transparentBackground,referenceImageUrls}: Parameters<SlidesApi['generateImage']>[0]) {
      if (!slideImages) return unavailable()
      const refs = referenceImageUrls && await mediaReferences(referenceImageUrls)
      if (refs === null) return {error: 'The generated image is no longer available.'}
      const result = await slideImages.generateImage({prompt,...(aspectRatio?{aspectRatio}:{}),...(transparentBackground!==undefined?{transparentBackground}:{}),...(refs?{referenceImageUrls:refs}:{})})
      if (!result.url || !isGeneratedImage(result.url)) return result
      const previewUrl = await generatedPreview(result.url)
      return previewUrl ? {...result,previewUrl} : {error: 'The generated image is no longer available.'}
    },
    saveStyleSidecar: unavailable,
    async saveStyleTemplate(name,data){try{return await requestPath('/api/v1/ai/style-templates','PUT',{name,...data}) as {ok:boolean;error?:string}}catch{return {ok:false,error:'Style template save failed.'}}},
    async listStyleTemplates(){try{return await requestPath('/api/v1/ai/style-templates','GET') as Array<{name:string;topic:string;createdAt:string}>}catch{return []}},
    async loadStyleTemplate(name){try{return await requestPath('/api/v1/ai/style-templates/load?name='+encodeURIComponent(name),'GET') as Awaited<ReturnType<SlidesApi['loadStyleTemplate']>>}catch{return {ok:false,error:'Style template unavailable.'}}},
  } satisfies Partial<SlidesApi>

  async function confirmSave() {
    const pending = recovery
    if (!pending || confirming) return
    confirming = true
    try {
      const saved = await host.reconcileSlides(fileId)
      if (disposed) throw hostError('UNAVAILABLE', 'disposed')
      // Adopt the confirmed head and clear the tracked dirty flag: the parked
      // receipt fenced mutations, so nothing was edited between the export and
      // this confirmation; edits made afterwards take the normal path.
      if (session) {
        session.revision = saved.revision; session.dirty = false
        if(session.nameCandidate)await host.nameSavedBlank?.(fileId,saved.revision,session.nameCandidate).catch(()=>undefined)
      }
      committed=saved
      recovery = null
      pending.resolve({ok: true, path: host.getState(fileId).name})
    } catch (error) {
      if (disposed) throw hostError('UNAVAILABLE', 'disposed')
      if (host.getState(fileId).status !== 'unknown') { recovery = null; pending.resolve({ok: false, error: text.saveFailed}) }
      throw error
    } finally { confirming = false; if (!disposed) onChange() }
  }
  async function prepareDownload(editor: {saveAndWait(): Promise<boolean>; isDirty(): boolean}) {
    if (disposed) throw hostError('UNAVAILABLE', 'disposed')
    const before = host.getState(fileId)
    if (!before.lease || before.status === 'unauthorized' || before.status === 'conflict') throw hostError('CONFLICT', 'download authority')
    // The renderer owns the active editor and its full save/late-edit cycle. Its
    // promise stays pending across an unknown commit receipt; never fall back to
    // a saved-head link on cancellation, conflict or remaining edits.
    if (!await editor.saveAndWait()) throw hostError('UNAVAILABLE', 'download save')
    if (disposed) throw hostError('UNAVAILABLE', 'disposed')
    const state = host.getState(fileId)
    // Server edits update the bridge before React's dirty notification settles.
    // Both views must be clean before exporting an acknowledged revision.
    if (editor.isDirty() || session?.dirty || recovery || state.status !== 'idle' || !state.lease) throw hostError('CONFLICT', 'download not clean')
    return {...state.revision}
  }
  async function takeover(editor: {reload(): Promise<boolean>; isDirty(): boolean}, preserveRevision=false) {
    if (disposed) throw hostError('UNAVAILABLE', 'disposed')
    if (editor.isDirty() || session?.dirty || recovery || host.getState(fileId).status === 'unknown') throw hostError('CONFLICT', 'unsaved takeover')
    let acquired = false
    try {
      await host.takeoverLease(fileId); acquired = true
      if (disposed || editor.isDirty() || session?.dirty || recovery) throw hostError('CONFLICT', 'unsaved takeover')
      if(preserveRevision){
        if(!await host.isCurrentRevision(fileId))throw new CitedRevisionChanged()
      }else await host.refreshHead(fileId)
      if (disposed || editor.isDirty() || session?.dirty || recovery) throw hostError('CONFLICT', 'unsaved takeover')
      if (!await editor.reload()) throw hostError('UNAVAILABLE', 'takeover reload')
      if (disposed || !host.getState(fileId).lease) throw hostError('CONFLICT', 'takeover authority')
    } catch (error) {
      // A failed reload must not expose a stale view as an editable new head.
      if (acquired) await host.releaseLease(fileId).catch(() => {})
      throw error
    }
  }
  async function exportDraftCopy(proof:string|undefined,signal:AbortSignal,mode:'export'|'recover'='export') {
    if(waiting.length>=64)throw hostError('UNAVAILABLE','slides copy capacity')
    await acquireSlot()
    try{
      const current=requireSession(),lease=mode==='recover'?current.authority:host.getState(fileId).lease,generation=current.generation
      if(mode==='recover')proof=csrf
      if(!proof)throw hostError('UNAUTHORIZED','slides copy')
      if(!lease||recovery||opening)throw hostError('CONFLICT','slides copy')
      const response=await fetchImpl(`/api/v1/files/${fileId}/slides/${mode}`,{method:'POST',credentials:'same-origin',redirect:'error',signal,
        headers:{'Content-Type':'application/json','X-CSRF-Token':proof},
        body:JSON.stringify({revision:current.revision,generation,editorId:lease.editorId,leaseEpoch:lease.leaseEpoch})})
      if(!response.ok||response.headers.get('x-slides-generation')!==String(generation))throw hostError('CONFLICT','slides copy')
      const blob=await response.blob()
      signal.throwIfAborted()
      const active=host.getState(fileId).lease
      if(disposed||session!==current||current.generation!==generation||(mode==='export'&&(!active||active.editorId!==lease.editorId||active.leaseEpoch!==lease.leaseEpoch))||!blob.size||blob.size>32*1024*1024)throw hostError('CONFLICT','slides copy')
      return blob
    }finally{releaseSlot()}
  }
  return {
    api,guardedSave,guardedApply,getReceipt:()=>committed,getAnalysisGeneration:()=>session?.generation??null,
    confirmSave,
    prepareDownload,exportDraftCopy,hasGeneratedName:()=>Boolean(session?.nameCandidate&&session.dirty&&host.getState(fileId).autoNamePending),
    takeover,
    needsConfirmation: () => recovery !== null,
    isDirty: () => session?.dirty ?? false,
    isWriteProtected: () => session?.writeProtected ?? false,
    cleanRevision: () => !disposed&&!opening&&!changing&&!saveFence&&!applyFence&&!recovery&&!session?.dirty ? session?.revision : undefined,
    dispose() {
      disposed = true
      slideImages?.dispose()
      for(const url of mediaUrls) URL.revokeObjectURL(url)
      mediaUrls.clear()
      recovery?.reject(hostError('UNAVAILABLE', 'disposed'))
      recovery = null
      for (const controller of controllers) controller.abort()
      controllers.clear()
      session = null
      pendingOpen = null
      historyHandlers.clear()
      openedHandlers.clear()
      slideInfo = undefined
      sections = []
      csrf = undefined
    },
  }
}
