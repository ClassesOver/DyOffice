import { officeSignatureNotice } from './office-signature-notice'
import {mountDocumentHandoff} from './document-handoff'
import './zod-csp'
import {reportDocumentOpenError,reportDocumentLoading,registerDisplayedRevision} from './document-loading-state'
import {DocumentNotifications} from './document-notifications'
import {createEditorCloseLifecycle,installEditorCloseLifecycle} from './editor-close-lifecycle'
import {createAnalysisDocumentTarget} from '../../../../packages/browser-host/src/analysis-document-target.ts'
import ReactDOM from 'react-dom/client'
import {useEffect,useRef,useState} from 'react'
import {createSessionFileHost, type SessionFileHost} from '../../../../packages/browser-host/src/files.ts'
import {createSheetsBridge} from './sheets-bridge.ts'
import {messages} from './messages.ts'
import {mountEditorRealtime} from './editor-realtime.ts'
import type {SheetsEditorHandle,SheetsEditorHost} from '../../../sheets/src/renderer/App'
import {App} from '../../../sheets/src/renderer/App'
import {DownloadCsvIcon,SaveAsIcon} from '../../../sheets/src/renderer/ribbon-icons'
import {LocaleProvider,setModuleLang} from '../../../sheets/src/renderer/i18n/locale'
import {installCanvasFontFallback,registerTextDingbatsFace,untilCellFontsLoaded} from '../../../sheets/src/renderer/cell-font-fallback'
import type {DesktopApi} from '../../../sheets/src/shared/desktop-api'
import {WORKBOOK_TOOLS} from '../../../sheets/src/renderer/ai/tools'
import {installScreenTips,applyAiPanelPrefs,useDismissablePopover} from '@genoffice/ui'
import '@genoffice/ui/tokens.css'
import '@genoffice/ui/screentip.css'
import '@genoffice/ui/ai-model-picker.css'
import '@genoffice/ui/ai-queue-strip.css'
import '@genoffice/ui/ai-usage.css'
import '@genoffice/ui/ai-skills.css'
import '@genoffice/ui/color-picker.css'
import '@genoffice/ui/dropdown.css'
import '@genoffice/ui/ribbon-collapse.css'
import '@genoffice/ui/markdown.css'
import '@genoffice/ui/ai-panel-prefs.css'
import '@genoffice/ui/ai-scope-quote.css'
import '@univerjs/preset-sheets-core/lib/index.css'
import '../../../sheets/src/renderer/styles.css'

import './sheets.css'
import './ribbon-file-button.css'
import './ai-dock-theme.css'
import {loadEditorAssistant,editorAssistantNotice} from './editor-assistant-status'
import {createWorkbookImageApi} from './web-ai-media-api'
import {createWebWorkbookDocumentApi,downloadWebCsv} from './web-ai-document-api'
import {confirmWebFileName,suggestWebFileName} from './web-ai-naming'

