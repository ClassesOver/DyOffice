import type {SessionFileHost} from '../../../../packages/browser-host/src/files.ts'
import {hostError} from '../../../../packages/web-contracts/src/errors.ts'
import {messages} from './messages.ts'
import {pickLocalFiles} from './pick-local-files.ts'
import {createAiPdf} from './create-ai-pdf.ts'
import {printInBrowser} from './browser-print.ts'
import {subscribeBrowserDocumentCommands} from './browser-document-command'
import {
  workbookMediaRequestSchema,workbookMediaResultSchema,
  workbookPivotRequestSchema,workbookPivotDefinitionSchema,externalLinksRequestSchema,externalLinksResultSchema,externalLinksUpdateResultSchema,
  workbookFileSchema, workbookRangeRequestSchema, workbookRangeResultSchema,
  workbookFormulaCellsRequestSchema, workbookFormulaCellsResultSchema, workbookRowOutlineResultSchema,
  workbookRedactionsResultSchema, workbookSlicerStateResultSchema, workbookQueriesResultSchema,
  workbookRecalcRequestSchema,workbookRecalcResultSchema,
  workbookConnectionsResultSchema, workbookRefreshRequestSchema, workbookRefreshResultSchema, workbookSaveRequestSchema,
  workbookFindCellsRequestSchema, workbookFindCellsResultSchema,
  workbookExportPdfRequestSchema,
  type DesktopApi, type WorkbookFile, type WorkbookSaveRequest, type WorkbookRangeResult,
} from '../../../sheets/src/shared/desktop-api'

