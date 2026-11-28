import {mountDocumentHandoff} from './document-handoff'
import {createRoot} from 'react-dom/client'
import {useLayoutEffect} from 'react'
import {installScreenTips} from '@genoffice/ui'
import type {AgentSkill} from '@genoffice/agent-core'
import App,{type PdfAssistantView,type PdfHostConversionDraft,type PdfHostLifecycle,type PdfHostSaveCopy} from '../../../pdf/src/renderer/App'
import {PDF_NAV_SCHEME,parsePdfNavHref} from '../../../pdf/src/renderer/ai/pdf-nav'
import {AGENT_TOOLS,deleteInsertedTextTool,editBlock,editInsertedTextTool,editText,insertTextTool,listInsertedTextTool,markupText,moveInsertedTextTool,moveTextBlockTool,searchText} from '../../../pdf/src/renderer/ai/tools'
import {addNoteTool,deleteMarkupTool,deleteNoteTool,editNoteTool,readAnnotations,replyNoteTool} from '../../../pdf/src/renderer/ai/tools'
import {applyOpsTool,getOutlineTool,insertBlankPageTool,listFormFields,setHeaderFooterTool,setWatermarkTool} from '../../../pdf/src/renderer/ai/tools'
import {validatePdfStampOperation} from '../../../../packages/web-contracts/src/pdf-stamp-ops'
import {isPdfAttachmentName,MAX_PDF_ATTACHMENT_ADDITIONS,MAX_PDF_ATTACHMENT_BYTES} from '../../../../packages/web-contracts/src/pdf-attachment-limits'
import {deleteImageTool,insertImageTool,listPageImagesTool,replaceImageTool,rotateImageTool,sortImageRefs,transformImageTool} from '../../../pdf/src/renderer/ai/tools'
import {viewToPdf} from '../../../pdf/src/renderer/annotations'
import {findPatternsInIndex} from '../../../pdf/src/renderer/search'
import {isScannedText} from '../../../pdf/src/renderer/ocr-layer'
import {REDACT_PATTERNS,type RedactPattern} from '../../../pdf/src/renderer/redact-patterns'
import type {PageImageRef,RedactionInput} from '../../../pdf/src/shared/ipc'
import type {PdfHostImageBake} from '../../../pdf/src/shared/ipc'
import {fileToCanvas} from '../../../pdf/src/renderer/SignatureDialog'
import {inspectPdfImageDraftBytes} from './pdf-image-draft-pixels'
import {normalizePdfGeneratedImage} from './pdf-generated-image'
import {LocaleProvider} from '../../../pdf/src/renderer/i18n/locale'
import {EDIT_FONTS,type PdfApi,type PdfBrowserPrintPage,type PdfConvertFormat,type PdfPageGeometryOperation} from '../../../pdf/src/shared/ipc'
import {openNativePdfBrowserFile} from './native-pdf-browser-file'
import {MAX_PDF_DRAFT_BLANK_PAGES,MAX_PDF_EDIT_PAGES} from '../../shared/pdf-edit-structure.mjs'
import {loadEditorAssistant,editorAssistantNotice} from './editor-assistant-status'
import {resolveTurnImageAttachment,SharedEditorAssistant} from './shared-editor-assistant'
import {createEditorBridge} from '../../../../packages/browser-host/src/editor-bridge'
import type {AnalysisDocumentTarget,AnalysisTargetCapture} from '../../../../packages/web-contracts/src/analysis-document'
import {createEditorCloseLifecycle,installEditorCloseLifecycle} from './editor-close-lifecycle'
import {reportDocumentLoading,reportDocumentOpenError,registerDisplayedRevision,type DocumentLoadingState} from './document-loading-state'
import {createPdfCreateDocumentSkill,createPdfDocumentCreator,type PreparedAiDocumentCreator} from '../shell/pdf-create-document-skill'
import {createNativePdfPageCopies} from './native-pdf-page-copies'
import type {PdfRedactionReview} from './pdf-redactions'
import {browserFileName,decodeBrowserBase64,downloadBrowserFile} from './browser-download'
import {confirmWorkspaceCopy} from './web-ai-naming'
import {printInBrowser} from './browser-print'
import {subscribeBrowserDocumentCommands,workspaceOpenAction} from './browser-document-command'
import {pickLocalFiles} from './pick-local-files'
import {createBrowserPdfCertificate} from './pdf-certificate'
import {createBrowserPdfSavedSignatures} from './pdf-saved-signatures'
import {selectPdfToInsert,selectReplacementPdf} from './native-pdf-replacement'
import {PDF_PAPER_SIZES,parsePdfPageRanges} from '../shell/pdf-page-inputs'
import {validatePdfPageOperations} from '../../../../packages/web-contracts/src/pdf-page-ops'
import type {RevisionRef} from '../../../../packages/web-contracts/src/api'
import '@genoffice/ui/tokens.css'
import '@genoffice/ui/screentip.css'
import '@genoffice/ui/ribbon-collapse.css'
import '../../../pdf/src/renderer/styles.css'
import '@genoffice/ui/ai-panel-prefs.css'
import {installBrowserAssistantPreferences} from './browser-assistant-appearance'
import './native-pdf-assistant.css'

