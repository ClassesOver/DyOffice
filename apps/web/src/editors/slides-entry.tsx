import {subscribeBrowserDocumentCommands,workspaceOpenAction} from './browser-document-command'
import {createDraftCopyAuthority,draftCopyParentActive} from './draft-copy-authority'
import { officeSignatureNotice } from './office-signature-notice'
import {documentHandoffPeer} from './document-handoff-peer'
import {mountDocumentHandoff} from './document-handoff'
import {createAnalysisDocumentTarget} from '../../../../packages/browser-host/src/analysis-document-target.ts'
import {reportDocumentOpenError,reportDocumentLoading,registerDisplayedRevision} from './document-loading-state'
import {DocumentNotifications} from './document-notifications'
import {createEditorCloseLifecycle,installEditorCloseLifecycle} from './editor-close-lifecycle'
import ReactDOM from 'react-dom/client'
import {createPortal} from 'react-dom'
import {useEffect,useState} from 'react'
import {createSessionFileHost, type SessionFileHost} from '../../../../packages/browser-host/src/files.ts'
import {CitedRevisionChanged} from '../../../../packages/browser-host/src/session-files'
import {createSlidesBridge} from './slides-bridge.ts'
import {createBrowserAudience} from './slides-browser-audience'
import {createBrowserSlideFullscreen} from './slides-browser-fullscreen'
import {messages} from './messages.ts'
import {mountEditorRealtime} from './editor-realtime.ts'
import {editorAssistantNotice,loadEditorAssistant} from './editor-assistant-status'
import {confirmWebFileName,suggestWebFileName} from './web-ai-naming'
import {ASSISTANT_FORMAT_TOOLS} from '../../../../packages/web-contracts/src/assistant.ts'
import {App, type SlidesAppHost, type SlidesEditorHandle} from '../../../slides/src/renderer/App'
import {AudienceView} from '../../../slides/src/renderer/components/AudienceView'
import {LocaleProvider, setModuleLang} from '../../../slides/src/renderer/i18n/locale'
import {installCanvasKerning} from '../../../slides/src/renderer/canvas-kerning'
import type {SlidesApi} from '../../../slides/src/shared/ipc'
import {WEB_SLIDE_MEDIA_MAX_BYTES} from '../../../slides/src/shared/media-kinds'
import {WEB_NOTES_TEXT_LIMIT} from '../../../slides/src/shared/notes-draft'
import {installScreenTips} from '@genoffice/ui'
import {installBrowserAssistantPreferences} from './browser-assistant-appearance'
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
import '../../../slides/src/renderer/styles.css'

import './slides.css'
import './ribbon-file-button.css'
import './ai-dock-theme.css'

