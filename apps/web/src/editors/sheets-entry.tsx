import {takeOfficeImportUnlock,workspaceOpenAction} from './browser-document-command'
import {applyBrowserEditorTheme} from './browser-editor-theme'
import {installBrowserAssistantPreferences} from './browser-assistant-appearance'
import { officeSignatureNotice } from './office-signature-notice'
import {createDraftCopyAuthority,draftCopyParentActive} from './draft-copy-authority'
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
import {EncryptedWorkbookPasswordDialog} from '../../../sheets/src/renderer/EncryptedWorkbookPasswordDialog'
import {DownloadCsvIcon,SaveAsIcon} from '../../../sheets/src/renderer/ribbon-icons'
import {LocaleProvider,setModuleLang,tFor} from '../../../sheets/src/renderer/i18n/locale'
import {installCanvasFontFallback,registerTextDingbatsFace,untilCellFontsLoaded} from '../../../sheets/src/renderer/cell-font-fallback'
import type {DesktopApi} from '../../../sheets/src/shared/desktop-api'
import {WORKBOOK_TOOLS} from '../../../sheets/src/renderer/ai/tools'
import {installScreenTips,useDismissablePopover} from '@genoffice/ui'
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
import {createWebAiMediaApi,createWorkbookImageApi} from './web-ai-media-api'
import {fetchClipboardImage} from './docs-image-clipboard'
import {decodeBrowserBase64} from './browser-download'
import {confirmWebCsvSave,createWebWorkbookDocumentApi,downloadWebCsv} from './web-ai-document-api'
import {confirmWorkspaceCopy,suggestWebFileName} from './web-ai-naming'

