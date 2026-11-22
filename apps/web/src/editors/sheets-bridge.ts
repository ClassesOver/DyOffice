import type {SessionFileHost} from '../../../../packages/browser-host/src/files.ts'
import {hostError} from '../../../../packages/web-contracts/src/errors.ts'
import {messages} from './messages.ts'
import {createAiPdf} from './create-ai-pdf.ts'
import {
  workbookMediaRequestSchema,workbookMediaResultSchema,
  workbookPivotRequestSchema,workbookPivotDefinitionSchema,externalLinksRequestSchema,externalLinksResultSchema,externalLinksUpdateResultSchema,
  workbookFileSchema, workbookRangeRequestSchema, workbookRangeResultSchema,
  workbookFormulaCellsRequestSchema, workbookFormulaCellsResultSchema, workbookRowOutlineResultSchema,
  workbookRedactionsResultSchema, workbookSlicerStateResultSchema, workbookQueriesResultSchema,
  workbookRecalcRequestSchema,workbookRecalcResultSchema,
  workbookConnectionsResultSchema, workbookSaveRequestSchema,
  workbookFindCellsRequestSchema, workbookFindCellsResultSchema,
  type DesktopApi, type WorkbookFile, type WorkbookSaveRequest,
} from '../../../sheets/src/shared/desktop-api'