export async function mountSlidesEditor(host: SessionFileHost, container: HTMLElement, fileId: string, citationMode=false) {
  const openWorkspaceFile = workspaceOpenAction()
  // Captured once: listeners and teardown must reach the mounting window even
  // if the embedding test harness has already restored the global.
  const stage = window
  container.textContent = messages.zh.opening
  const guest=new URLSearchParams(stage.location.search).get('guest')==='1'
  const copyAuthority=guest||citationMode?undefined:await createDraftCopyAuthority(()=>draftCopyParentActive(stage))
  const opened = await host.open(fileId)
  const signed=opened.officeSignatureProtected===true
  if (opened.format !== 'pptx') throw new Error(messages.zh.failed)
  const prefs = await host.getPreferences(), locale = prefs.language === 'en' ? 'en' : 'zh', text = messages[locale]
  setModuleLang(locale); document.documentElement.lang = locale
  if (prefs.theme === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = prefs.theme
  let screenRecordingActive=false
  let changed = () => {}, editor: SlidesEditorHandle | null = null, disposed = false, closing=false
  const chinese=locale==='zh'
  const audience=createBrowserAudience(stage,chinese?'幻灯片放映 · 观众窗口':'Slide Show · Audience Window',()=>changed())
  const fullscreen=createBrowserSlideFullscreen(stage.document)
  type AssistantResult=Awaited<ReturnType<typeof loadEditorAssistant>>
  let assistantLoadFinished=false
  let assistantResult:Parameters<typeof editorAssistantNotice>[0]={assistant:undefined,failure:undefined}
  let sharedAssistant:AssistantResult['assistant']
  let assistantContinuation:NonNullable<SlidesAppHost['assistant']>['continuation']
  const originalDesktop = Object.getOwnPropertyDescriptor(stage, 'desktop')
  let installedDesktop: typeof stage.desktop | undefined
  let downloading = false, takingOver = false, confirming = false, actionError = ''
  const copyLifetime=new AbortController()
  let naming=false,copying=false,copyNotice='',recoveryDownload:'idle'|'sent'|'failed'='idle'
  const searchApi = {
    webSearch: (query: string, maxResults?: number) => sharedAssistant?.searchApi.webSearch(query, maxResults) ?? Promise.reject(new Error(text.unavailable)),
    imageSearch: (query: string, maxResults?: number) => sharedAssistant?.searchApi.imageSearch(query, maxResults) ?? Promise.reject(new Error(text.unavailable)),
  }
  const mediaApi = {
    generateImage: (input: Parameters<SlidesApi['generateImage']>[0]) => sharedAssistant?.mediaApi.generateImage(input) ?? Promise.reject(new Error(text.unavailable)),
    analyzeMedia: (input: Parameters<SlidesApi['analyzeMedia']>[0]) => sharedAssistant?.mediaApi.analyzeMedia(input) ?? Promise.reject(new Error(text.unavailable)),
    fetchImage: (url:string) => sharedAssistant?.mediaApi.fetchImage(url) ?? Promise.resolve(null),
  }
  const bridge = createSlidesBridge(host, fileId, prefs, {
    onChange: () => changed(), searchApi, mediaApi,
    skillsApi: {
      skillsList: async () => (await sharedAssistant?.api.skillsList() ?? []).map(skill => ({
        name: skill.name,
        description: skill.description,
        relevant: skill.relevance.relevant,
      })),
      skillText: name => sharedAssistant?.api.skillText(name) ?? Promise.reject(new Error(text.unavailable)),
    },
  })
  const appearance=await installBrowserAssistantPreferences(prefs,{...await bridge.api.getAiPanelPrefs(),showAiSidebar:!guest&&prefs.showAssistant!==false})
  Object.defineProperty(window, 'slidesApi', {value: {...bridge.api,...audience.api,...fullscreen,
    getAiPanelPrefs:async()=>appearance.withAppearance(),
    setAiPanelPrefs:async(patch:Parameters<SlidesApi['setAiPanelPrefs']>[0])=>appearance.updatePanelPrefs(patch),
  } as unknown as SlidesApi, configurable: true})
  installScreenTips(); installCanvasKerning()
  // Canvas fillText never triggers @font-face downloads: the bundled document fonts
  // (Carlito <-> Calibri) must be requested explicitly or Konva draws the fallback face.
  for (const variant of ['', 'bold ', 'italic ', 'italic bold ']) for (const family of ['Carlito', "'Carlito GO'"]) document.fonts?.load?.(`${variant}16px ${family}`).catch(() => {})
  let initialLease = !signed
  if(!signed)try { await host.acquireLease(fileId) } catch { initialLease = false }
  let editorMounted = signed || initialLease
  const stop = host.startRenewal(fileId), unsubscribe = host.subscribe(() => {
    if(host.getState(fileId).status==='unauthorized')audience.end()
    changed()
  })
  const realtime = mountEditorRealtime(host, fileId, () => changed(),channels=>sharedAssistant?.channel?.observe(channels))
  const analysisTarget=createAnalysisDocumentTarget({fileId,format:'pptx',state:()=>host.getState(fileId),verifyAuthority:async()=>{await host.renewLease(fileId)},editor:()=>editor?.analysis??null,receipt:()=>bridge.getReceipt(),save:check=>bridge.guardedSave(check,async()=>!!editor&&await editor.saveAndWait()&&!editor.isDirty()&&!bridge.needsConfirmation())})
  let unregisterAnalysis:(()=>void)|undefined
  const dirty = () => (editor?.isDirty() ?? false) || bridge.needsConfirmation()
  let handoffOpen=false,documentLoaded=false
  const continuationRevision=()=>{
    const state=host.getState(fileId)
    if(!documentLoaded||disposed||closing||takingOver||confirming||downloading||!state.lease||state.status!=='idle'||!editor?.canContinueAssistant())return
    return bridge.cleanRevision()===state.revision.revision?state.revision.revision:undefined
  }
  const closeHandoff=mountDocumentHandoff({fileId,format:'pptx',assistant:()=>sharedAssistant??(assistantLoadFinished?null:undefined),
    activate:()=>{handoffOpen=true;changed()},ready:()=>documentLoaded&&!disposed&&!closing&&!!editor&&!!host.getState(fileId).lease&&!takingOver&&!['unauthorized','conflict','unknown'].includes(host.getState(fileId).status),
    clean:()=>!dirty()&&!bridge.isDirty(),revision:()=>host.getState(fileId).revision.revision,
    save:check=>bridge.guardedSave(check,async()=>!!editor&&await editor.saveAndWait()&&!editor.isDirty()&&!bridge.needsConfirmation()),
  })
  async function saveAndDownload() {
    if (!editor || downloading || takingOver || disposed) return
    downloading = true; actionError = ''; changed()
    try {
      const receipt = await bridge.prepareDownload(editor)
      if (disposed) return
      // Pin the confirmed receipt once. The main action never uses a render's
      // old head or a fallback link while there are unsaved/unknown changes.
      const anchor = document.createElement('a')
      anchor.href = `/api/v1/files/${fileId}/content?revision=${receipt.revision}&download=1`
      anchor.download = host.getState(fileId).name
      anchor.hidden = true; container.append(anchor); anchor.click(); anchor.remove()
    } catch { if (!disposed) actionError = text.saveFailed }
    finally { downloading = false; if (!disposed) changed() }
  }
  async function downloadLostDraft(){
    if(downloading||disposed||takingOver||bridge.needsConfirmation())return
    downloading=true;recoveryDownload='idle';changed()
    try{
      const bytes=await bridge.exportDraftCopy(undefined,copyLifetime.signal,'recover')
      copyLifetime.signal.throwIfAborted()
      const url=URL.createObjectURL(bytes),link=stage.document.createElement('a')
      try{
        link.href=url;link.download=host.getState(fileId).name.replace(/\.pptx$/i,'')+'-draft.pptx'
        container.append(link);link.click();recoveryDownload='sent'
      }finally{link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)}
    }catch{recoveryDownload='failed'}
    finally{downloading=false;if(!disposed)changed()}
  }
  async function takeOver() {
    if (downloading || takingOver || disposed) return
    if (dirty()) { actionError = text.takeoverDirty; changed(); return }
    takingOver = true; actionError = ''; changed()
    try {
      if (editor) await bridge.takeover(editor,citationMode)
      else {
        // No parser session exists before the first lease. Acquire authority and
        // refresh the persisted pin before mounting the renderer for the first time.
        let acquired = false
        try {
          await host.takeoverLease(fileId); acquired = true
          if(citationMode){
            if(!await host.isCurrentRevision(fileId))throw new CitedRevisionChanged()
          }else await host.refreshHead(fileId)
          if (disposed || !host.getState(fileId).lease) throw new Error('takeover authority lost')
          editorMounted = true
        } catch (error) {
          if (acquired) await host.releaseLease(fileId).catch(() => {})
          throw error
        }
      }
      initialLease = true
    }
    catch(error) {
      if(!disposed){
        if(error instanceof CitedRevisionChanged)reportDocumentOpenError(error)
        else actionError = dirty() ? text.takeoverDirty : text.takeoverFailed
      }
    }
    finally { takingOver = false; if (!disposed) changed() }
  }
  function reportOpenFailure() {
    if(!citationMode){reportDocumentLoading('error');return}
    void host.isCurrentRevision(fileId).then(
      current=>{if(!disposed&&!closing)reportDocumentLoading(current?'error':'citation-expired')},
      ()=>{if(!disposed&&!closing)reportDocumentLoading('error')},
    )
  }
  async function confirmSave() {
    if (confirming || disposed) return
    confirming = true; actionError = ''; changed()
    try { await bridge.confirmSave() }
    catch { if (!disposed) actionError = text.saveFailed }
    finally { confirming = false; if (!disposed) changed() }
  }
  const canCopy = () => documentLoaded && !signed && !!copyAuthority?.current() && !disposed && !closing &&
    !downloading && !takingOver && !confirming && !bridge.isWriteProtected() && !bridge.needsConfirmation() &&
    host.getState(fileId).status === 'idle' && !!host.getState(fileId).lease
  const request=copyAuthority?.request,proof=copyAuthority?.proof
  async function saveAsCopy(stem:string) {
    const signal=copyLifetime.signal
    if(!request||!proof||copying||signal.aborted||!canCopy())return
    copying=true;copyNotice='';actionError='';changed()
    let upload:string|undefined,finishStarted=false
    try{
      if(!await copyAuthority?.verify()||!canCopy())throw Error('Draft session ended')
      const chosen=await confirmWebFileName(stem+'.pptx',{locale,signal,document:stage.document})
      if(!chosen||signal.aborted)return
      const name=chosen.replace(/\.pptx$/i,'')+'.pptx'
      if(!await copyAuthority?.verify()||!canCopy())throw Error('Draft session ended')
      const blob=await bridge.exportDraftCopy(proof,signal)
      if(!canCopy())throw Error('Draft session ended')
      const {uploadId}=await request<{uploadId:string}>('/api/v1/files/uploads','POST',{name,size:blob.size},signal)
      upload='/api/v1/uploads/'+encodeURIComponent(uploadId)
      if(!canCopy())throw Error('Draft session ended')
      await request(upload+'/content','PUT',blob,signal)
      if(!canCopy())throw Error('Draft session ended')
      finishStarted=true
      await request(upload+'/finish','POST',undefined,signal)
      copyNotice=locale==='zh'?`已保存副本：${name}`:`Saved copy: ${name}`
    }catch{
      if(upload&&!finishStarted&&!signal.aborted)await request(upload,'DELETE',undefined,signal).catch(()=>{})
      if(!signal.aborted)actionError=finishStarted
        ?(locale==='zh'?'无法确认副本是否已保存。请先在工作区核对，再决定是否重试。':'Could not confirm the copy. Check your workspace before retrying.')
        :(locale==='zh'?'无法保存副本。原演示文稿和未保存的修改仍保留。':'Could not save the copy. The source presentation and its unsaved changes are still intact.')
    }finally{copying=false;if(!disposed)changed()}
  }
  const namedCopy:NonNullable<SlidesAppHost['namedCopy']>={
    async suggest({content}){
      const assistant=sharedAssistant,modelId=assistant?.selected()
      if(!assistant?.available||!modelId||naming||copying||!canCopy())return ''
      naming=true
      try{return await suggestWebFileName(content,{modelId,proof:assistant.sessionProof,format:'pptx',locale,signal:copyLifetime.signal})}
      finally{naming=false}
    },
    save:saveAsCopy,
  }
  function NativeSlides() {
    const [, tick] = useState(0), [loaded, setLoaded] = useState(false), [failed, setFailed] = useState(false)
    const [unlockOpen, setUnlockOpen] = useState(false)
    const [unlockBusy, setUnlockBusy] = useState(false)
    const [unlockMessage, setUnlockMessage] = useState('')
    useEffect(()=>{
      if(!failed) reportDocumentLoading(loaded || !editorMounted ? 'ready' : 'rendering')
    },[loaded,failed,editorMounted])
    changed = () => {if(!closing)tick(value => value + 1)}
    const state = host.getState(fileId)
    const writeProtected=bridge.isWriteProtected()
    const readOnly = writeProtected || failed || takingOver || !state.lease || state.status === 'conflict' || state.status === 'unknown' || bridge.needsConfirmation() || state.status === 'unauthorized'
    const canUnlock=writeProtected&&loaded&&!failed&&!signed&&!citationMode&&!takingOver&&!!state.lease&&state.status==='idle'
    async function unlock(password:string) {
      if(!canUnlock||unlockBusy)return
      setUnlockBusy(true)
      setUnlockMessage('')
      try{
        const result=await bridge.unlockEditing(password)
        if(disposed)return
        if(result==='unlocked')setUnlockOpen(false)
        else if(result==='incorrect')setUnlockMessage(chinese?'修改密码不正确。':'Incorrect modification password.')
        else if(result==='unsupported')setUnlockMessage(chinese?'此演示文稿使用了不支持的密码验证方式。':'This presentation uses an unsupported password verifier.')
        else setUnlockMessage(chinese?'请稍等片刻后重试。':'Wait a moment and try again.')
      }catch{
        if(!disposed)setUnlockMessage(chinese?'无法解锁当前演示文稿。':'Could not unlock this presentation.')
      }finally{if(!disposed)setUnlockBusy(false)}
    }
    const status = !editorMounted ? (takingOver ? text.takingOver : actionError || text.readOnly) : failed ? text.failed : !loaded ? text.opening : (state.status === 'unknown' || bridge.needsConfirmation()) ? text.unknown : state.status === 'unauthorized' ? text.unauthorized : takingOver ? text.takingOver : !state.lease || state.status === 'conflict' ? (dirty() ? text.takeoverDirty : initialLease ? text.conflict : text.readOnly) : downloading ? text.downloadSaving : actionError || (bridge.isDirty() ? '' : text.ready)
    const notice = realtime.notice(locale)
    const showAssistant=prefs.showAssistant!==false||handoffOpen
    const assistantNotice=!guest&&(assistantLoadFinished||!showAssistant)?editorAssistantNotice(assistantResult,showAssistant,locale):''
    const warning = failed || state.status === 'unknown' || bridge.needsConfirmation() || state.status === 'unauthorized' || (!signed && !state.lease && (loaded || !editorMounted) && !takingOver) || state.status === 'conflict' ? status : actionError
    const lostDraft=loaded&&!failed&&!signed&&!state.lease&&state.status!=='unauthorized'&&state.status!=='unknown'&&!bridge.needsConfirmation()&&(dirty()||bridge.isDirty())
    const recoveryHint=recoveryDownload==='failed'
      ?(locale==='zh'?'草稿下载未完成，请重试。请保留当前页面；若草稿已过期，可从文件菜单将可见幻灯片导出为图片。':'Draft download failed. Retry and keep this tab open. If the draft expired, export the visible slides as images from the File menu.')
      :recoveryDownload==='sent'?(locale==='zh'?'请检查下载的草稿，另行保留尚未提交的输入，再重新打开最新版本。':'Check the downloaded draft and copy any unsubmitted input before reopening the latest version.')
      :(locale==='zh'?'编辑权限已失效。可下载包含已应用修改的 PPTX 草稿；原文件不会被覆盖。':'Editing access was lost. Download a PPTX draft with the applied changes. The original file will stay unchanged.')
    const historical = (!editorMounted || loaded) && !failed && !state.lease && !dirty() && state.status !== 'unknown' && state.status !== 'unauthorized' && !bridge.needsConfirmation() && !takingOver
    const saveDownload = <>
      <button type="button" className="dyoffice-slides-download"
        title={text.saveDownloadVersionHint} disabled={writeProtected || !loaded || failed || !editor || !state.lease || state.status === 'conflict' || state.status === 'unauthorized' || downloading || takingOver}
        onClick={() => { void saveAndDownload() }}>{text.saveDownload}</button>
      {loaded && !failed && state.status !== 'unauthorized' && <a className="dyoffice-slides-download-saved"
        href={`/api/v1/files/${fileId}/content?revision=${state.revision.revision}&download=1`} download={state.name}>{text.download}</a>}
    </>
    const hostProps: SlidesAppHost = {openWorkspaceFile,saveDownload,hasGeneratedName:bridge.hasGeneratedName,analysisGeneration:bridge.getAnalysisGeneration,runAnalysis:(ops,check,adopt)=>bridge.guardedApply(check,async()=>{if(!check())return false;const result=await bridge.api.applyTxn({ops,isolation:'atomic'});if(!result?.applied||!result.slides)return false;adopt(result.slides);return true}),readOnly, inPlaceSave: true, presenterAudienceAvailable:false, documentStorageScope:`workspace:${fileId}`, assistantAvailable:Boolean(sharedAssistant?.available&&(prefs.showAssistant!==false||handoffOpen)),...(sharedAssistant?{assistant:{...sharedAssistant,mediaCapabilities:sharedAssistant.mediaCapabilities,continuation:assistantContinuation}}:{}), onDeckOpened: () => {documentLoaded=true;setLoaded(true)}, onOpenFailed: () => {documentLoaded=false;setFailed(true);reportOpenFailure()}, onEditorReady: handle => { editor = handle }}
    const audienceWindow=audience.current()
    hostProps.presenterBrowserAudience={
      active:!!audienceWindow,
      openLabel:chinese?'打开观众窗口':'Open Audience Window',
      blockedMessage:chinese?'无法打开观众窗口，请允许弹出窗口后重试。':'Allow pop-ups to open the audience window.',
      open:()=>!disposed&&!closing&&host.getState(fileId).status!=='unauthorized'&&audience.open(),
      end:audience.end,
    }
    hostProps.downloadPdf = async (baseName,pages,width,height,links) => {
      const {downloadSlidesPdf} = await import('./slides-pdf-download')
      return downloadSlidesPdf(baseName,pages,width,height,links,copyLifetime.signal)
    }
    hostProps.readBrowserPaste = bridge.readBrowserPaste
    hostProps.notesTextLimit = WEB_NOTES_TEXT_LIMIT
    hostProps.mediaFileSizeLimit = WEB_SLIDE_MEDIA_MAX_BYTES
    hostProps.onScreenRecordingActive = value=>{screenRecordingActive=value}
    hostProps.downloadImages = async (baseName,format,pages) => {
      const {downloadSlidesImages} = await import('./slides-image-download')
      return downloadSlidesImages(baseName,format,pages,copyLifetime.signal)
    }
    hostProps.saveAsCopy=saveAsCopy
    hostProps.canSaveAsCopy=loaded&&!readOnly&&!copying&&!!request&&!!proof&&canCopy()
    hostProps.namedCopy=signed||writeProtected?undefined:namedCopy
    return <div className="dyoffice-native-slides">
      <DocumentNotifications locale={locale} items={[
        ...(signed ? [{id:'office-signature',level:'info' as const,...officeSignatureNotice[locale]}] : []),
        ...(writeProtected ? [{id:'write-protected',level:'warning' as const,
          title:locale==='zh'?'演示文稿受写保护':'Write-protected presentation',
          message:locale==='zh'?'输入修改密码即可编辑此演示文稿。':'Enter the modification password to edit this presentation.',
          actions:canUnlock&&(unlockOpen?<form className="dyoffice-pptx-unlock" onSubmit={event=>{
            event.preventDefault()
            const input=event.currentTarget.elements.namedItem('password') as HTMLInputElement
            const password=input.value
            input.value=''
            void unlock(password)
          }}>
            <label>{chinese?'修改密码':'Modification password'}<input name="password" type="password" autoComplete="off" required maxLength={255} autoFocus disabled={unlockBusy}/></label>
            <div>
              <button type="submit" disabled={unlockBusy}>{chinese?'解锁编辑':'Unlock editing'}</button>
              <button type="button" disabled={unlockBusy} onClick={()=>{setUnlockOpen(false);setUnlockMessage('')}}>{chinese?'取消':'Cancel'}</button>
            </div>
            {unlockMessage&&<p role="alert">{unlockMessage}</p>}
          </form>:<button type="button" onClick={()=>setUnlockOpen(true)}>{chinese?'输入修改密码':'Enter modification password'}</button>)}] : []),
        ...(warning ? [{id:'document-state',level:'error' as const,title:locale === 'zh' ? '文档需要处理' : 'Document needs attention',message:lostDraft?recoveryHint:warning,actions:<>{lostDraft&&<>
          <button type="button" className="dyoffice-slides-recover" disabled={downloading} onClick={()=>{void downloadLostDraft()}}>{locale==='zh'?'下载 PPTX 草稿':'Download PPTX draft'}</button>
          {recoveryDownload==='sent'&&<button type="button" onClick={()=>{if(stage.confirm(locale==='zh'?'已核对下载的草稿并保留未提交的输入？重新打开会替换当前页面。':'Have you checked the downloaded draft and preserved unsubmitted input? Reopening will replace this view.'))stage.location.reload()}}>{locale==='zh'?'重新打开最新版本':'Reopen latest version'}</button>}
        </>}{!lostDraft&&!signed && !state.lease && (!editorMounted || !failed) && state.status !== 'unauthorized' && <button className="dyoffice-slides-takeover" disabled={(editorMounted && (!loaded || !editor)) || downloading || takingOver || dirty() || state.status === 'unknown' || bridge.needsConfirmation()} onClick={() => { void takeOver() }}>{text.takeover}</button>}{historical && <a href={`/api/v1/files/${fileId}/content?revision=${state.revision.revision}&download=1`} download={state.name}>{text.downloadReadOnly}</a>}{bridge.needsConfirmation() && <button data-save-fence-allow="confirm" disabled={confirming} onClick={() => { void confirmSave() }}>{text.retry}</button>}</>}] : []),
        ...(notice ? [{id:'version',level:'info' as const,title:locale === 'zh' ? '版本同步' : 'Version updates',message:notice}] : []),
        ...(assistantNotice ? [{id:'assistant',level:showAssistant?'warning' as const:'info' as const,title:locale==='zh'?'AI 助手':'AI Assistant',message:assistantNotice}] : []),
        ...(copyNotice ? [{id:'named-copy',level:'info' as const,title:locale==='zh'?'副本已保存':'Copy saved',message:copyNotice}] : []),
      ]} />
      {audienceWindow&&createPortal(<>
        <AudienceView target={audienceWindow}/>
        <button type="button" className="dyoffice-audience-fullscreen" onClick={()=>{
          void audienceWindow.document.documentElement.requestFullscreen?.().catch(()=>{})
        }}>{chinese?'全屏放映':'Enter Full Screen'}</button>
      </>,audienceWindow.document.body)}
      {editorMounted ? <App host={hostProps} /> : showAssistant && sharedAssistant &&
        <section className="ai-chat" aria-label={locale==='zh'?'Office 助手对话':'Office assistant conversation'}>
          {sharedAssistant.workspace.conversation(null)}
        </section>}
    </div>
  }
  reportDocumentLoading('rendering')
  const root = ReactDOM.createRoot(container)
  root.render(<LocaleProvider initial={locale}><NativeSlides /></LocaleProvider>)
  if(!guest&&(prefs.showAssistant!==false||documentHandoffPeer()))void loadEditorAssistant({fileId,editorId:host.getEditorId(),generation:()=>1,continuationRevision},false,'pptx',ASSISTANT_FORMAT_TOOLS.pptx).then(async result=>{
    const value=result.assistant
    if(disposed){value?.dispose();return}
    assistantResult=result
    if(!value)return
    sharedAssistant=value
    if(value.coding&&value.fileChat)assistantContinuation={revision:continuationRevision,hasModel:id=>value.catalog.entries.some(entry=>entry.id===id),coding:value.coding,fileChat:value.fileChat}
    unregisterAnalysis=value.documents.register(analysisTarget)
    const desktop={...(stage.desktop??{}),...value.api} as typeof stage.desktop
    Object.defineProperty(stage,'desktop',{value:desktop,configurable:true,writable:true})
    installedDesktop=desktop
  }).catch(()=>{}).finally(()=>{assistantLoadFinished=true;if(!disposed){appearance.updatePanelPrefs({showAiSidebar:sharedAssistant?.available===true});changed()}})
  const closeState=()=>({dirty:dirty()||bridge.isDirty(),blocked:copying||downloading||takingOver||confirming||bridge.needsConfirmation()||['unknown','saving'].includes(host.getState(fileId).status)})
  registerDisplayedRevision(()=>{
    const state=closeState(),current=host.getState(fileId)
    const revision=current.revision.revision
    return documentLoaded&&editor?.canContinueAssistant()&&!state.dirty&&!state.blocked&&current.status!=='unauthorized'&&bridge.cleanRevision()===revision?revision:undefined
  })
  const beforeUnload = (event: BeforeUnloadEvent) => { if (closeState().dirty||closeState().blocked) { event.preventDefault(); event.returnValue = '' } }
  stage.addEventListener('beforeunload', beforeUnload)
  // Save shortcuts use the renderer's serialized save and copy flows.
  // Flush pending text edits before the bridge decides whether a revision is needed.
  const canSaveFromShortcut=()=>!disposed&&!!editor&&!!host.getState(fileId).lease
  const saveFromShortcut=()=>{void editor?.saveAndWait().catch(() => {})}
  const unsubscribeSave=subscribeBrowserDocumentCommands({save:saveFromShortcut},canSaveFromShortcut)
  const onKeyDown = (event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return
    if (event.key !== 's' && event.key !== 'S') return
    event.preventDefault()
    if (!canSaveFromShortcut() || event.repeat || event.isComposing) return
    if(event.shiftKey)void editor?.saveAsCopy().catch(() => {})
    else saveFromShortcut()
  }
  window.addEventListener('keydown', onKeyDown)
  const cleanup=()=>{
    if(disposed)return
    copyLifetime.abort()
    closeHandoff();unregisterAnalysis?.();analysisTarget.dispose();disposed=true;changed=()=>{}
    audience.end()
    void fullscreen.setShowFullScreen(false)
    if(installedDesktop&&stage.desktop===installedDesktop){if(originalDesktop)Object.defineProperty(stage,'desktop',originalDesktop);else Reflect.deleteProperty(stage,'desktop');installedDesktop=undefined}
    stage.removeEventListener('beforeunload',beforeUnload);stage.removeEventListener('keydown',onKeyDown)
    unsubscribeSave()
    sharedAssistant?.dispose();realtime.dispose();stop();unsubscribe();root.unmount();bridge.dispose()
  }
  const lifecycle=createEditorCloseLifecycle({state:closeState,waitForSave:()=>editor?.waitForSave()??bridge.waitForSave(),save:()=>editor?.saveAndWait()??Promise.resolve(false),release:()=>host.releaseLease(fileId),cleanup,setClosing:value=>{closing=value;container.inert=value;if(!value)changed()},confirm:()=>stage.confirm('演示文稿有未保存的更改，是否保存后关闭？取消将保留当前页签。'),notify:()=>stage.alert('保存仍在进行或结果待确认，请先在演示文稿中核对后再关闭。')})
  return {save:()=>editor?.saveAndWait()??Promise.resolve(false),canClose:lifecycle.canClose,canSleep:()=>!screenRecordingActive&&!audience.current()&&!bridge.videoExportActive(),dispose:lifecycle.dispose,unload(){void host.releaseLease(fileId,true).catch(()=>{});cleanup()}}
}
async function bootstrap() {
  const params=new URLSearchParams(location.search),fileId=params.get('fileId')??''
  const host=createSessionFileHost({...(params.get('guest')==='1'&&params.get('editorId')?{editorId:params.get('editorId')!}:{}),expectedRevision:params.get('sourceRevision')??undefined})
  installEditorCloseLifecycle(window,{canClose:async()=>false,dispose:async()=>false})
  try {
    const mounted = await mountSlidesEditor(host, document.getElementById('root')!, fileId, params.has('sourceRevision'))
    installEditorCloseLifecycle(window,{canClose:mounted.canClose,canSleep:mounted.canSleep,dispose:async()=>{const closed=await mounted.dispose();if(closed)host.dispose();return closed}})
    window.addEventListener('pagehide',()=>{mounted.unload();host.dispose()},{once:true})
  } catch (error) { await host.releaseLease(fileId).catch(()=>{});host.dispose();installEditorCloseLifecycle(window,{canClose:async()=>true,dispose:async()=>true});throw error }
}
void bootstrap().catch(error => { reportDocumentOpenError(error);document.getElementById('root')!.textContent = messages.zh.failed })
