import { hostError } from '../../../../packages/web-contracts/src/errors.ts'
import type { DesktopApi } from '../../../docs/src/shared/ipc'
import type { TabsApi } from '../../../shell/src/shared/tabs-api'
import type { SessionFileHost } from '../../../../packages/browser-host/src/files.ts'
import { createSaveGenerationGuard, type SaveTicket } from '../../../../packages/browser-host/src/save-generation.ts'
import { messages } from './messages.ts'

// The native DOCX entry does not import the shell TabBar's global declaration.
// Only these optional, same-origin parent capabilities are used by this bridge.
type ParentTabsWindow = Window & {aiOfficeTabs?: Pick<TabsApi, 'list' | 'activate'>}

/** A narrow compatibility bridge for the existing renderer. Opaque paths are
 * aliases only; they never become filesystem paths or server authorization. */
export function createDocsBridge(host: SessionFileHost, fileId: string, prefs: Awaited<ReturnType<SessionFileHost['getPreferences']>>, onChange: () => void) {
  const locale = prefs.language === 'en' ? 'en' : 'zh', text = messages[locale], state = host.getState(fileId)
  const alias = `/files/${fileId}/${state.name}`, guard = createSaveGenerationGuard(), urls = new Set<string>()
  let disposed = false, downloading = false, takingOver = false
  let saveFence:(()=>boolean)|null=null
  async function guardedSave(check:()=>boolean,action:()=>Promise<boolean>){
    if(disposed||takingOver||saveFence||!check())return false
    saveFence=check
    try{const accepted=await action();return !disposed&&accepted}finally{saveFence=null}
  }
  let committed: import('../../../../packages/web-contracts/src/api').RevisionRef | null = null
  let consumed = false, ticket: SaveTicket | null = null
  let nativeSaveOutcome: 'none' | 'pending' | 'accepted' | 'incomplete' = 'none'
  let nativeSaveReasons: readonly string[] = []
  const unavailable = async () => { throw new Error(text.unavailable) }
  const noEvent = () => () => {}
  const lifecycle = {
    documentOpened() { if(disposed)return; guard.reset(); ticket = null; nativeSaveOutcome = 'none'; nativeSaveReasons = []; onChange() },
    edited() { if(disposed)return; guard.markEdited(); onChange() },
    async beforeSave() {
      if(disposed||takingOver)throw hostError('UNAVAILABLE','disposed or taking over')
      // The native queue may have waited after the download preflight. Do not
      // turn this action into implicit confirmation of an intervening save.
      if (downloading && (disposed || host.getState(fileId).status !== 'idle' || guard.getState().status === 'unknown')) throw hostError('UNAVAILABLE','download not ready')
      nativeSaveOutcome = 'pending'; nativeSaveReasons = []
      if (guard.getState().status === 'unknown') {
        await host.reconcile(fileId,saveFence??(()=>true))
        if(disposed)throw hostError('UNAVAILABLE','disposed')
        if (ticket) guard.settleSave(ticket,'committed')
        ticket = null
      }
      ticket = guard.beginSave()
      onChange()
    },
    afterSave(accepted: boolean, incompleteReasons: readonly string[] = []) {
      if(disposed)return
      nativeSaveOutcome = accepted ? 'accepted' : 'incomplete'
      nativeSaveReasons = [...incompleteReasons]
      if (ticket && guard.getState().status !== 'unknown') { guard.settleSave(ticket,'failed'); ticket = null }
      if (accepted && host.getState(fileId).status === 'idle') guard.reset()
      // Native metadata edits do not emit a ProseMirror update. An incomplete
      // native save must not make the Web status claim that those edits landed.
      if (!accepted && host.getState(fileId).status === 'idle' && !guard.getState().dirty) guard.markEdited()
      onChange()
    },
  }
  let panelPrefs = {side:'left' as 'left'|'right',fontSize:'default' as 'default'|'xlarge'|'large'|'custom',customFontSize:14,spellcheck:true,openInNewDocs:false,showAiSidebar:false,showAiAskTrigger:false}
  const panelListeners = new Set<(value:typeof panelPrefs)=>void>()
  function download(blob:Blob,name:string){const url=URL.createObjectURL(blob);try{const link=document.createElement('a');link.href=url;link.download=name;link.click()}finally{setTimeout(()=>URL.revokeObjectURL(url),0)}}
  async function imageBlob(src:string){if(!src.startsWith('data:image/')&&!src.startsWith('blob:'))throw Error(text.unavailable);const response=await fetch(src);if(!response.ok)throw Error(text.unavailable);const blob=await response.blob();if(!['image/png','image/jpeg','image/gif'].includes(blob.type)||blob.size>16*1024*1024)throw Error(text.unavailable);return blob}
  const api = {
    getLanguage: async () => locale,
    getSystemLocale: async () => navigator.language,
    getTheme: async () => prefs.theme,
    getDocumentTheme: async () => 'follow' as const,
    getAuthorName: async () => prefs.authorName ?? '',
    getAutoSaveDefault: async () => ({ on: prefs.autoSave ?? true,updatedAt: 1 }),
    getAiPanelPrefs: async () => ({...panelPrefs}),
    setAiPanelPrefs: async (patch: Partial<typeof panelPrefs>) => {panelPrefs={...panelPrefs,...patch};for(const listener of panelListeners)listener({...panelPrefs});return {...panelPrefs}},
    onAiPanelPrefsChanged: (listener:(value:typeof panelPrefs)=>void) => {panelListeners.add(listener);return()=>{panelListeners.delete(listener)}},
    onLanguageChanged: noEvent,onThemeChanged: noEvent,onDocumentThemeChanged: noEvent,onAuthorNameChanged: noEvent,onAutoSaveDefaultChanged: noEvent,
    onOpenDocx: noEvent,onRenamedDocx: noEvent,onMenuCommand: noEvent,onTeardown: noEvent,onViewImage: noEvent,onContextMenuRequest: noEvent,onCloseCheck: noEvent,onCloseSaveRequest: noEvent,
    getRecentFiles: async () => [],
    async listDocsTabs() {
      const tabs = (window.parent as ParentTabsWindow).aiOfficeTabs
      if (!tabs) throw new Error(text.unavailable)
      return (await tabs.list()).filter(tab => tab.kind === 'docs').map(tab => ({id:tab.id,title:tab.title,focused:tab.active}))
    },
    async focusDocsTab(id:string) {
      const tabs = (window.parent as ParentTabsWindow).aiOfficeTabs
      if (!tabs || !(await tabs.list()).some(tab => tab.id === id && tab.kind === 'docs')) throw new Error(text.unavailable)
      await tabs.activate(id)
    },
    fontMetrics: async () => null,
    fontAliases: async () => ({}),
    consumeNewBlankDoc: async () => false,
    consumeAiDocContent: async () => null,
    consumeHeadlessExport: async () => null,
    docPasswordIntentRevision: async () => 0,
    // The Web host cannot create password intents; replacement cleanup has none.
    discardDocPasswordIntents: async () => ({ ok: true }),
    armContextMenu() {},
    claimContextMenu() {},
    async consumePendingOpenDocx() {
      if (consumed) return null
      consumed = true
      const ref = host.getState(fileId).revision, bytes = await host.readBytes(fileId,ref.revision)
      const dataUrl = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer],{ type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }))
      urls.add(dataUrl)
      return { path: alias,name: state.name,dataUrl,hash: ref.sha256 }
    },
    async saveDocx(path: string, data: ArrayBuffer) {
      if (disposed || takingOver || path !== alias || (saveFence && !saveFence())) return { ok: false,error: text.saveFailed }
      try {
        const saved = await host.save(fileId,new Uint8Array(data),saveFence??(()=>true))
        // A dispatched commit may still land. Preserve its host state, but never
        // acknowledge it into an editor that has already been torn down.
        if(disposed)return {ok:false,error:text.saveFailed}
        committed = saved
        if (ticket) guard.settleSave(ticket,'committed')
        ticket = null; onChange()
        return { ok: true }
      } catch {
        if(disposed)return {ok:false,error:text.saveFailed}
        const unknown = host.getState(fileId).status === 'unknown'
        if (ticket) guard.settleSave(ticket,unknown ? 'unknown' : 'failed')
        if (!unknown) ticket = null
        onChange()
        return { ok: false,error: unknown ? text.unknown : host.getState(fileId).status === 'conflict' ? text.conflict : text.saveFailed }
      }
    },
    confirmDocumentReplace: async () => window.confirm(text.conflict),
    openDocx: unavailable,openDocxPath: unavailable,openDocxDecrypt: unavailable,
    saveDocxAs: unavailable,saveDocxNew: unavailable,saveDocxTo: unavailable,
    setDocPassword: unavailable,writeRecoveryCopy: unavailable,
    async pickImage(){return new Promise<import('../../../docs/src/shared/ipc').PickImageResult|null>((resolve,reject)=>{const input=document.createElement('input');input.type='file';input.accept='image/png,image/jpeg,image/gif';input.hidden=true;const cleanup=()=>input.remove();input.oncancel=()=>{cleanup();resolve(null)};input.onchange=()=>{const file=input.files?.[0];if(!file){cleanup();resolve(null);return}if(!['image/png','image/jpeg','image/gif'].includes(file.type)||file.size>16*1024*1024){cleanup();reject(Error(text.unavailable));return}const reader=new FileReader();reader.onerror=()=>{cleanup();reject(Error(text.unavailable))};reader.onload=()=>{cleanup();resolve({name:file.name,mime:file.type as 'image/png'|'image/jpeg'|'image/gif',base64:String(reader.result).split(',')[1]})};reader.readAsDataURL(file)};document.body.append(input);input.click()})},
    fetchImage: unavailable,
    async saveImageAs(src:string){try{const blob=await imageBlob(src);download(blob,`image.${blob.type==='image/jpeg'?'jpg':blob.type.split('/')[1]}`);return {ok:true}}catch{return {ok:false,error:text.unavailable}}},
    async copyImageToClipboard(src:string){if(!navigator.clipboard?.write||typeof ClipboardItem==='undefined')throw Error('浏览器未允许图片剪贴板访问，请使用系统复制快捷键。');const blob=await imageBlob(src);if(blob.type!=='image/png')throw Error('当前浏览器仅支持复制 PNG 图片。');await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);return true},
    listPrinters: async () => [],
    async print(){try{window.print();return {ok:true}}catch{return {ok:false,error:'浏览器打印不可用。'}}},
    async exportHtml(name:string,html:string){download(new Blob([html],{type:'text/html;charset=utf-8'}),name.replace(/\.docx$/i,'')+'.html');return {ok:true}},
    exportPdf: unavailable,exportMarkdown: unavailable,pickExportImagesTarget: unavailable,printPdfBuffer: unavailable,
    pickMergeDataSource: unavailable,writeMergeOutput: unavailable,zoteroCommand: unavailable,
    onZoteroRequest:noEvent,

    openAiModelSettings: unavailable,openSkillsSettings: unavailable,
  } satisfies Partial<DesktopApi>
  async function prepareDownload(editor: {save(): Promise<boolean>; isDirty(): boolean}) {
    const before = host.getState(fileId)
    if (disposed || downloading || before.status !== 'idle' || !before.lease || guard.getState().status !== 'idle' || nativeSaveOutcome === 'pending') throw hostError('UNAVAILABLE','download not ready')
    downloading = true
    try {
      // Only the native save flushes pending table input and awaits its complete
      // serialization/acknowledgement. isDirty alone cannot replace that flush.
      // Never enter reconciliation implicitly from an unknown host state.
      if (!await editor.save()) throw hostError('UNAVAILABLE','download save')
      if (disposed) throw hostError('UNAVAILABLE','disposed')
      const current = host.getState(fileId), local = guard.getState(), receipt = committed
      if (editor.isDirty() || local.dirty || local.status !== 'idle' || nativeSaveOutcome !== 'accepted' || current.status !== 'idle' || !current.lease || !receipt ||
          receipt.fileId !== current.revision.fileId || receipt.revision !== current.revision.revision || receipt.sha256 !== current.revision.sha256 || receipt.size !== current.revision.size) throw hostError('CONFLICT','download not confirmed')
      return {...receipt}
    } finally { downloading = false }
  }
  async function takeover(editor:{isDirty():boolean}) {
    if(disposed||takingOver||downloading||saveFence)throw hostError('UNAVAILABLE','takeover unavailable')
    const assertClean=()=>{
      if(disposed)throw hostError('UNAVAILABLE','disposed')
      const local=guard.getState(),state=host.getState(fileId)
      if(editor.isDirty()||local.dirty||local.status!=='idle'||nativeSaveOutcome==='pending'||['unknown','saving'].includes(state.status))throw new Error(text.takeoverDirty)
    }
    assertClean();takingOver=true;onChange()
    let acquired=false
    try{
      if(!await host.isCurrentRevision(fileId))throw new Error(text.takeoverStale)
      assertClean()
      await host.takeoverLease(fileId);acquired=true
      assertClean()
      if(!await host.isCurrentRevision(fileId))throw new Error(text.takeoverStale)
      assertClean()
    }catch(error){if(acquired)await host.releaseLease(fileId).catch(()=>{});throw error}
    finally{takingOver=false;if(!disposed)onChange()}
  }
  return { api,lifecycle,guardedSave,takeover,prepareDownload,getReceipt:()=>committed,getState: () => ({...guard.getState(), nativeSaveOutcome, nativeSaveReasons, takingOver}),dispose() { disposed = true; panelListeners.clear(); for (const url of urls) URL.revokeObjectURL(url); urls.clear() } }
}
