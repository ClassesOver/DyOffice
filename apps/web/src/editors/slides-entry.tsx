import { officeSignatureNotice } from './office-signature-notice'
import {documentHandoffPeer} from './document-handoff-peer'
import {mountDocumentHandoff} from './document-handoff'
import {createAnalysisDocumentTarget} from '../../../../packages/browser-host/src/analysis-document-target.ts'
import {reportDocumentOpenError,reportDocumentLoading,registerDisplayedRevision} from './document-loading-state'
import {DocumentNotifications} from './document-notifications'
import {createEditorCloseLifecycle,installEditorCloseLifecycle} from './editor-close-lifecycle'
import ReactDOM from 'react-dom/client'
import {useEffect,useState} from 'react'
import {createSessionFileHost, type SessionFileHost} from '../../../../packages/browser-host/src/files.ts'
import {CitedRevisionChanged} from '../../../../packages/browser-host/src/session-files'
import {createSlidesBridge} from './slides-bridge.ts'
import {messages} from './messages.ts'
import {mountEditorRealtime} from './editor-realtime.ts'
import {editorAssistantNotice,loadEditorAssistant} from './editor-assistant-status'
import {confirmWebFileName,suggestWebFileName} from './web-ai-naming'
import {ASSISTANT_FORMAT_TOOLS} from '../../../../packages/web-contracts/src/assistant.ts'
import {App, type SlidesAppHost, type SlidesEditorHandle} from '../../../slides/src/renderer/App'
import {LocaleProvider, setModuleLang} from '../../../slides/src/renderer/i18n/locale'
import {installCanvasKerning} from '../../../slides/src/renderer/canvas-kerning'
import type {SlidesApi} from '../../../slides/src/shared/ipc'
import {WEB_NOTES_TEXT_LIMIT} from '../../../slides/src/shared/notes-draft'
import {applyAiPanelPrefs, installScreenTips} from '@genoffice/ui'
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
  // Captured once: listeners and teardown must reach the mounting window even
  // if the embedding test harness has already restored the global.
  const stage = window
  container.textContent = messages.zh.opening
  const opened = await host.open(fileId)
  const signed=opened.officeSignatureProtected===true
  if (opened.format !== 'pptx') throw new Error(messages.zh.failed)
  const prefs = await host.getPreferences(), locale = prefs.language === 'en' ? 'en' : 'zh', text = messages[locale]
  setModuleLang(locale); document.documentElement.lang = locale
  if (prefs.theme === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = prefs.theme
  let changed = () => {}, editor: SlidesEditorHandle | null = null, disposed = false, closing=false
  type AssistantResult=Awaited<ReturnType<typeof loadEditorAssistant>>
  let assistantLoadFinished=false
  let assistantResult:Parameters<typeof editorAssistantNotice>[0]={assistant:undefined,failure:undefined}
  let sharedAssistant:AssistantResult['assistant']
  let assistantContinuation:NonNullable<SlidesAppHost['assistant']>['continuation']
  const originalDesktop = Object.getOwnPropertyDescriptor(stage, 'desktop')
  let installedDesktop: typeof stage.desktop | undefined
  let downloading = false, takingOver = false, confirming = false, actionError = ''
  const copyLifetime=new AbortController()
  let naming=false,copyNotice='',recoveryDownload:'idle'|'sent'|'failed'='idle'
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
  Object.defineProperty(window, 'slidesApi', {value: bridge.api as unknown as SlidesApi, configurable: true})
  applyAiPanelPrefs(await bridge.api.getAiPanelPrefs()); installScreenTips(); installCanvasKerning()
  // Canvas fillText never triggers @font-face downloads: the bundled document fonts
  // (Carlito <-> Calibri) must be requested explicitly or Konva draws the fallback face.
  for (const variant of ['', 'bold ', 'italic ', 'italic bold ']) for (const family of ['Carlito', "'Carlito GO'"]) document.fonts?.load?.(`${variant}16px ${family}`).catch(() => {})
  let initialLease = !signed
  if(!signed)try { await host.acquireLease(fileId) } catch { initialLease = false }
  let editorMounted = signed || initialLease
  const stop = host.startRenewal(fileId), unsubscribe = host.subscribe(() => changed())
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
  const namedCopy:NonNullable<SlidesAppHost['namedCopy']>={
    async suggest({content}){
      const assistant=sharedAssistant,modelId=assistant?.selected()
      if(!assistant?.available||!modelId||naming||closing||disposed||!host.getState(fileId).lease)return ''
      naming=true
      try{return await suggestWebFileName(content,{modelId,proof:assistant.sessionProof,format:'pptx',locale,signal:copyLifetime.signal})}
      finally{naming=false}
    },
    async save(stem){
      const assistant=sharedAssistant,signal=copyLifetime.signal
      if(!assistant||signal.aborted||closing||!host.getState(fileId).lease)return
      let upload:string|undefined,finishStarted=false
      try{
        const chosen=await confirmWebFileName(stem+'.pptx',{locale,signal,document:stage.document})
        if(!chosen||signal.aborted||closing)return
        const name=chosen.replace(/\.pptx$/i,'')+'.pptx'
        const blob=await bridge.exportDraftCopy(assistant.sessionProof,signal)
        const {uploadId}=await assistant.request<{uploadId:string}>('/api/v1/files/uploads','POST',{name,size:blob.size},signal)
        upload='/api/v1/uploads/'+encodeURIComponent(uploadId)
        await assistant.request(upload+'/content','PUT',blob,signal)
        finishStarted=true
        await assistant.request(upload+'/finish','POST',undefined,signal)
        copyNotice=locale==='zh'?`已保存副本：${name}`:`Saved copy: ${name}`
      }catch{
        // Before /finish nothing can have been created: drop the staged upload and say so plainly.
        if(upload&&!finishStarted&&!signal.aborted)await assistant.request(upload,'DELETE',undefined,signal).catch(()=>{})
        if(!signal.aborted)actionError=finishStarted
          ?(locale==='zh'?'无法确认副本是否已保存。请先在工作区核对，再决定是否重试。':'Could not confirm the copy. Check your workspace before retrying.')
          :(locale==='zh'?'无法保存副本。原演示文稿和未保存的修改仍保留。':'Could not save the copy. The source presentation and its unsaved changes are still intact.')
      }finally{if(!disposed)changed()}
    },
  }
  function NativeSlides() {
    const [, tick] = useState(0), [loaded, setLoaded] = useState(false), [failed, setFailed] = useState(false)
    useEffect(()=>{
      if(!failed) reportDocumentLoading(loaded || !editorMounted ? 'ready' : 'rendering')
    },[loaded,failed,editorMounted])
    changed = () => {if(!closing)tick(value => value + 1)}
    const state = host.getState(fileId)
    const writeProtected=bridge.isWriteProtected()
    const readOnly = writeProtected || failed || takingOver || !state.lease || state.status === 'conflict' || state.status === 'unknown' || bridge.needsConfirmation() || state.status === 'unauthorized'
    const status = !editorMounted ? (takingOver ? text.takingOver : actionError || text.readOnly) : failed ? text.failed : !loaded ? text.opening : (state.status === 'unknown' || bridge.needsConfirmation()) ? text.unknown : state.status === 'unauthorized' ? text.unauthorized : takingOver ? text.takingOver : !state.lease || state.status === 'conflict' ? (dirty() ? text.takeoverDirty : initialLease ? text.conflict : text.readOnly) : downloading ? text.downloadSaving : actionError || (bridge.isDirty() ? '' : text.ready)
    const notice = realtime.notice(locale)
    const showAssistant=prefs.showAssistant!==false||handoffOpen
    const assistantNotice=assistantLoadFinished||!showAssistant?editorAssistantNotice(assistantResult,showAssistant,locale):''
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
    const hostProps: SlidesAppHost = {saveDownload,hasGeneratedName:bridge.hasGeneratedName,analysisGeneration:bridge.getAnalysisGeneration,runAnalysis:(ops,check,adopt)=>bridge.guardedApply(check,async()=>{if(!check())return false;const result=await bridge.api.applyTxn({ops,isolation:'atomic'});if(!result?.applied||!result.slides)return false;adopt(result.slides);return true}),readOnly, inPlaceSave: true, presenterAudienceAvailable:false, documentStorageScope:`workspace:${fileId}`, assistantAvailable:Boolean(sharedAssistant?.available&&(prefs.showAssistant!==false||handoffOpen)),...(sharedAssistant?{assistant:{...sharedAssistant,mediaCapabilities:sharedAssistant.mediaCapabilities,continuation:assistantContinuation}}:{}), onDeckOpened: () => {documentLoaded=true;setLoaded(true)}, onOpenFailed: () => {documentLoaded=false;setFailed(true);reportOpenFailure()}, onEditorReady: handle => { editor = handle }}
    hostProps.downloadPdf = async (baseName,pages,width,height,links) => {
      const {downloadSlidesPdf} = await import('./slides-pdf-download')
      return downloadSlidesPdf(baseName,pages,width,height,links,copyLifetime.signal)
    }
    hostProps.notesTextLimit = WEB_NOTES_TEXT_LIMIT
    hostProps.downloadImages = async (baseName,format,pages) => {
      const {downloadSlidesImages} = await import('./slides-image-download')
      return downloadSlidesImages(baseName,format,pages,copyLifetime.signal)
    }
    hostProps.namedCopy=signed||writeProtected?undefined:namedCopy
    return <div className="dyoffice-native-slides">
      <DocumentNotifications locale={locale} items={[
        ...(signed ? [{id:'office-signature',level:'info' as const,...officeSignatureNotice[locale]}] : []),
        ...(writeProtected ? [{id:'write-protected',level:'info' as const,
          title:locale==='zh'?'演示文稿受写保护':'Write-protected presentation',
          message:locale==='zh'?'此演示文稿需要修改密码。Web 当前以只读方式打开，可下载已保存版本。':'This presentation requires a password to modify. The Web editor opens it read only, and the saved version can be downloaded.'}] : []),
        ...(warning ? [{id:'document-state',level:'error' as const,title:locale === 'zh' ? '文档需要处理' : 'Document needs attention',message:lostDraft?recoveryHint:warning,actions:<>{lostDraft&&<>
          <button type="button" className="dyoffice-slides-recover" disabled={downloading} onClick={()=>{void downloadLostDraft()}}>{locale==='zh'?'下载 PPTX 草稿':'Download PPTX draft'}</button>
          {recoveryDownload==='sent'&&<button type="button" onClick={()=>{if(stage.confirm(locale==='zh'?'已核对下载的草稿并保留未提交的输入？重新打开会替换当前页面。':'Have you checked the downloaded draft and preserved unsubmitted input? Reopening will replace this view.'))stage.location.reload()}}>{locale==='zh'?'重新打开最新版本':'Reopen latest version'}</button>}
        </>}{!lostDraft&&!signed && !state.lease && (!editorMounted || !failed) && state.status !== 'unauthorized' && <button className="dyoffice-slides-takeover" disabled={(editorMounted && (!loaded || !editor)) || downloading || takingOver || dirty() || state.status === 'unknown' || bridge.needsConfirmation()} onClick={() => { void takeOver() }}>{text.takeover}</button>}{historical && <a href={`/api/v1/files/${fileId}/content?revision=${state.revision.revision}&download=1`} download={state.name}>{text.downloadReadOnly}</a>}{bridge.needsConfirmation() && <button data-save-fence-allow="confirm" disabled={confirming} onClick={() => { void confirmSave() }}>{text.retry}</button>}</>}] : []),
        ...(notice ? [{id:'version',level:'info' as const,title:locale === 'zh' ? '版本同步' : 'Version updates',message:notice}] : []),
        ...(assistantNotice ? [{id:'assistant',level:showAssistant?'warning' as const:'info' as const,title:locale==='zh'?'AI 助手':'AI Assistant',message:assistantNotice}] : []),
        ...(copyNotice ? [{id:'named-copy',level:'info' as const,title:locale==='zh'?'副本已保存':'Copy saved',message:copyNotice}] : []),
      ]} />
      {editorMounted ? <App host={hostProps} /> : showAssistant && sharedAssistant &&
        <section className="ai-chat" aria-label={locale==='zh'?'Office 助手对话':'Office assistant conversation'}>
          {sharedAssistant.workspace.conversation(null)}
        </section>}
    </div>
  }
  reportDocumentLoading('rendering')
  const root = ReactDOM.createRoot(container)
  root.render(<LocaleProvider initial={locale}><NativeSlides /></LocaleProvider>)
  if(prefs.showAssistant!==false||documentHandoffPeer())void loadEditorAssistant({fileId,editorId:host.getEditorId(),generation:()=>1,continuationRevision},false,'pptx',ASSISTANT_FORMAT_TOOLS.pptx).then(async result=>{
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
    const panelPrefs=await bridge.api.getAiPanelPrefs()
    if(!disposed){
      applyAiPanelPrefs({...panelPrefs,showAiSidebar:value.available})
    }
  }).catch(()=>{}).finally(()=>{assistantLoadFinished=true;if(!disposed)changed()})
  const closeState=()=>({dirty:dirty()||bridge.isDirty(),blocked:downloading||takingOver||confirming||bridge.needsConfirmation()||['unknown','saving'].includes(host.getState(fileId).status)})
  registerDisplayedRevision(()=>{
    const state=closeState(),current=host.getState(fileId)
    const revision=current.revision.revision
    return documentLoaded&&editor?.canContinueAssistant()&&!state.dirty&&!state.blocked&&current.status!=='unauthorized'&&bridge.cleanRevision()===revision?revision:undefined
  })
  const beforeUnload = (event: BeforeUnloadEvent) => { if (closeState().dirty||closeState().blocked) { event.preventDefault(); event.returnValue = '' } }
  stage.addEventListener('beforeunload', beforeUnload)
  // Ctrl/Cmd+S saves in place through the renderer's own save flow (no download).
  // Flush pending text edits before the bridge decides whether a revision is needed.
  const onKeyDown = (event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
    if (event.key !== 's' && event.key !== 'S') return
    event.preventDefault()
    if (disposed || !editor || event.repeat || event.isComposing || !host.getState(fileId).lease) return
    void editor.saveAndWait().catch(() => {})
  }
  window.addEventListener('keydown', onKeyDown)
  const cleanup=()=>{
    if(disposed)return
    copyLifetime.abort()
    closeHandoff();unregisterAnalysis?.();analysisTarget.dispose();disposed=true;changed=()=>{}
    if(installedDesktop&&stage.desktop===installedDesktop){if(originalDesktop)Object.defineProperty(stage,'desktop',originalDesktop);else Reflect.deleteProperty(stage,'desktop');installedDesktop=undefined}
    stage.removeEventListener('beforeunload',beforeUnload);stage.removeEventListener('keydown',onKeyDown)
    sharedAssistant?.dispose();realtime.dispose();stop();unsubscribe();root.unmount();bridge.dispose()
  }
  const lifecycle=createEditorCloseLifecycle({state:closeState,waitForSave:()=>editor?.waitForSave()??bridge.waitForSave(),save:()=>editor?.saveAndWait()??Promise.resolve(false),release:()=>host.releaseLease(fileId),cleanup,setClosing:value=>{closing=value;container.inert=value;if(!value)changed()},confirm:()=>stage.confirm('演示文稿有未保存的更改，是否保存后关闭？取消将保留当前页签。'),notify:()=>stage.alert('保存仍在进行或结果待确认，请先在演示文稿中核对后再关闭。')})
  return {save:()=>editor?.saveAndWait()??Promise.resolve(false),canClose:lifecycle.canClose,dispose:lifecycle.dispose,unload(){void host.releaseLease(fileId,true).catch(()=>{});cleanup()}}
}
async function bootstrap() {
  const params=new URLSearchParams(location.search),fileId=params.get('fileId')??''
  const host=createSessionFileHost({expectedRevision:params.get('sourceRevision')??undefined})
  installEditorCloseLifecycle(window,{canClose:async()=>false,dispose:async()=>false})
  try {
    const mounted = await mountSlidesEditor(host, document.getElementById('root')!, fileId, params.has('sourceRevision'))
    installEditorCloseLifecycle(window,{canClose:mounted.canClose,dispose:async()=>{const closed=await mounted.dispose();if(closed)host.dispose();return closed}})
    window.addEventListener('pagehide',()=>{mounted.unload();host.dispose()},{once:true})
  } catch (error) { await host.releaseLease(fileId).catch(()=>{});host.dispose();installEditorCloseLifecycle(window,{canClose:async()=>true,dispose:async()=>true});throw error }
}
void bootstrap().catch(error => { reportDocumentOpenError(error);document.getElementById('root')!.textContent = messages.zh.failed })