export async function mountSheetsEditor(host: SessionFileHost, container: HTMLElement, fileId: string) {
  const openWorkspaceFile = workspaceOpenAction()
  container.textContent = messages.zh.opening
  let changed = () => {}, editor: SheetsEditorHandle | null = null, disposed = false, closing=false
  let downloading = false, exportingCsv = false, takingOver = false, unlocking = false, confirming = false, actionError = ''
  let documentLoaded=false
  const continuationRevision = () => {
    if (!documentLoaded || disposed || closing || takingOver || !editor || dirty() || bridge.needsConfirmation()) return
    const state = host.getState(fileId), sessionId = editor.getWorkbookSessionId()
    if (state.status === 'idle' && state.lease && sessionId && bridge.getWorkbookRevision(sessionId) === state.revision.revision) return state.revision.revision
  }
  const params=new URLSearchParams(location.search)
  const guest=params.get('guest')==='1'
  const opened = await host.open(fileId)
  const isCsv=opened.format==='csv', isXlsm=opened.format==='xlsm'
  const copyExtension=isXlsm?'.xlsm':'.xlsx'
  if (opened.format !== 'xlsx' && !isCsv && !isXlsm) throw new Error(messages.zh.failed)
  const signed=opened.officeSignatureProtected===true, passwordProtected=opened.workbookPasswordProtected===true
  const lockedToViewing=signed
  const copyAuthority=guest?undefined:await createDraftCopyAuthority(()=>draftCopyParentActive(window))
  const assistantResult = guest||passwordProtected?{assistant:undefined,failure:undefined}:await loadEditorAssistant({fileId,editorId:host.getEditorId()!,generation:()=>1,continuationRevision},false,'xlsx',new Set([...WORKBOOK_TOOLS.map(tool=>tool.name),'read_attachment','merge_attached_workbooks']))
  const assistant = assistantResult.assistant
  const workbookImages = assistant && createWorkbookImageApi(assistant.mediaApi)
  const prefs = await host.getPreferences(), locale = prefs.language === 'en' ? 'en' : 'zh', text = messages[locale]
  const exportCsvLabel = locale === 'en' ? 'Export active sheet as CSV' : '导出当前工作表为 CSV'
  setModuleLang(locale); document.documentElement.lang = locale
  applyBrowserEditorTheme(document.documentElement, prefs)
  let naming = false, copying = false, copyNotice = ''
  const copyLifetime = new AbortController()
  const clipboardMedia=copyAuthority?.request&&!isCsv?createWebAiMediaApi(copyAuthority.request):undefined
  const fetchClipboardPicture=clipboardMedia?async(source:string)=>{
    const editable=()=>!disposed&&!closing&&copyAuthority?.current()&&!!host.getState(fileId).lease
    if(!editable())return null
    const picture=await fetchClipboardImage(source,clipboardMedia.fetchImage,copyLifetime.signal)
    if(!editable())return null
    const ext=picture.mime==='image/jpeg'?'jpg':picture.mime==='image/gif'?'gif':'png'
    return new File([decodeBrowserBase64(picture.base64)],`Clipboard picture.${ext}`,{type:picture.mime})
  }:undefined
  const bridge = createSheetsBridge(host,fileId,prefs,{
    isCsv,confirmCsvSave:()=>confirmWebCsvSave(locale,!!copyAuthority?.current() && canCopy()),
    getExportLayout:name=>{if(!editor)throw new Error(text.unavailable);return editor.getExportLayout(name)},
    docxCreationAvailable:opened.capabilities?.docx==='editable',onChange:()=>changed(),
    getAttachmentFile:path=>assistant?.api.getAttachmentFile(path)??Promise.resolve(null),
    ...(!params.has('sourceRevision')&&copyAuthority?.request&&copyAuthority.proof?{workspaceSources:{
      request:copyAuthority.request,proof:copyAuthority.proof,verify:()=>copyAuthority.verify(),
      readBytes:(id,revision)=>host.readBytes(id,revision),
    }}:{}),
  })
  const revision=host.getState(fileId).revision.revision
  const importUnlock=passwordProtected&&!guest?takeOfficeImportUnlock(revision):undefined
  const initiallyUnlocked=!passwordProtected||!!importUnlock&&await bridge.adoptWorkbookImportUnlock(revision,importUnlock)
  const documentApi=createWebWorkbookDocumentApi(bridge.api,async input=>downloadWebCsv(input),{language:locale})
  const assistantNotice = guest||passwordProtected?'':editorAssistantNotice(assistantResult,locale)
  const assistantAvailable = Boolean(assistant?.available)
  const panelPrefs = {...await bridge.api.getAiPanelPrefs(), showAiSidebar: assistantAvailable}
  const appearance=await installBrowserAssistantPreferences(prefs,panelPrefs)
  Object.defineProperty(window,'desktopApi',{value:{...documentApi,...assistant?.api,...(workbookImages?{generateImage:workbookImages.generateImage,fetchImage:workbookImages.fetchImage}:{}),getAiPanelPrefs:async()=>appearance.withAppearance(),
    setAiPanelPrefs:async(patch:Parameters<DesktopApi['setAiPanelPrefs']>[0])=>
      patch.side ? appearance.movePanel(patch.side,assistant?.sessionProof) : appearance.updatePanelPrefs(patch)} as unknown as DesktopApi,configurable:true})
  installScreenTips(); installCanvasFontFallback()
  const loads: Promise<unknown>[] = [registerTextDingbatsFace()]
  for (const variant of ['', 'bold ', 'italic ', 'italic bold ']) for (const family of ['Calibri','Aptos',"'Aptos Narrow'",'Carlito']) loads.push(document.fonts.load(`${variant}16px ${family}`).catch(()=>{}))
  await untilCellFontsLoaded(Promise.all(loads))
  let initialLease = !lockedToViewing&&initiallyUnlocked
  if(initialLease)try { await host.acquireLease(fileId) } catch { initialLease = false }
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
    ready:()=>documentLoaded&&!disposed&&!closing&&!!editor&&!!host.getState(fileId).lease&&!takingOver&&!['unauthorized','conflict','unknown'].includes(host.getState(fileId).status),
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
  const canCopy = () => documentLoaded && !signed && !!copyAuthority?.current() && !disposed && !closing && !downloading && !takingOver && !confirming &&
    host.getState(fileId).status === 'idle' && !!host.getState(fileId).lease && !bridge.needsConfirmation()
  const request=copyAuthority?.request,proof=copyAuthority?.proof
  const workspaceCopy: SheetsEditorHost['workspaceCopy'] = request && proof ? {
    ...(!passwordProtected && assistant && assistantAvailable ? {async suggest(content: string) {
      const modelId = assistant.selected()
      if (!modelId || naming || copying || !canCopy()) return ''
      naming = true
      try { return await suggestWebFileName(content,{modelId,proof:assistant.sessionProof,format:'xlsx',locale,signal:copyLifetime.signal}) }
      finally { naming = false }
    }} : {}),
    async save(stem,capture,captureCsv) {
      if (copying || !canCopy()) return
      const signal = copyLifetime.signal
      copying = true; changed()
      let upload: string | undefined, finishStarted = false
      const uploadBlob = async (name:string,blob:Blob,folderId?:string) => {
        if (!canCopy()) throw Error('Draft session ended')
        const {uploadId} = await request<{uploadId:string}>('/api/v1/files/uploads','POST',{name,size:blob.size,folderId},signal)
        upload = '/api/v1/uploads/'+encodeURIComponent(uploadId)
        if (!canCopy()) throw Error('Draft session ended')
        await request(upload+'/content','PUT',blob,signal)
      }
      const finishCopy = async () => {
        if (!upload || !canCopy()) throw Error('Draft session ended')
        finishStarted = true
        await request(upload+'/finish','POST',undefined,signal)
      }
      try {
        if (!await copyAuthority?.verify() || !canCopy()) throw Error('Draft session ended')
        const csv = !isXlsm && captureCsv && (await request<Record<string,string>>('/api/v1/capabilities','GET',undefined,signal)).csvImport==='editable'
          ? captureCsv : undefined
        if (!canCopy()) return
        const csvNotice = locale === 'en'
          ? 'CSV saves the current sheet as displayed values. Formulas, formatting, and other sheets are omitted.'+(passwordProtected?' The CSV copy is unencrypted.':'')
          : 'CSV 只保存当前工作表的显示值。公式、格式和其他工作表会丢失。'+(passwordProtected?' CSV 副本未加密。':'')
        const chosen = await confirmWorkspaceCopy(stem+copyExtension,{locale,signal,request,fileId,...(csv?{csvNotice}:{})})
        if (!chosen || !canCopy()) return
        const csvCopy = csv && /\.csv$/i.test(chosen.name) ? csv : undefined
        const base = chosen.name.replace(csvCopy?/\.csv$/i:/\.(xlsx|xlsm)$/i,'').trim()
        if (!base) return
        const name = base+(csvCopy?'.csv':copyExtension)
        copyNotice = ''; actionError = ''; changed()
        if (csvCopy) {
          const content = await csvCopy()
          if (content === null) return
          if (!await copyAuthority?.verify() || !canCopy()) throw Error('Draft session ended')
          await uploadBlob(name,new Blob(['\ufeff',content]),chosen.folderId)
          await finishCopy()
        } else {
          const result = await capture(async (sessionId,phases) => {
            if (!await copyAuthority?.verify() || !canCopy()) throw Error('Draft session ended')
            const draft = await bridge.prepareDraftCopy(sessionId,phases,name,proof,signal,chosen.folderId)
            if ('uploadId' in draft) {
              upload = '/api/v1/uploads/'+encodeURIComponent(draft.uploadId)
              draft.check()
            } else await uploadBlob(name,draft.blob,chosen.folderId)
            await finishCopy()
          })
          if (!result.ok) throw new Error('Copy failed')
        }
        copyNotice = locale==='zh'?`已保存副本：${name}`:`Saved copy: ${name}`
      } catch {
        if (upload && !finishStarted && !signal.aborted) await request(upload,'DELETE',undefined,signal).catch(()=>{})
        if (!signal.aborted) actionError = finishStarted
          ? (locale==='zh'?'无法确认副本是否已保存。请先在工作区核对，再决定是否重试。':'Could not confirm the copy. Check your workspace before retrying.')
          : (locale==='zh'?'无法导出完整的工作簿草稿。源文件和未保存更改仍保留。':'Could not export the complete workbook draft. The source and its unsaved changes are still intact.')
      } finally { copying = false; if(!disposed)changed() }
    },
  } : undefined
  function NativeWorkbook() {
    const [,tick] = useState(0), [loaded,setLoaded] = useState(false), [failed,setFailed] = useState(false)
    const [fileOpen,setFileOpen]=useState(false)
    const [unlocked,setUnlocked]=useState(initiallyUnlocked),[passwordPrompt,setPasswordPrompt]=useState(!initiallyUnlocked)
    const [unlockBusy,setUnlockBusy]=useState(false),[unlockError,setUnlockError]=useState<string|null>(null)
    const fileWrap=useRef<HTMLDivElement>(null),fileButton=useRef<HTMLButtonElement>(null)
    useDismissablePopover(fileOpen,()=>setFileOpen(false),{inside:()=>[fileWrap.current]})
    useEffect(()=>{if(loaded&&!failed)reportDocumentLoading('ready')},[loaded,failed])
    changed = () => {if(!closing)tick(value=>value+1)}
    const state = host.getState(fileId)
    const originalDownload=`/api/v1/files/${fileId}/content?revision=${state.revision.revision}&download=1`
    if(!unlocked){
      const unlock=async(password:string)=>{
        if(unlocking||closing)return
        unlocking=true;setUnlockBusy(true);setUnlockError(null)
        try{
          await bridge.unlockWorkbook(password)
          if(!lockedToViewing&&!disposed){
            try{await host.acquireLease(fileId);initialLease=true}catch{initialLease=false}
          }
          if(!disposed){reportDocumentLoading('rendering');setUnlocked(true)}
        }
        catch(error){if(!disposed)setUnlockError(error instanceof Error?error.message:text.unavailable)}
        finally{unlocking=false;if(!disposed)setUnlockBusy(false)}
      }
      return <div className="dyoffice-native-sheets">
        <DocumentNotifications locale={locale} items={[{id:'workbook-locked',level:'warning',title:locale==='en'?'Password-protected workbook':'受密码保护的工作簿',message:locale==='en'?'Unlock the workbook to view its sheets.':'解锁后可查看工作表。',actions:<>
          <button type="button" onClick={()=>{setUnlockError(null);setPasswordPrompt(true)}}>{locale==='en'?'Unlock workbook':'解锁工作簿'}</button>
          <a href={originalDownload} download={state.name}>{text.downloadReadOnly}</a>
        </>}]} />
        {passwordPrompt&&<EncryptedWorkbookPasswordDialog error={unlockError} busy={unlockBusy} maxLength={255} onSubmit={password=>{void unlock(password)}} onClose={()=>{if(!unlocking)setPasswordPrompt(false)}} />}
      </div>
    }
    const readOnly = lockedToViewing || failed || takingOver || !state.lease || state.status === 'conflict' || state.status === 'unknown' || bridge.needsConfirmation() || state.status === 'unauthorized'
    const status = failed ? text.failed : !loaded ? text.opening : (state.status === 'unknown' || bridge.needsConfirmation()) ? text.unknown : state.status === 'unauthorized' ? text.unauthorized : takingOver ? text.takingOver : !state.lease || state.status==='conflict' ? (dirty() ? text.takeoverDirty : initialLease ? text.conflict : text.readOnly) : downloading ? text.downloadSaving : actionError || (bridge.isDirty() ? '' : text.ready)
    const notice = realtime.notice(locale)
    const warning = failed || state.status === 'unknown' || bridge.needsConfirmation() || state.status === 'unauthorized' || (!lockedToViewing && !state.lease && loaded && !takingOver) || state.status === 'conflict' ? status : actionError
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
        {openWorkspaceFile&&<button type="button" onClick={()=>{
          setFileOpen(false)
          fileButton.current?.focus()
          openWorkspaceFile()
        }}>{locale==='zh'?'打开…':'Open…'}</button>}
        <button type="button" disabled={downloadDisabled} title={text.saveDownloadVersionHint} onClick={()=>{setFileOpen(false);fileButton.current?.focus();void saveAndDownload()}}>{text.saveDownload}</button>
        <button type="button" disabled={!loaded || !editor || !workspaceCopy || readOnly || copying || !canCopy()} onClick={() => {
          setFileOpen(false)
          fileButton.current?.focus()
          editor?.saveAsCopy()
        }}>{tFor(locale,'appSaveAs')}</button>
        <button type="button" disabled={!loaded || failed || !editor || state.status === 'unauthorized'} onClick={() => {
          setFileOpen(false)
          fileButton.current?.focus()
          editor?.openPrintPreview()
        }}>{tFor(locale,'dlgPrintButton')}</button>
        <button type="button" disabled={csvDisabled} onClick={()=>{setFileOpen(false);fileButton.current?.focus();void exportCsv()}}>{exportCsvLabel}</button>
        {workspaceCopy?.suggest&&<button type="button" disabled={!loaded||!canCopy()||readOnly||copying} onClick={()=>{setFileOpen(false);void editor?.nameWithAi()}}>{locale==='zh'?'用 AI 命名副本…':'Name a copy with AI…'}</button>}
        {lockedToViewing&&historical&&<a href={originalDownload} download={state.name}>{text.download}</a>}
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
        ...(passwordProtected ? [{id:'workbook-unlocked',level:'info' as const,title:locale==='en'?'Workbook unlocked':'工作簿已解锁',message:locale==='en'?'Saved revisions keep password protection.':'保存的版本会继续受密码保护。'}] : []),
        ...(assistantNotice ? [{id:'assistant',level:'warning' as const,title:locale === 'zh' ? 'AI 助手' : 'AI Assistant',message:assistantNotice}] : []),
        ...(warning ? [{id:'document-state',level:'error' as const,title:locale === 'zh' ? '文档需要处理' : 'Document needs attention',message:warning,actions:<>{!lockedToViewing && !state.lease && !failed && state.status!=='unauthorized' && <button disabled={!loaded || !editor || downloading || takingOver || dirty() || state.status==='unknown' || bridge.needsConfirmation()} onClick={()=>{void takeOver()}}>{text.takeover}</button>}{historical && <a href={originalDownload} download={state.name}>{text.downloadReadOnly}</a>}{bridge.needsConfirmation() && <button data-save-fence-allow="confirm" disabled={confirming} onClick={()=>{void confirmSave()}}>{text.retry}</button>}</>}] : []),
        ...(notice ? [{id:'version',level:'info' as const,title:locale === 'zh' ? '版本同步' : 'Version updates',message:notice}] : []),
        ...(copyNotice ? [{id:'named-copy',level:'info' as const,title:locale==='zh'?'副本已保存':'Copy saved',message:copyNotice}] : []),
      ]} />
      <App queuedWorkbookAtBoot host={{readOnly,saveDownload,fileMenu,
        ...(fetchClipboardPicture?{fetchClipboardPicture}:{}),
        ...(passwordProtected?{workbookPasswordLimit:255}:{}),
        ...(passwordProtected&&bridge.needsConfirmation()?{confirmWorkbookPasswordSave:{label:text.retry,busy:confirming,...(actionError?{error:actionError}:{}),run:()=>{void confirmSave()}}}:{}),
        getSupportedCreateDocumentTypes:()=>bridge.supportedCreateDocumentTypes,...(workbookImages?{setImageAttachments:workbookImages.setImageAttachments}:{}),supportedMergeExtensions:bridge.supportedMergeExtensions,workspaceCopy:loaded&&!copying&&canCopy()?workspaceCopy:undefined,inPlaceSave:true,...(isCsv?{saveCsvContent:bridge.saveCsv}:{}),workspaceLinks:bridge.workspaceLinks,assistantAvailable,...(assistant?{assistant}:{}),...(harnessRecovery?{harnessRecovery}:{}),onWorkbookOpened:()=>{documentLoaded=true;setLoaded(true)},onOpenFailed:()=>{documentLoaded=false;setFailed(true);reportDocumentLoading('error')},onEditorReady:handle=>{editor=handle}}} />
    </div>
  }
  reportDocumentLoading(initiallyUnlocked?'rendering':'ready')
  const root = ReactDOM.createRoot(container)
  root.render(<LocaleProvider initial={locale}><NativeWorkbook /></LocaleProvider>)
  const closeState=()=>({dirty:dirty(),blocked:copying||downloading||takingOver||unlocking||confirming||bridge.needsConfirmation()||['unknown','saving'].includes(host.getState(fileId).status)})
  registerDisplayedRevision(()=>{
    const state=closeState(),current=host.getState(fileId)
    const revision=current.revision.revision,session=editor?.getWorkbookSessionId()
    return documentLoaded&&!state.dirty&&!state.blocked&&current.status!=='unauthorized'&&session&&bridge.getWorkbookRevision(session)===revision?revision:undefined
  })
  const beforeUnload = (event: BeforeUnloadEvent) => { if (closeState().dirty||closeState().blocked) { event.preventDefault(); event.returnValue='' } }
  window.addEventListener('beforeunload',beforeUnload)
  const cleanup=()=>{if(disposed)return;closeHandoff();unregisterAnalysis?.();analysisTarget.dispose();disposed=true;copyLifetime.abort();workbookImages?.dispose();assistant?.dispose();realtime.dispose();changed=()=>{};window.removeEventListener('beforeunload',beforeUnload);stop();unsubscribe();root.unmount();bridge.dispose()}
  const lifecycle=createEditorCloseLifecycle({state:closeState,waitForSave:()=>editor?.waitForSave()??bridge.waitForSave(),save:()=>editor?.saveAndWait()??Promise.resolve(false),release:()=>host.releaseLease(fileId),cleanup,setClosing:value=>{closing=value;container.inert=value;if(!value)changed()},confirm:()=>window.confirm('工作簿有未保存的更改，是否保存后关闭？取消将保留当前页签。'),notify:()=>window.alert('保存仍在进行或结果待确认，请先在工作簿中核对后再关闭。')})
  return {save:()=>editor?.saveAndWait()??Promise.resolve(false),canClose:lifecycle.canClose,dispose:lifecycle.dispose,unload(){void host.releaseLease(fileId,true).catch(()=>{});cleanup()}}
}
async function bootstrap() {
  const params=new URLSearchParams(location.search),fileId=params.get('fileId')??''
  const host=createSessionFileHost({...(params.get('guest')==='1'&&params.get('editorId')?{editorId:params.get('editorId')!}:{}),expectedRevision:params.get('sourceRevision')??undefined})
  installEditorCloseLifecycle(window,{canClose:async()=>false,dispose:async()=>false})
  try {
    const mounted=await mountSheetsEditor(host,document.getElementById('root')!,fileId)
    installEditorCloseLifecycle(window,{canClose:mounted.canClose,dispose:async()=>{const closed=await mounted.dispose();if(closed)host.dispose();return closed}})
    window.addEventListener('pagehide',()=>{mounted.unload();host.dispose()},{once:true})
  } catch(error){await host.releaseLease(fileId).catch(()=>{});host.dispose();installEditorCloseLifecycle(window,{canClose:async()=>true,dispose:async()=>true});throw error}
}
void bootstrap().catch(error=>{reportDocumentOpenError(error);document.getElementById('root')!.textContent=messages.zh.failed})
