import {DocumentNotifications} from './document-notifications'
import {createEditorCloseLifecycle} from './editor-close-lifecycle'
import {createAnalysisDocumentTarget} from '../../../../packages/browser-host/src/analysis-document-target.ts'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../../docs/src/renderer/App'
import { LocaleProvider, setModuleLang } from '../../../docs/src/renderer/i18n/locale'
import { setAuthorName } from '../../../docs/src/renderer/author-name'
import { applyAiPanelPrefs, installScreenTips } from '@genoffice/ui'
import type { SessionFileHost } from '../../../../packages/browser-host/src/files.ts'
import { createDocsBridge } from './docs-bridge.ts'
import type { DocsEditorHandle } from '../../../docs/src/renderer/file-actions'
import type { DesktopApi } from '../../../docs/src/shared/ipc'
import { messages } from './messages.ts'
import {loadEditorAssistant,editorAssistantNotice} from './editor-assistant-status'
import { mountEditorRealtime } from './editor-realtime.ts'
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
import '@genoffice/ui/image-viewer.css'
import '../../../docs/src/renderer/styles.css'
import '../../../docs/src/renderer/fonts/fonts.css'
import './docs.css'

export async function mountDocsEditor(host: SessionFileHost,element: HTMLElement,fileId: string) {
  element.textContent = messages.zh.opening
  if (!/^[0-9a-f-]{36}$/i.test(fileId)) throw new Error(messages.zh.failed)
  let closing=false
  let changed = () => {}
  let disposed = false, downloading = false, actionError = ''
  let editorHandle: DocsEditorHandle | null = null
  const registerEditor = (handle: DocsEditorHandle | null) => { editorHandle = handle }
  const unsubscribe = host.subscribe(() => changed())
  const assistantResult = await loadEditorAssistant({fileId,editorId:host.getEditorId()!,generation:()=>1})
  const assistant = assistantResult.assistant
  const opened = await host.open(fileId)
  if (opened.format !== 'docx') throw new Error(messages.zh.failed)
  const prefs = await host.getPreferences(), locale = prefs.language === 'en' ? 'en' : 'zh', text = messages[locale]
  setModuleLang(locale); document.documentElement.lang = locale
  if (prefs.theme === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = prefs.theme
  setAuthorName(prefs.authorName ?? '')
  const bridge = createDocsBridge(host,fileId,prefs,() => changed())
  const analysisTarget=createAnalysisDocumentTarget({fileId,format:'docx',state:()=>host.getState(fileId),verifyAuthority:async()=>{await host.renewLease(fileId)},
    editor:()=>editorHandle?.analysis??null,receipt:()=>bridge.getReceipt(),
    save:check=>bridge.guardedSave(check,async()=>!!editorHandle&&await editorHandle.save()&&!editorHandle.isDirty()&&bridge.getState().nativeSaveOutcome==='accepted')})
  const unregisterAnalysis=assistant?.documents.register(analysisTarget)
  const assistantNotice = editorAssistantNotice(assistantResult,prefs.showAssistant,locale)
  const assistantAvailable = Boolean(assistant?.available && prefs.showAssistant !== false)
  const panelPrefs = {...await bridge.api.getAiPanelPrefs(), showAiSidebar: assistantAvailable}
  window.desktop = {...bridge.api,...assistant?.api, getAiPanelPrefs: async () => ({...await bridge.api.getAiPanelPrefs(),showAiSidebar:assistantAvailable})} as unknown as DesktopApi
  applyAiPanelPrefs(panelPrefs); installScreenTips()
  let initialLease = true
  try { await host.acquireLease(fileId) } catch { initialLease = false }
  const stop = host.startRenewal(fileId)
  const realtime = mountEditorRealtime(host, fileId, () => changed(),channels=>assistant?.channel?.observe(channels))
  async function saveAndDownload() {
    const editor = editorHandle
    if (!editor || disposed || downloading) return
    downloading = true; actionError = ''; changed()
    try {
      const receipt = await bridge.prepareDownload(editor)
      if (disposed || editorHandle !== editor) return
      const current = host.getState(fileId), local = bridge.getState()
      if (editor.isDirty() || local.dirty || local.status !== 'idle' || local.nativeSaveOutcome !== 'accepted' || current.status !== 'idle' || !current.lease || current.revision.fileId !== receipt.fileId || current.revision.revision !== receipt.revision || current.revision.sha256 !== receipt.sha256 || current.revision.size !== receipt.size) throw new Error(text.saveFailed)
      const anchor = document.createElement('a')
      anchor.href = `/api/v1/files/${fileId}/content?revision=${receipt.revision}`
      anchor.download = host.getState(fileId).name
      anchor.hidden = true; element.append(anchor); anchor.click(); anchor.remove()
    } catch { if (!disposed) actionError = text.saveFailed }
    finally { downloading = false; if (!disposed) changed() }
  }
  function NativeDocument() {
    const [,tick] = useState(0), [loaded,setLoaded] = useState(false), [failed,setFailed] = useState(false)
    const state = host.getState(fileId)
    changed = () => {if(!closing)tick(value => value + 1)}
    useEffect(() => {
      const focus = () => { if (host.getState(fileId).lease) void host.renewLease(fileId).catch(() => {}) }
      window.addEventListener('focus',focus)
      return () => window.removeEventListener('focus',focus)
    },[])
    const local = bridge.getState()
    const warning = failed ? text.failed : state.status === 'unknown' ? text.unknown : state.status === 'unauthorized' ? text.unauthorized : !state.lease && loaded ? (initialLease ? text.conflict : text.readOnly) : actionError
    const notice = realtime.notice(locale)
    const status = !loaded ? text.opening : downloading ? text.downloadSaving : state.status === 'saving' || local.status === 'saving' ? (locale === 'zh' ? '正在保存…' : 'Saving…') : local.dirty ? (locale === 'zh' ? '未保存' : 'Unsaved') : text.ready
    const saveStatus = <>
      <span className="dyoffice-docs-persistence-state" role="status" data-attention={Boolean(warning || notice)} data-native-save={local.nativeSaveOutcome} data-incomplete-reasons={local.nativeSaveReasons.join(',')} data-dirty={String(local.dirty)} title={warning || [status, notice].filter(Boolean).join(' · ')}>{warning ? (locale === 'zh' ? '需要处理' : 'Needs attention') : status}</span>
    </>
    const fileActions = <>
      <div className="file-menu-sep" />
      <button className="dyoffice-docs-save-download" title={text.saveDownloadVersionHint} disabled={!loaded || failed || !editorHandle || !state.lease || state.status !== 'idle' || downloading} onClick={() => { void saveAndDownload() }}>{text.saveDownload}</button>
      <a className="dyoffice-docs-download" href={`/api/v1/files/${fileId}/content?revision=${state.revision.revision}`} download>{text.download}</a>
    </>
    return <div className="dyoffice-native-docs">
      <DocumentNotifications locale={locale} items={[
        ...(assistantNotice ? [{id:'assistant',level:prefs.showAssistant === false ? 'info' as const : 'warning' as const,title:locale === 'zh' ? 'AI 助手' : 'AI Assistant',message:assistantNotice}] : []),
        ...(warning ? [{id:'document-state',level:'error' as const,title:locale === 'zh' ? '文档需要处理' : 'Document needs attention',message:warning,actions:<>
        {!state.lease && !failed && state.status !== 'unauthorized' && <button onClick={() => { void host.takeoverLease(fileId).then(() => { initialLease = true }).catch(() => { actionError = text.takeoverFailed; changed() }) }}>{text.takeover}</button>}
        {state.status === 'unknown' && <button onClick={() => { void host.reconcile(fileId).then(() => changed()).catch(() => {}) }}>{text.retry}</button>}
      </>}] : []),
        ...(notice ? [{id:'version',level:'info' as const,title:locale === 'zh' ? '版本同步' : 'Version updates',message:notice}] : []),
      ]} />
      <App host={{ fileActions,saveStatus,desktopActionsAvailable:false,readOnly: !loaded || failed || !state.lease,assistantAvailable,assistant,preferenceScope: fileId,onEditorReady: registerEditor,lifecycle: { ...bridge.lifecycle,documentOpened() { bridge.lifecycle.documentOpened(); setLoaded(true) } },onDocumentEdited: bridge.lifecycle.edited,onOpenFailed: () => setFailed(true) }} />
    </div>
  }
  const root = createRoot(element)
  root.render(<LocaleProvider initial={locale}><NativeDocument /></LocaleProvider>)
  const closeState=()=>({dirty:!!editorHandle?.isDirty()||bridge.getState().dirty,blocked:downloading||['unknown','saving'].includes(host.getState(fileId).status)||bridge.getState().nativeSaveOutcome==='pending'})
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (closeState().dirty || closeState().blocked) { event.preventDefault(); event.returnValue = '' }
  }
  window.addEventListener('beforeunload',beforeUnload)
  const cleanup=()=>{if(disposed)return;disposed=true;unregisterAnalysis?.();analysisTarget.dispose();window.removeEventListener('beforeunload',beforeUnload);assistant?.dispose();realtime.dispose();stop();unsubscribe();root.unmount();bridge.dispose()}
  const lifecycle=createEditorCloseLifecycle({state:closeState,save:()=>editorHandle?.save()??Promise.resolve(false),release:()=>host.releaseLease(fileId),cleanup,setClosing:value=>{closing=value;element.inert=value;if(!value)changed()},confirm:()=>window.confirm('文档有未保存的更改，是否保存后关闭？取消将保留当前页签。'),notify:()=>window.alert('保存仍在进行或结果待确认，请先在文档中核对后再关闭。')})
  return {
    canClose:lifecycle.canClose,
    dispose:lifecycle.dispose,
    unload(){void host.releaseLease(fileId,true).catch(()=>{});cleanup()},
    getSelection: () => editorHandle?.getSelection() ?? null,
    serialize: () => editorHandle ? editorHandle.serialize() : Promise.reject(new Error(text.opening)),
    save: () => editorHandle ? editorHandle.save() : Promise.resolve(false),
  }
}