export async function mountSheetsEditor(host: SessionFileHost, container: HTMLElement, fileId: string) {
  container.textContent = messages.zh.opening
  let changed = () => {}, editor: SheetsEditorHandle | null = null, disposed = false, closing=false
  let downloading = false, exportingCsv = false, takingOver = false, confirming = false, actionError = ''
  let handoffOpen=false,documentLoaded=false
  const continuationRevision = () => {
    if (!documentLoaded || disposed || closing || takingOver || !editor || dirty() || bridge.needsConfirmation()) return
    const state = host.getState(fileId), sessionId = editor.getWorkbookSessionId()
    if (state.status === 'idle' && state.lease && sessionId && bridge.getWorkbookRevision(sessionId) === state.revision.revision) return state.revision.revision
  }
  const assistantResult = await loadEditorAssistant({fileId,editorId:host.getEditorId()!,generation:()=>1,continuationRevision},false,'xlsx',new Set([...WORKBOOK_TOOLS.map(tool=>tool.name),'read_attachment','merge_attached_workbooks']))
  const assistant = assistantResult.assistant
  const workbookImages = assistant && createWorkbookImageApi(assistant.mediaApi)
  const opened = await host.open(fileId)
  const signed=opened.officeSignatureProtected===true
  if (opened.format !== 'xlsx') throw new Error(messages.zh.failed)
  const prefs = await host.getPreferences(), locale = prefs.language === 'en' ? 'en' : 'zh', text = messages[locale]
  const exportCsvLabel = locale === 'en' ? 'Export active sheet as CSV' : '导出当前工作表为 CSV'
  setModuleLang(locale); document.documentElement.lang = locale
  if (prefs.theme === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = prefs.theme
  let naming = false, copying = false, copyNotice = ''
  const copyLifetime = new AbortController()
  const bridge = createSheetsBridge(host,fileId,prefs,{docxCreationAvailable:opened.capabilities?.docx==='editable',onChange:()=>changed(),getAttachmentFile:path=>assistant?.api.getAttachmentFile(path)??Promise.resolve(null)})
  const documentApi=createWebWorkbookDocumentApi(bridge.api,async input=>downloadWebCsv(input),{language:locale})
  const assistantNotice = editorAssistantNotice(assistantResult,prefs.showAssistant,locale)
  const assistantAvailable = Boolean(assistant?.available && prefs.showAssistant !== false)
  const panelPrefs = {...await bridge.api.getAiPanelPrefs(), showAiSidebar: assistantAvailable}
  Object.defineProperty(window,'desktopApi',{value:{...documentApi,...assistant?.api,...(workbookImages?{generateImage:workbookImages.generateImage,fetchImage:workbookImages.fetchImage}:{}),getAiPanelPrefs:async()=>panelPrefs} as unknown as DesktopApi,configurable:true})
  applyAiPanelPrefs(panelPrefs); installScreenTips(); installCanvasFontFallback()
  const loads: Promise<unknown>[] = [registerTextDingbatsFace()]
  for (const variant of ['', 'bold ', 'italic ', 'italic bold ']) for (const family of ['Calibri','Aptos',"'Aptos Narrow'",'Carlito']) loads.push(document.fonts.load(`${variant}16px ${family}`).catch(()=>{}))
  await untilCellFontsLoaded(Promise.all(loads))
  let initialLease = !signed
  if(!signed)try { await host.acquireLease(fileId) } catch { initialLease = false }
  const stop = host.startRenewal(fileId), unsubscribe = host.subscribe(()=>changed())
  const realtime = mountEditorRealtime(host, fileId, () => changed(),channels=>assistant?.channel?.observe(channels))
  const analysisTarget=createAnalysisDocumentTarget({fileId,format:'xlsx',state:()=>host.getState(fileId),verifyAuthority:async()=>{await host.renewLease(fileId)},
    editor:()=>editor?.analysis??null,receipt:()=>bridge.getReceipt(),
    save:check=>bridge.guardedSave(check,async()=>!!editor&&await editor.saveAndWait()&&!editor.isDirty()&&!bridge.needsConfirmation())})
  const unregisterAnalysis=assistant?.documents.register(analysisTarget)
  const dirty = () => (editor?.isDirty() ?? false) || bridge.isDirty()
  const harnessRecovery = assistant?.coding && assistant.fileChat ? {
    coding:assistant.coding, fileChat:assistant.fileChat, continuationRevision,
    hasModel:(modelId:string)=>assistant.catalog.entries.some(entry=>entry.id===modelId),
  } : undefined
  const closeHandoff=mountDocumentHandoff({fileId,format:'xlsx',assistant:()=>assistant??null,prepare:()=>editor!.prepareHandoff(),
    activate:()=>{handoffOpen=true;changed()},ready:()=>documentLoaded&&!disposed&&!closing&&!!editor&&!!host.getState(fileId).lease&&!takingOver&&!['unauthorized','conflict','unknown'].includes(host.getState(fileId).status),
    clean:()=>!dirty()&&!bridge.isDirty(),revision:()=>host.getState(fileId).revision.revision,
    save:check=>bridge.guardedSave(check,async()=>!!editor&&await editor.saveAndWait()&&!editor.isDirty()&&!bridge.needsConfirmation()),
  })
  async function saveAndDownload() {
    if(!editor || downloading || takingOver || disposed)return
    downloading=true;actionError='';changed()
    try {
      const receipt=await bridge.prepareDownload(editor)
      if(disposed)return
      // Pin the confirmed receipt once. The main action never uses a render's
      // old head or a fallback link while there are unsaved/unknown changes.
      const anchor=document.createElement('a')
      anchor.href=`/api/v1/files/${fileId}/content?revision=${receipt.revision}&download=1`
      anchor.download=host.getState(fileId).name
      anchor.hidden=true;container.append(anchor);anchor.click();anchor.remove()
    } catch {if(!disposed)actionError=text.saveFailed}
    finally {downloading=false;if(!disposed)changed()}
  }
  async function exportCsv() {
    if (!editor || exportingCsv || downloading || takingOver || disposed) return
    exportingCsv=true;changed()
    try { await editor.exportCsv() }
    finally { exportingCsv=false;if(!disposed)changed() }
  }
  async function takeOver() {
    if(!editor || downloading || takingOver || disposed)return
    if(dirty()){actionError=text.takeoverDirty;changed();return}
    takingOver=true;actionError='';changed()
    try {await bridge.takeover(editor);initialLease=true}
    catch {if(!disposed)actionError=dirty()?text.takeoverDirty:text.takeoverFailed}
    finally {takingOver=false;if(!disposed)changed()}
  }
  async function confirmSave() {
    if(confirming || disposed)return
    confirming=true;actionError='';changed()
    try {await bridge.confirmSave()}
    catch {if(!disposed)actionError=text.saveFailed}
    finally {confirming=false;if(!disposed)changed()}
  }
  const canCopy = () => !disposed && !closing && !downloading && !takingOver && !confirming &&
    host.getState(fileId).status === 'idle' && !!host.getState(fileId).lease && !bridge.needsConfirmation()
  const namedCopy: SheetsEditorHost['namedCopy'] = assistant && assistantAvailable ? {
    async suggest(content) {
      const modelId = assistant.selected()
      if (!modelId || naming || copying || !canCopy()) return ''
      naming = true
      try { return await suggestWebFileName(content,{modelId,proof:assistant.sessionProof,format:'xlsx',locale,signal:copyLifetime.signal}) }
      finally { naming = false }
    },
    async save(stem,capture) {
      if (copying || !canCopy()) return
      const signal = copyLifetime.signal
      copying = true; changed()
      let upload: string | undefined, finishStarted = false
      try {
        const chosen = await confirmWebFileName(stem+'.xlsx',{locale,signal})
        const base = chosen?.trim().replace(/\.xlsx$/i,'').trim()
        if (!base || !canCopy()) return
        const name = base+'.xlsx'
        copyNotice = ''; actionError = ''; changed()
        const result = await capture(async (sessionId,phases) => {
          const blob = await bridge.exportDraftCopy(sessionId,phases,assistant.sessionProof,signal)
          const {uploadId} = await assistant.request<{uploadId:string}>('/api/v1/files/uploads','POST',{name,size:blob.size},signal)
          upload = '/api/v1/uploads/'+encodeURIComponent(uploadId)
          await assistant.request(upload+'/content','PUT',blob,signal)
          finishStarted = true
          await assistant.request(upload+'/finish','POST',undefined,signal)
        })
        if (!result.ok) throw new Error('Copy failed')
        copyNotice = locale==='zh'?`已保存副本：${name}`:`Saved copy: ${name}`
      } catch {
        if (upload && !finishStarted && !signal.aborted) await assistant.request(upload,'DELETE',undefined,signal).catch(()=>{})
        if (!signal.aborted) actionError = finishStarted
          ? (locale==='zh'?'无法确认副本是否已保存。请先在工作区核对，再决定是否重试。':'Could not confirm the copy. Check your workspace before retrying.')
          : (locale==='zh'?'无法导出完整的工作簿草稿。源文件和未保存更改仍保留。':'Could not export the complete workbook draft. The source and its unsaved changes are still intact.')
      } finally { copying = false; if(!disposed)changed() }
    },
  } : undefined
  function NativeWorkbook() {
    const [,tick] = useState(0), [loaded,setLoaded] = useState(false), [failed,setFailed] = useState(false)
    const [fileOpen,setFileOpen]=useState(false)
    const fileWrap=useRef<HTMLDivElement>(null),fileButton=useRef<HTMLButtonElement>(null)
    useDismissablePopover(fileOpen,()=>setFileOpen(false),{inside:()=>[fileWrap.current]})
    useEffect(()=>{if(loaded&&!failed)reportDocumentLoading('ready')},[loaded,failed])
    changed = () => {if(!closing)tick(value=>value+1)}
    const state = host.getState(fileId)
    const readOnly = failed || takingOver || !state.lease || state.status === 'conflict' || state.status === 'unknown' || bridge.needsConfirmation() || state.status === 'unauthorized'
    const status = failed ? text.failed : !loaded ? text.opening : (state.status === 'unknown' || bridge.needsConfirmation()) ? text.unknown : state.status === 'unauthorized' ? text.unauthorized : takingOver ? text.takingOver : !state.lease || state.status==='conflict' ? (dirty() ? text.takeoverDirty : initialLease ? text.conflict : text.readOnly) : downloading ? text.downloadSaving : actionError || (bridge.isDirty() ? '' : text.ready)
    const notice = realtime.notice(locale)
    const warning = failed || state.status === 'unknown' || bridge.needsConfirmation() || state.status === 'unauthorized' || (!signed && !state.lease && loaded && !takingOver) || state.status === 'conflict' ? status : actionError
    const historical = loaded && !failed && !state.lease && !dirty() && state.status !== 'unknown' && state.status !== 'unauthorized' && !bridge.needsConfirmation() && !takingOver
    const downloadDisabled=!loaded || failed || !editor || !state.lease || state.status === 'conflict' || state.status === 'unauthorized' || downloading || takingOver
    const csvDisabled=!loaded || failed || !editor || state.status === 'unauthorized' || downloading || exportingCsv || takingOver
    const fileLabel=locale==='zh'?'文件':'File'
    const fileMenu=<div ref={fileWrap} className="file-tab-wrap" onKeyDown={event=>{
      if(event.key!=='Escape'||!fileOpen)return
      event.stopPropagation();setFileOpen(false);fileButton.current?.focus()
    }}>
      <button ref={fileButton} type="button" className="ribbon-tab-file" aria-expanded={fileOpen} onClick={()=>setFileOpen(value=>!value)}>{fileLabel}</button>
      {fileOpen&&<div className="file-menu" role="group" aria-label={fileLabel}>
        <button type="button" disabled={downloadDisabled} title={text.saveDownloadVersionHint} onClick={()=>{setFileOpen(false);fileButton.current?.focus();void saveAndDownload()}}>{text.saveDownload}</button>
        <button type="button" disabled={csvDisabled} onClick={()=>{setFileOpen(false);fileButton.current?.focus();void exportCsv()}}>{exportCsvLabel}</button>
        {signed&&historical&&<a href={`/api/v1/files/${fileId}/content?revision=${state.revision.revision}&download=1`} download={state.name}>{text.download}</a>}
      </div>}
    </div>
    const saveDownload = <><button type="button" className="dyoffice-sheets-download qa-btn" aria-label={text.saveDownload} data-tip={text.saveDownload}
      title={text.saveDownloadVersionHint} disabled={downloadDisabled}
      onClick={() => { void saveAndDownload() }}><SaveAsIcon /></button>
      <button type="button" className="qa-btn" aria-label={exportCsvLabel} data-tip={exportCsvLabel}
        disabled={csvDisabled}
        onClick={()=>{void exportCsv()}}><DownloadCsvIcon /></button></>
    return <div className="dyoffice-native-sheets">
      <DocumentNotifications locale={locale} items={[
        ...(signed ? [{id:'office-signature',level:'info' as const,...officeSignatureNotice[locale]}] : []),
        ...(assistantNotice ? [{id:'assistant',level:prefs.showAssistant === false ? 'info' as const : 'warning' as const,title:locale === 'zh' ? 'AI 助手' : 'AI Assistant',message:assistantNotice}] : []),
        ...(warning ? [{id:'document-state',level:'error' as const,title:locale === 'zh' ? '文档需要处理' : 'Document needs attention',message:warning,actions:<>{!signed && !state.lease && !failed && state.status!=='unauthorized' && <button disabled={!loaded || !editor || downloading || takingOver || dirty() || state.status==='unknown' || bridge.needsConfirmation()} onClick={()=>{void takeOver()}}>{text.takeover}</button>}{historical && <a href={`/api/v1/files/${fileId}/content?revision=${state.revision.revision}&download=1`} download={state.name}>{text.downloadReadOnly}</a>}{bridge.needsConfirmation() && <button data-save-fence-allow="confirm" disabled={confirming} onClick={()=>{void confirmSave()}}>{text.retry}</button>}</>}] : []),
        ...(notice ? [{id:'version',level:'info' as const,title:locale === 'zh' ? '版本同步' : 'Version updates',message:notice}] : []),
        ...(copyNotice ? [{id:'named-copy',level:'info' as const,title:locale==='zh'?'副本已保存':'Copy saved',message:copyNotice}] : []),
      ]} />
      <App queuedWorkbookAtBoot host={{readOnly,saveDownload,fileMenu,getSupportedCreateDocumentTypes:()=>bridge.supportedCreateDocumentTypes,...(workbookImages?{setImageAttachments:workbookImages.setImageAttachments}:{}),supportedMergeExtensions:bridge.supportedMergeExtensions,namedCopy:loaded&&!copying&&canCopy()?namedCopy:undefined,inPlaceSave:true,workspaceLinks:bridge.workspaceLinks,assistantAvailable:assistantAvailable||!!(handoffOpen&&assistant?.available),...(assistant?{assistant}:{}),...(harnessRecovery?{harnessRecovery}:{}),onWorkbookOpened:()=>{documentLoaded=true;setLoaded(true)},onOpenFailed:()=>{documentLoaded=false;setFailed(true);reportDocumentLoading('error')},onEditorReady:handle=>{editor=handle}}} />
    </div>
  }
  reportDocumentLoading('rendering')
  const root = ReactDOM.createRoot(container)
  root.render(<LocaleProvider initial={locale}><NativeWorkbook /></LocaleProvider>)
  const closeState=()=>({dirty:dirty(),blocked:copying||downloading||takingOver||confirming||bridge.needsConfirmation()||['unknown','saving'].includes(host.getState(fileId).status)})
  registerDisplayedRevision(()=>{
    const state=closeState(),current=host.getState(fileId)
    const revision=current.revision.revision,session=editor?.getWorkbookSessionId()
    return documentLoaded&&!state.dirty&&!state.blocked&&current.status!=='unauthorized'&&session&&bridge.getWorkbookRevision(session)===revision?revision:undefined
  })
  const beforeUnload = (event: BeforeUnloadEvent) => { if (closeState().dirty||closeState().blocked) { event.preventDefault(); event.returnValue='' } }
  window.addEventListener('beforeunload',beforeUnload)
  const cleanup=()=>{if(disposed)return;closeHandoff();unregisterAnalysis?.();analysisTarget.dispose();disposed=true;copyLifetime.abort();workbookImages?.dispose();assistant?.dispose();realtime.dispose();changed=()=>{};window.removeEventListener('beforeunload',beforeUnload);stop();unsubscribe();root.unmount();bridge.dispose()}
  const lifecycle=createEditorCloseLifecycle({state:closeState,save:()=>editor?.saveAndWait()??Promise.resolve(false),release:()=>host.releaseLease(fileId),cleanup,setClosing:value=>{closing=value;container.inert=value;if(!value)changed()},confirm:()=>window.confirm('工作簿有未保存的更改，是否保存后关闭？取消将保留当前页签。'),notify:()=>window.alert('保存仍在进行或结果待确认，请先在工作簿中核对后再关闭。')})
  return {save:()=>editor?.saveAndWait()??Promise.resolve(false),canClose:lifecycle.canClose,dispose:lifecycle.dispose,unload(){void host.releaseLease(fileId,true).catch(()=>{});cleanup()}}
}
async function bootstrap() {
  const params=new URLSearchParams(location.search),fileId=params.get('fileId')??''
  const host=createSessionFileHost({expectedRevision:params.get('sourceRevision')??undefined})
  installEditorCloseLifecycle(window,{canClose:async()=>false,dispose:async()=>false})
  try {
    const mounted=await mountSheetsEditor(host,document.getElementById('root')!,fileId)
    installEditorCloseLifecycle(window,{canClose:mounted.canClose,dispose:async()=>{const closed=await mounted.dispose();if(closed)host.dispose();return closed}})
    window.addEventListener('pagehide',()=>{mounted.unload();host.dispose()},{once:true})
  } catch(error){await host.releaseLease(fileId).catch(()=>{});host.dispose();installEditorCloseLifecycle(window,{canClose:async()=>true,dispose:async()=>true});throw error}
}
void bootstrap().catch(error=>{reportDocumentOpenError(error);document.getElementById('root')!.textContent=messages.zh.failed})