const element=document.getElementById('root')!
installEditorCloseLifecycle(window,{canClose:async()=>false,dispose:async()=>false})
reportDocumentLoading('reading')
async function mount(){
 const openWorkspaceFile=workspaceOpenAction()
 const params=new URLSearchParams(location.search),fileId=params.get('fileId')??''
 const grant=await openNativePdfBrowserFile({fileId,editorId:params.get('guest')==='1'?params.get('editorId')??undefined:undefined,expectedRevision:params.get('sourceRevision')??undefined})
 const browserActions=new AbortController()
 const [prefs,account]=await Promise.all([
  grant.getPreferences().catch(()=>undefined),
  params.get('guest')==='1'?undefined:grant.accountIdentity(browserActions.signal).catch(()=>undefined),
 ])
 const appearance=await installBrowserAssistantPreferences(prefs)
 const lastZoomStorage={
  getItem:(key:string)=>account?localStorage.getItem(`${key}:${account.join(':')}`):null,
  setItem(key:string,value:string){
   if(account&&(window.parent===window||window.frameElement?.getClientRects().length))localStorage.setItem(`${key}:${account.join(':')}`,value)
  },
 }
 const inspectDocument=async(bytes:Uint8Array,encrypted:boolean)=>{
  grant.inspectSignatureMarker(bytes,encrypted)
  const {inspectNativePdf}=await import('./native-pdf-edit-restriction')
  return inspectNativePdf(bytes,encrypted,prefs?.language??'zh')
 }
 if(prefs){
  document.documentElement.lang=prefs.language
  if(prefs.theme==='system')delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme=prefs.theme
 }
 const unsubscribe=()=>()=>{}
 const empty=async()=>[]
 let disposed=false,view:PdfAssistantView|undefined
 const certificate=createBrowserPdfCertificate({
  path:grant.path,signal:browserActions.signal,current:grant.current,readPdf:grant.api.readFile,
  canSign:()=>isClean()&&!ribbonBusy&&!ribbonPending&&!redacting&&!review?.candidates.length,
 })
 const pageCopyName=(value:string|undefined,fallback:string)=>{
  const points=Array.from(browserFileName(value?.replace(/\.pdf$/i,'')??'',fallback).replace(/[\p{Cs}\u202a-\u202e\u2066-\u2069]/gu,'_'))
  const encoder=new TextEncoder()
  while(encoder.encode(points.join('')+'.pdf').length>255)points.pop()
  return points.join('')+'.pdf'
 }
 const api={
  ...grant.api,...certificate,...createBrowserPdfSavedSignatures(grant.accountIdentity,browserActions.signal),
  getUsername:grant.username,getDefaultZoom:async()=>prefs?.pdfDefaultZoom??'width',
  listEditFonts:empty,listPrinters:empty,
  onLanguageChanged:unsubscribe,onUsernameChanged:unsubscribe,onFileRenamed:unsubscribe,onSaveAsFlow:unsubscribe,
  onCloseSaveRequest:unsubscribe,onSaveAsRequest:unsubscribe,onChromePressed:unsubscribe,
  onPrintRequest:(listener:()=>void)=>subscribeBrowserDocumentCommands({print:listener},()=>!disposed),
  async printBrowserPages(pages:readonly PdfBrowserPrintPage[]){
   if(disposed||!pages.length||pages.some(({src,widthPt,heightPt})=>
    !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(src)||
    !Number.isFinite(widthPt)||widthPt<=0||!Number.isFinite(heightPt)||heightPt<=0)){
    throw Error(prefs?.language==='en'?'PDF printing is unavailable.':'PDF 打印不可用。')
   }
   const paper=pages.map(({widthPt,heightPt},index)=>`@page sheet-${index}{size:${widthPt}pt ${heightPt}pt;margin:0}`).join('')
   const sheets=pages.map(({src,widthPt,heightPt},index)=>
    `<section style="page:sheet-${index};width:${widthPt}pt;height:${heightPt}pt"><img src="${src}"></section>`).join('')
   const html=`<!doctype html><style>${paper}body{margin:0}section{break-inside:avoid;overflow:hidden}section+section{break-before:page}img{display:block;width:100%;height:100%;object-fit:contain}</style>${sheets}`
   await printInBrowser(html,grant.path.split('/').pop()??'document.pdf')
  },
  async compareReadPdf(){
   try{
    const [file]=await pickLocalFiles('application/pdf,.pdf',browserActions.signal)
    if(!file)return {ok:false as const,canceled:true as const}
    if(!file.size||file.size>64*1024*1024)throw Error('PDF exceeds the comparison size limit.')
    const {readPdfComparisonPages}=await import('./pdf-browser-actions')
    const pages=await readPdfComparisonPages(new Uint8Array(await file.arrayBuffer()),undefined,browserActions.signal)
    return {ok:true as const,name:file.name,pageCount:pages.length,pages}
   }catch(error){return {ok:false as const,reason:error instanceof Error?error.message:String(error)}}
  },
  async compareReadOpen(path:string,password?:string){
   try{
    const base=grant.current()
    const {readPdfComparisonPages}=await import('./pdf-browser-actions')
    const pages=await readPdfComparisonPages(new Uint8Array(await grant.api.readFile(path)),password,browserActions.signal)
    if(base!==grant.current())throw Error('The PDF changed during comparison.')
    return {ok:true as const,name:grant.path.split('/').at(-1)!,pageCount:pages.length,pages}
   }catch(error){return {ok:false as const,reason:error instanceof Error?error.message:String(error)}}
  },
  async exportImages(request:Parameters<PdfApi['exportImages']>[0]){
   try{
    const {downloadPdfImages}=await import('./pdf-browser-actions')
    const archive=await downloadPdfImages(request,browserActions.signal)
    return {ok:true as const,savedDir:archive,count:request.images.length}
   }catch(error){return {ok:false as const,error:error instanceof Error?error.message:String(error)}}
  },
  async pickAttachmentFile(pending={count:0,bytes:0}){
   try{
    const zh=prefs?.language==='zh'
    if(pending.count>=MAX_PDF_ATTACHMENT_ADDITIONS){
     throw Error(zh?`一次最多新增 ${MAX_PDF_ATTACHMENT_ADDITIONS} 个附件。`:`Add up to ${MAX_PDF_ATTACHMENT_ADDITIONS} attachments per save.`)
    }
    const [file]=await pickLocalFiles('',browserActions.signal)
    if(!file)return {ok:false as const,cancelled:true as const}
    if(!isPdfAttachmentName(file.name))throw Error(zh?'请选择名称有效的附件。':'Choose an attachment with a valid name.')
    if(file.size+pending.bytes>MAX_PDF_ATTACHMENT_BYTES){
     const limit=MAX_PDF_ATTACHMENT_BYTES/(1024*1024)
     throw Error(zh?`本次新增附件的总大小不能超过 ${limit} MiB。`:`New attachments can total up to ${limit} MiB per save.`)
    }
    const bytes=new Uint8Array(await file.arrayBuffer())
    browserActions.signal.throwIfAborted()
    const parts:string[]=[]
    for(let offset=0;offset<bytes.length;offset+=32768)parts.push(String.fromCharCode(...bytes.subarray(offset,offset+32768)))
    return {ok:true as const,name:file.name,bytesBase64:btoa(parts.join(''))}
   }catch(error){return {ok:false as const,reason:error instanceof Error?error.message:String(error)}}
  },
  async exportAttachment(path:string,name:string,data:string){
   try{
    browserActions.signal.throwIfAborted()
    if(path!==grant.path||data.length>64*1024*1024)throw Error('PDF attachment is unavailable or too large.')
    const targetPath=browserFileName(name,'attachment')
    downloadBrowserFile(new Blob([decodeBrowserBase64(data)],{type:'application/octet-stream'}),targetPath)
    return {ok:true as const,targetPath}
   }catch(error){return {ok:false as const,reason:error instanceof Error?error.message:String(error)}}
  },
  async mergePdf(
   {path,suggestedName}:Parameters<PdfApi['mergePdf']>[0],
   flushDraft:()=>Promise<boolean>=async()=>true,
  ):ReturnType<PdfApi['mergePdf']>{
   const fail=(error:string)=>({ok:false as const,error})
   const canceled={ok:true as const,canceled:true as const}
   const signal=browserActions.signal
   if(path!==grant.path||disposed||ribbonBusy||ribbonPending||redacting||review?.candidates.length){
    return fail('A PDF merge is unavailable while another page operation is pending.')
   }
   const initial=grant.current()
   ribbonBusy=true
   try{
    const files=await pickLocalFiles('application/pdf,.pdf',signal,true)
    if(!files.length)return canceled
    const {preparePdfMerge,validatePdfMergeFiles}=await import('./pdf-merge-download')
    signal.throwIfAborted()
    validatePdfMergeFiles(files)
    if(grant.current()!==initial)return fail('The PDF changed while selecting files. Retry the merge.')
    if(!await flushDraft())return canceled
    const revision=grant.current()
    const unchanged=()=>grant.current()===revision&&isClean()&&!redacting&&!review?.candidates.length
    const {merged,appended}=await preparePdfMerge(await grant.api.readFile(path),files,signal)
    signal.throwIfAborted()
    if(!unchanged())return fail('The PDF changed during the merge. Retry the merge.')
    const filename=browserFileName(suggestedName.replace(/\.pdf$/i,''),'merged')+'.pdf'
    downloadBrowserFile(new Blob([merged],{type:'application/pdf'}),filename)
    return {ok:true,savedPath:filename,appendedCount:appended}
   }catch(error){
    return signal.aborted?canceled:fail(error instanceof Error?error.message:String(error))
   }finally{
    ribbonBusy=false
   }
  },
  setDirty(){},
  extractPages:({path,pages,suggestedName}:Parameters<PdfApi['extractPages']>[0])=>
   ribbonCopy(path,client=>client.extract(pages.map(page=>page+1),browserActions.signal,pageCopyName(suggestedName,'pages'))),
  splitPdf:async({path,chunkSize,baseName}:Parameters<PdfApi['splitPdf']>[0])=>{
   const signal=browserActions.signal,base=grant.current()
   const locale=prefs?.language==='en'?'en':'zh'
   let canceled=false
   const result=await ribbonCopy(path,async client=>{
    const chosen=await confirmWorkspaceCopy(baseName,{locale,signal,request:grant.workspaceRequest,fileId,batchPdf:true})
    if(!chosen){canceled=true;return false}
    if(disposed||base!==grant.current())throw Error('PDF copy authorization changed.')
    return client.split(chunkSize,signal,{name:pageCopyName(chosen.name,'split'),folderId:chosen.folderId})
   })
   if(canceled)return {ok:true as const,canceled:true as const}
   return result.ok?{ok:true as const,savedDir:'',count:copies!.getReceipts().length}:result
  },
  splitPages:({path,perPage,suggestedName}:Parameters<PdfApi['splitPages']>[0])=>
   ribbonCopy(path,client=>client.layout({kind:'split',perPage},browserActions.signal,pageCopyName(suggestedName,'split-pages'))),
  mergePages:({path,perSheet,direction,separator,suggestedName}:Parameters<PdfApi['mergePages']>[0])=>
   ribbonCopy(path,client=>client.layout({kind:'merge',perSheet,direction,separator},browserActions.signal,pageCopyName(suggestedName,'merged-pages'))),
 } satisfies Partial<PdfApi>
 const unavailable=async()=>{throw Error('PDF action is unavailable in this Web preview')}
 window.pdfApi=new Proxy<Partial<PdfApi>>(api,{get(target,key,receiver){
  return Reflect.has(target,key)?Reflect.get(target,key,receiver):unavailable
 }}) as PdfApi
 installScreenTips()
 const root=createRoot(element)
 let editor:PdfHostLifecycle|null=null,loading:DocumentLoadingState='reading'
 const unsubscribeSaveShortcuts=subscribeBrowserDocumentCommands(
  {save:()=>{void editor?.saveFromToolbar()},'save-as':()=>{void editor?.saveAsCopy()}},
  ()=>!disposed&&editor?.status==='ready',
 )
 let assistant:Awaited<ReturnType<typeof loadEditorAssistant>>['assistant']
 let realtime:ReturnType<typeof createEditorBridge>|undefined
 const copies=(()=>{
  try{
   const open=(window.parent as Window&{dyofficeOpenPdfCopy?:(receipt:RevisionRef,proof:string,signal?:AbortSignal)=>Promise<void>}).dyofficeOpenPdfCopy
   return open?grant.pageCopies(open):undefined
  }catch{return undefined}
 })()
 let ribbonBusy=false,ribbonPending=false,ribbonError=''
 async function ribbonCopy(path:string,run?:(client:NonNullable<typeof copies>)=>Promise<boolean>){
  const fail=(error:string)=>({ok:false as const,error})
  if(path!==grant.path||disposed||!copies||ribbonBusy||redacting)return fail('当前不能生成 PDF 副本。')
  if(run&&(copies.hasPending()||review?.candidates.length))return fail('请先确认待保存的副本，或清除涂黑候选。')
  if(!run&&!ribbonPending)return fail('没有待确认的 PDF 副本。')
  ribbonBusy=true;ribbonError=''
  try{
   const ok=run?await run(copies):await copies.confirm()
   if(!ok)return fail('当前不能生成 PDF 副本。')
   ribbonPending=false
   return {ok:true as const,savedPath:copies.getReceipts().at(-1)!.fileId}
  }catch(error){
   ribbonError=error instanceof Error?error.message:'无法确认 PDF 副本。'
   ribbonPending=copies.hasPending()
   return fail(ribbonError)
  }finally{
   ribbonBusy=false
   if(!disposed)render()
  }
 }
 const isClean=()=>{
  const state=editor?.state()
  return !disposed&&editor?.status==='ready'&&!!state&&!state.dirty&&!state.blocked
 }
 const canRewritePages=()=>!disposed&&!ribbonBusy&&!ribbonPending&&!redacting&&!review?.candidates.length
 async function preparePageSource(selection:{pages:readonly number[]}|{afterPageIndex:number}){
  if(!canRewritePages()||!isClean())return null
  const revision=grant.current(),signal=browserActions.signal
  const check=()=>canRewritePages()&&grant.current()===revision
  ribbonBusy=true
  try{
   if('pages' in selection){
    const source=await selectReplacementPdf(selection.pages,signal,prefs?.language)
    return source?()=>grant.writer.replacePages(selection.pages,source,check,signal):null
   }
   const source=await selectPdfToInsert(selection.afterPageIndex,signal,prefs?.language)
   return source?()=>grant.writer.insertPdf(selection.afterPageIndex,source,check,signal):null
  }finally{
   ribbonBusy=false
  }
 }
 const hostSave={
  ...grant.writer,
  savePageGeometry(operation:PdfPageGeometryOperation){
   const revision=grant.current()
   const check=()=>canRewritePages()&&grant.current()===revision
   return grant.writer.pageGeometry(operation,check,browserActions.signal)
  },
  preparePageReplacement:(pages:readonly number[])=>preparePageSource({pages}),
  preparePageImport:(afterPageIndex:number)=>preparePageSource({afterPageIndex}),
  revisionHistory:{
   current:()=>grant.current().revision,
   restore:(revision:string,baseRevision:string)=>grant.writer.restoreRevision(revision,
    ()=>canRewritePages()&&grant.current().revision===baseRevision,browserActions.signal),
  },
 }
 async function exportProtectedCopy(
  path:string,
  protection:import('../../../pdf/src/shared/ipc').PdfEncryptionInput,
  flushDraft:()=>Promise<boolean>,
 ):Promise<string|null>{
  const zh=prefs?.language==='zh'
  const unavailable=zh?'当前无法生成受保护副本。':'The protected copy is unavailable.'
  if(path!==grant.path||disposed||ribbonBusy||ribbonPending||redacting||review?.candidates.length) return unavailable
  const signal=browserActions.signal
  const initial=grant.current()
  ribbonBusy=true
  try{
   const {createProtectedPdfCopy,isCopyPasswordValid,needsDistinctOwnerPassword}=await import('./pdf-protected-copy')
   signal.throwIfAborted()
   if(!isCopyPasswordValid(protection.userPassword)||!isCopyPasswordValid(protection.ownerPassword)){
    return zh?'密码须为 1 至 127 个 UTF-8 字节，且不得包含空字符。':'Use 1 to 127 UTF-8 bytes for each password and omit NUL characters.'
   }
   if(needsDistinctOwnerPassword(protection)){
    return zh?'限制操作权限时，请使用不同的所有者密码。':'Use a distinct owner password to restrict permissions.'
   }
   if(grant.current()!==initial)return unavailable
   if(!await flushDraft())return zh?'待保存的编辑无法保存。':'Pending edits could not be saved.'
   const revision=grant.current()
   // The save returns before React necessarily publishes the cleared draft.
   // Check the revision and ready state after retrieving the committed bytes.
   const bytes=new Uint8Array(await grant.api.readFile(path))
   const unchanged=()=>grant.current()===revision&&isClean()&&!redacting&&!review?.candidates.length
   if(!unchanged())return unavailable
   const encrypted=await createProtectedPdfCopy(bytes,protection,signal)
   if(!unchanged())return unavailable
   const suggested=path.slice(path.lastIndexOf('/')+1).replace(/\.pdf$/i,'')+'-protected'
   downloadBrowserFile(new Blob([encrypted],{type:'application/pdf'}),browserFileName(suggested,'protected')+'.pdf')
   return null
  }catch{
   return unavailable
  }finally{
   ribbonBusy=false
  }
 }
 registerDisplayedRevision(()=>isClean()?grant.current().revision:undefined)
 const savedPageCount=()=>isClean()&&view?.canAppendReport()?view.doc?.numPages:undefined
 let review:PdfRedactionReview|undefined,selected=new Set<string>(),querySequence=0
 let confirming=false,redacting=false,recoverRedaction=false,recoverManual=false,reviewError=''
 function clearReview(){
  querySequence++;review=undefined;selected=new Set();confirming=false;reviewError=''
  render()
 }
 async function findRedactionCandidates(patterns:readonly RedactPattern[],signal?:AbortSignal){
  const canFind=()=>isClean()&&!redacting&&!!copies&&!copies.hasPending()
  if(!canFind())throw Error('请先保存或撤销 PDF 修改，并确认待处理的副本，再查找敏感信息。')
  const revision=grant.current(),sequence=++querySequence
  const result=await grant.queryRedactions(patterns,signal)
  signal?.throwIfAborted()
  if(sequence!==querySequence)return null
  if(grant.current()!==revision||!canFind())throw Error('PDF 状态已变化，请重新查找。')
  review=result;selected=new Set(result.candidates.map(candidate=>candidate.id));confirming=false;reviewError=''
  render()
  return result
 }
 async function publishRedaction(){
  if(!copies||redacting||!review)return
  if(!recoverRedaction){
   if(!confirming||!selected.size||review.truncated||copies.hasPending())return
   if(!isClean()||review.revision!==grant.current().revision){
    reviewError='PDF 有未保存修改或版本已变更。请保存或撤销修改后重新查找。';confirming=false;render();return
   }
  }
  redacting=true;reviewError='';render()
  try{
   const ok=recoverRedaction?await copies.confirm():await copies.redact({patterns:review.patterns,ids:[...selected]})
   if(!ok)reviewError='当前无法生成副本，请稍后核对。'
   else{recoverRedaction=false;clearReview()}
  }catch(error){
   recoverRedaction=copies.hasPending()
   reviewError=error instanceof Error?error.message:'涂黑副本保存失败。'
  }finally{
   redacting=false;confirming=false
   if(!disposed)render()
  }
 }
 async function publishManualRedaction(regions:RedactionInput[]){
  if(!copies||redacting||disposed)throw Error('当前不能生成涂黑副本。')
  if(!recoverManual&&(review||copies.hasPending()))throw Error('请先清除查找候选或确认待保存的副本。')
  redacting=true
  try{
   const ok=recoverManual?await copies.confirm():await copies.redact({regions})
   if(!ok)throw Error('当前不能生成涂黑副本。')
   recoverManual=false
   return true
  }catch(error){
   recoverManual=copies.hasPending()
   throw error
  }finally{
   redacting=false
   if(!disposed)render()
  }
 }
 const editorId=crypto.randomUUID(),conversationId=new URLSearchParams(location.search).get('channel')||undefined
 const onLifecycle=(next:PdfHostLifecycle|null)=>{
  editor=next
  if(!next)return
  const state=next.status==='ready'||next.status==='password'?'ready':next.status==='loading'?'rendering':'error'
  if(state!==loading){loading=state;reportDocumentLoading(state)}
 }
 const beforeUnload=(event:BeforeUnloadEvent)=>{
  const state=editor?.state()
  if(state?.dirty||state?.blocked||redacting||recoverRedaction||recoverManual||ribbonBusy||ribbonPending){event.preventDefault();event.returnValue=''}
 }
 function cleanup(){
  if(disposed)return
  disposed=true
  browserActions.abort()
  unsubscribeSaveShortcuts()
  window.removeEventListener('beforeunload',beforeUnload)
  closeHandoff();assistant?.dispose();root.unmount();realtime?.dispose();grant.dispose()
 }
 window.addEventListener('beforeunload',beforeUnload)
 window.addEventListener('pagehide',cleanup,{once:true})
 installEditorCloseLifecycle(window,createEditorCloseLifecycle({
  state:()=>{
   const state=editor?.state()??{dirty:false,blocked:loading==='reading'}
   return {...state,blocked:state.blocked||redacting||recoverRedaction||recoverManual||ribbonBusy||ribbonPending}
  },
  waitForSave:()=>editor?.waitForSave?.(),
  save:()=>editor?.saveForClose()??Promise.resolve(false),
  release:async()=>{},cleanup,
  confirm:()=>window.confirm('PDF 有未保存修改。保存并关闭？'),
  notify:()=>window.alert('PDF 保存尚未完成，请在文档中核对保存结果。'),
 }))
 let captured:AnalysisTargetCapture|undefined,applied:{id:string;matches:()=>boolean}|undefined
 const target:AnalysisDocumentTarget={
  fileId,format:'pdf',
  capture(){
   if(disposed||!view?.canAppendReport())throw Error('Save or discard PDF changes first.')
   applied=undefined
   return captured=Object.freeze({token:crypto.randomUUID(),fileId,format:'pdf',baseRevision:grant.current().revision})
  },
  async apply(capture,content,_artifact,authorized){
   if(disposed||capture!==captured||capture.baseRevision!==grant.current().revision||!authorized()||content.kind!=='text')throw Error('PDF insertion unavailable')
   captured=undefined
   const measure=document.createElement('canvas').getContext('2d')!
   measure.font='11px sans-serif'
   const lines=content.text.replace(/\r\n?/g,'\n').replace(/\t/g,'    ').split('\n').flatMap(line=>{
    const wrapped:string[]=[]
    let part=''
    for(const ch of line){
     if(part&&measure.measureText(part+ch).width>500){wrapped.push(part);part=''}
     part+=ch
    }
    return [...wrapped,part]
   })
   const sections=Array.from({length:Math.ceil(lines.length/47)},(_,i)=>lines.slice(i*47,(i+1)*47).join('\n').trimEnd()).filter(section=>section.trim())
   if(sections.length>MAX_PDF_DRAFT_BLANK_PAGES)throw Error('PDF report exceeds the page limit')
   const matches=view?.appendReport(sections)
   if(!matches)throw Error('PDF draft changed or report cannot be appended')
   const applicationId=crypto.randomUUID()
   applied={id:applicationId,matches}
   return {status:'applied_uncommitted',applicationId}
  },
  async save(applicationId,authorized){
   const application=applied,before=grant.current(),doc=view?.doc
   const check=()=>!disposed&&authorized()&&!!application&&applied===application&&view?.doc===doc&&application.matches()&&grant.current()===before
   if(application?.id!==applicationId||!check())return {status:'not_confirmed',reason:'newer_edits'}
   if(!await view?.saveReport(check))return {status:'not_confirmed',reason:'unknown'}
   const receipt=grant.current()
   if(receipt===before||!authorized())return {status:'not_confirmed',reason:'unknown'}
   applied=undefined
   return {status:'saved',applicationId,receipt}
  },
  dispose(){captured=undefined;applied=undefined},
 }
 const insertActions={
  list_inserted_text:listInsertedTextTool,edit_inserted_text:editInsertedTextTool,
  move_inserted_text:moveInsertedTextTool,delete_inserted_text:deleteInsertedTextTool,
 }
 const annotationActions={
  read_annotations:readAnnotations,add_note:addNoteTool,reply_note:replyNoteTool,
  edit_note:editNoteTool,delete_note:deleteNoteTool,delete_markup:deleteMarkupTool,
 }
 const textToolNames=new Set(['search_text','find_sensitive_info','markup_text','edit_text','edit_block','move_text_block','insert_text',...Object.keys(insertActions),...Object.keys(annotationActions)])
 const stampTools=new Set(['set_watermark','set_header_footer'])
 const imageBakeTools=new Set(['flip_image','crop_image','set_image_opacity','remove_image_background'])
 const imageTools=new Set(['list_page_images','insert_image','transform_image','rotate_image','replace_image','delete_image',...imageBakeTools])
 const readTools=new Set(['read_pages','goto_page','search_text','find_sensitive_info','read_annotations','list_form_fields','get_outline'])
 const pdfSkill:AgentSkill={
  id:'native-pdf',
  systemPrompt:'Find passages with search_text and read the relevant pages before answering. When the user refers to selected text, use the supplied selection as the target unless the user asks for a wider scope. Page numbers follow the current visible order except apply_ops, list_form_fields and insert_blank_page, which use original page numbers. Cite document passages using current visible page numbers as [p.N](pdfnav://page/N). goto_page changes only the view.',
  tools:[
   {name:'read_pages',description:'Read text on one or more visible PDF pages, up to 10 pages. Scan-only pages use OCR when local recognition is available.',inputSchema:{type:'object',properties:{start:{type:'integer',minimum:1},end:{type:'integer',minimum:1}},required:['start']}},
   {name:'goto_page',description:'Navigate to a visible PDF page.',inputSchema:{type:'object',properties:{page:{type:'integer',minimum:1}},required:['page']}},
   ...AGENT_TOOLS.filter(tool=>textToolNames.has(tool.name)).map(tool=>tool.name==='find_sensitive_info'?{
    ...tool,description:'Find sensitive information in extracted PDF text. Returns matches with visible page numbers. No OCR is performed.'+(copies?' Use mark=true to open the candidate review on the saved PDF. Only the user can confirm permanent redaction to a separate copy.':''),
    inputSchema:{type:'object',additionalProperties:false,properties:{patterns:{type:'array',uniqueItems:true,items:{type:'string',enum:[...REDACT_PATTERNS]}},...(copies?{mark:{type:'boolean'}}:{})}},
   }:tool),
   ...AGENT_TOOLS.filter(tool=>tool.name==='insert_blank_page'||tool.name==='get_outline'),
   ...AGENT_TOOLS.filter(tool=>tool.name==='replace_pages').map(tool=>({
    ...tool,description:'Replace the selected saved PDF pages with all pages of a PDF chosen and confirmed by the user. Use a 1-based range such as "1-3,5". Requires a clean editor and saves a new revision. Re-read the new page order after success.',
   })),
   ...AGENT_TOOLS.filter(tool=>tool.name==='set_page_size'||tool.name==='crop_pages').map(tool=>({
    ...tool,description:(tool.name==='crop_pages'
     ?'Crop selected saved PDF pages to the kept fractions from the displayed top-left corner. Hidden content remains; this is not redaction.'
     :'Resize all saved PDF pages to a paper preset or width and height in points, scaling content to fit.')
     +' Requires a clean editor and user confirmation. Saves a new revision; re-read the updated pages after success.',
   })),
   ...AGENT_TOOLS.filter(tool=>imageTools.has(tool.name)).map(tool=>{
    if(tool.name!=='insert_image'&&tool.name!=='replace_image')return tool
    return {...tool,description:tool.description+' If the user wants to use a current attached image, pass its listed attachment:// reference as url; no image search or generation is needed.',
     inputSchema:{...tool.inputSchema,properties:{...(tool.inputSchema.properties as Record<string,unknown>),url:{type:'string',description:'Current message image attachment reference, or a direct image URL from image_search or generate_image.'}}}}
   }),
   ...AGENT_TOOLS.filter(tool=>stampTools.has(tool.name)).map(tool=>({
    ...tool,description:tool.name==='set_watermark'
     ?'Draft a managed watermark on every page. Pass empty text to clear a managed watermark. The change takes effect on save.'
     :'Draft a managed header and footer on every page. Text accepts {page} and {total}. Set page_number for page numbers in the footer center. Empty slots and page_number false clear the managed header and footer. The change takes effect on save.',
   })),
   ...AGENT_TOOLS.filter(tool=>tool.name==='apply_ops'||tool.name==='list_form_fields').map(tool=>({
    ...tool,description:tool.name==='apply_ops'
     ?tool.description.replace("Page numbers are the document's 1-based numbers like every other tool","Use original 1-based page numbers, even after an unsaved reorder")
     :tool.description+' Page numbers refer to original positions before unsaved reorders.',
   })),
   ...AGENT_TOOLS.filter(tool=>tool.name==='add_form_mark'),
  ],
  buildContext(){
   const current=view
   if(!current?.doc||current.pages[current.currentPage-1]===undefined)return ''
   const context=`The user is viewing visible page ${current.currentPage} of ${current.pages.length}.`+
    (current.editRestriction?` The current PDF is read only: ${current.editRestriction}. Explain the restriction if asked to edit it.`:'')
   const selection=current.selection
   if(!selection?.text.trim())return context
   const pages=selection.pages.map(page=>current.pages.indexOf(page)+1).sort((a,b)=>a-b)
   if(!pages.length||pages[0]===0)return context
   const where=pages.length===1?`visible page ${pages[0]}`:`visible pages ${pages.join(', ')}`
   const text=selection.text.length>12_000?`${selection.text.slice(0,12_000)}…`:selection.text
   return `${context}\nThe user has selected the following text on ${where}:\n"""\n${text}\n"""`
  },
  async executeTool(call,signal){
   const current=view,doc=current?.doc
   const invalid=(output:string)=>({output,summary:call.name,isError:true,mutated:false})
   if(!current||!doc)return invalid('The PDF is not ready.')
   if(current.editRestriction&&(!readTools.has(call.name)||call.name==='find_sensitive_info'&&call.input.mark===true))return invalid(current.editRestriction)
   const samePages=()=>view?.doc===doc&&view.pages===current.pages
   if(call.name==='find_sensitive_info'){
    const {patterns,mark}=call.input
    if(Object.keys(call.input).some(key=>key!=='patterns'&&(key!=='mark'||!copies))||
     mark!==undefined&&typeof mark!=='boolean'||
     patterns!==undefined&&(!Array.isArray(patterns)||patterns.some(value=>!REDACT_PATTERNS.includes(value as RedactPattern))))return invalid('Use only the offered sensitive information search options.')
    const requested=Array.isArray(patterns)&&patterns.length?[...new Set<RedactPattern>(patterns)]:REDACT_PATTERNS
    if(mark===true){
     try{
      const result=await findRedactionCandidates(requested,signal)
      if(!result)return invalid('Another redaction review replaced this request.')
      return {output:`Opened review with ${result.candidates.length} candidate(s). ${result.truncated?'The list is incomplete; narrow the search before creating a copy. ':'Only the user can approve and generate a separate redacted copy. '}No redaction has been applied.`,summary:'Review sensitive information',mutated:false}
     }catch(error){signal?.throwIfAborted();return invalid(error instanceof Error?error.message:'Could not locate redaction candidates.')}
    }
    const index=await current.sourceTextIndex()
    signal?.throwIfAborted()
    if(!index||!samePages())return invalid('The PDF changed. Read the current pages again.')
    const matches=findPatternsInIndex(current.pages.map(i=>index[i]??{text:'',lower:'',items:[]}),requested)
    const lines=matches.slice(0,60).map(hit=>`Page ${hit.pageIndex+1} [${hit.pattern}]: ${hit.text.replace(/\s+/g,' ')}`)
    if(matches.length>60)lines.push('Only the first 60 matches are shown.')
    return {output:(lines.join('\n')||'No matches found.')+'\nSearched extracted text only. No OCR or redactions were applied.',summary:'Find sensitive information',mutated:false}
   }
   if(call.name==='replace_pages'){
    const pages=parsePdfPageRanges(call.input.pages,doc.numPages)
    if(!pages||Object.keys(call.input).length!==1)return invalid('Select existing pages using a range such as 1-3,5.')
    if(!current.canAppendReport())return invalid('Save or discard PDF changes before replacing pages.')
    const revision=grant.current()
    const check=()=>!disposed&&!signal?.aborted&&view?.doc===doc&&grant.current()===revision
    const source=await selectReplacementPdf(pages,signal)
    signal?.throwIfAborted()
    if(!source)return invalid('The user canceled PDF page replacement.')
    if(!await view?.savePageRewrite(()=>grant.writer.replacePages(pages,source,check,signal),check))return invalid('PDF page replacement was not confirmed. Check the editor save status before retrying.')
    return {output:'Replaced the selected pages and saved a new revision. Re-read the updated page order.',summary:'Replace PDF pages',mutated:true}
   }
   if(call.name==='crop_pages'||call.name==='set_page_size'){
    const crop=call.name==='crop_pages',input=call.input
    let operation:PdfPageGeometryOperation
    try{
     const keys=Object.keys(input)
     if(keys.some(key=>!(crop?['pages','left','top','right','bottom']:['preset','width','height']).includes(key)))throw Error('Invalid fields')
     if(!crop&&input.preset!==undefined&&(input.width!==undefined||input.height!==undefined))throw Error('Choose one paper size')
     const preset=PDF_PAPER_SIZES.find(size=>size.label.toLowerCase()===String(input.preset).toLowerCase())
     if(!crop&&input.preset!==undefined&&!preset)throw Error('Unknown paper size')
     operation=validatePdfPageOperations([crop
      ?{op:'cropPages',pages:parsePdfPageRanges(input.pages,doc.numPages),left:input.left,top:input.top,right:input.right,bottom:input.bottom}
      :{op:'setPageSize',width:preset?.width??input.width,height:preset?.height??input.height}],doc.numPages)[0] as PdfPageGeometryOperation
    }catch{return invalid('Invalid PDF page geometry. Choose a paper preset or both dimensions in points; use a smaller kept rectangle and valid page range for cropping.')}
    if(!current.canAppendReport())return invalid('Save or discard PDF changes before changing page geometry.')
    const revision=grant.current()
    const check=()=>!disposed&&!signal?.aborted&&view?.doc===doc&&grant.current()===revision
    if(!check())return invalid('The PDF is no longer current.')
    const message=operation.op==='cropPages'
     ?`裁剪第 ${operation.pages.join('、')} 页（保留区域：左 ${operation.left*100}%，上 ${operation.top*100}%，右 ${operation.right*100}%，下 ${operation.bottom*100}%）并保存新版本？隐藏内容仍会保留。`
     :`将所有页面调整为 ${operation.width} × ${operation.height} 磅并保存新版本？`
    if(!window.confirm(message))return invalid('The user canceled the PDF page adjustment.')
    if(!await view?.savePageRewrite(()=>grant.writer.pageGeometry(operation,check,signal),check))return invalid('The page adjustment was not confirmed. Check the editor save status before retrying.')
    return {output:crop?'Cropped the selected pages and saved a new revision. Hidden content remains.':'Resized all pages and saved a new revision.',summary:call.name,mutated:true}
   }
   if(imageTools.has(call.name)){
    const revision=grant.current(),url=call.input.url
    const attachedImage=typeof url==='string'?resolveTurnImageAttachment(url,signal):undefined
    if(call.name==='insert_image'||call.name==='replace_image'){
     if(typeof url!=='string'||url.length>8192)return invalid('Use an image reference from the current message or an HTTP image URL.')
     if(url.startsWith('attachment://')&&!attachedImage)return invalid('This image reference is unavailable. Use an attachment from the current message.')
     if(!attachedImage&&!/^https?:\/\//.test(url))return invalid('Use an image reference from the current message or an HTTP image URL.')
    }
    const stillCurrent=()=>!signal?.aborted&&samePages()&&grant.current()===revision
    const canEdit=()=>stillCurrent()&&!!view?.canEdit()
    const original=(ref:PageImageRef)=>({...ref,pageIndex:current.pages[ref.pageIndex]!})
    let refs:PageImageRef[]=[]
    const savedRefs=new Map<PageImageRef,{number:number;rotation:number}>()
    const checkTarget=(ref:PageImageRef)=>{
     if(!canEdit()||refs.filter(item=>item.pageIndex===ref.pageIndex&&item.rect.every((value,index)=>Math.abs(value-ref.rect[index]!)<=2)).length!==1)
      throw Error('The image position is ambiguous or the PDF changed.')
     return original(ref)
    }
    const deps={
     readOnly:()=>!canEdit(),pageCount:()=>current.pages.length,isDeleted:()=>false,
     pageGeom:(page:number)=>view?.pageGeom(current.pages[page]!)??null,
     async listImages(){
      const images=await grant.listImages(signal),geometries=new Map<number,Awaited<ReturnType<typeof doc.getPage>>>()
      refs=[]
      savedRefs.clear()
      for(const image of images){
       const pageIndex=current.pages.indexOf(image.page-1)
       if(pageIndex<0)continue
       const saved=geometries.get(image.page)??await doc.getPage(image.page)
       geometries.set(image.page,saved)
       const [x0,y0,x1,y1]=saved.view
       const geom={x0,y0,pw:(x1-x0)*saved.userUnit,ph:(y1-y0)*saved.userUnit,userUnit:saved.userUnit,rot:saved.rotate}
       const a=viewToPdf(geom,image.x,image.y),b=viewToPdf(geom,image.x+image.width,image.y+image.height)
       const ref:PageImageRef={pageIndex,rect:[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[0],b[0]),Math.max(a[1],b[1])],aboveText:image.layer==='above_text'}
       refs.push(ref)
       savedRefs.set(ref,{number:image.image_number,rotation:saved.rotate})
      }
      if(!stillCurrent())throw Error('The PDF changed during image lookup.')
      return refs
     },
     isImageClaimed:(ref:PageImageRef)=>!!view?.existingImageApi.isImageClaimed(original(ref)),
     transformImage(...[ref,...args]:Parameters<PdfAssistantView['existingImageApi']['transformImage']>){view!.existingImageApi.transformImage(checkTarget(ref),...args)},
     replaceImage(ref:PageImageRef,png:string){view!.existingImageApi.replaceImage(checkTarget(ref),png)},
     deleteImage(ref:PageImageRef){view!.existingImageApi.deleteImage(checkTarget(ref))},
     searchIndex(){
      const index=current.searchIndex()
      return index?.then(pages=>current.pages.map(page=>pages[page]??{text:'',lower:'',items:[]}))??null
     },
     isImageAttachment:(reference:string)=>reference===url&&!!attachedImage,
     async fetchImage(url:string){
      try{
       if(!canEdit())return null
       const image=url.startsWith('attachment://')
        ?attachedImage&&await normalizePdfGeneratedImage(attachedImage,signal)
        :await assistant?.mediaApi.fetchImage(url,signal)
       if(!canEdit()||!image||(image.mime!=='image/png'&&image.mime!=='image/jpeg'))return null
       const header=inspectPdfImageDraftBytes({base64:image.base64,mime:image.mime})
       const bytes=Uint8Array.from(header.bytes)
       const canvas=await fileToCanvas(new File([bytes],'image',{type:image.mime}),2400)
       const png=canvas?.toDataURL('image/png').split(',')[1]
       if(!canEdit()||!canvas||!png)return null
       inspectPdfImageDraftBytes({base64:png,mime:'image/png'})
       return {png,width:canvas.width,height:canvas.height}
      }catch{signal?.throwIfAborted();return null}
     },
     insertImage(...[page,...args]:Parameters<PdfAssistantView['insertImage']>){view!.insertImage(current.pages[page]!,...args)},
     gotoPage(page:number){if(!canEdit())return false;view!.gotoPage(page);return true},
    }
    try{
     if(call.name==='list_page_images')return await listPageImagesTool(deps,call.input)
     if(imageBakeTools.has(call.name)){
      const {page,image_number,...input}=call.input
      if(!canEdit()||typeof page!=='number'||!Number.isSafeInteger(page)||page<1||page>current.pages.length||
        typeof image_number!=='number'||!Number.isSafeInteger(image_number)||image_number<1)return invalid('Invalid page or image number.')
      const geom=deps.pageGeom(page-1)
      if(!geom)return invalid('The PDF page is not ready.')
      const onPage=sortImageRefs((await deps.listImages()).filter(ref=>ref.pageIndex===page-1),geom)
      const ref=onPage[image_number-1]
      if(!ref||deps.isImageClaimed(ref))return invalid('The image is missing or already has a draft.')
      const target=checkTarget(ref),saved=savedRefs.get(ref)!
      const turns=((geom.rot-saved.rotation)%360+360)%360/90
      const operation={...input,op:call.name,page:target.pageIndex+1,image_number:saved.number} as PdfHostImageBake
      if(operation.op==='flip_image'&&turns%2&&(operation.axis==='horizontal'||operation.axis==='vertical'))
       operation.axis=operation.axis==='horizontal'?'vertical':'horizontal'
      if(operation.op==='crop_image'&&turns){
       const sides=['top','right','bottom','left'] as const
       for(const [i,side] of sides.entries()){
        const value=input[sides[(i+turns)%4]!]
        if(value===undefined)delete operation[side]
        else operation[side]=value as number
       }
      }
      const prior=view!.imageBakes()
      await grant.previewImageBakes([...prior,operation],signal)
      const next=view?.imageBakes()
      if(!canEdit()||deps.pageGeom(page-1)?.rot!==geom.rot||deps.isImageClaimed(ref)||
       next?.length!==prior.length||next.some((item,i)=>item!==prior[i])||!view!.queueImageBake(target,operation))
       return invalid('The PDF changed during image validation.')
      return {output:`Image ${image_number} on page ${page} has a pending ${call.name} edit. Save to apply it.`,summary:call.name,mutated:true}
     }
     const tool=call.name==='insert_image'?insertImageTool:call.name==='transform_image'?transformImageTool:
      call.name==='rotate_image'?rotateImageTool:call.name==='replace_image'?replaceImageTool:deleteImageTool
     return await tool(deps,call.input,signal)
    }catch{
     signal?.throwIfAborted()
     return invalid('The image could not be read or uniquely edited. Read the current pages again.')
    }
   }
   if(call.name==='get_outline'){
    signal?.throwIfAborted()
    return getOutlineTool(current.batchApi)
   }
   if(call.name==='add_form_mark'){
    const revision=grant.current()
    const canEdit=()=>!signal?.aborted&&samePages()&&grant.current()===revision&&!!view?.canEdit()
    if(!canEdit())return invalid('The PDF cannot accept a draft right now.')
    return current.addFormMark(call.input,signal,canEdit)
   }
   if(stampTools.has(call.name)){
    signal?.throwIfAborted()
    if(!current.canEdit())return invalid('The PDF cannot accept a draft right now.')
    let operation
    try{operation=validatePdfStampOperation({...call.input,op:call.name})}
    catch{return invalid('Invalid watermark or header/footer parameters.')}
    const {op,...input}=operation
    const previous=current.stampApi.stamps()
    const isWatermark=op==='set_watermark'
    const clear=operation.op==='set_watermark'?!operation.text:!operation.page_number&&
     ![operation.header_left,operation.header_center,operation.header_right,operation.footer_left,operation.footer_center,operation.footer_right].some(Boolean)
    if(clear){
     current.stampApi.setStamps({
      wm:isWatermark?null:previous?.wm??null,hf:isWatermark?previous?.hf??null:null,
      clearWatermark:isWatermark||previous?.clearWatermark,clearHeaderFooter:!isWatermark||previous?.clearHeaderFooter,
     })
     return {output:'Removal of the managed '+(isWatermark?'watermark':'header/footer')+' is queued. Save to apply it.',summary:call.name,mutated:true}
    }
    const deps={
     readOnly:()=>!current.canEdit(),stamps:()=>previous,
     setStamps(cfg:ReturnType<typeof current.stampApi.stamps>){
      if(cfg)current.stampApi.setStamps({...cfg,
       clearWatermark:!isWatermark&&previous?.clearWatermark,clearHeaderFooter:isWatermark&&previous?.clearHeaderFooter,
      })
     },
    }
    const result=(isWatermark?setWatermarkTool:setHeaderFooterTool)(deps,input)
    return {...result,output:result.output.replace('the user saves with ⌘S','save to apply')}
   }
   if(call.name==='insert_blank_page'){
    signal?.throwIfAborted()
    return insertBlankPageTool({...current.batchApi,readOnly:()=>!current.canEdit()},call.input,signal)
   }
   if(call.name==='apply_ops'||call.name==='list_form_fields'){
    const revision=grant.current()
    const stillCurrent=()=>!signal?.aborted&&samePages()&&grant.current()===revision
    if(call.name==='apply_ops')return applyOpsTool({...current.batchApi,
     readOnly:()=>!stillCurrent()||!view?.canEdit(),
    },call.input)
    signal?.throwIfAborted()
    const result=await listFormFields(current.batchApi)
    return stillCurrent()?result:invalid('The PDF changed. Read the form fields again.')
   }
   if(textToolNames.has(call.name)){
    const writing=!['search_text','list_inserted_text','read_annotations'].includes(call.name),revision=grant.current()
    signal?.throwIfAborted()
    if(writing&&!current.canEdit())return invalid('The PDF cannot accept a draft right now.')
    const canEdit=()=>!signal?.aborted&&samePages()&&grant.current()===revision&&!!view?.canEdit()
    const visible={readOnly:()=>!canEdit(),pageCount:()=>current.pages.length,isDeleted:()=>false,
     pageGeom:(page:number)=>view?.pageGeom(current.pages[page]!)??null,
     gotoPage(page:number){if(!samePages())return false;view!.gotoPage(page);return true},
    }
    if(Object.hasOwn(insertActions,call.name)){
     const api=current.textInsertApi
     const textInserts=()=>api.textInserts().flatMap(item=>{
      const pageIndex=current.pages.indexOf(item.input.pageIndex)
      return pageIndex<0?[]:[{...item,input:{...item.input,pageIndex}}]
     })
     return insertActions[call.name as keyof typeof insertActions]({...api,...visible,textInserts},call.input)
    }
    const index=await current.searchIndex()
    signal?.throwIfAborted()
    if(!index||!samePages())return invalid('The PDF changed. Read the current pages again.')
    const pages=current.pages.map(i=>index[i]??{text:'',lower:'',items:[]})
    const deps={...visible,searchIndex:()=>Promise.resolve(pages),editFonts:()=>EDIT_FONTS.map(font=>font.id)}
    if(Object.hasOwn(annotationActions,call.name)){
     const original=(page:number)=>current.pages[page]!
     const check=()=>{
      signal?.throwIfAborted()
      if(!samePages()||grant.current()!==revision||(writing&&!canEdit()))throw Error('The PDF changed before the annotation action could finish.')
     }
     const api:PdfAssistantView['annotationApi']={
      async annotationsOn(page){
       check()
       const result=await view!.annotationApi.annotationsOn(original(page))
       check()
       return result
      },
      async findNoteRoot(page,key){
       check()
       const result=await view!.annotationApi.findNoteRoot(original(page),key)
       check()
       return result
      },
      addNote(page,...args){check();return view!.annotationApi.addNote(original(page),...args)},
      replyToThread(page,...args){check();view!.annotationApi.replyToThread(original(page),...args)},
      editNote(page,...args){check();view!.annotationApi.editNote(original(page),...args)},
      deleteNoteThread(page,...args){check();view!.annotationApi.deleteNoteThread(original(page),...args)},
     }
     return annotationActions[call.name as keyof typeof annotationActions]({...deps,...api,
      deleteMarkups(page,keys){check();return view!.deleteMarkups(original(page),keys,check)},
     },call.input,signal)
    }
    if(call.name==='search_text')return searchText(deps,call.input)
    if(call.name==='insert_text')return insertTextTool({...deps,
     insertText(input){
      if(!canEdit())return {error:'The PDF changed before the text could be inserted.'}
      return view!.textInsertApi.insertText({...input,pageIndex:current.pages[input.pageIndex]!})
     },
    },call.input,signal)
    if(call.name==='move_text_block')return moveTextBlockTool({...deps,
     moveTextBlock(page,block,delta){
      if(!canEdit())return Promise.resolve({reason:'The PDF changed before the move could be validated.'})
      return view!.moveTextBlock(current.pages[page]!,block,delta,input=>grant.validateTextEdit(input,signal),canEdit)
     },
    },call.input)
    if(call.name==='edit_text'||call.name==='edit_block')return (call.name==='edit_block'?editBlock:editText)({...deps,
     editText(edit){
      if(!canEdit())return Promise.resolve('The PDF changed before the edit could be validated.')
      return view!.editText({...edit,pageIndex:current.pages[edit.pageIndex]!},input=>grant.validateTextEdit(input,signal),canEdit)
     },
    },call.input)
    return markupText({...deps,
     addMarkup(type,page,rects,color){
      signal?.throwIfAborted()
      if(!canEdit())throw Error('The PDF changed before the annotation could be added.')
      view!.addMarkup(type,current.pages[page]!,rects,color)
     },
    },call.input)
   }
   const {start,page,end}=(call.input??{}) as {start?:number;page?:number;end?:number}
   const first=call.name==='goto_page'?page:start,last=call.name==='goto_page'?page:end??start
   if(first===undefined||last===undefined||!Number.isSafeInteger(first)||!Number.isSafeInteger(last)||first<1||last<first||last-first>=10||last>current.pages.length)return invalid('Invalid visible PDF page range.')
   signal?.throwIfAborted()
   if(call.name==='goto_page'){
    current.gotoPage(first)
    return {output:'Navigated to page '+first,summary:'Go to page '+first,mutated:false}
   }
   if(call.name!=='read_pages')return invalid('Unavailable PDF tool.')
   const output=[]
   for(let n=first;n<=last;n++){
    const original=current.pages[n-1]!
    const content=original<doc.numPages?await (await doc.getPage(original+1)).getTextContent():undefined
    let text=content?.items.flatMap(item=>'str' in item?[item.str+(item.hasEOL?'\n':' ')]:[]).join('').trim()??'(unsaved blank page)'
    if(content&&isScannedText(text)){
     const recognized=await current.recognizeText(original,signal).catch(()=>null)
     if(recognized?.trim())text='(recovered by OCR; may contain recognition errors)\n'+recognized
     else if(!text)text='(no extractable text; OCR did not return text)'
    }
    signal?.throwIfAborted()
    if(!samePages())return invalid('The PDF changed. Read the current pages again.')
    output.push(`[Page ${n}]\n`+text.slice(0,8000))
   }
   return {output:output.join('\n\n'),summary:`Read pages ${first}-${last}`,mutated:false}
  },
 }
 const skill:AgentSkill={
  ...pdfSkill,
  get tools(){
   if(!view?.editRestriction)return pdfSkill.tools
   return pdfSkill.tools.filter(tool=>readTools.has(tool.name)).map(tool=>tool.name==='find_sensitive_info'?{
    ...tool,description:'Find sensitive information in extracted PDF text without marking or changing the PDF.',
    inputSchema:{type:'object',additionalProperties:false,properties:{patterns:{type:'array',uniqueItems:true,items:{type:'string',enum:[...REDACT_PATTERNS]}}}},
   }:tool)
  },
 }
 function Dock({value}:{value:PdfAssistantView}){
  useLayoutEffect(()=>{view=value;return()=>{view=undefined}},[value])
  const citationPage=(href:string)=>{
   const page=parsePdfNavHref(href)
   return page!==null&&Number.isSafeInteger(page)&&page>=1&&page<=value.pages.length?page:null
  }
  return assistant?.available?<SharedEditorAssistant assistant={assistant} lang={prefs?.language??'zh'} dock={value} onMovePanel={side=>appearance.movePanel(side,assistant?.sessionProof)} widthKey="dyoffice:native-pdf:ai-panel-width" imageAttachmentReferences onLocalEditDone={()=>{void autoSaveBlank()}} assistantNav={{
   scheme:PDF_NAV_SCHEME,accepts:href=>!!value.doc&&citationPage(href)!==null,
   onNavigate:href=>{const page=citationPage(href);if(value.doc&&page!==null)value.gotoPage(page)},
  }}/>:null
 }
 async function autoSaveBlank(){
  const base=grant.current().revision
  const check=()=>!disposed&&editor?.status==='ready'&&!editor.state().blocked&&grant.current().revision===base
  if(!check()||!view?.textInsertApi.textInserts().length)return
  try{if(await grant.canAutoSave()&&check()&&view?.textInsertApi.textInserts().length)await editor?.save()}
  catch{/* Keep the dirty draft available for manual save if authority changed. */}
 }
 let notice=''
 let assistantLoadFinished=false
 const closeHandoff=mountDocumentHandoff({fileId,format:'pdf',assistant:()=>assistant??(assistantLoadFinished?null:undefined),
  pdfTools:skill.tools.map(tool=>tool.name),
  ready:()=>!disposed&&editor?.status==='ready'&&!redacting&&!ribbonBusy,
  clean:isClean,revision:()=>grant.current().revision,save:async check=>{
   if(!editor||!check()||!await editor.save())return false
   // Saving reloads the PDF. React publishes the clean lifecycle after the commit.
   for(let i=0;i<100&&!disposed;i++){
    if(editor?.status==='ready'&&!editor.state().dirty&&!editor.state().blocked)return check()
    await new Promise(resolve=>setTimeout(resolve,30))
   }
   return false
  },
 })
 let saveCopyNotice=''
 const reduceFileSize=async()=>{
  try{
   const {blob,bytesBefore}=await grant.reduceSize(browserActions.signal)
   if(blob.size){
    const name=browserFileName((grant.path.split('/').at(-1)??'').replace(/\.pdf$/i,''),'document')
    downloadBrowserFile(new Blob([blob],{type:'application/pdf'}),`${name}-small.pdf`)
   }
   return {bytesBefore,bytesAfter:blob.size||bytesBefore}
  }catch{
   throw Error(prefs?.language==='en'?'Could not reduce this PDF.':'无法减小此 PDF 的大小。')
  }
 }
 const convertOffice=async(format:PdfConvertFormat,pdfPassword:string|undefined,draft?:PdfHostConversionDraft)=>{
  const signal=browserActions.signal
  try{
   const blob=await grant.convertOffice(format,pdfPassword,signal,draft)
   signal.throwIfAborted()
   const name=browserFileName((grant.path.split('/').at(-1)??'').replace(/\.pdf$/i,''),'document')
   downloadBrowserFile(blob,`${name}.${format}`)
  }catch(error){
   if(signal.aborted)return
   const code=(error as {code?:string})?.code
   const zh=prefs?.language!=='en'
   let message=zh?'无法转换此 PDF。':'Could not convert this PDF.'
   if(code==='PDF_COPY_RESTRICTED')message=zh?'此 PDF 限制复制内容。':'This PDF restricts copying its contents.'
   if(code==='PDF_CONVERSION_NEEDS_OCR')message=zh?'请先识别扫描件中的文字，再转换格式。':'Recognize the text in this scan before converting it.'
   if(code==='PDF_CONVERSION_NO_TEXT')message=zh?'此 PDF 没有可导出为 Markdown 的文字。':'This PDF has no text to export as Markdown.'
   if(code==='PDF_CONVERSION_LIMIT'||code==='OUTPUT_LIMIT')message=zh?'此 PDF 超出转换大小限制。':'This PDF exceeds the conversion size limit.'
   throw Object.assign(new Error(message),{code})
  }
 }
 const saveCopy: PdfHostSaveCopy = async (draft,count,modified,stamps,imageBakes)=>{
  if(disposed||ribbonBusy||ribbonPending||redacting)return null
  const locale=prefs?.language==='en'?'en':'zh',signal=browserActions.signal
  const base=grant.current()
  ribbonBusy=true;saveCopyNotice=''
  try{
   const chosen=await confirmWorkspaceCopy(grant.path.split('/').pop()??'document.pdf',{locale,signal,request:grant.workspaceRequest,fileId})
   if(!chosen)return null
   if(disposed||base!==grant.current())throw Error('PDF copy authorization changed.')
   const name=browserFileName(chosen.name.replace(/\.pdf$/i,''),'document')+'.pdf'
   const result=await grant.writer.saveCopy(draft,count,name,modified,stamps,imageBakes,signal,chosen.folderId)
   if(result.ok)saveCopyNotice=locale==='zh'?`已保存副本：${name}`:`Saved copy: ${name}`
   return result
  }finally{ribbonBusy=false;if(!disposed)render()}
 }
 const render=()=>root.render(<LocaleProvider initial={prefs?.language??'zh'}>
  <App hostAssistantOpenState hostOpenFile={openWorkspaceFile} hostInspectDocument={inspectDocument} hostLastZoomStorage={lastZoomStorage} hostSave={hostSave} hostSaveCopy={params.has('sourceRevision')||params.get('guest')==='1'?undefined:saveCopy} hostPageLimits={{maxPages:MAX_PDF_EDIT_PAGES,maxBlankPagesPerSave:MAX_PDF_DRAFT_BLANK_PAGES}} hostMergePdf={api.mergePdf} hostConvertOffice={convertOffice} hostReduceFileSize={reduceFileSize} {...(globalThis.crypto?.subtle ? {hostProtectCopy:exportProtectedCopy} : {})} hostOcr={grant.recognizeOcr} hostImageBakePreview={grant.previewImageBakes} hostLifecycle={onLifecycle} hostAssistant={assistant?.available?value=><Dock value={value}/>:undefined}
   hostFindSensitive={copies?findRedactionCandidates:undefined}
   hostRedact={copies?publishManualRedaction:undefined} hostRedactionPending={recoverManual?'确认保存结果':undefined}
   hostReview={ribbonPending?<section className="native-pdf-redaction-review" aria-label="页面副本保存">
    {ribbonError&&<p role="alert">{ribbonError}</p>}
    <button type="button" disabled={ribbonBusy} onClick={()=>{void ribbonCopy(grant.path)}}>确认副本保存结果</button>
   </section>:review&&<section className="native-pdf-redaction-review" aria-label="涂黑候选审查">
    <strong>涂黑候选 · 已选 {selected.size} / {review.candidates.length}</strong>
    <p>仅检查可提取文字，未运行 OCR。{review.unsupportedPages.length>0&&`第 ${review.unsupportedPages.join('、')} 页有无法定位的文字。`}</p>
    {review.truncated&&<p role="alert">候选超出上限，请缩小查找范围后重试。</p>}
    {review.candidates.length===0&&<p>没有可定位的候选。</p>}
    <ul>{review.candidates.map(candidate=><li key={candidate.id}>
     <label><input type="checkbox" checked={selected.has(candidate.id)} disabled={redacting||recoverRedaction} onChange={event=>{
      if(event.target.checked)selected.add(candidate.id);else selected.delete(candidate.id)
      confirming=false;render()
     }}/> 第 {candidate.page} 页：{candidate.text}</label>
     <button type="button" disabled={review?.revision!==grant.current().revision} onClick={()=>editor?.gotoPage(candidate.page)}>查看位置</button>
    </li>)}</ul>
    {confirming&&<p role="alert">将从副本永久删除所选 {selected.size} 处内容，原文件保留。</p>}
    {reviewError&&<p role="alert">{reviewError}</p>}
    <div className="native-pdf-redaction-actions">
     {recoverRedaction
      ?<button type="button" disabled={redacting} onClick={()=>{void publishRedaction()}}>确认保存结果</button>
      :<button type="button" disabled={!selected.size||review.truncated||redacting} onClick={()=>{
       if(confirming)void publishRedaction();else{confirming=true;render()}
      }}>{confirming?'确认永久涂黑并另存':'生成涂黑副本'}</button>}
     <button type="button" disabled={redacting||recoverRedaction} onClick={clearReview}>清除标记</button>
    </div>
   </section>}
   hostPageOverlay={(page,width,height)=>{
    if(review?.revision!==grant.current().revision)return null
    const marks=review.candidates.filter(candidate=>candidate.page===page+1&&selected.has(candidate.id))
    return marks.length>0&&<svg className="native-pdf-redaction-overlay" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-label="待确认的涂黑标记">
     {marks.map(({id,displayRect:box})=><rect key={id} x={box.left} y={box.top} width={box.width} height={box.height}/>)}
    </svg>
   }}
   hostDownloadUrl={()=>`/api/v1/files/${encodeURIComponent(fileId)}/content?revision=${encodeURIComponent(grant.current().revision)}&download=1`}/>
  {saveCopyNotice&&<div className="native-pdf-assistant-status" role="status">{saveCopyNotice}</div>}
  {notice&&<div className="native-pdf-assistant-status" role="status">{notice}</div>}
 </LocaleProvider>)
 render()
 async function creationSkill(){
  try{
   const parent=window.parent as Window&{dyofficePrepareAiDoc?:(signal?:AbortSignal,proof?:string)=>Promise<PreparedAiDocumentCreator>}
   const prepare=parent.dyofficePrepareAiDoc
   if(!prepare)return []
   const options=await grant.documentCreation(prepare)
   return [createPdfCreateDocumentSkill({...options,createDocument:createPdfDocumentCreator(options)})]
  }catch{return []}
 }
 if(params.get('guest')!=='1')void creationSkill().then(async creation=>{
  if(disposed)return
  const skills=[skill,...creation]
  if(copies){
   const copySkill=createNativePdfPageCopies(copies,()=>review?.candidates.length?undefined:savedPageCount(),()=>!redacting&&!recoverRedaction&&!recoverManual&&!ribbonBusy&&!ribbonPending)
   skills.push({...copySkill,get tools(){return view?.editRestriction?[]:copySkill.tools}})
  }
  const result=await loadEditorAssistant({fileId,editorId,conversationId,generation:()=>1,continuationRevision:()=>isClean()?grant.current().revision:undefined},false,'pdf',new Set(skills.flatMap(item=>item.tools.map(tool=>tool.name))),skills)
  if(disposed){result.assistant?.dispose();return}
  assistantLoadFinished=true;assistant=result.assistant
  assistant?.documents.register(target)
  notice=editorAssistantNotice(result,prefs?.language??'zh')
  const channel=assistant?.channel
  if(channel)realtime=createEditorBridge({origin:location.origin,fileId,editorId,onEvent:event=>{
   if(event.type==='assistant-channels')channel.observe(event.channels)
  }})
  render()
 })
}
void mount().catch(error=>{
 reportDocumentOpenError(error)
 installEditorCloseLifecycle(window,{canClose:async()=>true,dispose:async()=>true})
 element.textContent='无法打开 PDF。'
})
