import ReactDOM from 'react-dom/client'
import {useState} from 'react'
import {createSessionFileHost, type SessionFileHost} from '../../../../packages/browser-host/src/files.ts'
import {createSlidesBridge} from './slides-bridge.ts'
import {messages} from './messages.ts'
import {mountEditorRealtime} from './editor-realtime.ts'
import {App, type SlidesAppHost, type SlidesEditorHandle} from '../../../slides/src/renderer/App'
import {LocaleProvider, setModuleLang} from '../../../slides/src/renderer/i18n/locale'
import {installCanvasKerning} from '../../../slides/src/renderer/canvas-kerning'
import type {SlidesApi} from '../../../slides/src/shared/ipc'
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

export async function mountSlidesEditor(host: SessionFileHost, container: HTMLElement, fileId: string) {
  // Captured once: listeners and teardown must reach the mounting window even
  // if the embedding test harness has already restored the global.
  const stage = window
  container.textContent = messages.zh.opening
  const opened = await host.open(fileId)
  if (opened.format !== 'pptx') throw new Error(messages.zh.failed)
  const prefs = await host.getPreferences(), locale = prefs.language === 'en' ? 'en' : 'zh', text = messages[locale]
  setModuleLang(locale); document.documentElement.lang = locale
  if (prefs.theme === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = prefs.theme
  let changed = () => {}, editor: SlidesEditorHandle | null = null, disposed = false
  let downloading = false, takingOver = false, confirming = false, actionError = ''
  const bridge = createSlidesBridge(host, fileId, prefs, {onChange: () => changed()})
  Object.defineProperty(window, 'slidesApi', {value: bridge.api as unknown as SlidesApi, configurable: true})
  applyAiPanelPrefs(await bridge.api.getAiPanelPrefs()); installScreenTips(); installCanvasKerning()
  // Canvas fillText never triggers @font-face downloads: the bundled document fonts
  // (Carlito <-> Calibri) must be requested explicitly or Konva draws the fallback face.
  for (const variant of ['', 'bold ', 'italic ', 'italic bold ']) for (const family of ['Carlito', "'Carlito GO'"]) document.fonts?.load?.(`${variant}16px ${family}`).catch(() => {})
  let initialLease = true
  try { await host.acquireLease(fileId) } catch { initialLease = false }
  let editorMounted = initialLease
  const stop = host.startRenewal(fileId), unsubscribe = host.subscribe(() => changed())
  const realtime = mountEditorRealtime(host, fileId, () => changed())
  const dirty = () => (editor?.isDirty() ?? false) || bridge.needsConfirmation()
  async function saveAndDownload() {
    if (!editor || downloading || takingOver || disposed) return
    downloading = true; actionError = ''; changed()
    try {
      const receipt = await bridge.prepareDownload(editor)
      if (disposed) return
      // Pin the confirmed receipt once. The main action never uses a render's
      // old head or a fallback link while there are unsaved/unknown changes.
      const anchor = document.createElement('a')
      anchor.href = `/api/v1/files/${fileId}/content?revision=${receipt.revision}`
      anchor.download = host.getState(fileId).name
      anchor.hidden = true; container.append(anchor); anchor.click(); anchor.remove()
    } catch { if (!disposed) actionError = text.saveFailed }
    finally { downloading = false; if (!disposed) changed() }
  }
  async function takeOver() {
    if (downloading || takingOver || disposed) return
    if (dirty()) { actionError = text.takeoverDirty; changed(); return }
    takingOver = true; actionError = ''; changed()
    try {
      if (editor) await bridge.takeover(editor)
      else {
        // No parser session exists before the first lease. Acquire authority and
        // refresh the persisted pin before mounting the renderer for the first time.
        let acquired = false
        try {
          await host.takeoverLease(fileId); acquired = true
          await host.refreshHead(fileId)
          if (disposed || !host.getState(fileId).lease) throw new Error('takeover authority lost')
          editorMounted = true
        } catch (error) {
          if (acquired) await host.releaseLease(fileId).catch(() => {})
          throw error
        }
      }
      initialLease = true
    }
    catch { if (!disposed) actionError = dirty() ? text.takeoverDirty : text.takeoverFailed }
    finally { takingOver = false; if (!disposed) changed() }
  }
  async function confirmSave() {
    if (confirming || disposed) return
    confirming = true; actionError = ''; changed()
    try { await bridge.confirmSave() }
    catch { if (!disposed) actionError = text.saveFailed }
    finally { confirming = false; if (!disposed) changed() }
  }
  function NativeSlides() {
    const [, tick] = useState(0), [loaded, setLoaded] = useState(false), [failed, setFailed] = useState(false)
    changed = () => tick(value => value + 1)
    const state = host.getState(fileId)
    const readOnly = failed || takingOver || !state.lease || state.status === 'conflict' || state.status === 'unknown' || bridge.needsConfirmation() || state.status === 'unauthorized'
    const status = !editorMounted ? (takingOver ? text.takingOver : actionError || text.readOnly) : failed ? text.failed : !loaded ? text.opening : (state.status === 'unknown' || bridge.needsConfirmation()) ? text.unknown : state.status === 'unauthorized' ? text.unauthorized : takingOver ? text.takingOver : !state.lease || state.status === 'conflict' ? (dirty() ? text.takeoverDirty : initialLease ? text.conflict : text.readOnly) : downloading ? text.downloadSaving : actionError || (bridge.isDirty() ? '' : text.ready)
    const historical = (!editorMounted || loaded) && !failed && !state.lease && !dirty() && state.status !== 'unknown' && state.status !== 'unauthorized' && !bridge.needsConfirmation() && !takingOver
    const hostProps: SlidesAppHost = {readOnly, inPlaceSave: true, assistantAvailable: false, onDeckOpened: () => setLoaded(true), onOpenFailed: () => setFailed(true), onEditorReady: handle => { editor = handle }}
    return <div className="dyoffice-native-slides">
      <div className="dyoffice-slides-state" role="status"><span>{status}</span>
        {realtime.notice(locale) && <span>{realtime.notice(locale)}</span>}
        <button className="dyoffice-slides-download" disabled={!loaded || failed || !editor || !state.lease || state.status === 'conflict' || state.status === 'unauthorized' || downloading || takingOver} onClick={() => { void saveAndDownload() }}>{text.saveDownload}</button>
        {historical && <a href={`/api/v1/files/${fileId}/content?revision=${state.revision.revision}`} download={state.name}>{text.downloadReadOnly}</a>}
        {!state.lease && (!editorMounted || !failed) && state.status !== 'unauthorized' && <button className="dyoffice-slides-takeover" disabled={(editorMounted && (!loaded || !editor)) || downloading || takingOver || dirty() || state.status === 'unknown' || bridge.needsConfirmation()} onClick={() => { void takeOver() }}>{text.takeover}</button>}
        {bridge.needsConfirmation() && <button data-save-fence-allow="confirm" disabled={confirming} onClick={() => { void confirmSave() }}>{text.retry}</button>}
        {actionError && status !== actionError && <span className="dyoffice-slides-action-error">{actionError}</span>}
      </div>
      {editorMounted && <App host={hostProps} />}
    </div>
  }
  const root = ReactDOM.createRoot(container)
  root.render(<LocaleProvider initial={locale}><NativeSlides /></LocaleProvider>)
  const beforeUnload = (event: BeforeUnloadEvent) => { if (editor?.isDirty() || host.getState(fileId).status === 'unknown') { event.preventDefault(); event.returnValue = '' } }
  stage.addEventListener('beforeunload', beforeUnload)
  // Ctrl/Cmd+S saves in place through the renderer's own save flow (no download).
  // A read-only session is never dirty, so the save is naturally a no-op there.
  const onKeyDown = (event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
    if (event.key !== 's' && event.key !== 'S') return
    event.preventDefault()
    if (disposed || !editor?.isDirty()) return
    void editor.saveAndWait().catch(() => {})
  }
  window.addEventListener('keydown', onKeyDown)
  return {
    save: () => editor?.saveAndWait() ?? Promise.resolve(false),
    dispose() {
      disposed = true; changed = () => {}
      stage.removeEventListener('beforeunload', beforeUnload)
      stage.removeEventListener('keydown', onKeyDown)
      realtime.dispose(); stop(); unsubscribe(); root.unmount(); bridge.dispose()
    },
  }
}
async function bootstrap() {
  const host = createSessionFileHost(), fileId = new URL(location.href).searchParams.get('fileId') ?? ''
  try {
    const mounted = await mountSlidesEditor(host, document.getElementById('root')!, fileId)
    window.addEventListener('pagehide', () => { void host.releaseLease(fileId, true).catch(() => {}); mounted.dispose(); host.dispose() }, {once: true})
  } catch (error) { host.dispose(); throw error }
}
void bootstrap().catch(() => { document.getElementById('root')!.textContent = messages.zh.failed })
