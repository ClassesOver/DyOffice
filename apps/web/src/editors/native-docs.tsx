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
import {createEditorAssistant} from './assistant.tsx'
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
  let changed = () => {}
  let editorHandle: DocsEditorHandle | null = null
  const registerEditor = (handle: DocsEditorHandle | null) => { editorHandle = handle }
  const unsubscribe = host.subscribe(() => changed())
  const assistant = await createEditorAssistant({fileId,editorId:host.getEditorId()!,generation:()=>1}).catch(() => undefined)
  const opened = await host.open(fileId)
  if (opened.format !== 'docx') throw new Error(messages.zh.failed)
  const prefs = await host.getPreferences(), locale = prefs.language === 'en' ? 'en' : 'zh', text = messages[locale]
  setModuleLang(locale); document.documentElement.lang = locale
  if (prefs.theme === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = prefs.theme
  setAuthorName(prefs.authorName ?? '')
  const bridge = createDocsBridge(host,fileId,prefs,() => changed())
  const assistantAvailable = Boolean(assistant?.available && prefs.showAssistant !== false)
  const panelPrefs = {...await bridge.api.getAiPanelPrefs(), showAiSidebar: assistantAvailable}
  window.desktop = {...bridge.api,...assistant?.api, getAiPanelPrefs: async () => panelPrefs} as unknown as DesktopApi
  applyAiPanelPrefs(panelPrefs); installScreenTips()
  let initialLease = true
  try { await host.acquireLease(fileId) } catch { initialLease = false }
  const stop = host.startRenewal(fileId)
  const realtime = mountEditorRealtime(host, fileId, () => changed(),channels=>assistant?.channel?.observe(channels))
  function NativeDocument() {
    const [,tick] = useState(0), [loaded,setLoaded] = useState(false), [failed,setFailed] = useState(false)
    const state = host.getState(fileId)
    changed = () => tick(value => value + 1)
    useEffect(() => {
      const focus = () => { if (host.getState(fileId).lease) void host.renewLease(fileId).catch(() => {}) }
      window.addEventListener('focus',focus)
      return () => window.removeEventListener('focus',focus)
    },[])
    const status = failed ? text.failed : state.status === 'unknown' ? text.unknown : state.status === 'unauthorized' ? text.unauthorized : !state.lease ? (initialLease ? text.conflict : text.readOnly) : bridge.getState().dirty ? '' : text.ready
    return <div className="dyoffice-native-docs">
      <div className="dyoffice-docs-state" role="status"><span className="dyoffice-docs-persistence-state" data-native-save={bridge.getState().nativeSaveOutcome} data-dirty={String(bridge.getState().dirty)}>{status}</span>
        {realtime.notice(locale) && <span className="dyoffice-docs-notification-state">{realtime.notice(locale)}</span>}
        <a href={`/api/v1/files/${fileId}/content?revision=${state.revision.revision}`} download>{text.download}</a>
        {!state.lease && !failed && <button onClick={() => { void host.takeoverLease(fileId).then(() => { initialLease = true }).catch(() => {}) }}>{text.takeover}</button>}
        {state.status === 'unknown' && <button onClick={() => { void host.reconcile(fileId).then(() => changed()).catch(() => {}) }}>{text.retry}</button>}
      </div>
      <App host={{ readOnly: !loaded || failed || !state.lease,assistantAvailable,assistant,preferenceScope: fileId,onEditorReady: registerEditor,lifecycle: { ...bridge.lifecycle,documentOpened() { bridge.lifecycle.documentOpened(); setLoaded(true) } },onDocumentEdited: bridge.lifecycle.edited,onOpenFailed: () => setFailed(true) }} />
    </div>
  }
  const root = createRoot(element)
  root.render(<LocaleProvider initial={locale}><NativeDocument /></LocaleProvider>)
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (editorHandle?.isDirty() || host.getState(fileId).status === 'unknown') { event.preventDefault(); event.returnValue = '' }
  }
  window.addEventListener('beforeunload',beforeUnload)
  return {
    getSelection: () => editorHandle?.getSelection() ?? null,
    serialize: () => editorHandle ? editorHandle.serialize() : Promise.reject(new Error(text.opening)),
    save: () => editorHandle ? editorHandle.save() : Promise.resolve(false),
    dispose() { window.removeEventListener('beforeunload',beforeUnload); assistant?.dispose();realtime.dispose(); stop(); unsubscribe(); root.unmount(); bridge.dispose() },
  }
}
