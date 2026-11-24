import {createWebKnowledge} from './web-knowledge'
import type {SettingsRequest} from '../../../../packages/browser-host/src/preferences'
import {isRevisionRef} from '../../../../packages/web-contracts/src/api.ts'
import type {AiDocCreationResult} from '../shell/ai-doc-creation.ts'
import { hostError } from '../../../../packages/web-contracts/src/errors.ts'
import type { DesktopApi } from '../../../docs/src/shared/ipc'
import { validPrintPaper } from '../../../docs/src/shared/print-paper'
import type { TabsApi } from '../../../shell/src/shared/tabs-api'
import type { SessionFileHost } from '../../../../packages/browser-host/src/files.ts'
import { createSaveGenerationGuard, type SaveTicket } from '../../../../packages/browser-host/src/save-generation.ts'
import { messages } from './messages.ts'
import { createAiPdf } from './create-ai-pdf.ts'
import { prepareMarkdownDownload } from './docs-markdown-export.ts'
import { copyDocsImageToClipboard, fetchDocsClipboardImage, readDocsImage } from './docs-image-clipboard.ts'

// The native DOCX entry does not import the shell TabBar's global declaration.
// Only these optional, same-origin parent capabilities are used by this bridge.
type ParentTabsWindow = Window & {
  aiOfficeTabs?: Pick<TabsApi, 'list' | 'activate'>
  dyofficeOpenEditorSettings?: (target: 'models' | 'skills', caller: Window) => void
  dyofficeCompleteAiDocContent?: (fileId:string,result:AiDocCreationResult) => void
  dyofficeConsumeAiDocContent?: (fileId: string) => Promise<{title:string;html:string}|null>
  dyofficeCreateAiDoc?: (request:{type:'docx'|'pdf';title:string;content:string;file?:Blob}) => Promise<void>
}

/** A narrow compatibility bridge for the existing renderer. Opaque paths are
 * aliases only; they never become filesystem paths or server authorization. */
