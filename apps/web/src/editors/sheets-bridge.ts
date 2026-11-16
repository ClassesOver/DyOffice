import type {SessionFileHost} from '../../../../packages/browser-host/src/files.ts'
import {hostError} from '../../../../packages/web-contracts/src/errors.ts'
import {messages} from './messages.ts'
import {
  workbookMediaRequestSchema,workbookMediaResultSchema,
  workbookFileSchema, workbookRangeRequestSchema, workbookRangeResultSchema,
  workbookFormulaCellsRequestSchema, workbookFormulaCellsResultSchema, workbookRowOutlineResultSchema,
  workbookRedactionsResultSchema, workbookSlicerStateResultSchema, workbookQueriesResultSchema,
  workbookRecalcRequestSchema,workbookRecalcResultSchema,
  workbookConnectionsResultSchema, workbookSaveRequestSchema,
  type DesktopApi, type WorkbookFile,
} from '../../../sheets/src/shared/desktop-api'

type Preferences = Awaited<ReturnType<SessionFileHost['getPreferences']>>
type SaveResult = {canceled: false; file: WorkbookFile; touchedEntries: string[]}
type Recovery = {saved?: Awaited<ReturnType<SessionFileHost['saveSheets']>>; resolve(value: SaveResult): void; reject(error: unknown): void}
type Session = {revision: string; file: WorkbookFile; extras?: Promise<Record<string,unknown>>}
export function createSheetsBridge(host: SessionFileHost, fileId: string, prefs: Preferences, {fetchImpl = fetch, onChange = () => {}}: {fetchImpl?: typeof fetch; onChange?: () => void} = {}) {
  const sessions = new Map<string,Session>(), controllers = new Set<AbortController>()
  const text = messages[prefs.language === 'en' ? 'en' : 'zh']
  let recovery: Recovery | null = null, confirming = false
  let inFlight = 0
  const waiting: (() => void)[] = []
  let csrf: string | undefined, disposed = false, queued = true, pendingEdits = 0
  const noEvent = () => () => {}
  const unavailable = async (): Promise<never> => { throw new Error(text.unavailable) }
  const session = (id: string) => { const current = sessions.get(id); if (disposed || !current) throw hostError('INVALID_REVISION','workbook session'); return current }
  async function request(revision: string, method: string, input: object = {}) {
    if (disposed) throw hostError('UNAVAILABLE','disposed')
    const controller = new AbortController(); controllers.add(controller)
    try {
      if (!csrf) {
        const response = await fetchImpl('/api/v1/auth/csrf',{credentials:'same-origin',cache:'no-store',signal:controller.signal})
        if (!response.ok) throw hostError('UNAUTHORIZED','session')
        const body = await response.json()
        if (typeof body?.csrfToken !== 'string') throw hostError('INVALID_RESPONSE','csrf')
        csrf = body.csrfToken
      }
      const response = await fetchImpl(`/api/v1/files/${fileId}/sheets/${method}`,{method:'POST',credentials:'same-origin',cache:'no-store',signal:controller.signal,headers:{'content-type':'application/json','x-csrf-token':csrf!},body:JSON.stringify({revision,...input})})
      if (!response.ok) throw hostError(response.status === 401 || response.status === 403 ? 'UNAUTHORIZED' : response.status === 409 ? 'CONFLICT' : 'UNAVAILABLE','workbook read')
      if (!response.headers.get('content-type')?.includes('application/json')) throw hostError('INVALID_RESPONSE','workbook read')
      return await response.json()
    } finally { controllers.delete(controller) }
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
  const api = {
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
    async closeWorkbook(id: string){sessions.delete(id)},
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
    async readWorkbookRange(input){const request=workbookRangeRequestSchema.parse(input),current=session(request.sessionId);return workbookRangeResultSchema.parse(await call(current.revision,'range',{sheetName:sheet(current,request.sheetId),range:request.range}))},
    async readWorkbookFormulas(input){const request=workbookFormulaCellsRequestSchema.parse(input),current=session(request.sessionId);return workbookFormulaCellsResultSchema.parse(await call(current.revision,'sheet',{sheetName:sheet(current,request.sheetId),kind:'formulas'}))},
    async readWorkbookRowOutline(input){const request=workbookFormulaCellsRequestSchema.parse(input),current=session(request.sessionId);return workbookRowOutlineResultSchema.parse(await call(current.revision,'sheet',{sheetName:sheet(current,request.sheetId),kind:'outline'}))},
    async readWorkbookRedactions({sessionId}){return workbookRedactionsResultSchema.parse((await extras(sessionId)).redactions)},
    async readSlicerState({sessionId}){return workbookSlicerStateResultSchema.parse((await extras(sessionId)).slicers)},
    async listWorkbookConnections({sessionId}){return workbookConnectionsResultSchema.parse((await extras(sessionId)).connections)},
    async readWorkbookQueries({sessionId}){return workbookQueriesResultSchema.parse((await extras(sessionId)).queries)},
    async saveWorkbookEdits(input){
      const request=workbookSaveRequestSchema.parse(input),current=session(request.sessionId)
      if (host.getState(fileId).revision.revision!==current.revision) throw hostError('CONFLICT','workbook base')
      let saved: Awaited<ReturnType<SessionFileHost['saveSheets']>> | undefined
      try {
        saved=await host.saveSheets(fileId,request)
        return {canceled:false as const,file:await open(),touchedEntries:saved.touchedEntries}
      } catch(error) {
        if (!saved && host.getState(fileId).status !== 'unknown') throw error
        // Keep save-actions' original Promise, journal snapshot and view alive.
        // Confirmation resumes that exact save, including its late-edit carry.
        return new Promise<SaveResult>((resolve,reject)=>{recovery={...(saved ? {saved} : {}),resolve,reject};onChange()})
      }
    },
    selectWorkbooksForMerge:unavailable,openWorkbooksForMerge:unavailable,openEncryptedWorkbook:unavailable,reopenWorkbook:unavailable,
    listExternalLinks:unavailable,refreshWorkbookConnection:unavailable,readLocalImage:unavailable,
    writeWorkbookRecovery:unavailable,exportPdf:unavailable,printWorkbook:unavailable,exportCsv:unavailable,
    openAiModelSettings:unavailable,openSkillsSettings:unavailable,
  } satisfies Partial<DesktopApi>
  async function confirmSave() {
    const pending=recovery
    if (!pending || confirming) return
    confirming=true
    try {
      pending.saved ??= await host.reconcileSheets(fileId)
      const file=await open()
      recovery=null
      pending.resolve({canceled:false,file,touchedEntries:pending.saved.touchedEntries})
    } catch(error) {
      if (!pending.saved && host.getState(fileId).status !== 'unknown') {recovery=null;pending.reject(error)}
      throw error
    } finally {confirming=false;onChange()}
  }
  return {api,confirmSave,needsConfirmation:()=>recovery!==null,isDirty:()=>pendingEdits>0,dispose(){disposed=true;recovery?.reject(hostError('UNAVAILABLE','disposed'));recovery=null;for(const controller of controllers)controller.abort();controllers.clear();sessions.clear();csrf=undefined}}
}