type Preferences = Awaited<ReturnType<SessionFileHost['getPreferences']>>
type ParentAiWindow = Window & {
  dyofficeCreateAiXlsx?: (request:{title:string;sheetName?:string;content:string})=>Promise<void>
  dyofficeCreateAiDoc?: (request:{type?:'docx'|'pdf';title:string;content:string;file?:Blob})=>Promise<void>
}
type SaveResult = {canceled: false; file: WorkbookFile; touchedEntries: string[]}
type Recovery = {saved?: Awaited<ReturnType<SessionFileHost['saveSheets']>>; resolve(value: SaveResult): void; reject(error: unknown): void}
type Session = {revision: string; file: WorkbookFile; attachment?: boolean; extras?: Promise<Record<string,unknown>>}
type WorkspaceWorkbook = {id:string;name:string;revision:string}
const workbookId=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
export function createSheetsBridge(host: SessionFileHost, fileId: string, prefs: Preferences, {fetchImpl = fetch, onChange = () => {},getAttachmentFile,docxCreationAvailable=false}: {fetchImpl?: typeof fetch; onChange?: () => void; getAttachmentFile?:(path:string)=>Promise<File|null>; docxCreationAvailable?:boolean} = {}) {
  let saveFence:(()=>boolean)|null=null
  async function guardedSave(check:()=>boolean,action:()=>Promise<boolean>){
    if(saveFence||!check())return false
    saveFence=check
    try{return await action()}finally{saveFence=null}
  }
  let committed: import('../../../../packages/web-contracts/src/api').RevisionRef | null = null
  const sessions = new Map<string,Session>(), controllers = new Set<AbortController>()
  const text = messages[prefs.language === 'en' ? 'en' : 'zh']
  let recovery: Recovery | null = null, confirming = false
  let inFlight = 0
  const waiting: (() => void)[] = []
  let csrf: string | undefined, disposed = false, queued = true, pendingEdits = 0
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
        const response = await fetchImpl(`/api/v1/files/${fileId}/sheets/${method}`,{method:'POST',credentials:'same-origin',cache:'no-store',signal:controller.signal,headers:{'content-type':'application/json','x-csrf-token':proof!},body:JSON.stringify({revision,...input})})
        if(response.status===403 && attempt===0){if(csrf===proof)csrf=undefined;continue}
        if (!response.ok) throw hostError(response.status === 401 || response.status === 403 ? 'UNAUTHORIZED' : response.status === 409 ? 'CONFLICT' : 'UNAVAILABLE','workbook read')
        if (!response.headers.get('content-type')?.includes('application/json')) throw hostError('INVALID_RESPONSE','workbook read')
        return await response.json()
      }
    } finally { controllers.delete(controller) }
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
  async function call(revision: string, method: string, input: object = {}) {
    if (waiting.length >= 64) throw hostError('UNAVAILABLE','read capacity')
    if (inFlight >= 2) await new Promise<void>(resolve => waiting.push(resolve))
    else inFlight++
    try { return await request(revision,method,input) }
    finally { const next=waiting.shift(); if(next) next(); else inFlight-- }
  }
  async function open() {
    const state = host.getState(fileId), raw = await call(state.revision.revision,'inspect')
    const file = workbookFileSchema.parse({...raw,sessionId:crypto.randomUUID(),name:state.name,sha256:state.revision.sha256,fileBytes:state.revision.size,readOnly:!state.lease,needsSaveAs:false,automaticRecoveryDisabled:true})
    if (disposed) throw hostError('UNAVAILABLE','disposed')
    sessions.set(file.sessionId,{revision:state.revision.revision,file}); queued=false
    return file
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
    getAiPanelPrefs: async () => ({side:'left' as const,fontSize:'default' as const,customFontSize:14,spellcheck:true,openInNewDocs:false,showAiSidebar:false,showAiAskTrigger:false}),
    getUserDisplayName: async () => prefs.authorName ?? '',
    onLanguageChanged:noEvent,onThemeChanged:noEvent,onDocumentThemeChanged:noEvent,onAutoSaveDefaultChanged:noEvent,onAiPanelPrefsChanged:noEvent,onUserDisplayNameChanged:noEvent,
    onWorkbookPickArmed:noEvent,onWorkbookPickSelected:noEvent,onWorkbookPickCancelled:noEvent,
    isCopyEmfAvailable:async()=>false,
    onChromePressed:noEvent,onMenuAction:noEvent,onCloseSaveRequest:noEvent,onWorkbookRenamed:noEvent,onRecoveryPrompt:noEvent,onSidecarCrashed:noEvent,
    hasQueuedWorkbook:async()=>queued,consumeNewBlankWorkbook:async()=>false,consumeHeadlessExport:async()=>null,
    notifyPendingEdits(count: number){pendingEdits=count;onChange()},
    selectWorkbook:open,
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
      if(saveFence&&!saveFence())throw hostError('UNAVAILABLE','save authorization changed')
      const request=workbookSaveRequestSchema.parse(input),current=session(request.sessionId)
      if (host.getState(fileId).revision.revision!==current.revision) throw hostError('CONFLICT','workbook base')
      let saved: Awaited<ReturnType<SessionFileHost['saveSheets']>> | undefined
      try {
        saved=await host.saveSheets(fileId,request,saveFence??(()=>true))
        committed=saved
        return {canceled:false as const,file:await open(),touchedEntries:saved.touchedEntries}
      } catch(error) {
        // Teardown cannot undo a dispatched commit. Leave its durable/unknown
        // state in the host, but never recreate recovery for an unmounted view.
        if (disposed) throw hostError('UNAVAILABLE','disposed')
        if (!saved && host.getState(fileId).status !== 'unknown') {
          if ((error as {code?:string}).code === 'PAYLOAD_TOO_LARGE') throw new Error(prefs.language === 'en' ? 'Web save exceeds the 4 MiB request limit. Your edits are still unsaved; keep this page open.' : '本次保存超过 Web 请求的 4 MiB 限制。更改仍未保存，请保留当前页面，不要关闭或刷新。')
          throw error
        }
        // Keep save-actions' original Promise, journal snapshot and view alive.
        // Confirmation resumes that exact save, including its late-edit carry.
        return new Promise<SaveResult>((resolve,reject)=>{recovery={...(saved ? {saved} : {}),resolve,reject};onChange()})
      }
    },
    async createDocument(input:import('../../../sheets/src/shared/desktop-api').WorkbookCreateDocumentRequest){
      try{
        const parent=parentWindow()
        if(input.type==='xlsx'&&typeof parent?.dyofficeCreateAiXlsx==='function'){await parent.dyofficeCreateAiXlsx({title:input.title,...(input.sheetName?{sheetName:input.sheetName}:{}),content:input.content});return {ok:true}}
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
    selectWorkbooksForMerge:unavailable,
    async openWorkbooksForMerge(paths:string[]){
      if(!getAttachmentFile||!Array.isArray(paths)||paths.length<1||paths.length>8)throw new Error(text.unavailable)
      const opened:WorkbookFile[]=[]
      try{
        for(const path of paths){
          if(typeof path!=='string'||!path.startsWith('web-attachment:'))throw new Error(text.unavailable)
          const file=await getAttachmentFile(path);if(!file)throw new Error(text.unavailable)
          const current=host.getState(fileId),revision=current.revision.revision,raw=await requestAttachment(revision,file.name,file)
          const source=workbookFileSchema.parse({...raw,readOnly:true,needsSaveAs:false,automaticRecoveryDisabled:true})
          sessions.set(source.sessionId,{revision,file:source,attachment:true});opened.push(source)
        }
        return opened
      }catch(error){await Promise.allSettled(opened.map(async file=>{const current=sessions.get(file.sessionId);sessions.delete(file.sessionId);if(current)await call(current.revision,'merge-sources/close',{sessionId:file.sessionId})}));throw error}
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
    refreshWorkbookConnection:unavailable,readLocalImage:unavailable,
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
    updateWorkbookPassword:unavailable,
    readExternalLinkUsage:unavailable,listWorkbookTabs:unavailable,
    writeWorkbookRecovery:unavailable,exportPdf:unavailable,printWorkbook:unavailable,exportCsv:unavailable,
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
      const file=await open()
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
    supportedMergeExtensions: ['xlsx','xlsm','xls','csv','tsv'] as const,
    api,workspaceLinks,guardedSave,getReceipt:()=>committed,getWorkbookRevision:(id:string)=>sessions.get(id)?.revision,confirmSave,prepareDownload,exportDraftCopy,takeover,needsConfirmation:()=>recovery!==null,isDirty:()=>pendingEdits>0,dispose(){disposed=true;recovery?.reject(hostError('UNAVAILABLE','disposed'));recovery=null;for(const controller of controllers)controller.abort();controllers.clear();sessions.clear();csrf=undefined}}
}