export function createDocsBridge(host: SessionFileHost, fileId: string, prefs: Awaited<ReturnType<SessionFileHost['getPreferences']>>, onChange: () => void, consumeAiDocContent?: () => Promise<{title:string;html:string}|null>,options:{knowledgeRequest?:SettingsRequest;wordCheckpoint?:()=>Promise<number|undefined>;onSourceOpenFailed?:()=>void}={}) {
  const locale = prefs.language === 'en' ? 'en' : 'zh', text = messages[locale], state = host.getState(fileId)
  const alias = `/files/${fileId}/${state.name}`, guard = createSaveGenerationGuard(), urls = new Set<string>()
  let disposed = false, downloading = false, takingOver = false
  let saveFence:(()=>boolean)|null=null
  async function guardedSave(check:()=>boolean,action:()=>Promise<boolean>){
    if(disposed||takingOver||saveFence||!check())return false
    saveFence=check
    try{const accepted=await action();return !disposed&&accepted}finally{saveFence=null}
  }
  let wordVersion:number|undefined
  let committed: import('../../../../packages/web-contracts/src/api').RevisionRef | null = null
  let consumed = false, consumedAiDocContent = false, ticket: SaveTicket | null = null
  let nativeSaveOutcome: 'none' | 'pending' | 'accepted' | 'incomplete' = 'none'
  let nativeSaveReasons: readonly string[] = []
  let generatedContentPending = false
  function completeGeneratedContent(accepted:boolean){
    if(!generatedContentPending)return
    generatedContentPending=false
    const current=host.getState(fileId),local=guard.getState(),receipt=committed
    const confirmed=accepted&&!disposed&&nativeSaveOutcome==='accepted'&&!local.dirty&&local.status==='idle'&&current.status==='idle'&&!!current.lease&&isRevisionRef(receipt)&&
      receipt.fileId===fileId&&receipt.fileId===current.revision.fileId&&receipt.revision===current.revision.revision&&receipt.sha256===current.revision.sha256&&receipt.size===current.revision.size
    ;(window.parent as ParentTabsWindow).dyofficeCompleteAiDocContent?.(fileId,confirmed?{ok:true,revision:receipt!}:{ok:false,error:'Word 正文未确认保存，请核对工作区文件，不要重复创建。'})
  }
  const unavailable = async () => { throw new Error(text.unavailable) }
  const noEvent = () => () => {}
  const lifecycle = {
    aiDocumentCreated: completeGeneratedContent,
    documentOpened() { if(disposed)return; guard.reset(); ticket = null; nativeSaveOutcome = 'none'; nativeSaveReasons = []; onChange() },
    edited() { if(disposed)return; guard.markEdited(); onChange() },
    async beforeSave() {
      if(disposed||takingOver)throw hostError('UNAVAILABLE','disposed or taking over')
      // The native queue may have waited after the download preflight. Do not
      // turn this action into implicit confirmation of an intervening save.
      if (downloading && (disposed || host.getState(fileId).status !== 'idle' || guard.getState().status === 'unknown')) throw hostError('UNAVAILABLE','download not ready')
      wordVersion=await options.wordCheckpoint?.()
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
  let panelPrefs = {side:'left' as 'left'|'right',fontSize:'default' as 'default'|'xlarge'|'large'|'custom',customFontSize:14,spellcheck:true,openInNewDocs:false,showAiSidebar:false,showAiAskTrigger:true}
  const panelListeners = new Set<(value:typeof panelPrefs)=>void>()
  function download(blob:Blob,name:string){const url=URL.createObjectURL(blob);try{const link=document.createElement('a');link.href=url;link.download=name;link.click()}finally{setTimeout(()=>URL.revokeObjectURL(url),0)}}
  const knowledge=createWebKnowledge(options.knowledgeRequest)
  const createInWorkspace = () => {
    try { return typeof window === 'undefined' ? undefined : (window.parent as ParentTabsWindow)?.dyofficeCreateAiDoc }
    catch { return undefined }
  }
  const api = {
    kbList:knowledge.kbList,kbSearch:knowledge.kbSearch,kbRead:knowledge.kbRead,
    openSourcePath: options.onSourceOpenFailed ? (path:string)=>knowledge.openSourcePath(path).catch(options.onSourceOpenFailed!) : knowledge.openSourcePath,
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
    consumeAiDocContent: async () => {
      if(consumedAiDocContent)return null
      consumedAiDocContent=true
      const content=await (consumeAiDocContent ? consumeAiDocContent() : (window.parent as ParentTabsWindow).dyofficeConsumeAiDocContent?.(fileId) ?? null)
      generatedContentPending=!!content
      if(disposed)completeGeneratedContent(false)
      return content
    },
    async createDocument(request:{type:'docx'|'pdf'|'md'|'html';title:string;content:string}) {
      const type=request.type
      if(type!=='docx'&&type!=='pdf')return {ok:false,error:text.unavailable}
      try {
        const create=createInWorkspace()
        if(typeof create!=='function')throw new Error(text.unavailable)
        if(type==='pdf'){
          const response=await fetch(new URL('../../../docs/src/renderer/fonts/NotoSansCJKsc-Regular-subset.woff2',import.meta.url))
          if(!response.ok)throw new Error(text.unavailable)
          const bytes=await createAiPdf(request.title,request.content,new Uint8Array(await response.arrayBuffer()))
          const data=new Uint8Array(bytes).buffer as ArrayBuffer
          await create({type,title:request.title,content:request.content,file:new Blob([data],{type:'application/pdf'})})
        }else await create({type,title:request.title,content:request.content})
        return {ok:true,destination:'workspace'}
      }
      catch(error){return {ok:false,error:error&&typeof error==='object'&&'message' in error&&typeof error.message==='string'?error.message:text.unavailable}}
    },
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
    async saveDocx(path: string, data: ArrayBuffer,_auto?:boolean,candidate?:string) {
      if (disposed || takingOver || path !== alias || (saveFence && !saveFence())) return { ok: false,error: text.saveFailed }
      try {
        const saved = await host.save(fileId,new Uint8Array(data),saveFence??(()=>true),wordVersion)
        // A dispatched commit may still land. Preserve its host state, but never
        // acknowledge it into an editor that has already been torn down.
        if(disposed)return {ok:false,error:text.saveFailed}
        committed = saved
        if(candidate)await host.nameSavedBlank?.(fileId,saved.revision,candidate).catch(()=>undefined)
        const name=host.getState(fileId).name
        if(disposed)return {ok:false,error:text.saveFailed}
        if (ticket) guard.settleSave(ticket,'committed')
        ticket = null; onChange()
        return { ok: true,...(name?{name}:{}) }
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
    async saveDocxAs(_currentPath: string | null, data: ArrayBuffer) {
      const name = host.getState(fileId).name
      download(new Blob([data],{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}),name)
      return {ok:true as const,path:alias,name}
    },
    saveDocxNew: unavailable,saveDocxTo: unavailable,
    setDocPassword: unavailable,writeRecoveryCopy: unavailable,
    async pickImage(){return new Promise<import('../../../docs/src/shared/ipc').PickImageResult|null>((resolve,reject)=>{const input=document.createElement('input');input.type='file';input.accept='image/png,image/jpeg,image/gif';input.hidden=true;const cleanup=()=>input.remove();input.oncancel=()=>{cleanup();resolve(null)};input.onchange=()=>{const file=input.files?.[0];if(!file){cleanup();resolve(null);return}if(!['image/png','image/jpeg','image/gif'].includes(file.type)||file.size>16*1024*1024){cleanup();reject(Error(text.unavailable));return}const reader=new FileReader();reader.onerror=()=>{cleanup();reject(Error(text.unavailable))};reader.onload=()=>{cleanup();resolve({name:file.name,mime:file.type as 'image/png'|'image/jpeg'|'image/gif',base64:String(reader.result).split(',')[1]})};reader.readAsDataURL(file)};document.body.append(input);input.click()})},
    fetchImage: unavailable,
    fetchClipboardImage: fetchDocsClipboardImage,
    async saveImageAs(src: string) {
      try {
        const { blob, extension } = await readDocsImage(src)
        download(blob, `image.${extension}`)
        return { ok: true }
      } catch {
        return { ok: false, error: text.unavailable }
      }
    },
    async copyImageToClipboard(src:string){try{await copyDocsImageToClipboard(src);return true}catch{throw Error('浏览器未允许图片剪贴板访问，请使用系统复制快捷键。')}},
    listPrinters: async () => [],
    async print(_scale?: Parameters<DesktopApi['print']>[0], _job?: Parameters<DesktopApi['print']>[1], paper?: Parameters<DesktopApi['print']>[2]) {
      const geometry = validPrintPaper(paper)
      const pageStyle = geometry ? window.document.createElement('style') : undefined
      let started = false
      const beforePrint = () => { started = true }
      let afterPrint!: () => void
      const finished = new Promise<void>(resolve => { afterPrint = resolve })
      try {
        if (pageStyle && geometry) {
          pageStyle.dataset.docsPrintPaper = ''
          pageStyle.textContent = `@media print { @page { size: ${geometry.widthTwips / 1440}in ${geometry.heightTwips / 1440}in; margin: 0; } }`
          window.document.head.append(pageStyle)
        }
        window.addEventListener('beforeprint', beforePrint)
        window.addEventListener('afterprint', afterPrint)
        window.print()
        // Keep the paper rule and preview alive if the system dialog is asynchronous.
        if (started) await finished
        return {ok:true}
      } catch {
        return {ok:false,error:locale==='en'?'Browser printing is unavailable.':'浏览器打印不可用。'}
      } finally {
        window.removeEventListener('beforeprint', beforePrint)
        window.removeEventListener('afterprint', afterPrint)
        pageStyle?.remove()
      }
    },
    async exportHtml(name:string,html:string){download(new Blob([html],{type:'text/html;charset=utf-8'}),name.replace(/\.docx$/i,'')+'.html');return {ok:true}},
    exportPdf: unavailable,
    async exportMarkdown(name:string,md:string,images:Parameters<DesktopApi['exportMarkdown']>[2]=[]){
      if(disposed)return {ok:false,error:text.unavailable}
      try{
        const file=await prepareMarkdownDownload(name,md,images,window.location.origin)
        if(disposed)return {ok:false,error:text.unavailable}
        download(file.blob,file.name)
        return {ok:true,path:file.name,imagesDropped:file.imagesDropped}
      }catch(error){return {ok:false,error:error instanceof RangeError?error.message:text.unavailable}}
    },
    pickExportImagesTarget: unavailable,printPdfBuffer: unavailable,
    pickMergeDataSource: unavailable,writeMergeOutput: unavailable,zoteroCommand: unavailable,
    onZoteroRequest:noEvent,

    async openAiModelSettings(){const open=(window.parent as ParentTabsWindow).dyofficeOpenEditorSettings;if(!open)throw new Error(text.unavailable);open('models',window)},
    async openSkillsSettings(){const open=(window.parent as ParentTabsWindow).dyofficeOpenEditorSettings;if(!open)throw new Error(text.unavailable);open('skills',window)},
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
  return { api,lifecycle,resolveKnowledgeCitation:knowledge.citationPath,get supportedCreateDocumentTypes() {return typeof createInWorkspace() === 'function' ? ['docx', 'pdf'] as const : []},guardedSave,takeover,prepareDownload,getReceipt:()=>committed,getState: () => ({...guard.getState(), nativeSaveOutcome, nativeSaveReasons, takingOver}),dispose() { knowledge.dispose(); completeGeneratedContent(false); disposed = true; panelListeners.clear(); for (const url of urls) URL.revokeObjectURL(url); urls.clear() } }
}