type Preferences = Awaited<ReturnType<SessionFileHost['getPreferences']>>
type ParentAiWindow = Window & {
  dyofficeCreateAiXlsx?: (request:{title:string;sheetName?:string;content:string;layout?:import('@genoffice/xlsx-gateway/gateway/csv-import').SheetExportLayout})=>Promise<void>
  dyofficeCreateAiDoc?: (request:{type?:'docx'|'pdf';title:string;content:string;file?:Blob})=>Promise<void>
}
type SaveResult = {canceled: false; file: WorkbookFile; touchedEntries: string[]}
type SavedWorkbook = Awaited<ReturnType<SessionFileHost['saveSheets']>>
type ApplySavedWorkbook = (saved:SavedWorkbook)=>Promise<WorkbookFile>
type Recovery = {saved?:SavedWorkbook; apply:ApplySavedWorkbook; resolve(value:SaveResult):void; reject(error:unknown):void}
type OpeningViewport = {sheetId:string;endRow:number;endColumn:number;result:WorkbookRangeResult}
type Session = {openingViewport?:OpeningViewport; revision: string; file: WorkbookFile; attachment?: boolean; extras?: Promise<Record<string,unknown>>}
type WorkspaceWorkbook = {id:string;name:string;revision:string}
const mergeExtensions = ['xlsx','xlsm','xls','csv','tsv'] as const
const workbookId=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
export function createSheetsBridge(host: SessionFileHost, fileId: string, prefs: Preferences, {fetchImpl = fetch, onChange = () => {},getAttachmentFile,getExportLayout,docxCreationAvailable=false,pickMergeFiles=(signal:AbortSignal)=>pickLocalFiles(mergeExtensions.map(ext=>'.'+ext).join(','),signal,true)}: {fetchImpl?: typeof fetch; onChange?: () => void; getAttachmentFile?:(path:string)=>Promise<File|null>; docxCreationAvailable?:boolean;getExportLayout?:(sheetName:string)=>import('@genoffice/xlsx-gateway/gateway/csv-import').SheetExportLayout; pickMergeFiles?:(signal:AbortSignal)=>Promise<File[]>} = {}) {
  let saveFence:(()=>boolean)|null=null
  async function guardedSave(check:()=>boolean,action:()=>Promise<boolean>){
    if(saveFence||!check())return false
    saveFence=check
    try{return await action()}finally{saveFence=null}
  }
  let committed: import('../../../../packages/web-contracts/src/api').RevisionRef | null = null
  const sessions = new Map<string,Session>(), controllers = new Set<AbortController>()
  const renameListeners = new Set<(name:string)=>void>()
  const text = messages[prefs.language === 'en' ? 'en' : 'zh']
  let recovery: Recovery | null = null, confirming = false
  let activeSaveCount=0,activeSave:Promise<void>|undefined,resolveActiveSave:(()=>void)|undefined
  function beginActiveSave(){
    if(activeSaveCount++===0)activeSave=new Promise(resolve=>{resolveActiveSave=resolve})
    let ended=false
    return ()=>{
      if(ended)return
      ended=true
      if(--activeSaveCount===0){const resolve=resolveActiveSave;activeSave=undefined;resolveActiveSave=undefined;resolve?.()}
    }
  }
  function waitForSave(){return recovery?undefined:activeSave}
  let inFlight = 0
  const waiting: (() => void)[] = []
  let csrf: string | undefined, disposed = false, queued = true, pendingEdits = 0
  let unlockGrant: {revision:string;id:string} | undefined
  const noEvent = () => () => {}
  const unavailable = async (): Promise<never> => { throw new Error(text.unavailable) }
  const session = (id: string) => { const current = sessions.get(id); if (disposed || !current) throw hostError('INVALID_REVISION','workbook session'); return current }
  async function exportDraftCopy(id: string, phases: WorkbookSaveRequest[], proof: string, signal: AbortSignal): Promise<Blob> {
    const current = session(id), { lease } = host.getState(fileId)
    const check = () => {
      signal.throwIfAborted()
      const state = host.getState(fileId)
      if (session(id) !== current || current.attachment || !lease || recovery || state.status !== 'idle' ||
          state.revision.revision !== current.revision || state.lease?.editorId !== lease.editorId || state.lease.leaseEpoch !== lease.leaseEpoch) {
        throw hostError('CONFLICT','workbook draft copy')
      }
      return lease
    }
    const {editorId, leaseEpoch} = check()
    const body = JSON.stringify({baseRevision:current.revision, editorId, leaseEpoch, phases:phases.map(phase=>workbookSaveRequestSchema.parse(phase))})
    if (new TextEncoder().encode(body).byteLength > 4 * 1024 * 1024) throw hostError('PAYLOAD_TOO_LARGE','workbook draft copy')
    const response = await fetchImpl(`/api/v1/files/${fileId}/sheets/export`,{method:'POST',credentials:'same-origin',redirect:'error',signal,
      headers:{'content-type':'application/json','x-csrf-token':proof},body})
    if (!response.ok || response.headers.get('content-type') !== 'application/octet-stream') throw hostError('UNAVAILABLE','workbook draft copy')
    const blob = await response.blob()
    check()
    if (!blob.size || blob.size > 32 * 1024 * 1024) throw hostError('INVALID_RESPONSE','workbook draft copy')
    return blob
  }
  async function request(revision: string, method: string, input: object = {}) {
    if (disposed) throw hostError('UNAVAILABLE','disposed')
    const controller = new AbortController(); controllers.add(controller)
    try {
      for (let attempt=0;attempt<2;attempt++) {
        if (!csrf) {
          const response = await fetchImpl('/api/v1/auth/csrf',{credentials:'same-origin',cache:'no-store',signal:controller.signal})
          if (!response.ok) throw hostError('UNAUTHORIZED','session')
          const body = await response.json()
          if (typeof body?.csrfToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.csrfToken)) throw hostError('INVALID_RESPONSE','csrf')
          csrf = body.csrfToken
        }
        const proof=csrf
        const grant=method!=='unlock'?unlockGrant?.id:undefined
        const response = await fetchImpl(`/api/v1/files/${fileId}/sheets/${method}`,{method:'POST',credentials:'same-origin',redirect:'error',cache:'no-store',signal:controller.signal,headers:{'content-type':'application/json','x-csrf-token':proof!,...(grant?{'x-dyoffice-workbook-unlock':grant}:{})},body:JSON.stringify({revision,...input})})
        if(response.status===403 && attempt===0){if(csrf===proof)csrf=undefined;continue}
        if(response.status===422&&method==='unlock')throw Error(prefs.language==='en'?'The workbook password is incorrect.':'工作簿密码错误。')
        if (!response.ok) throw Object.assign(hostError(response.status === 401 || response.status === 403 ? 'UNAUTHORIZED' : response.status === 409 ? 'CONFLICT' : 'UNAVAILABLE','workbook read'),{status:response.status})
        if (!response.headers.get('content-type')?.includes('application/json')) throw hostError('INVALID_RESPONSE','workbook read')
        return await response.json()
      }
    } finally { controllers.delete(controller) }
  }
  async function unlockWorkbook(password:string) {
    const revision=host.getState(fileId).revision.revision
    const result=await call(revision,'unlock',{password})
    if(disposed||host.getState(fileId).revision.revision!==revision||typeof result?.unlockId!=='string'||!workbookId.test(result.unlockId))throw hostError('CONFLICT','workbook unlock')
    unlockGrant={revision,id:result.unlockId}
  }
  function releaseWorkbookUnlock(){
    const grant=unlockGrant
    unlockGrant=undefined
    if(grant&&csrf)void fetchImpl(`/api/v1/files/${fileId}/sheets/lock`,{method:'POST',credentials:'same-origin',keepalive:true,redirect:'error',
      headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({revision:grant.revision,unlockId:grant.id})}).catch(()=>{})
  }
  async function adoptWorkbookImportUnlock(revision:string,id:string){
    if(disposed||!workbookId.test(id)||host.getState(fileId).revision.revision!==revision)return false
    unlockGrant={revision,id}
    try{
      await call(revision,'inspect')
      if(!disposed&&host.getState(fileId).revision.revision===revision)return true
    }catch{
      // A stale import grant falls back to the normal password prompt.
    }
    releaseWorkbookUnlock()
    return false
  }
  async function requestAttachment(revision:string,name:string,file:File){
    if(disposed)throw hostError('UNAVAILABLE','disposed')
    const controller=new AbortController();controllers.add(controller)
    try{
      for(let attempt=0;attempt<2;attempt++){
        if(!csrf){const response=await fetchImpl('/api/v1/auth/csrf',{credentials:'same-origin',cache:'no-store',signal:controller.signal});if(!response.ok)throw hostError('UNAUTHORIZED','session');const body=await response.json();if(typeof body?.csrfToken!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(body.csrfToken))throw hostError('INVALID_RESPONSE','csrf');csrf=body.csrfToken}
        const proof=csrf,query=new URLSearchParams({revision,name})
        const response=await fetchImpl(`/api/v1/files/${fileId}/sheets/merge-sources/open?${query}`,{method:'POST',credentials:'same-origin',cache:'no-store',signal:controller.signal,headers:{'content-type':'application/octet-stream','x-csrf-token':proof!},body:file})
        if(response.status===403&&attempt===0){if(csrf===proof)csrf=undefined;continue}
        if(!response.ok)throw hostError(response.status===401||response.status===403?'UNAUTHORIZED':response.status===409?'CONFLICT':'UNAVAILABLE','merge attachment')
        if(!response.headers.get('content-type')?.includes('application/json'))throw hostError('INVALID_RESPONSE','merge attachment')
        return await response.json()
      }
    }finally{controllers.delete(controller)}
  }
  async function openMergeFiles(files:File[],revision:string,check=()=>true){
    const supported:readonly string[]=mergeExtensions
    if(files.length>8||files.some(file=>!file.size||file.size>50*1024*1024||!supported.includes(file.name.split('.').at(-1)?.toLowerCase()??''))){
      throw new Error(prefs.language==='zh'?'请选择最多 8 个工作簿，每个最多 50 MiB。':'Choose up to 8 supported workbooks, each at most 50 MiB.')
    }
    const opened:WorkbookFile[]=[]
    try{
      for(const file of files){
        if(!check()||host.getState(fileId).revision.revision!==revision)throw hostError('CONFLICT','merge source revision')
        const raw=await requestAttachment(revision,file.name,file)
        const source=workbookFileSchema.parse({...raw,readOnly:true,needsSaveAs:false,automaticRecoveryDisabled:true})
        sessions.set(source.sessionId,{revision,file:source,attachment:true})
        opened.push(source)
      }
      if(disposed||!check()||host.getState(fileId).revision.revision!==revision)throw hostError('CONFLICT','merge source revision')
      return opened
    }catch(error){
      await Promise.allSettled(opened.map(async file=>{
        sessions.delete(file.sessionId)
        await call(revision,'merge-sources/close',{sessionId:file.sessionId})
      }))
      throw error
    }
  }
  async function call(revision: string, method: string, input: object = {}) {
    if (waiting.length >= 64) throw hostError('UNAVAILABLE','read capacity')
    if (inFlight >= 2) await new Promise<void>(resolve => waiting.push(resolve))
    else inFlight++
    try { return await request(revision,method,input) }
    finally { const next=waiting.shift(); if(next) next(); else inFlight-- }
  }
  async function open(withViewport=false) {
    const state = host.getState(fileId), {openingViewport,...raw} = await call(state.revision.revision,'inspect',withViewport?{openingViewport:true}:{})
    const file = workbookFileSchema.parse({...raw,sessionId:crypto.randomUUID(),name:state.name,sha256:state.revision.sha256,fileBytes:state.revision.size,readOnly:!state.lease,needsSaveAs:false,automaticRecoveryDisabled:true,...(unlockGrant?{passwordProtected:true}:{})})
    if(unlockGrant)unlockGrant.revision=state.revision.revision
    if (disposed) throw hostError('UNAVAILABLE','disposed')
    const result=withViewport&&openingViewport&&file.sheets.some(s=>s.id===openingViewport.sheetId)
      &&Number.isInteger(openingViewport.endRow)&&openingViewport.endRow>=0&&openingViewport.endRow<160
      &&Number.isInteger(openingViewport.endColumn)&&openingViewport.endColumn>=0&&openingViewport.endColumn<34
      ? workbookRangeResultSchema.safeParse(openingViewport.result) : undefined
    const preview=result?.success&&result.data.indexingComplete ? {...openingViewport,result:result.data} : undefined
    sessions.set(file.sessionId,{revision:state.revision.revision,file,openingViewport:preview}); queued=false
    return file
  }
  async function openSaved(revision:string):Promise<WorkbookFile> {
    const file=await open(),current=session(file.sessionId)
    if(current.revision!==revision||!host.getState(fileId).autoNamePending)return file
    try {
      const visible=file.sheets.filter(sheet=>!sheet.hidden)
      let candidate=visible.map(sheet=>sheet.name.trim()).find(name=>name&&!/^(?:sheet|工作表|ワークシート|シート)\s*\d*$/i.test(name))
      if(!candidate){
        const first=visible.find(sheet=>(sheet.valueCellCount??sheet.storedCellCount??1)>0)
        if(first){
          const range={startRow:0,endRow:Math.min(first.rowCount,8)-1,startColumn:0,endColumn:Math.min(first.columnCount,8)-1}
          const {cells}=workbookRangeResultSchema.parse(await call(revision,'range',{sheetName:first.name,range}))
          const redactions=await api.readWorkbookRedactions({sessionId:file.sessionId})
          if(redactions.status==='unreadable')return file
          const marks=redactions.status==='ok'?redactions.states.filter(state=>state.sheetName===first.name).flatMap(state=>state.marks):[]
          const title=cells.find(cell=>!cell.formula&&typeof cell.value==='string'&&cell.value.trim()&&
            !marks.some(mark=>cell.row>=mark.startRow&&cell.row<=mark.endRow&&cell.column>=mark.startColumn&&cell.column<=mark.endColumn))?.value
          if(typeof title==='string')candidate=title.trim().split(/[\r\n]/,1)[0]
        }
      }
      if(candidate&&!disposed)await api.autoRenameWorkbook(file.sessionId,candidate)
    }catch{ /* Naming is optional; the revision has already been saved. */ }
    if(disposed)throw hostError('UNAVAILABLE','disposed')
    return current.file
  }
  async function persistWorkbook(submit:()=>Promise<SavedWorkbook>,apply:ApplySavedWorkbook):Promise<SaveResult>{
    const finishSave=beginActiveSave()
    try{
      if(saveFence&&!saveFence())throw hostError('UNAVAILABLE','save authorization changed')
      let saved:SavedWorkbook|undefined
      try{
        saved=await submit()
        committed=saved
        return {canceled:false,file:await apply(saved),touchedEntries:saved.touchedEntries}
      }catch(error){
        if(disposed)throw hostError('UNAVAILABLE','disposed')
        if(!saved&&host.getState(fileId).status!=='unknown')throw error
        // Confirmation resumes the original receipt without staging a second revision.
        return await new Promise<SaveResult>((resolve,reject)=>{recovery={...(saved?{saved}:{}),apply,resolve,reject};onChange()})
      }
    }finally{finishSave()}
  }
  function sheet(current: Session, sheetId: string) {
    const value = current.file.sheets.find(value => value.id === sheetId)
    if (!value) throw hostError('INVALID_REVISION','worksheet')
    return value.name
  }
  function extras(id: string) {
    const current = session(id)
    return current.extras ??= call(current.revision,'package').catch(error => { delete current.extras; throw error })
  }
  function workspaceSourceId(target: string) {
    try {
      const url=new URL(target)
      if(url.origin!==location.origin||url.username||url.password||url.hash||
        !/^\?revision=[a-f0-9-]+$/.test(url.search)||!workbookId.test(url.searchParams.get('revision')??''))return undefined
      const id=/^\/api\/v1\/files\/([^/]+)\/content$/.exec(url.pathname)?.[1]
      if(id&&workbookId.test(id))return id
    }catch { /* Imported desktop paths stay unbound. */ }
  }
  async function listWorkspaceWorkbooks():Promise<WorkspaceWorkbook[]> {
    if(disposed)throw hostError('UNAVAILABLE','disposed')
    const controller=new AbortController()
    controllers.add(controller)
    try {
      const workbooks:WorkspaceWorkbook[]=[], seen=new Set<string>()
      let cursor:string|null=null
      do {
        const response:Response=await fetchImpl('/api/v1/files?limit=100'+(cursor?'&cursor='+encodeURIComponent(cursor):''),
          {credentials:'same-origin',cache:'no-store',signal:controller.signal})
        if(!response.ok)throw hostError('UNAVAILABLE','workspace workbooks')
        const body:{files?:unknown;nextCursor?:unknown}=await response.json()
        if(!Array.isArray(body?.files))throw hostError('INVALID_RESPONSE','workspace workbooks')
        for(const item of body.files) {
          if(item?.format==='xlsx'&&item.id!==fileId&&typeof item.name==='string'&&
            typeof item.id==='string'&&workbookId.test(item.id)&&typeof item.revision==='string'&&workbookId.test(item.revision)){
            workbooks.push({id:item.id,name:item.name,revision:item.revision})
          }
        }
        const next=body.nextCursor
        if(next!==null){
          if(typeof next!=='string'||!workbookId.test(next)||seen.has(next))throw hostError('INVALID_RESPONSE','workspace workbooks cursor')
          seen.add(next)
        }
        cursor=next
      }while(cursor)
      return workbooks.sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id))
    }finally{controllers.delete(controller)}
  }
  async function workspaceLinkMetadata(current:Session) {
    return externalLinksResultSchema.parse(await call(current.revision,'external-links'))
  }
  function workspaceSourceTarget(id:string,revision:string){
    if(!workbookId.test(id)||!workbookId.test(revision))throw hostError('INVALID_REVISION','workspace source')
    const url=new URL('/api/v1/files/'+id+'/content',location.origin)
    url.searchParams.set('revision',revision)
    return url.href
  }
  const workspaceLinks = {
    listSources:listWorkspaceWorkbooks,
    sourceTarget:workspaceSourceTarget,
    async refresh(sessionId:string){
      const current=session(sessionId)
      if(current.attachment||current.revision!==host.getState(fileId).revision.revision)throw hostError('CONFLICT','external links')
      const links=await workspaceLinkMetadata(current)
      if(!links.workspaceSources)throw hostError('UNAVAILABLE','workspace sources')
      const workbooks=new Map((await listWorkspaceWorkbooks()).map(file=>[file.id,file]))
      const sources=links.links.flatMap(link=>{
        const id=workspaceSourceId(link.rawTarget)
        const source=id&&workbooks.get(id)
        return source?[{index:link.index,fileId:source.id,revision:source.revision}]:[]
      })
      const report=externalLinksUpdateResultSchema.parse(await call(current.revision,'external-links/preview',{sources}))
      const savedLinks=report.links.map(link=>{
        const id=workspaceSourceId(link.rawTarget)
        const source=id?workbooks.get(id):undefined
        if(!source||!link.reachable)return link
        return {...link,displayName:source.name}
      })
      return {...report,links:savedLinks}
    },
  }
  const parentWindow = () => typeof window === 'undefined' ? undefined : window.parent as ParentAiWindow
  const api = {
    saveEditsInlineMaxBytes: 4 * 1024 * 1024,
    getLanguage: async () => prefs.language === 'en' ? 'en' as const : 'zh' as const,
    getTheme: async () => prefs.theme,
    getDocumentTheme: async () => 'follow' as const,
    getAutoSaveDefault: async () => ({on:prefs.autoSave === true,updatedAt:1}),
    getAiPanelPrefs: async () => ({side:'left' as const,fontSize:'default' as const,customFontSize:14,spellcheck:true,openInNewDocs:false,showAiSidebar:false,showAiAskTrigger:true}),
    getUserDisplayName: async () => prefs.authorName ?? '',
    onLanguageChanged:noEvent,onThemeChanged:noEvent,onDocumentThemeChanged:noEvent,onAutoSaveDefaultChanged:noEvent,onAiPanelPrefsChanged:noEvent,onUserDisplayNameChanged:noEvent,
    onWorkbookPickArmed:noEvent,onWorkbookPickSelected:noEvent,onWorkbookPickCancelled:noEvent,
    isCopyEmfAvailable:async()=>false,
    onChromePressed:noEvent,onCloseSaveRequest:noEvent,onRecoveryPrompt:noEvent,onSidecarCrashed:noEvent,
    onMenuAction(listener: Parameters<DesktopApi['onMenuAction']>[0]){
      const keydown = (event: KeyboardEvent) => {
        if (disposed || event.isComposing || event.altKey ||
            (!event.ctrlKey && !event.metaKey)) return
        const key = event.key.toLowerCase()
        const action = key === 's' ? event.shiftKey ? 'save-as' : 'save' : key === 'p' && !event.shiftKey ? 'print' : undefined
        if (!action) return
        event.preventDefault()
        event.stopPropagation()
        if (event.repeat || (action === 'print' && host.getState(fileId).status === 'unauthorized')) return
        listener(action)
      }
      window.addEventListener('keydown', keydown, true)
      const unsubscribe=subscribeBrowserDocumentCommands({print:()=>listener('print'),save:()=>listener('save'),'save-as':()=>listener('save-as')},()=>!disposed&&host.getState(fileId).status!=='unauthorized')
      return () => {unsubscribe();window.removeEventListener('keydown', keydown, true)}
    },
    onWorkbookRenamed(listener:(name:string)=>void){
      renameListeners.add(listener)
      return ()=>{renameListeners.delete(listener)}
    },
    hasQueuedWorkbook:async()=>queued,consumeNewBlankWorkbook:async()=>false,consumeHeadlessExport:async()=>null,
    notifyPendingEdits(count: number){pendingEdits=count;onChange()},
    selectWorkbook:()=>open(queued),
    async closeWorkbook(id: string){const current=sessions.get(id);sessions.delete(id);if(current?.attachment)await call(current.revision,'merge-sources/close',{sessionId:id})},
    async readWorkbookMedia(input){const request=workbookMediaRequestSchema.parse(input),current=session(request.sessionId);return workbookMediaResultSchema.parse(await call(current.revision,'media',{visualId:request.visualId}))},
    async recalcWorkbook(input){
      const request=workbookRecalcRequestSchema.parse(input),current=session(request.sessionId)
      const result=await call(current.revision,'recalculate',{edits:request.edits.map(({sheetId,...e})=>({sheetName:sheet(current,sheetId),...e})),reads:request.reads.map(({sheetId,range})=>({sheetName:sheet(current,sheetId),range}))})
      return workbookRecalcResultSchema.parse({cells:result.cells.map(({sheet:name,...cell}: {sheet:string})=>{
        const target=current.file.sheets.find(s=>s.name===name)
        if(!target)throw hostError('INVALID_RESPONSE','recalculated worksheet')
        return {...cell,sheetId:target.id}
      })})
    },
    async readWorkbookRange(input) {
      const request = workbookRangeRequestSchema.parse(input)
      const current = session(request.sessionId)
      const sheetName = sheet(current, request.sheetId)
      const read = async (range: typeof request.range) => workbookRangeResultSchema.parse(await call(
        current.revision, current.attachment ? 'merge-sources/range' : 'range',
        { ...(current.attachment ? {sessionId: request.sessionId} : {}), sheetName, range },
      ))
      const range = request.range
      const preview=current.openingViewport
      if(preview&&preview.sheetId===request.sheetId&&range.endRow<=preview.endRow&&range.endColumn<=preview.endColumn&&host.getState(fileId).revision.revision===current.revision){
        // The Node reader's only range-dependent field is cells. Hand the renderer its own copy.
        return structuredClone({...preview.result,cells:preview.result.cells.filter(c=>c.row>=range.startRow&&c.row<=range.endRow&&c.column>=range.startColumn&&c.column<=range.endColumn)})
      }
      const columns = range.endColumn - range.startColumn + 1
      // Match the Web native worker's per-request limit while keeping the renderer's range intact.
      const rowsPerBatch = Math.max(1, Math.floor(20_000 / columns))
      if (range.endRow - range.startRow + 1 <= rowsPerBatch) return read(range)

      const batches = []
      for (let startRow = range.startRow; startRow <= range.endRow; startRow += rowsPerBatch) {
        session(request.sessionId)
        const endRow = Math.min(range.endRow, startRow + rowsPerBatch - 1)
        const batch = await read({...range, startRow, endRow})
        batches.push(batch)
        if (!batch.indexingComplete && (batch.indexedThroughRow === null || batch.indexedThroughRow < endRow)) break
      }
      const last = batches.at(-1)
      if (!last) throw hostError('INVALID_RESPONSE','workbook range')
      const merges = new Map(batches.flatMap(batch => batch.merges).map(merge => [
        [merge.startRow, merge.endRow, merge.startColumn, merge.endColumn].join(','), merge,
      ]))
      return {
        ...last,
        cells: batches.flatMap(batch => batch.cells),
        rows: batches.flatMap(batch => batch.rows),
        merges: [...merges.values()],
        hyperlinks: batches.flatMap(batch => batch.hyperlinks),
      }
    },
    async readWorkbookFormulas(input){const request=workbookFormulaCellsRequestSchema.parse(input),current=session(request.sessionId);return workbookFormulaCellsResultSchema.parse(await call(current.revision,'sheet',{sheetName:sheet(current,request.sheetId),kind:'formulas'}))},
    async readWorkbookRowOutline(input){const request=workbookFormulaCellsRequestSchema.parse(input),current=session(request.sessionId);return workbookRowOutlineResultSchema.parse(await call(current.revision,'sheet',{sheetName:sheet(current,request.sheetId),kind:'outline'}))},
    async readWorkbookRedactions({sessionId}){return workbookRedactionsResultSchema.parse((await extras(sessionId)).redactions)},
    async readSlicerState({sessionId}){return workbookSlicerStateResultSchema.parse((await extras(sessionId)).slicers)},
    async listWorkbookConnections({sessionId}){return workbookConnectionsResultSchema.parse((await extras(sessionId)).connections)},
    async readWorkbookQueries({sessionId}){return workbookQueriesResultSchema.parse((await extras(sessionId)).queries)},
    async saveWorkbookEdits(input){
      const request=workbookSaveRequestSchema.parse(input),current=session(request.sessionId)
      if (host.getState(fileId).revision.revision!==current.revision) throw hostError('CONFLICT','workbook base')
      try{
        return await persistWorkbook(()=>host.saveSheets(fileId,request,saveFence??(()=>true),unlockGrant?.id),saved=>openSaved(saved.revision))
      }catch(error){
        if((error as {code?:string}).code==='PAYLOAD_TOO_LARGE')throw new Error(prefs.language==='en'?'Web save exceeds the 4 MiB request limit. Your edits are still unsaved; keep this page open.':'本次保存超过 Web 请求的 4 MiB 限制。更改仍未保存，请保留当前页面，不要关闭或刷新。')
        throw error
      }
    },
    async autoRenameWorkbook(sessionId:string,candidate:string){
      const current=session(sessionId)
      if(committed?.revision!==current.revision)return {renamed:false}
      const name=await host.nameSavedBlank?.(fileId,current.revision,candidate)
      if(!name)return {renamed:false}
      current.file={...current.file,name}
      if(sessions.get(sessionId)===current)for(const listener of renameListeners)listener(name)
      return {renamed:true,name}
    },
    async createDocument(input:import('../../../sheets/src/shared/desktop-api').WorkbookCreateDocumentRequest){
      try{
        const parent=parentWindow()
        if(input.type==='xlsx'&&typeof parent?.dyofficeCreateAiXlsx==='function'){await parent.dyofficeCreateAiXlsx({title:input.title,...(input.sheetName?{sheetName:input.sheetName,...(getExportLayout?{layout:getExportLayout(input.sheetName)}:{})}:{}),content:input.content});return {ok:true}}
        if(input.type==='docx'&&docxCreationAvailable&&typeof parent?.dyofficeCreateAiDoc==='function'){await parent.dyofficeCreateAiDoc({title:input.title,content:input.content});return {ok:true}}
        if(input.type==='pdf'&&typeof parent?.dyofficeCreateAiDoc==='function'){
          const response=await fetchImpl(new URL('../../../docs/src/renderer/fonts/NotoSansCJKsc-Regular-subset.woff2',import.meta.url))
          if(!response.ok)throw new Error(text.unavailable)
          const bytes=await createAiPdf(input.title,input.content,new Uint8Array(await response.arrayBuffer()))
          if(disposed)throw new Error(text.unavailable)
          await parent.dyofficeCreateAiDoc({type:'pdf',title:input.title,content:input.content,file:new Blob([new Uint8Array(bytes).buffer as ArrayBuffer],{type:'application/pdf'})})
          return {ok:true}
        }
        return {ok:false,error:text.unavailable}
      }catch(error){return {ok:false,error:error&&typeof error==='object'&&'message'in error&&typeof error.message==='string'?error.message:text.unavailable}}
    },
    async selectWorkbooksForMerge(){
      const base=host.getState(fileId)
      const controller=new AbortController()
      controllers.add(controller)
      try{
        const files=await pickMergeFiles(controller.signal)
        if(!files.length)return []
        const stillCurrent=()=>{
          const current=host.getState(fileId)
          return !disposed&&!!base.lease&&!!current.lease&&base.revision.revision===current.revision.revision&&
            base.lease.editorId===current.lease.editorId&&base.lease.leaseEpoch===current.lease.leaseEpoch
        }
        return await openMergeFiles(files,base.revision.revision,stillCurrent)
      }finally{controllers.delete(controller)}
    },
    async openWorkbooksForMerge(paths:string[]){
      if(!getAttachmentFile||!Array.isArray(paths)||paths.length<1||paths.length>8)throw new Error(text.unavailable)
      const files:File[]=[]
      for(const path of paths){
        if(typeof path!=='string'||!path.startsWith('web-attachment:'))throw new Error(text.unavailable)
        const file=await getAttachmentFile(path)
        if(!file)throw new Error(text.unavailable)
        files.push(file)
      }
      return openMergeFiles(files,host.getState(fileId).revision.revision)
    },
    openEncryptedWorkbook:unavailable,reopenWorkbook:unavailable,
    async listExternalLinks(input){
      const {sessionId}=externalLinksRequestSchema.parse(input)
      const current=session(sessionId)
      if(current.attachment)throw hostError('INVALID_REVISION','external links')
      const result=await workspaceLinkMetadata(current)
      if(!result.workspaceSources||!result.links.some(link=>workspaceSourceId(link.rawTarget)))return result
      const names=new Map((await listWorkspaceWorkbooks()).map(file=>[file.id,file.name]))
      return {...result,links:result.links.map(link=>{
        const id=workspaceSourceId(link.rawTarget)
        const displayName=id?names.get(id):undefined
        return displayName?{...link,displayName}:link
      })}
    },
    async refreshWorkbookConnection(input){
      const {sessionId,connectionId}=workbookRefreshRequestSchema.parse(input)
      const current=session(sessionId), before=host.getState(fileId), lease=before.lease
      if(current.attachment||!lease||before.revision.revision!==current.revision)throw hostError('CONFLICT','workbook query')
      const result=await call(current.revision,'web-query',{connectionId,editorId:lease.editorId,leaseEpoch:lease.leaseEpoch})
      const after=host.getState(fileId)
      if(disposed||sessions.get(sessionId)!==current||after.revision.revision!==current.revision||
          after.lease?.editorId!==lease.editorId||after.lease.leaseEpoch!==lease.leaseEpoch){
        throw hostError('CONFLICT','workbook query')
      }
      return workbookRefreshResultSchema.parse(result)
    },
    readLocalImage:unavailable,
    async readPivotDefinition(input){
      const request=workbookPivotRequestSchema.parse(input),current=session(request.sessionId)
      if(current.attachment||!current.file.sheets.some(sheet=>sheet.pivotTables.some(pivot=>pivot.path===request.path&&pivot.cachePath===request.cachePath)))throw hostError('INVALID_REVISION','pivot parts')
      return workbookPivotDefinitionSchema.parse(await call(current.revision,'pivot-definition',{path:request.path,cachePath:request.cachePath}))
    },
    async findWorkbookCells(input){
      const {sessionId,sheetId,resumeAt,limit,...options}=workbookFindCellsRequestSchema.parse(input)
      const current=session(sessionId)
      if(current.attachment||!sheetId||resumeAt&&resumeAt.sheetId!==sheetId)throw hostError('INVALID_REVISION','worksheet search')
      return workbookFindCellsResultSchema.parse(await call(current.revision,'find',{
        ...options,sheetName:sheet(current,sheetId),limit:Math.min(limit,100),
        ...(resumeAt?{resumeAt:{row:resumeAt.row,column:resumeAt.column}}:{}),
      }))
    },
    async updateWorkbookPassword(sessionId,newPassword){
      const current=session(sessionId),grant=unlockGrant
      if(!grant||current.attachment||!current.file.passwordProtected||current.revision!==host.getState(fileId).revision.revision)throw hostError('CONFLICT','workbook password')
      const {file}=await persistWorkbook(()=>host.changeSheetsPassword(fileId,newPassword,grant.id,saveFence??(()=>true)),async saved=>{
        const assertSavedRevision=()=>{
          if(disposed||session(sessionId)!==current||host.getState(fileId).revision.revision!==saved.revision)throw hostError('CONFLICT','workbook password revision')
        }
        assertSavedRevision()
        try{await call(saved.revision,'inspect')}
        catch(error){
          if((error as {status?:number})?.status!==423)throw error
          // The revision receipt is durable even when the in-memory grant has expired.
          assertSavedRevision()
          await unlockWorkbook(newPassword)
        }
        assertSavedRevision()
        // Rotation leaves the underlying package identical. Keep the active
        // renderer session and point its future reads and saves at the new head.
        if(unlockGrant)unlockGrant.revision=saved.revision
        current.revision=saved.revision
        delete current.extras
        current.file={...current.file,sha256:saved.sha256,fileBytes:saved.size,passwordProtected:true}
        return current.file
      })
      if(file.fileBytes===undefined)throw hostError('INVALID_RESPONSE','workbook password receipt')
      return {sha256:file.sha256,fileBytes:file.fileBytes,passwordProtected:true as const}
    },
    readExternalLinkUsage:unavailable,
    // Browser editors use the typed-range picker for external workbook links.
    async listWorkbookTabs(){return {tabs:[]}},
    browserPrintDialog:true,
    async listPrinters(){return []},
    async printWorkbook(input){
      const request=workbookExportPdfRequestSchema.parse(input)
      try{
        await printInBrowser(request.html,request.fileName)
        return {ok:true}
      }catch{
        return {ok:false,error:prefs.language==='en'?'Browser printing is unavailable.':'浏览器打印不可用。'}
      }
    },
    writeWorkbookRecovery:unavailable,exportPdf:unavailable,exportCsv:unavailable,
    openAiModelSettings:async()=>{
      const parent=typeof window!=='undefined'?(window.parent as unknown as {dyofficeOpenEditorSettings?:(tab:'models'|'skills',source:Window)=>Promise<void>}):undefined
      if(parent&&typeof parent.dyofficeOpenEditorSettings==='function')return parent.dyofficeOpenEditorSettings('models',window)
      return unavailable()
    },
    openSkillsSettings:async()=>{
      const parent=typeof window!=='undefined'?(window.parent as unknown as {dyofficeOpenEditorSettings?:(tab:'models'|'skills',source:Window)=>Promise<void>}):undefined
      if(parent&&typeof parent.dyofficeOpenEditorSettings==='function')return parent.dyofficeOpenEditorSettings('skills',window)
      return unavailable()
    },
  } satisfies Partial<DesktopApi>
  async function confirmSave() {
    const pending=recovery
    if (!pending || confirming) return
    if(!pending.saved&&saveFence&&!saveFence())throw hostError('UNAVAILABLE','save authorization changed')
    confirming=true
    try {
      pending.saved ??= await host.reconcileSheets(fileId,saveFence??(()=>true))
      if (disposed) throw hostError('UNAVAILABLE','disposed')
      committed=pending.saved
      const file=await pending.apply(pending.saved)
      recovery=null
      pending.resolve({canceled:false,file,touchedEntries:pending.saved.touchedEntries})
    } catch(error) {
      if (!pending.saved && host.getState(fileId).status !== 'unknown') {recovery=null;pending.reject(error)}
      throw error
    } finally {confirming=false;if(!disposed)onChange()}
  }
  async function prepareDownload(editor: {saveAndWait(): Promise<boolean>; isDirty(): boolean}) {
    if(disposed)throw hostError('UNAVAILABLE','disposed')
    const before=host.getState(fileId)
    if(!before.lease || before.status==='unauthorized' || before.status==='conflict')throw hostError('CONFLICT','download authority')
    // The renderer owns the active editor and the full save/late-edit queue.
    // Its Promise stays pending across an unknown commit receipt. Never fall
    // back to a saved-head link on cancellation, conflict or remaining edits.
    if(!await editor.saveAndWait())throw hostError('UNAVAILABLE','download save')
    if(disposed)throw hostError('UNAVAILABLE','disposed')
    const state=host.getState(fileId)
    if(editor.isDirty() || recovery || state.status!=='idle' || !state.lease)throw hostError('CONFLICT','download not clean')
    return {...state.revision}
  }
  async function takeover(editor: {reload(): Promise<boolean>; isDirty(): boolean}) {
    if(disposed)throw hostError('UNAVAILABLE','disposed')
    if(editor.isDirty() || pendingEdits>0 || recovery || host.getState(fileId).status==='unknown')throw hostError('CONFLICT','unsaved takeover')
    let acquired=false
    try {
      await host.takeoverLease(fileId);acquired=true
      if(disposed || editor.isDirty() || pendingEdits>0 || recovery)throw hostError('CONFLICT','unsaved takeover')
      await host.refreshHead(fileId)
      if(disposed || editor.isDirty() || pendingEdits>0 || recovery)throw hostError('CONFLICT','unsaved takeover')
      if(!await editor.reload())throw hostError('UNAVAILABLE','takeover reload')
      if(disposed || !host.getState(fileId).lease)throw hostError('CONFLICT','takeover authority')
    } catch(error) {
      // A failed reload must not expose a stale view as an editable new head.
      if(acquired)await host.releaseLease(fileId).catch(()=>{})
      throw error
    }
  }
  return {
    get supportedCreateDocumentTypes() {
      try {
        const parent=parentWindow()
        return [
          ...(typeof parent?.dyofficeCreateAiXlsx==='function' ? ['xlsx'] as const : []),
          'csv',
          ...(typeof parent?.dyofficeCreateAiDoc==='function' ? docxCreationAvailable?['docx','pdf'] as const:['pdf'] as const : []),
        ] as const
      } catch {
        return ['csv'] as const // Cross-origin parents cannot supply workspace creators.
      }
    },
    supportedMergeExtensions: mergeExtensions,
    api,workspaceLinks,unlockWorkbook,adoptWorkbookImportUnlock,guardedSave,waitForSave,getReceipt:()=>committed,getWorkbookRevision:(id:string)=>sessions.get(id)?.revision,confirmSave,prepareDownload,exportDraftCopy,takeover,needsConfirmation:()=>recovery!==null,isDirty:()=>pendingEdits>0,dispose(){releaseWorkbookUnlock();disposed=true;recovery?.reject(hostError('UNAVAILABLE','disposed'));recovery=null;for(const controller of controllers)controller.abort();controllers.clear();sessions.clear();csrf=undefined}}
}
