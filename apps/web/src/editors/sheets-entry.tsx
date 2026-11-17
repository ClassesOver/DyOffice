import ReactDOM from 'react-dom/client'
import {useState} from 'react'
import {createSessionFileHost, type SessionFileHost} from '../../../../packages/browser-host/src/files.ts'
import {createSheetsBridge} from './sheets-bridge.ts'
import {messages} from './messages.ts'
import {mountEditorRealtime} from './editor-realtime.ts'
import type {SheetsEditorHandle} from '../../../sheets/src/renderer/App'
import {App} from '../../../sheets/src/renderer/App'
import {LocaleProvider,setModuleLang} from '../../../sheets/src/renderer/i18n/locale'
import {installCanvasFontFallback,registerTextDingbatsFace,untilCellFontsLoaded} from '../../../sheets/src/renderer/cell-font-fallback'
import type {DesktopApi} from '../../../sheets/src/shared/desktop-api'
import {installScreenTips,applyAiPanelPrefs} from '@genoffice/ui'
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
import {createEditorAssistant} from './assistant.tsx'

export async function mountSheetsEditor(host: SessionFileHost, container: HTMLElement, fileId: string) {
  container.textContent = messages.zh.opening
  const assistant = await createEditorAssistant().catch(() => undefined)
  const opened = await host.open(fileId)
  if (opened.format !== 'xlsx') throw new Error(messages.zh.failed)
  const prefs = await host.getPreferences(), locale = prefs.language === 'en' ? 'en' : 'zh', text = messages[locale]
  setModuleLang(locale); document.documentElement.lang = locale
  if (prefs.theme === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = prefs.theme
  let changed = () => {}, editor: SheetsEditorHandle | null = null, disposed = false
  let downloading = false, takingOver = false, confirming = false, actionError = ''
  const bridge = createSheetsBridge(host,fileId,prefs,{onChange:()=>changed()})
  const assistantAvailable = Boolean(assistant?.available && prefs.showAssistant !== false)
  const panelPrefs = {...await bridge.api.getAiPanelPrefs(), showAiSidebar: assistantAvailable}
  Object.defineProperty(window,'desktopApi',{value:{...bridge.api,...assistant?.api,getAiPanelPrefs:async()=>panelPrefs} as unknown as DesktopApi,configurable:true})
  applyAiPanelPrefs(panelPrefs); installScreenTips(); installCanvasFontFallback()
  const loads: Promise<unknown>[] = [registerTextDingbatsFace()]
  for (const variant of ['', 'bold ', 'italic ', 'italic bold ']) for (const family of ['Calibri','Aptos',"'Aptos Narrow'",'Carlito']) loads.push(document.fonts.load(`${variant}16px ${family}`).catch(()=>{}))
  await untilCellFontsLoaded(Promise.all(loads))
  let initialLease = true
  try { await host.acquireLease(fileId) } catch { initialLease = false }
  const stop = host.startRenewal(fileId), unsubscribe = host.subscribe(()=>changed())
  const realtime = mountEditorRealtime(host, fileId, () => changed())
  const dirty = () => (editor?.isDirty() ?? false) || bridge.isDirty()
  async function saveAndDownload() {
    if(!editor || downloading || takingOver || disposed)return
    downloading=true;actionError='';changed()
    try {
      const receipt=await bridge.prepareDownload(editor)
      if(disposed)return
      // Pin the confirmed receipt once. The main action never uses a render's
      // old head or a fallback link while there are unsaved/unknown changes.
      const anchor=document.createElement('a')
      anchor.href=`/api/v1/files/${fileId}/content?revision=${receipt.revision}`
      anchor.download=host.getState(fileId).name
      anchor.hidden=true;container.append(anchor);anchor.click();anchor.remove()
    } catch {if(!disposed)actionError=text.saveFailed}
    finally {downloading=false;if(!disposed)changed()}
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
  function NativeWorkbook() {
    const [,tick] = useState(0), [loaded,setLoaded] = useState(false), [failed,setFailed] = useState(false)
    changed = () => tick(value=>value+1)
    const state = host.getState(fileId)
    const readOnly = failed || takingOver || !state.lease || state.status === 'conflict' || state.status === 'unknown' || bridge.needsConfirmation() || state.status === 'unauthorized'
    const status = failed ? text.failed : !loaded ? text.opening : (state.status === 'unknown' || bridge.needsConfirmation()) ? text.unknown : state.status === 'unauthorized' ? text.unauthorized : takingOver ? text.takingOver : !state.lease || state.status==='conflict' ? (dirty() ? text.takeoverDirty : initialLease ? text.conflict : text.readOnly) : downloading ? text.downloadSaving : actionError || (bridge.isDirty() ? '' : text.ready)
    const historical = loaded && !failed && !state.lease && !dirty() && state.status !== 'unknown' && state.status !== 'unauthorized' && !bridge.needsConfirmation() && !takingOver
    return <div className="dyoffice-native-sheets">
      <div className="dyoffice-sheets-state" role="status"><span>{status}</span>
        {realtime.notice(locale) && <span>{realtime.notice(locale)}</span>}
        <button className="dyoffice-sheets-download" disabled={!loaded || failed || !editor || !state.lease || state.status==='conflict' || state.status==='unauthorized' || downloading || takingOver} onClick={()=>{void saveAndDownload()}}>{text.saveDownload}</button>
        {historical && <a href={`/api/v1/files/${fileId}/content?revision=${state.revision.revision}`} download={state.name}>{text.downloadReadOnly}</a>}
        {!state.lease && !failed && state.status!=='unauthorized' && <button disabled={!loaded || !editor || downloading || takingOver || dirty() || state.status==='unknown' || bridge.needsConfirmation()} onClick={()=>{void takeOver()}}>{text.takeover}</button>}
        {bridge.needsConfirmation() && <button data-save-fence-allow="confirm" disabled={confirming} onClick={()=>{void confirmSave()}}>{text.retry}</button>}
        {actionError && status!==actionError && <span className="dyoffice-sheets-action-error">{actionError}</span>}
      </div>
      <App queuedWorkbookAtBoot host={{readOnly,inPlaceSave:true,assistantAvailable,...(assistant?{assistant}:{}),onWorkbookOpened:()=>setLoaded(true),onOpenFailed:()=>setFailed(true),onEditorReady:handle=>{editor=handle}}} />
    </div>
  }
  const root = ReactDOM.createRoot(container)
  root.render(<LocaleProvider initial={locale}><NativeWorkbook /></LocaleProvider>)
  const beforeUnload = (event: BeforeUnloadEvent) => { if (editor?.isDirty() || host.getState(fileId).status === 'unknown') { event.preventDefault(); event.returnValue='' } }
  window.addEventListener('beforeunload',beforeUnload)
  return {save:()=>editor?.saveAndWait() ?? Promise.resolve(false),dispose(){disposed=true;assistant?.dispose();realtime.dispose();changed=()=>{};window.removeEventListener('beforeunload',beforeUnload);stop();unsubscribe();root.unmount();bridge.dispose()}}
}
async function bootstrap() {
  const host=createSessionFileHost(),fileId=new URL(location.href).searchParams.get('fileId') ?? ''
  try {
    const mounted=await mountSheetsEditor(host,document.getElementById('root')!,fileId)
    window.addEventListener('pagehide',()=>{void host.releaseLease(fileId,true).catch(()=>{});mounted.dispose();host.dispose()},{once:true})
  } catch(error){host.dispose();throw error}
}
void bootstrap().catch(()=>{document.getElementById('root')!.textContent=messages.zh.failed})
