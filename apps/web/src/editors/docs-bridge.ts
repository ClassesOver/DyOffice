import {createWebKnowledge} from './web-knowledge'
import {browserEditorTheme} from './browser-editor-theme'
import type {SettingsRequest} from '../../../../packages/browser-host/src/preferences'
import {isRevisionRef} from '../../../../packages/web-contracts/src/api.ts'
import {bytesBase64} from '../../../../packages/browser-host/src/analysis-image.ts'
import {imageSize} from '../../../../packages/cli/src/formats/image-size.ts'
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
import { copyDocsImageToClipboard, fetchDocsClipboardImage, readDocsImage, type ClipboardImageFetcher } from './docs-image-clipboard.ts'
import {subscribeBrowserDocumentCommands} from './browser-document-command'
import {pickLocalFiles} from './pick-local-files'
import {browserFileName} from './browser-download'

function browserPrintPaperCss(
  doc: Document,
  fallback: NonNullable<ReturnType<typeof validPrintPaper>>,
): string {
  const paperSize = ({widthTwips,heightTwips}: typeof fallback) =>
    `${widthTwips / 1440}in ${heightTwips / 1440}in`
  const pages = new Map<string, string[]>()
  for (const page of doc.querySelectorAll<HTMLElement>('.pagination-preview .pv-page:not(.pv-print-skip)')) {
    const index = page.dataset.pvPage
    if (!index || !/^\d+$/.test(index)) continue
    const geometry = validPrintPaper({
      widthTwips: Math.round(Number.parseFloat(page.style.width) * 15),
      heightTwips: Math.round(Number.parseFloat(page.style.height) * 15),
    })
    if (!geometry) continue
    const size = paperSize(geometry)
    const selector = `.pagination-preview .pv-page[data-pv-page="${index}"]`
    const selectors = pages.get(size)
    if (selectors) selectors.push(selector)
    else pages.set(size, [selector])
  }
  const rules = [`@page { size: ${paperSize(fallback)}; margin: 0; }`]
  if (pages.size > 1) {
    for (const [size,selectors] of pages) {
      const name = `docx-paper-${rules.length}`
      rules.push(`@page ${name} { size: ${size}; margin: 0; } ${selectors.join(', ')} { page: ${name}; }`)
    }
  }
  return `@media print { ${rules.join('\n')} }`
}

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
export function createDocsBridge(host: SessionFileHost, fileId: string, prefs: Awaited<ReturnType<SessionFileHost['getPreferences']>>, onChange: () => void, consumeAiDocContent?: () => Promise<{title:string;html:string}|null>,options:{knowledgeRequest?:SettingsRequest;fetchClipboardRemoteImage?:ClipboardImageFetcher;wordCheckpoint?:()=>Promise<number|undefined>;onSourceOpenFailed?:()=>void;takeUnlockedBytes?:()=>Uint8Array|undefined;setOpenPassword?:(password:string|null)=>boolean}={}) {
  const locale = prefs.language === 'en' ? 'en' : 'zh', text = messages[locale], state = host.getState(fileId)
  const alias = `/files/${fileId}/${state.name}`, guard = createSaveGenerationGuard(), urls = new Set<string>()
  const lifetime = new AbortController()
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
  let activeSave: Promise<void> | undefined
  let resolveActiveSave: (()=>void) | undefined
  function finishActiveSave(){
    activeSave=undefined
    resolveActiveSave?.()
    resolveActiveSave=undefined
  }
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
    documentOpened() { if(disposed)return; finishActiveSave(); guard.reset(); ticket = null; nativeSaveOutcome = 'none'; nativeSaveReasons = []; onChange() },
    edited() { if(disposed)return; guard.markEdited(); onChange() },
    async beforeSave() {
      if(disposed||takingOver)throw hostError('UNAVAILABLE','disposed or taking over')
      // The native queue may have waited after the download preflight. Do not
      // turn this action into implicit confirmation of an intervening save.
      if (downloading && (disposed || host.getState(fileId).status !== 'idle' || guard.getState().status === 'unknown')) throw hostError('UNAVAILABLE','download not ready')
      activeSave=new Promise(resolve=>{resolveActiveSave=resolve})
      nativeSaveOutcome = 'pending'; nativeSaveReasons = []
      if (guard.getState().status === 'unknown') {
        await host.reconcile(fileId,saveFence??(()=>true))
        if(disposed)throw hostError('UNAVAILABLE','disposed')
        if (ticket) guard.settleSave(ticket,'committed')
        ticket = null
      }
      wordVersion=await options.wordCheckpoint?.()
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
      finishActiveSave()
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
    ...browserEditorTheme(prefs),
    getAuthorName: async () => prefs.authorName ?? '',
    getAutoSaveDefault: async () => ({ on: prefs.autoSave ?? true,updatedAt: 1 }),
    getAiPanelPrefs: async () => ({...panelPrefs}),
    setAiPanelPrefs: async (patch: Partial<typeof panelPrefs>) => {panelPrefs={...panelPrefs,...patch};for(const listener of panelListeners)listener({...panelPrefs});return {...panelPrefs}},
    onAiPanelPrefsChanged: (listener:(value:typeof panelPrefs)=>void) => {panelListeners.add(listener);return()=>{panelListeners.delete(listener)}},
    onLanguageChanged: noEvent,onAuthorNameChanged: noEvent,onAutoSaveDefaultChanged: noEvent,
    onOpenDocx: noEvent,onRenamedDocx: noEvent,onTeardown: noEvent,onViewImage: noEvent,onContextMenuRequest: noEvent,onCloseCheck: noEvent,onCloseSaveRequest: noEvent,
    onMenuCommand(listener:Parameters<DesktopApi['onMenuCommand']>[0]){
      return subscribeBrowserDocumentCommands({print:()=>listener('print'),save:()=>listener('save'),'save-as':()=>listener('save-as'),
        'zoom-in':()=>listener('zoom-in'),'zoom-out':()=>listener('zoom-out'),'zoom-reset':()=>listener('zoom-100'),
      },()=>!disposed&&host.getState(fileId).status!=='unauthorized')
    },
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
      const ref = host.getState(fileId).revision
      const bytes=options.takeUnlockedBytes?options.takeUnlockedBytes():await host.readBytes(fileId,ref.revision)
      if(!bytes)throw hostError('UNAVAILABLE','document unlock')
      const dataUrl = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer],{ type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }))
      urls.add(dataUrl)
      return { path: alias,name: state.name,dataUrl,hash: ref.sha256,...(options.takeUnlockedBytes?{encrypted:true}:{}) }
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
    async pickComparisonDocx(){
      if (disposed || host.getState(fileId).status === 'unauthorized') return null
      const [file] = await pickLocalFiles('.docx', lifetime.signal)
      if (!file || disposed) return null
      if (!/\.docx$/i.test(file.name) || !file.size || file.size > 32 * 1024 * 1024) {
        throw new Error(locale === 'en' ? 'Choose a nonempty DOCX up to 32 MiB.' : '请选择不超过 32 MiB 的非空 DOCX。')
      }
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (disposed || host.getState(fileId).status === 'unauthorized') return null
      return { name: file.name, bytes }
    },
    async saveDocxAs(_currentPath: string | null, data: ArrayBuffer) {
      const name = host.getState(fileId).name
      download(new Blob([data],{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}),name)
      return {ok:true as const,path:alias,name}
    },
    saveDocxNew: unavailable,saveDocxTo: unavailable,
    async setDocPassword(path,password){
      return {ok:!disposed&&path===alias&&options.setOpenPassword?.(password)===true}
    },
    writeRecoveryCopy: unavailable,
    async pickImage(){
      if(disposed)return null
      const [file]=await pickLocalFiles('.png,.jpg,.jpeg,.gif,image/png,image/jpeg,image/gif',lifetime.signal)
      if(!file||disposed)return null
      if(!file.size||file.size>16*1024*1024)throw Error(text.unavailable)
      const bytes=new Uint8Array(await file.arrayBuffer())
      if(disposed||host.getState(fileId).status==='unauthorized')return null
      const image=imageSize(bytes)
      if(!image)throw Error(text.unavailable)
      return {name:file.name,mime:image.mime,base64:bytesBase64(bytes)}
    },
    fetchImage: unavailable,
    async fetchClipboardImage(src:string){
      if(disposed||host.getState(fileId).status==='unauthorized')return null
      const image=await fetchDocsClipboardImage(src,options.fetchClipboardRemoteImage,lifetime.signal)
      return disposed||host.getState(fileId).status==='unauthorized'?null:image
    },
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
          pageStyle.textContent = browserPrintPaperCss(window.document, geometry)
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
    async exportHtml(name:string,html:string,outputName?:string){
      if(disposed)return {ok:false,error:text.unavailable}
      const base=outputName?.replace(/\.html?$/i,'')??name.replace(/\.docx$/i,'')
      const filename=browserFileName(base,'Document')+'.html'
      download(new Blob([html],{type:'text/html;charset=utf-8'}),filename)
      return {ok:true,path:filename}
    },
    exportPdf: unavailable,
    async exportMarkdown(name:string,md:string,images?:Parameters<DesktopApi['exportMarkdown']>[2],outputName?:string){
      if(disposed)return {ok:false,error:text.unavailable}
      try{
        const base=outputName?.replace(/\.md$/i,'')??name.replace(/\.docx$/i,'')
        const file=await prepareMarkdownDownload(base,md,images ?? [],window.location.origin)
        if(disposed)return {ok:false,error:text.unavailable}
        download(file.blob,file.name)
        return images === undefined ? {ok:true} : {ok:true,path:file.name,imagesDropped:file.imagesDropped}
      }catch(error){return {ok:false,error:error instanceof RangeError?error.message:text.unavailable}}
    },
    pickExportImagesTarget: unavailable,printPdfBuffer: unavailable,
    async pickMergeDataSource(){
      if(disposed)return null
      try{
        const [file]=await pickLocalFiles('.csv,.xlsx',lifetime.signal)
        if(!file)return null
        const {readMailMergeSource}=await import('./docs-mail-merge')
        return {ok:true,source:await readMailMergeSource(file,prefs.language,lifetime.signal)}
      }catch(error){
        if(disposed)return null
        return {ok:false,error:error instanceof Error?error.message:text.unavailable}
      }
    },
    async writeMergeOutput(request){
      if(disposed||!host.getState(fileId).lease)return {ok:false,canceled:true}
      const {downloadMailMerge}=await import('./docs-mail-merge')
      return downloadMailMerge(request,host.getState(fileId).name,lifetime.signal)
    },
    zoteroCommand: unavailable,
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
  return { api,lifecycle,resolveKnowledgeCitation:knowledge.citationPath,get supportedCreateDocumentTypes() {return typeof createInWorkspace() === 'function' ? ['docx', 'pdf'] as const : []},guardedSave,takeover,prepareDownload,waitForSave:()=>activeSave,getReceipt:()=>committed,getState: () => ({...guard.getState(), nativeSaveOutcome, nativeSaveReasons, takingOver}),dispose() { knowledge.dispose(); completeGeneratedContent(false); disposed = true; lifetime.abort(); finishActiveSave(); panelListeners.clear(); for (const url of urls) URL.revokeObjectURL(url); urls.clear() } }
}
