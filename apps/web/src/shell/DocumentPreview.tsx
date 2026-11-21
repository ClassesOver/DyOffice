import {createPdfPendingSession} from '../editors/pdf-pending-session'
import {createPdfAnnotationDrafts} from '../editors/pdf-annotation-drafts'
import {queryPdfPendingPreview} from '../editors/pdf-pending-preview'
import type {PdfPendingContext} from '../editors/pdf-pending-ops'
import {createPdfSavedImageDrafts} from '../editors/pdf-saved-image-drafts'
import {queryPdfRedactions,type PdfRedactionReview} from '../editors/pdf-redactions'
import {createPdfTextDrafts} from '../editors/pdf-text-drafts'
import {PdfTextDraftOverlay} from '../editors/PdfTextDraftOverlay'
import {createPdfImageDrafts,type PdfImageDraftBakeOperation} from '../editors/pdf-image-drafts'
import {PdfImageDraftOverlay} from '../editors/PdfImageDraftOverlay'
import type {RedactPattern} from '../../../pdf/src/renderer/redact-patterns'
import {createWebAiMediaApi} from '../editors/web-ai-media-api'
import {createPdfImageAccess} from '../editors/pdf-images'
import {DocumentLoading} from '../editors/DocumentLoading'
import type {FormField} from '../../../pdf/src/renderer/form-catalog'
import type {RevisionRef} from '../../../../packages/web-contracts/src/api'
import {createPdfExtraction,type PdfPageLayout} from '../editors/pdf-extraction'
import type {PdfPageOperation} from '../../../../packages/web-contracts/src/pdf-page-ops'
import {DocumentNotifications} from '../editors/document-notifications'
import {useEffect,useRef,useState} from 'react'
import {Button,Card,Input,InputNumber} from 'antd'
import JSZip from 'jszip'
import type {SettingsRequest} from '../../../../packages/browser-host/src/preferences'
import {createEditorBridge} from '../../../../packages/browser-host/src/editor-bridge'
import {createEditorAssistant} from '../editors/assistant'
import {SharedEditorAssistant} from '../editors/shared-editor-assistant'
import {editorAssistantNotice,loadEditorAssistant} from '../editors/editor-assistant-status'
import type {PdfFormFieldOperation} from '../../../../packages/web-contracts/src/pdf-form-fields'
import {createPdfPreviewSkill,searchPdfPreview,scrollPdfPreviewToPage,type PdfTextEdit,type PdfBlockEdit,type PdfBlockMove,type PdfAnnotation,type PdfAnnotationDelete,type PdfNoteUpdate,type PdfExtractionResult,type PdfFormValueOperation,type PreviewPage as PdfPreviewPage} from './pdf-preview-skill'
import {createPdfMutations} from '../editors/pdf-mutations'
import type {DocumentCloseGuard} from './document-tabs'
import {createPdfDocumentCreator,createPdfCreateDocumentSkill,type PreparedAiDocumentCreator} from './pdf-create-document-skill'

async function previewBytes(endpoint:string,limit:number,signal?:AbortSignal){
 const response=await fetch(endpoint,{credentials:'same-origin',signal,redirect:'error'})
 if(!response.ok){await response.body?.cancel();throw Error('文件读取失败。')}
 if(Number(response.headers.get('content-length'))>limit){await response.body?.cancel();throw Error('文件超过预览大小限制。')}
 const reader=response.body?.getReader();if(!reader)throw Error('文件内容不可读取。')
 const chunks:Uint8Array[]=[];let size=0
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw Error('文件超过预览大小限制。')}chunks.push(value)}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}
 return bytes
}

// XML prefixes are aliases. Accept the two OOXML namespace families, never a
// same-local-name element or relationship attribute from an unrelated namespace.
const previewNamespaces = {
 spreadsheet: ['http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'http://purl.oclc.org/ooxml/spreadsheetml/main'],
 presentation: ['http://schemas.openxmlformats.org/presentationml/2006/main', 'http://purl.oclc.org/ooxml/presentationml/main'],
 drawing: ['http://schemas.openxmlformats.org/drawingml/2006/main', 'http://purl.oclc.org/ooxml/drawingml/main'],
 relationships: ['http://schemas.openxmlformats.org/package/2006/relationships'],
 relationshipIds: ['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships'],
}
function previewElements(node: Document | Element, family: keyof typeof previewNamespaces, localName: string) {
 return [...node.getElementsByTagNameNS('*', localName)].filter(element => previewNamespaces[family].includes(element.namespaceURI ?? ''))
}

type PreviewPage={name:string;rows:string[][]}
type Metadata={file:{fileId:string;revision:string};downloadEndpoint:string}
export function resolvePreviewContentUrl(fileId:string,metadata:Metadata){
 const revision=metadata?.file?.revision
 const expected=`/api/v1/files/${encodeURIComponent(fileId)}/content?revision=${encodeURIComponent(revision)}`
 if(metadata?.file?.fileId!==fileId||typeof revision!=='string'||!revision||metadata.downloadEndpoint!==expected)throw Error('文件版本地址无效。')
 return expected
}
export async function parseOfficePreview(bytes:Uint8Array,format:'xlsx'|'pptx'):Promise<PreviewPage[]>{
 if(bytes.byteLength>16*1024*1024)throw Error('预览文件超过限制，请下载原件。')
 const zip=await JSZip.loadAsync(bytes),entries=Object.values(zip.files)
 if(entries.length>512)throw Error('文档条目过多，请下载原件。')
 let size=0
 for(const entry of entries){const declared=(entry as unknown as {_data?:{uncompressedSize?:number}})._data?.uncompressedSize??0;size+=declared;if(declared>8*1024*1024||size>32*1024*1024)throw Error('文档解压大小超过预览限制。')}
 async function xml(path:string){const file=zip.file(path);if(!file)return null;const content=await file.async('uint8array');if(content.byteLength>8*1024*1024)throw Error('文档内容超过预览限制。');const source=new TextDecoder().decode(content);if(/<!DOCTYPE|<!ENTITY/i.test(source))throw Error('文档 XML 不支持。');const document=new DOMParser().parseFromString(source,'application/xml');if(document.getElementsByTagName('parsererror').length)throw Error('文档 XML 无效。');return document}
 const pages:PreviewPage[]=[]
 let paths=entries.filter(entry=>!entry.dir&&(format==='xlsx'?/^xl\/worksheets\/sheet\d+\.xml$/:/^ppt\/slides\/slide\d+\.xml$/).test(entry.name)).sort((a,b)=>Number(a.name.match(/\d+/)?.[0])-Number(b.name.match(/\d+/)?.[0])).map(entry=>({path:entry.name,name:''}))
 const base=format==='xlsx'?'xl':'ppt',indexPath=format==='xlsx'?'workbook':'presentation'
 const index=await xml(`${base}/${indexPath}.xml`),relationships=await xml(`${base}/_rels/${indexPath}.xml.rels`)
 if(index){
  if(!relationships)throw Error('文档页索引缺失，请下载原件。')
  const nodes=format==='xlsx'?previewElements(index,'spreadsheet','sheet'):previewElements(index,'presentation','sldId')
  paths=nodes.map(node=>{
   const id=previewNamespaces.relationshipIds.map(namespace=>node.getAttributeNS(namespace,'id')).find(value=>value!==null)
   const relationship=previewElements(relationships,'relationships','Relationship').find(item=>item.getAttribute('Id')===id)
   const target=relationship?.getAttribute('Target')??''
   const path=target.startsWith(`/${base}/`)?target.slice(1):`${base}/${target.replace(/^\.\//,'')}`
   const allowed=format==='xlsx'?/^xl\/worksheets\/[^/]+\.xml$/:/^ppt\/slides\/[^/]+\.xml$/
   if(relationship?.getAttribute('TargetMode')==='External'||!allowed.test(path)||!zip.file(path))throw Error('文档页索引无效，请下载原件。')
   return {path,name:format==='xlsx'?node.getAttribute('name')??'':''}
  })
 }
 if(paths.length>100)throw Error('文档页数超过预览限制。')
 const strings=format==='xlsx'?await xml('xl/sharedStrings.xml'):null
 const shared=strings?previewElements(strings,'spreadsheet','si').map(node=>node.textContent??''):[]
 let cells=0
 for(const path of paths){const doc=await xml(path.path);if(!doc)continue
  const rows:string[][]=[]
  if(format==='xlsx')for(const row of previewElements(doc,'spreadsheet','row').slice(0,200)){
   const values:string[]=[]
   for(const cell of previewElements(row,'spreadsheet','c')){if(++cells>20000)throw Error('单元格数量超过预览限制。');const ref=cell.getAttribute('r')?.match(/^[A-Z]+/)?.[0];const index=ref?[...ref].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1:values.length;if(index>199)continue;while(values.length<index)values.push('');const value=previewElements(cell,'spreadsheet','v')[0]?.textContent??'';values[index]=cell.getAttribute('t')==='s'?shared[Number(value)]??'':cell.getAttribute('t')==='inlineStr'?previewElements(cell,'spreadsheet','is')[0]?.textContent??'':value}
   rows.push(values)
  }
  else for(const text of previewElements(doc,'drawing','t')){if(++cells>20000)throw Error('文本数量超过预览限制。');rows.push([text.textContent??''])}
  pages.push({name:path.name||(format==='xlsx'?`工作表 ${pages.length+1}`:`幻灯片 ${pages.length+1}`),rows})
 }
 if(!pages.length)throw Error('此文档没有可预览的内容，请下载原件。')
 return pages
}
export function DocumentPreview({fileId,name,format,conversationId,request:latestRequest,assistantEnabled=false,registerGuard,onCreatedPdf,prepareDocument:latestPrepareDocument,docxCreationAvailable=false}:{fileId:string;name:string;format:'docx'|'xlsx'|'pptx'|'pdf';conversationId?:string;request:SettingsRequest;assistantEnabled?:boolean;registerGuard?:(id:string,guard:DocumentCloseGuard|null)=>void;onCreatedPdf?:(receipt:RevisionRef)=>Promise<void>;prepareDocument?:(signal?:AbortSignal)=>Promise<PreparedAiDocumentCreator>;docxCreationAvailable?:boolean}){
 // The bound request/prepare callbacks change identity when the session proof rotates (e.g. after a
 // password change). The clients below are created once and the load effect must not re-run (which
 // would discard pending edits), so route every call through refs that always hold the latest proof.
 const requestRef=useRef(latestRequest),prepareRef=useRef(latestPrepareDocument)
 requestRef.current=latestRequest;prepareRef.current=latestPrepareDocument
 const [request]=useState<SettingsRequest>(()=>((...args:Parameters<SettingsRequest>)=>requestRef.current(...args)) as SettingsRequest)
 const prepareDocument=latestPrepareDocument&&((signal?:AbortSignal)=>prepareRef.current!(signal))
 const documentCreator=useRef<ReturnType<typeof createPdfDocumentCreator>|undefined>(undefined)
 if(!documentCreator.current&&prepareDocument)documentCreator.current=createPdfDocumentCreator({prepare:prepareDocument})
 const canCreateDocument=!!documentCreator.current
 const [pages,setPages]=useState<PreviewPage[]>([]),[url,setUrl]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(true)
 const revision=useRef(''),[pdfPageCount,setPdfPageCount]=useState(0),[targetPage,setTargetPage]=useState(1),[savingPdf,setSavingPdf]=useState(false),[pdfMessage,setPdfMessage]=useState('')
 const [pdfPageInput,setPdfPageInput]=useState<number|null>(1),[pdfSearch,setPdfSearch]=useState('')
 const host=useRef<HTMLDivElement>(null),loading=useRef(true),pdfBytesRef=useRef<Uint8Array|null>(null),pdfPages=useRef<PdfPreviewPage[]>([]),editorId=useRef(crypto.randomUUID()),[sharedAssistant,setSharedAssistant]=useState<Awaited<ReturnType<typeof createEditorAssistant>>>()
 const [pdfContext,setPdfContext]=useState('')
 const pdfOutline=useRef<string[]>([])
 const [draftTick,setDraftTick]=useState(0),[selectedDraft,setSelectedDraft]=useState(''),[draftText,setDraftText]=useState(''),[draftFontSize,setDraftFontSize]=useState<number|null>(14),[draftColor,setDraftColor]=useState('#000000'),[draftAlign,setDraftAlign]=useState<'left'|'center'|'right'>('left'),[draftX,setDraftX]=useState<number|null>(0),[draftY,setDraftY]=useState<number|null>(0)
 const [imageTick,setImageTick]=useState(0),[selectedImage,setSelectedImage]=useState(''),[imageX,setImageX]=useState<number|null>(0),[imageY,setImageY]=useState<number|null>(0),[imageWidth,setImageWidth]=useState<number|null>(100),[imageHeight,setImageHeight]=useState<number|null>(100),[imageLayer,setImageLayer]=useState<'above_text'|'below_text'>('below_text'),[imageOpacity,setImageOpacity]=useState<number|null>(100),[imageTolerance,setImageTolerance]=useState<number|null>(30),[imageCrop,setImageCrop]=useState<Record<'left'|'top'|'right'|'bottom',number>>({left:0,top:0,right:0,bottom:0}),[pickingImage,setPickingImage]=useState(false)
 const imagePicking=useRef(false),imageReadGeneration=useRef(0),imageReadAlive=useRef(true),imageReader=useRef<FileReader|null>(null)
 useEffect(()=>{imageReadAlive.current=true;return()=>{imageReadAlive.current=false;imageReadGeneration.current++;imageReader.current?.abort()}},[])
 const imageDrafts=useRef<ReturnType<typeof createPdfImageDrafts>|undefined>(undefined),savedImageDrafts=useRef<ReturnType<typeof createPdfSavedImageDrafts>|undefined>(undefined)
 const baselineGeometries=useRef<PdfPendingContext['pageGeometries']>([{pw:1,ph:1,rot:0}]),pdfFormFields=useRef<readonly FormField[]|null>(null)
 const canonicalPreviewVisible=useRef(false)
 const [pendingTick,setPendingTick]=useState(0),[,setPreviewTick]=useState(0)
 const pendingSession=useRef<ReturnType<typeof createPdfPendingSession>|undefined>(undefined)
 if(!pendingSession.current)pendingSession.current=createPdfPendingSession({getContext:()=>({fileId,baseRevision:revision.current||'loading',pageGeometries:baselineGeometries.current,savedFields:pdfFormFields.current??[],readOnly:loading.current||!pdfBytesRef.current}),onChange:()=>{setPendingTick(v=>v+1);setDraftTick(v=>v+1);setImageTick(v=>v+1)}})
 function hasCanonicalPending(){const p=pendingSession.current!.read();return !!(p.markups.length||p.notes.length||p.textInserts.length||p.imageEdits.length||p.savedImageEdits?.length||p.formFields.length||Object.keys(p.formEdits).length||Object.keys(p.rotations).length||p.deleted.length||p.order||p.metadata)}
 const annotationDrafts=useRef<ReturnType<typeof createPdfAnnotationDrafts>|undefined>(undefined)
 if(!annotationDrafts.current)annotationDrafts.current=createPdfAnnotationDrafts({session:pendingSession.current,request,isReady:()=>draftReady.current()&&!textDrafts.current!.isBusy()&&!imageWorkBusy()})
 const draftReady=useRef<()=>boolean>(()=>false),textDrafts=useRef<ReturnType<typeof createPdfTextDrafts>|undefined>(undefined)
 if(!textDrafts.current)textDrafts.current=createPdfTextDrafts({fileId,request,getRevision:()=>revision.current,isReady:()=>draftReady.current()&&!imageWorkBusy(),session:pendingSession.current,pageGeometry:page=>baselineGeometries.current[page-1],onChange:()=>{setDraftTick(value=>value+1)}})
 if(!imageDrafts.current)imageDrafts.current=createPdfImageDrafts({fileId,request,getRevision:()=>revision.current,session:pendingSession.current,pageGeometry:page=>baselineGeometries.current[page-1],isReady:()=>draftReady.current()&&!textDrafts.current!.isBusy()&&!savedImageDrafts.current?.isBusy(),onChange:()=>{setImageTick(value=>value+1)}})
 if(!savedImageDrafts.current)savedImageDrafts.current=createPdfSavedImageDrafts({fileId,request,getRevision:()=>revision.current,session:pendingSession.current,isReady:()=>draftReady.current()&&!textDrafts.current!.isBusy()&&!imageDrafts.current!.isBusy(),onChange:()=>{setImageTick(value=>value+1)}})
 function hasRasterDrafts(){return !!imageDrafts.current?.hasPending()||!!savedImageDrafts.current?.hasPending()}
 function imageWorkBusy(){return !!imageDrafts.current?.isBusy()||!!savedImageDrafts.current?.isBusy()}
 const savedImageOperations=savedImageDrafts.current.list()
 const imageBlocks=imageDrafts.current.list(),activeImage=imageBlocks.find(block=>block.id===selectedImage)
 const [draftPreviewBusy,setDraftPreviewBusy]=useState(false),[draftPreviewError,setDraftPreviewError]=useState('')
 const draftPreview=useRef<AbortController|null>(null)
 useEffect(()=>{if(!imageBlocks.some(block=>block.id===selectedImage))setSelectedImage(imageBlocks.at(-1)?.id??'')},[imageTick,selectedImage])
 useEffect(()=>{if(activeImage){setImageX(activeImage.x);setImageY(activeImage.y);setImageWidth(activeImage.width);setImageHeight(activeImage.height);setImageLayer(activeImage.layer)}},[imageTick,selectedImage])
 const draftBlocks=textDrafts.current.list(),activeDraft=draftBlocks.find(block=>block.id===selectedDraft)
 useEffect(()=>{if(!draftBlocks.some(block=>block.id===selectedDraft))setSelectedDraft(draftBlocks.at(-1)?.id??'')},[draftTick,selectedDraft])
 useEffect(()=>{if(activeDraft){setDraftText(activeDraft.text);setDraftFontSize(activeDraft.font_size);setDraftColor(activeDraft.color);setDraftAlign(activeDraft.align);setDraftX(activeDraft.x);setDraftY(activeDraft.y)}},[draftTick,selectedDraft])
 function projectedFormFields(){
  if(pdfFormFields.current===null)return null
  const snapshot=pendingSession.current!.read()
  return pdfFormFields.current.filter(field=>!snapshot.deleted.includes(field.pageIndex)).map(field=>({...field,...snapshot.formEdits[field.name]}))
 }
 const [attempt,setAttempt]=useState(0)
 const [loadPhase,setLoadPhase]=useState<'reading'|'rendering'>('reading')
 const [assistantAttempt,setAssistantAttempt]=useState(0),[assistantError,setAssistantError]=useState('')
 const [redactionReview,setRedactionReview]=useState<PdfRedactionReview|null>(null),[selectedRedactions,setSelectedRedactions]=useState<string[]>([]),[redactionConfirm,setRedactionConfirm]=useState(false)
 const redactionQuery=useRef(0)
 const pdfSensitiveMarker=useRef<((patterns:readonly RedactPattern[],signal?:AbortSignal)=>Promise<{count:number;truncated:boolean;error?:string}>)|undefined>(undefined)
 const pdfReplacementWriter=useRef<((pages:readonly number[],signal?:AbortSignal)=>Promise<boolean>)|undefined>(undefined)
 const replacementPending=useRef<{pages:readonly number[];revision:string;signal?:AbortSignal;resolve:(saved:boolean)=>void;cleanup:()=>void}|undefined>(undefined)
 const [replacementPages,setReplacementPages]=useState<readonly number[]|null>(null),[replacementSource,setReplacementSource]=useState<File|null>(null),[replacementError,setReplacementError]=useState('')
 const pdfStampWriter=useRef<((operation:import('../../../../packages/web-contracts/src/pdf-stamp-ops').PdfStampOperation,signal?:AbortSignal)=>Promise<boolean>)|undefined>(undefined)
 const pdfTextWriter=useRef<((edit:PdfTextEdit,signal?:AbortSignal)=>Promise<boolean>)|undefined>(undefined)
 const pdfAnnotationWriter=useRef<((annotation:PdfAnnotation,signal?:AbortSignal)=>Promise<boolean>)|undefined>(undefined)
 const pdfAnnotationDeleter=useRef<((operations:readonly PdfAnnotationDelete[],signal?:AbortSignal)=>Promise<boolean>)|undefined>(undefined)
 const pdfNoteUpdater=useRef<((operation:PdfNoteUpdate,signal?:AbortSignal)=>Promise<boolean>)|undefined>(undefined)
 const pdfPageWriter=useRef<((operations:readonly PdfPageOperation[],signal?:AbortSignal)=>Promise<boolean>)|undefined>(undefined)
 const pdfImageReady=useRef<()=>boolean>(()=>false)
 const pdfImageWriter=useRef<((operation:import('./pdf-preview-skill').PdfImageOperation,signal?:AbortSignal)=>Promise<boolean>)|undefined>(undefined)
 const pdfImageContentWriter=useRef<((operation:import('./pdf-preview-skill').PdfImageContentOperation,signal?:AbortSignal)=>Promise<boolean>)|undefined>(undefined)
 const pdfImageAccess=useRef<ReturnType<typeof createPdfImageAccess>|undefined>(undefined)
 const assistantImageFetcher=useRef<ReturnType<typeof createWebAiMediaApi>['fetchImage']|undefined>(undefined)
 if(!pdfImageAccess.current)pdfImageAccess.current=createPdfImageAccess({fileId,request,getRevision:()=>revision.current,isReady:()=>draftReady.current()&&!textDrafts.current!.isBusy()&&!imageWorkBusy(),queueEdit:(operation,signal)=>savedImageDrafts.current!.queue(operation,signal),isClaimed:(page,imageNumber)=>savedImageDrafts.current!.isClaimed(page,imageNumber),isReadable:()=>draftReady.current(),isDraftReady:()=>draftReady.current(),queueInsert:(operation,signal)=>imageDrafts.current!.insert(operation,signal),write:(operation,signal)=>pdfImageWriter.current?.(operation,signal)??Promise.resolve(false),fetchImage:(url,signal)=>assistantImageFetcher.current?assistantImageFetcher.current(url,signal):url.startsWith('https://generated-image.invalid/')?Promise.resolve(null):createWebAiMediaApi(request).fetchImage(url,signal),writeContent:(operation,signal)=>pdfImageContentWriter.current?.(operation,signal)??Promise.resolve(false)})
 const pdfBlockMover=useRef<((input:PdfBlockMove,signal?:AbortSignal)=>Promise<boolean>)|undefined>(undefined)
 const pdfBlockWriter=useRef<((input:PdfBlockEdit,signal?:AbortSignal)=>Promise<boolean>)|undefined>(undefined)
 const pdfFormFieldWriter=useRef<((operations:readonly PdfFormFieldOperation[],signal?:AbortSignal)=>Promise<boolean>)|undefined>(undefined)
 const pdfFormWriter=useRef<((operations:readonly PdfFormValueOperation[],signal?:AbortSignal)=>Promise<boolean>)|undefined>(undefined)
 const pdfLayout=useRef<((operation:PdfPageLayout,signal?:AbortSignal)=>Promise<PdfExtractionResult>)|undefined>(undefined)
 const pdfSplitter=useRef<((pagesPerFile:number,signal?:AbortSignal)=>Promise<PdfExtractionResult>)|undefined>(undefined)
 const pdfExtractor=useRef<((pages:readonly number[],signal?:AbortSignal)=>Promise<PdfExtractionResult>)|undefined>(undefined)
 const createdPdf=useRef(onCreatedPdf);createdPdf.current=onCreatedPdf
 const canCreatePdf=!!onCreatedPdf
 const extractionClient=useRef<ReturnType<typeof createPdfExtraction>|undefined>(undefined)
 if(!extractionClient.current)extractionClient.current=createPdfExtraction({fileId,name,request,getRevision:()=>revision.current,onCreated:async receipt=>{if(!createdPdf.current)throw Error('PDF 打开入口不可用');await createdPdf.current(receipt)}})
 const pdfRender=useRef<AbortController|null>(null)
 useEffect(()=>()=>{pdfRender.current?.abort();draftPreview.current?.abort();annotationDrafts.current?.dispose();pendingSession.current?.dispose()},[])
 async function renderPdf(target:HTMLElement,bytes:Uint8Array,signal?:AbortSignal,requestedRotations?:Readonly<Record<number,number>>){
  pdfRender.current?.abort()
  const controller=new AbortController();pdfRender.current=controller
  const cancel=()=>controller.abort(signal?.reason)
  signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel()
  try{
   const {mountPdfEditor}=await import('../editors/pdf-viewer')
   controller.signal.throwIfAborted()
   const result=await mountPdfEditor(target,bytes,controller.signal,requestedRotations)
   controller.signal.throwIfAborted()
   return result
  }finally{signal?.removeEventListener('abort',cancel)}
 }
 const pdfSaveLock=useRef(false)
 const [saveUnknown,setSaveUnknown]=useState(false)
 const mutationClient=useRef<ReturnType<typeof createPdfMutations>|undefined>(undefined)
 draftReady.current=()=>!!pdfBytesRef.current&&!imagePicking.current&&!loading.current&&!pdfSaveLock.current&&!mutationClient.current?.hasPending()&&!extractionClient.current?.hasPending()&&!redactionReview?.candidates.length&&!replacementPending.current
 pdfImageReady.current=()=>!!pdfBytesRef.current&&!hasCanonicalPending()&&!imagePicking.current&&!loading.current&&!pdfSaveLock.current&&!mutationClient.current?.hasPending()&&!extractionClient.current?.hasPending()&&!textDrafts.current!.hasPending()&&!textDrafts.current!.isBusy()&&!hasRasterDrafts()&&!imageWorkBusy()
 function hasPendingPdf(){return !!mutationClient.current?.hasPending()||!!extractionClient.current?.hasPending()}
 useEffect(()=>{
  if((!hasCanonicalPending()&&!canonicalPreviewVisible.current)||loading.current||!pdfBytesRef.current||!host.current||textDrafts.current!.isBusy()||imageWorkBusy())return
  const snapshot=pendingSession.current!.read(),controller=new AbortController();draftPreview.current?.abort();draftPreview.current=controller
  const current=()=>{const p=pendingSession.current!.read();return !controller.signal.aborted&&p.fileId===snapshot.fileId&&p.baseRevision===snapshot.baseRevision&&p.generation===snapshot.generation&&revision.current===snapshot.baseRevision}
  setDraftPreviewBusy(true);setDraftPreviewError('')
  void(async()=>{try{
   const bytes=hasCanonicalPending()?(await queryPdfPendingPreview(request,snapshot,controller.signal)).bytes:pdfBytesRef.current!
   if(!current()||!host.current)return
   canonicalPreviewVisible.current=true
   const mounted=await renderPdf(host.current,bytes,controller.signal)
   if(!current())return
   canonicalPreviewVisible.current=hasCanonicalPending()
   const identities=(snapshot.order??baselineGeometries.current.map((_,i)=>i)).filter(i=>!snapshot.deleted.includes(i))
   const figures=host.current!.querySelectorAll<HTMLElement>('figure[data-pdf-page]')
   figures.forEach((figure,i)=>{figure.dataset.pdfPage=String(identities[i]!+1)})
   if(mounted.pages.length!==identities.length)throw Error('PDF 页面预览与原始页标识不一致。')
   setPreviewTick(v=>v+1)
  }catch(error){if(!controller.signal.aborted)setDraftPreviewError(error instanceof Error?error.message:'PDF 预览失败。')}
  finally{if(draftPreview.current===controller)setDraftPreviewBusy(false)}})()
  return()=>controller.abort()
 },[pendingTick,draftTick,imageTick,busy,fileId,request])
 if(!mutationClient.current)mutationClient.current=createPdfMutations({fileId,request,getRevision:()=>revision.current,onSaved:async saved=>{
  draftPreview.current?.abort();setDraftPreviewError('')
  clearRedactions();pdfRender.current?.abort()
  canonicalPreviewVisible.current=false
  revision.current=saved.revision
  pdfBytesRef.current=null;pdfPages.current=[];pdfOutline.current=[];pdfFormFields.current=null;setPdfContext('')
  // A confirmed commit ends the draft session even if loading its preview takes longer.
  textDrafts.current!.saved();imageDrafts.current!.saved()
  const endpoint=`/api/v1/files/${encodeURIComponent(fileId)}/content?revision=${encodeURIComponent(saved.revision)}`
  setUrl(endpoint)
  try{
   const bytes=await previewBytes(endpoint,64*1024*1024)
   if(!host.current)return
   const mounted=await renderPdf(host.current,bytes)
   pdfBytesRef.current=bytes;pdfPages.current=mounted.pages;pdfOutline.current=mounted.outline;pdfFormFields.current=mounted.formFields??[];baselineGeometries.current=mounted.pageGeometries??mounted.pages.map(p=>({pw:p.width!,ph:p.height!,rot:0}))
   setTargetPage(page=>page===0?0:Math.min(Math.max(page,1),mounted.pages.length));setPdfPageInput(page=>Math.min(Math.max(page??1,1),mounted.pages.length))
   setPdfPageCount(mounted.pages.length);setPdfContext(mounted.pages.map(page=>page.text).join('\n').slice(0,16000))
  }catch{pdfPages.current=[];setError('PDF 已保存，但预览刷新失败。请重新加载。')}
  finally{setSaveUnknown(false)}
 }})
 useEffect(()=>{
  if(format!=='pdf'||!registerGuard)return
  const guard=()=>{
   const unknown=hasPendingPdf()
   if(pdfSaveLock.current||unknown){setSaveUnknown(unknown);setPdfMessage(unknown?'PDF 保存结果待确认。请先确认保存结果。':'PDF 正在保存，请等待保存结束。');return false}
   if(hasCanonicalPending()||imagePicking.current||textDrafts.current!.hasPending()||textDrafts.current!.isBusy()||hasRasterDrafts()||imageWorkBusy()){setPdfMessage('PDF 有尚未保存的修改，请先保存或放弃修改。');return false}
   return true
  }
  registerGuard(fileId,guard)
  const beforeUnload=(event:BeforeUnloadEvent)=>{if(hasCanonicalPending()||imagePicking.current||pdfSaveLock.current||hasPendingPdf()||textDrafts.current!.hasPending()||textDrafts.current!.isBusy()||hasRasterDrafts()||imageWorkBusy()){event.preventDefault();event.returnValue=''}}
  window.addEventListener('beforeunload',beforeUnload)
  return()=>{registerGuard(fileId,null);window.removeEventListener('beforeunload',beforeUnload)}
 },[fileId,format,registerGuard])
 useEffect(()=>{
  if(format!=='pdf'||!assistantEnabled)return
  let alive=true,instance:Awaited<ReturnType<typeof createEditorAssistant>>|undefined
  let realtime:ReturnType<typeof createEditorBridge>|undefined
  setAssistantError('')
  const previewSkill=createPdfPreviewSkill(()=>pdfPages.current,page=>{
   if(!scrollPdfPreviewToPage(host.current,page))return false
  setTargetPage(page);setPdfPageInput(page);return true
  },()=>pdfOutline.current,undefined,(edit,signal)=>pdfTextWriter.current?.(edit,signal)??Promise.resolve(false),(annotation,signal)=>pdfAnnotationWriter.current?.(annotation,signal)??Promise.resolve(false),(operations,signal)=>pdfAnnotationDeleter.current?.(operations,signal)??Promise.resolve(false),(operation,signal)=>pdfNoteUpdater.current?.(operation,signal)??Promise.resolve(false),(operations,signal)=>pdfPageWriter.current?.(operations,signal)??Promise.resolve(false),canCreatePdf?(pages,signal)=>pdfExtractor.current?.(pages,signal)??Promise.resolve({ok:false}):undefined,canCreatePdf?(count,signal)=>pdfSplitter.current?.(count,signal)??Promise.resolve({ok:false}):undefined,canCreatePdf?(operation,signal)=>pdfLayout.current?.(operation,signal)??Promise.resolve({ok:false}):undefined,()=>projectedFormFields(),(operations,signal)=>pdfFormWriter.current?.(operations,signal)??Promise.resolve(false),undefined,(input,signal)=>pdfBlockWriter.current?.(input,signal)??Promise.resolve(false),(input,signal)=>pdfBlockMover.current?.(input,signal)??Promise.resolve(false),pdfImageAccess.current,(operation,signal)=>pdfStampWriter.current?.(operation,signal)??Promise.resolve(false),(pages,signal)=>pdfReplacementWriter.current?.(pages,signal)??Promise.resolve(false),canCreatePdf?(patterns,signal)=>pdfSensitiveMarker.current?.(patterns,signal)??Promise.resolve({count:0,truncated:false,error:'涂黑副本入口不可用。'}):undefined,textDrafts.current,async(input,signal)=>{
   if(!pdfBytesRef.current||!draftReady.current()||imageWorkBusy()||textDrafts.current!.isBusy())throw Error('PDF 尚未就绪，请先完成其他操作。')
   const current=revision.current,source=pdfBytesRef.current
   const {preparePdfFormMark}=await import('../editors/pdf-viewer')
   const planned=await preparePdfFormMark(source,input,signal)
   signal?.throwIfAborted()
   if(current!==revision.current||source!==pdfBytesRef.current||!draftReady.current())throw Error('PDF 版本或编辑状态已变化，请重新操作。')
   if(planned.kind==='checkbox'){
    if(hasRasterDrafts()||textDrafts.current!.hasPending())throw Error('请先保存或放弃待保存修改，再填写交互式复选框。')
    const result=pendingSession.current!.apply([{op:'setFormValue',value:{name:planned.name,checked:true}}],{signal})
    if(result.failures.length)throw Error(result.failures[0]!.error)
    return {fieldName:planned.name}
   }
   const {kind,...image}=planned
   const draft=await imageDrafts.current!.insert({op:'insert_image',page:input.page,...image,layer:'above_text'},signal)
   return {draft}
  },(operations,signal)=>pdfFormFieldWriter.current?.(operations,signal)??Promise.resolve(false),{pending:{apply:(operations,options)=>{if(!draftReady.current()||textDrafts.current!.isBusy()||imageWorkBusy())throw Error('请等待 PDF 就绪或完成当前操作。');return pendingSession.current!.apply(operations,options)},annotate:(annotation,signal)=>annotationDrafts.current!.append([annotation],signal),annotations:()=>pendingSession.current!.read()}})
  const skills=[previewSkill,...(documentCreator.current?[createPdfCreateDocumentSkill({docxEditable:docxCreationAvailable,createDocument:documentCreator.current})]:[])]
  void loadEditorAssistant({fileId,editorId:editorId.current,...(conversationId?{conversationId}:{}),generation:()=>1},true,'pdf',new Set(skills.flatMap(skill=>skill.tools.map(tool=>tool.name))),skills).then(result=>{
   if(!alive){result.assistant?.dispose();return}
   if(!result.assistant?.available){setAssistantError(editorAssistantNotice(result,assistantEnabled,document.documentElement.lang.startsWith('en')?'en':'zh'));return}
   instance=result.assistant;assistantImageFetcher.current=result.assistant.mediaApi?.fetchImage;setSharedAssistant(result.assistant)
   const channel=instance.channel
   if(channel&&typeof globalThis.WebSocket==='function')realtime=createEditorBridge({
    origin:location.origin,fileId,editorId:editorId.current,
    onEvent:event=>{if(event.type==='assistant-channels')channel.observe(event.channels)},
   })
  })
  return()=>{alive=false;realtime?.dispose();assistantImageFetcher.current=undefined;instance?.dispose();setSharedAssistant(undefined)}
 },[format,fileId,conversationId,assistantEnabled,assistantAttempt,canCreatePdf,canCreateDocument,docxCreationAvailable])
 function retry(){if(hasCanonicalPending()||loading.current||hasPendingPdf()||textDrafts.current!.hasPending()||textDrafts.current!.isBusy()||hasRasterDrafts()||imageWorkBusy())return;loading.current=true;setBusy(true);setAttempt(value=>value+1)}
 useEffect(()=>{let alive=true;const abort=new AbortController();const target=host.current;loading.current=true;setLoadPhase('reading');setPages([]);setUrl('');setError('');setBusy(true);setPdfPageCount(0);setTargetPage(1);setPdfPageInput(1);setPdfSearch('');setPdfMessage('');setPdfContext('');pdfBytesRef.current=null;pdfPages.current=[];pdfOutline.current=[];pdfFormFields.current=null
 void(async()=>{try{
  const metadata=await request<Metadata>(`/api/v1/files/${encodeURIComponent(fileId)}`)
  const endpoint=resolvePreviewContentUrl(fileId,metadata);if(!alive)return;setUrl(endpoint);revision.current=metadata.file.revision
  if(format==='docx')throw Error('当前 Word 编辑器未启用，请下载原件。')
  const bytes=await previewBytes(endpoint,format==='pdf'?64*1024*1024:16*1024*1024,abort.signal)
  if(!alive)return
  setLoadPhase('rendering')
  if(format==='pdf'){if(alive&&target){const mounted=await renderPdf(target,bytes,abort.signal);if(alive){pdfBytesRef.current=bytes;pdfPages.current=mounted.pages;pdfOutline.current=mounted.outline;pdfFormFields.current=mounted.formFields??[];baselineGeometries.current=mounted.pageGeometries??mounted.pages.map(p=>({pw:p.width!,ph:p.height!,rot:0}));pendingSession.current!.discard();setPdfPageCount(mounted.pages.length);setPdfContext(mounted.pages.map(page=>page.text).join('\n').slice(0,16000));setTargetPage(1)}}}
  else {const result=await parseOfficePreview(bytes,format);if(alive)setPages(result)}
 }catch{if(alive)setError('无法生成只读预览，可下载原件查看。')}finally{if(alive){loading.current=false;setBusy(false)}}})()
 return()=>{alive=false;abort.abort();target?.replaceChildren()}
 },[fileId,format,request,attempt])
 async function rotatePage(delta:number){
  if(!draftReady.current()||textDrafts.current!.isBusy()||imageWorkBusy())return
  const snapshot=pendingSession.current!.read(),pages=(targetPage===0?baselineGeometries.current.map((_,i)=>i+1):[targetPage]).filter(page=>!snapshot.deleted.includes(page-1))
  const result=pendingSession.current!.apply([{op:'rotatePages',pages,dir:delta}])
  setPdfMessage(result.failures[0]?.error??'页面旋转尚未保存。')
 }
 async function savePdfMutation(action:'rotate'|'edit-text'|'annotate'|'delete-annotations'|'update-notes'|'page-ops'|'form-values'|'form-fields'|'text-inserts'|'block-edits'|'block-moves'|'image-edits'|'image-content'|'image-bakes'|'stamps'|'replace-pages'|'draft-inserts'|'apply-ops',operations:readonly unknown[],message:string,signal?:AbortSignal):Promise<boolean>{
  signal?.throwIfAborted()
  if(action!=='apply-ops'&&hasCanonicalPending()){setPdfMessage('请先保存或放弃待保存修改，再修改原文件。');return false}
  if(action!=='apply-ops'&&(textDrafts.current!.isBusy()||imageWorkBusy()||textDrafts.current!.hasPending()&&!['text-inserts','draft-inserts'].includes(action)||hasRasterDrafts()&&(action!=='draft-inserts'||!!draftPreviewError))){setPdfMessage('请先完成预览并保存或放弃待保存文字和图片，再修改原文件。');return false}
  if(redactionReview?.candidates.length){setPdfMessage('请先完成或清除待确认的涂黑标记，再修改原文件。');return false}
  if(imagePicking.current||pdfSaveLock.current||!revision.current||!pdfBytesRef.current||loading.current||hasPendingPdf())return false
  pdfSaveLock.current=true;setSavingPdf(true);setPdfMessage('')
  try{
   const saved=await mutationClient.current!.mutate(action,operations,signal)
   if(saved)setPdfMessage(message)
   return saved
  }catch{
   const unknown=hasPendingPdf()
   setSaveUnknown(unknown)
   setPdfMessage(unknown?'PDF 保存结果待确认。请点击“确认保存结果”，不要重复执行修改。':'PDF 保存失败：原文可能无法匹配、字体不支持、版本已变化，或文档受保护。')
   return false
  }finally{pdfSaveLock.current=false;setSavingPdf(false)}
 }
 async function confirmPdfSave(){
  if(pdfSaveLock.current)return
  pdfSaveLock.current=true;setSavingPdf(true)
  const confirmingCreation=extractionClient.current!.hasPending()
  try{if(await (confirmingCreation?extractionClient.current!.confirm():mutationClient.current!.confirm())){const progress=extractionClient.current!.getProgress();if(confirmingCreation)clearRedactions();setPdfMessage(confirmingCreation?`已生成并打开 ${progress.created}/${progress.total} 份 PDF，保存结果已确认。`:'PDF 保存结果已确认。')}}
  catch(error){const progress=extractionClient.current!.getProgress();setPdfMessage(confirmingCreation?`${error instanceof Error?error.message:'PDF 创建结果待确认。'} 已确认生成 ${progress.created}/${progress.total} 份 PDF。${hasPendingPdf()?'请确认保存结果，不要重复生成。':''}`:hasPendingPdf()?'PDF 保存结果仍待确认，请保留当前页面后重试。':'PDF 保存失败：版本或租约发生冲突，请重新加载后再修改。')}
  finally{setSaveUnknown(hasPendingPdf());pdfSaveLock.current=false;setSavingPdf(false)}
 }
 function clearRedactions(){redactionQuery.current++;setRedactionReview(null);setSelectedRedactions([]);setRedactionConfirm(false)}
 useEffect(()=>()=>{redactionQuery.current++},[])
 pdfSensitiveMarker.current=async(patterns,signal)=>{
  if(!pdfImageReady.current()||replacementPending.current)return {count:0,truncated:false,error:'请先结束当前保存、旋转或文件选择，再标记候选。'}
  const current=revision.current,sequence=++redactionQuery.current
  try{
   const review=await queryPdfRedactions(request,fileId,current,patterns,signal)
   if(sequence!==redactionQuery.current||revision.current!==current||replacementPending.current||!pdfImageReady.current())return {count:0,truncated:false,error:'文档状态已变化，请重新读取后标记。'}
   setRedactionReview(review);setSelectedRedactions(review.candidates.map(candidate=>candidate.id));setRedactionConfirm(false)
   return {count:review.candidates.length,truncated:review.truncated}
  }catch(error){signal?.throwIfAborted();return {count:0,truncated:false,error:error instanceof Error?error.message:'读取涂黑候选失败。'}}
 }
 useEffect(()=>{
  const overlays:SVGElement[]=[]
  if(redactionReview?.revision===revision.current)for(const page of pdfPages.current){
   const candidates=redactionReview.candidates.filter(candidate=>candidate.page===page.page&&selectedRedactions.includes(candidate.id))
   const surface=host.current?.querySelector<HTMLElement>(`figure[data-pdf-page="${page.page}"] .pdf-page-surface`)
   if(!surface||!candidates.length)continue
   const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox',`0 0 ${page.width} ${page.height}`);svg.setAttribute('aria-label','待确认的涂黑标记');svg.style.cssText='position:absolute;inset:0;width:100%;height:100%;pointer-events:none'
   for(const candidate of candidates){const rect=document.createElementNS('http://www.w3.org/2000/svg','rect'),box=candidate.displayRect;for(const [key,value]of Object.entries({x:box.left,y:box.top,width:box.width,height:box.height}))rect.setAttribute(key,String(value));rect.setAttribute('fill','#111');rect.setAttribute('fill-opacity','.65');rect.setAttribute('stroke','#dc2626');rect.setAttribute('stroke-dasharray','4 2');svg.append(rect)}
   surface.append(svg);overlays.push(svg)
  }
  return()=>{for(const overlay of overlays)overlay.remove()}
 },[redactionReview,selectedRedactions,busy])
 async function saveRedactedCopy(){
  if(!redactionReview||!selectedRedactions.length||redactionReview.truncated||redactionReview.revision!==revision.current||pdfSaveLock.current||hasPendingPdf()||hasPendingRotations||replacementPending.current)return
  pdfSaveLock.current=true;setSavingPdf(true);setPdfMessage('')
  try{if(await extractionClient.current!.redact({patterns:redactionReview.patterns,ids:selectedRedactions})){clearRedactions();setPdfMessage('已生成并打开涂黑副本，原文件保持不变。')}}
  catch(error){setSaveUnknown(hasPendingPdf());setPdfMessage(error instanceof Error?error.message:'涂黑副本保存失败。')}
  finally{pdfSaveLock.current=false;setSavingPdf(false);setRedactionConfirm(false)}
 }
 function finishReplacement(saved:boolean){
  const pending=replacementPending.current
  replacementPending.current=undefined;setReplacementPages(null);setReplacementSource(null);setReplacementError('')
  pending?.cleanup();pending?.resolve(saved)
 }
 useEffect(()=>()=>{const pending=replacementPending.current;replacementPending.current=undefined;pending?.cleanup();pending?.resolve(false)},[])
 pdfReplacementWriter.current=(pages,signal)=>{
  signal?.throwIfAborted()
  if(redactionReview?.candidates.length||replacementPending.current||!pdfImageReady.current())return Promise.resolve(false)
  setReplacementSource(null);setReplacementError('');setReplacementPages(pages)
  return new Promise<boolean>(resolve=>{
   const aborted=()=>finishReplacement(false)
   replacementPending.current={pages,revision:revision.current,signal,resolve,cleanup:()=>signal?.removeEventListener('abort',aborted)}
   signal?.addEventListener('abort',aborted,{once:true})
   if(signal?.aborted)aborted()
  })
 }
 async function confirmReplacement(){
  const pending=replacementPending.current,source=replacementSource
  if(!pending||!source||pdfSaveLock.current)return
  if(pending.revision!==revision.current||!pdfImageReady.current()){finishReplacement(false);setPdfMessage('文档状态已变化，请重新读取页码后再替换。');return}
  const saved=await savePdfMutation('replace-pages',[{pages:pending.pages,source}],'PDF 页面替换已保存为新版本，请重新读取页码。',pending.signal)
  finishReplacement(saved)
 }
 pdfStampWriter.current=(operation,signal)=>{
  return savePdfMutation('stamps',[operation],'PDF 水印或页眉页脚已保存为新版本。',signal)
 }
 pdfTextWriter.current=(edit,signal)=>{
  return savePdfMutation('edit-text',[edit],'PDF 原文改写已保存为新版本。',signal)
 }
 pdfAnnotationWriter.current=async(annotation,signal)=>{await annotationDrafts.current!.append([annotation],signal);return true}
 pdfAnnotationDeleter.current=(operations,signal)=>{
  return savePdfMutation('delete-annotations',operations,'PDF 批注删除已保存为新版本。',signal)
 }
 pdfNoteUpdater.current=(operation,signal)=>{
  return savePdfMutation('update-notes',[operation],operation.action==='reply'?'PDF 批注回复已保存为新版本。':'PDF 批注改写已保存为新版本。',signal)
 }
 pdfImageContentWriter.current=(operation,signal)=>{
  if(!pdfImageReady.current())return Promise.resolve(false)
  return savePdfMutation('image-content',[operation],'PDF 图片已保存为新版本，请重新读取图片编号。',signal)
 }
 pdfImageWriter.current=(operation,signal)=>{
  const action=['flip_image','set_image_opacity','crop_image','remove_image_background'].includes(operation.op)?'image-bakes':'image-edits'
  return savePdfMutation(action,[operation],'PDF 图片修改已保存为新版本，请重新读取图片编号。',signal)
 }
 pdfBlockMover.current=(input,signal)=>{
  return savePdfMutation('block-moves',[input],'PDF 段落移动已保存为新版本。',signal)
 }
 pdfBlockWriter.current=(input,signal)=>{
  return savePdfMutation('block-edits',[input],'PDF 段落改写已保存为新版本。',signal)
 }
 pdfFormFieldWriter.current=(operations,signal)=>{
  return savePdfMutation('form-fields',operations,'PDF 新增表单字段已保存为新版本。',signal)
 }
 pdfFormWriter.current=(operations,signal)=>{
  if(pdfFormFields.current===null)return Promise.resolve(false)
  return savePdfMutation('form-values',operations,'PDF 表单字段与显示内容已保存为新版本。',signal)
 }
 pdfPageWriter.current=(operations,signal)=>{
  return savePdfMutation('page-ops',operations,'PDF 页面调整已保存为新版本，请重新读取页码。',signal)
 }
 async function createNewPdfs(kind:'extract'|'split'|'layout',input:readonly number[]|number|PdfPageLayout,signal?:AbortSignal):Promise<PdfExtractionResult>{
  if(hasCanonicalPending()||imagePicking.current||textDrafts.current!.hasPending()||textDrafts.current!.isBusy()||hasRasterDrafts()||imageWorkBusy())return {ok:false,error:'请先完成图片读取、保存或放弃待保存文字和图片，再生成副本。'}
  if(redactionReview?.candidates.length)return {ok:false,error:'请先完成或清除待确认的涂黑标记，再生成其他副本。'}
  signal?.throwIfAborted()
  if(!createdPdf.current||loading.current||pdfSaveLock.current||hasPendingPdf())return {ok:false,error:'请先完成或确认当前 PDF 保存，再创建新 PDF。'}
  signal?.throwIfAborted()
  pdfSaveLock.current=true;setSavingPdf(true);setPdfMessage('')
  try{
   const saved=kind==='layout'?await extractionClient.current!.layout(input as PdfPageLayout,signal):kind==='split'?await extractionClient.current!.split(input as number,signal):await extractionClient.current!.extract(input as readonly number[],signal)
   if(saved){const progress=extractionClient.current!.getProgress();setPdfMessage(`已生成并打开 ${progress.created}/${progress.total} 份新的 PDF，原文件页面保持不变。`)}
   return {ok:saved}
  }catch(error){
   const message=error instanceof Error?error.message:'PDF 创建失败。'
   const progress=extractionClient.current!.getProgress()
   const count=kind==='split'&&progress.total?` 已确认生成 ${progress.created}/${progress.total} 份 PDF。`:''
   const detail=`${message}${count}${extractionClient.current!.hasPending()?' 请确认保存结果，不要重复生成。':''}`
   setSaveUnknown(hasPendingPdf());setPdfMessage(detail)
   return {ok:false,error:detail}
  }finally{pdfSaveLock.current=false;setSavingPdf(false)}
 }
 pdfExtractor.current=(pages,signal)=>createNewPdfs('extract',pages,signal)
 pdfSplitter.current=(count,signal)=>createNewPdfs('split',count,signal)
 pdfLayout.current=(operation,signal)=>createNewPdfs('layout',operation,signal)
 const hasPendingRotations=Object.keys(pendingSession.current!.read().rotations).length>0
 const draftOverlayPages=pdfPages.current.map(page=>(pendingSession.current!.read().rotations[page.page-1]??0)%180===0?page:{...page,width:page.height,height:page.width})
 const draftBusy=busy||pickingImage||savingPdf||saveUnknown||textDrafts.current.isBusy()||imageWorkBusy()
 const rotationDisabled=draftBusy
 async function changeDraft(change:()=>Promise<unknown>|unknown){try{await change();setPdfMessage('文字修改尚未保存，请核对页面后点击“保存新版本”。')}catch(error){setPdfMessage(error instanceof Error?error.message:'文字修改失败。')}}
 async function changeImageDraft(change:()=>Promise<unknown>|unknown){try{await change();setPdfMessage('图片修改尚未保存，请核对页面后点击“保存新版本”。')}catch(error){setPdfMessage(error instanceof Error?error.message:'图片修改失败。')}}
 function bakeImage(operation:PdfImageDraftBakeOperation){if(activeImage)void changeImageDraft(()=>imageDrafts.current!.bake(activeImage.id,operation))}
 async function pickImage(file:File|null,replaceId?:string){
  if(!file||imagePicking.current||!draftReady.current())return
  const sequence=++imageReadGeneration.current,current=revision.current
  imagePicking.current=true;setPickingImage(true)
  await changeImageDraft(async()=>{
   try{
   if(file.size<1||file.size>5*1024*1024||!['image/png','image/jpeg'].includes(file.type))throw Error('请选择不超过 5 MiB 的 PNG 或 JPEG 图片。')
   const base64=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();imageReader.current=reader;reader.onabort=()=>reject(new DOMException('图片读取已取消。','AbortError'));reader.onerror=()=>reject(Error('图片读取失败。'));reader.onload=()=>resolve(String(reader.result).split(',')[1]!);reader.readAsDataURL(file)})
   if(!imageReadAlive.current||sequence!==imageReadGeneration.current||current!==revision.current)throw Error('PDF 版本或工作区已变化，图片尚未加入。')
   imagePicking.current=false;setPickingImage(false)
   const image={base64,mime:file.type as 'image/png'|'image/jpeg'}
   if(replaceId)await imageDrafts.current!.replace(replaceId,image)
   else await imageDrafts.current!.insert({op:'insert_image',page:targetPage||1,image})
   }finally{if(sequence===imageReadGeneration.current){imagePicking.current=false;imageReader.current=null;setPickingImage(false)}}
  })
 }
 async function savePdfDrafts(){
  if(hasCanonicalPending())await savePdfMutation('apply-ops',[pendingSession.current!.read()],'PDF 修改已保存为新版本。')
 }
 const pdfSearchResults=searchPdfPreview(pdfPages.current,pdfSearch)
 function jumpToPdfPage(page:number|null){
  if(page===null||!Number.isSafeInteger(page)||page<1||page>pdfPageCount)return
  if(scrollPdfPreviewToPage(host.current,page)){setTargetPage(page);setPdfPageInput(page)}
 }
 return <div className="document-loading-host">{busy&&<DocumentLoading key={`${fileId}-${attempt}`} name={name} format={format} state={loadPhase}/>}<div className="document-loading-content" data-loading={busy} aria-busy={busy}><div className={`document-preview-layout${format==='pdf'&&sharedAssistant?.available?' has-assistant':''}`}><section className="document-preview-main" style={{height:'100%',overflow:'auto',padding:24}}><Card title={name} extra={<>{url&&<Button href={url} download={name}>下载原件</Button>}{format==='pdf'&&pdfPageCount>0&&<span className="dyoffice-pdf-toolbar" style={{display:'inline-flex',gap:8,alignItems:'center'}}><select aria-label="选择旋转页码" value={targetPage} onChange={e=>setTargetPage(Number(e.target.value))} disabled={savingPdf||saveUnknown} style={{height:32,borderRadius:6,padding:'0 8px'}}><option value={0}>全部页面 ({pdfPageCount} 页)</option>{Array.from({length:pdfPageCount},(_,i)=>i).filter(i=>!pendingSession.current!.read().deleted.includes(i)).map(i=><option key={i+1} value={i+1}>第 {i+1} 页</option>)}</select><Button disabled={rotationDisabled} onClick={()=>{void rotatePage(-90)}}>向左旋转 90°</Button><Button disabled={rotationDisabled} onClick={()=>{void rotatePage(90)}}>向右旋转 90°</Button><Button disabled={draftBusy||!!redactionReview?.candidates.length||!!replacementPages} onClick={()=>{void changeDraft(()=>textDrafts.current!.insert({page:targetPage||1,text:'新文字',x:72,y:72}))}}>添加文字</Button><Button disabled={draftBusy||!pendingSession.current!.canUndo()} onClick={()=>pendingSession.current!.undo()}>撤销修改</Button><Button disabled={draftBusy||!pendingSession.current!.canRedo()} onClick={()=>pendingSession.current!.redo()}>重做修改</Button><Button disabled={draftBusy||!hasCanonicalPending()} onClick={()=>pendingSession.current!.discard()}>放弃修改</Button><Button type="primary" loading={savingPdf} disabled={(!hasCanonicalPending()&&!hasRasterDrafts())||draftBusy||draftPreviewBusy||!!draftPreviewError} onClick={()=>{void savePdfDrafts()}}>保存新版本</Button></span>}</>}>
 <DocumentNotifications key={fileId} items={[
 {id:'preview-mode',level:'info',title:format==='pdf'?'PDF 编辑与批注':'只读预览',message:format==='pdf'?'页面旋转、删除和排序、元数据、批注、新增文字与图片、表单编辑进入待保存修改，可统一撤销、重做或放弃；点击“保存新版本”后统一写入。原文改写、已有批注和其他专用工具会立即保存，执行前须先保存或放弃待保存修改。裁剪仅调整显示区域，不会完成脱敏。PDF 不会自动重排；签名字段和只读字段不可填写。受保护文档或助手管理的水印可能限制编辑。':'仅提取文本与缓存数值，不执行公式或外部连接，不保证原始排版。每张工作表最多显示 200 行、200 列。'},
 ...(pdfMessage?[{id:'pdf-save-state',level:(pdfMessage.includes('失败')?'error':'info') as 'error'|'info',title:'PDF 保存状态',message:pdfMessage,...(saveUnknown?{actions:<Button disabled={savingPdf} onClick={()=>{void confirmPdfSave()}}>确认保存结果</Button>}:{})}]:[]),
 ...(assistantEnabled&&assistantError?[{id:'pdf-assistant-state',level:'error' as const,title:'Office 助手',message:assistantError,actions:<Button onClick={()=>setAssistantAttempt(value=>value+1)}>重试助手</Button>}]:[]),
 ...(error?[{id:'preview-error',level:'error' as const,title:'预览未完成',message:error,actions:<Button disabled={busy} onClick={retry}>重新加载预览</Button>}]:[]),
 ]}/>
 {format==='pdf'&&pdfPageCount>0&&<div role="group" aria-label="PDF 导航" style={{display:'flex',flexWrap:'wrap',gap:8,alignItems:'flex-start',marginBottom:12}}><div style={{flex:'1 1 240px',minWidth:0}}><Input.Search aria-label="搜索 PDF 文本" placeholder="搜索 PDF 文本" value={pdfSearch} onChange={event=>setPdfSearch(event.target.value)} allowClear/><div aria-live="polite" style={{display:'grid',gap:4,marginTop:4}}>{pdfSearch.trim()&&!pdfSearchResults.length&&<span>没有匹配的文本。</span>}{pdfSearchResults.map(result=><Button key={result.page} type="link" style={{height:'auto',justifyContent:'flex-start',whiteSpace:'normal',textAlign:'left'}} onClick={()=>jumpToPdfPage(result.page)}>第 {result.page} 页：{result.excerpt}</Button>)}</div></div><div style={{display:'flex',gap:6,alignItems:'center',flex:'0 0 auto'}}><InputNumber aria-label="跳转到 PDF 页码" min={1} max={pdfPageCount} value={pdfPageInput} onChange={setPdfPageInput} onPressEnter={()=>jumpToPdfPage(pdfPageInput)} controls/><Button onClick={()=>jumpToPdfPage(pdfPageInput)}>跳转</Button></div></div>}
 {format==='pdf'&&pdfPageCount>0&&<label style={{display:'inline-flex',gap:8,alignItems:'center',marginBottom:12}}>添加图片 <input type="file" aria-label="添加待保存图片" accept="image/png,image/jpeg" disabled={draftBusy||!!redactionReview?.candidates.length||!!replacementPages} onChange={event=>{const file=event.currentTarget.files?.[0]??null;event.currentTarget.value='';void pickImage(file)}}/></label>}
 {draftPreviewBusy&&<p role="status">正在生成图片与文字的页面预览…</p>}
 {draftPreviewError&&<p role="alert">图片预览失败：{draftPreviewError} <Button disabled={draftBusy} onClick={()=>setImageTick(value=>value+1)}>重试图片预览</Button></p>}
 {savedImageOperations.length>0&&<section role="region" aria-label="已有图片待保存编辑" style={{padding:16,border:'1px solid var(--border)',borderRadius:8,marginBottom:16}}>
 <strong>已有图片 · {savedImageOperations.length} 项待保存编辑</strong>
 <ul>{savedImageOperations.map(operation=><li key={`${operation.page}:${operation.image_number}`}>第 {operation.page} 页 · 图片 {operation.image_number} · {{transform_image:'调整位置或大小',rotate_image:'旋转',delete_image:'删除',replace_image:'替换',flip_image:'翻转',set_image_opacity:'调整不透明度',crop_image:'裁剪',remove_image_background:'去背景'}[operation.op]}</li>)}</ul>
 </section>}
 {(imageBlocks.length>0)&&<section role="region" aria-label="待保存图片编辑" style={{padding:16,border:'1px solid var(--border)',borderRadius:8,marginBottom:16}}>
 <strong>待保存图片 · {imageBlocks.length} 张</strong><p>选中图片后可拖动，拖动右下角缩放。像素修改与文字一起在确认保存后写入 PDF。</p>
 {imageBlocks.length>0&&<select aria-label="选择待保存图片" value={selectedImage} disabled={draftBusy} onChange={event=>setSelectedImage(event.target.value)}>{imageBlocks.map((block,index)=><option key={block.id} value={block.id}>第 {block.page} 页 · 图片 {index+1}</option>)}</select>}
 {activeImage&&<><div style={{display:'flex',flexWrap:'wrap',gap:8,alignItems:'center',marginTop:8}}>{([['横坐标',imageX,setImageX],['纵坐标',imageY,setImageY],['宽度',imageWidth,setImageWidth],['高度',imageHeight,setImageHeight]] as const).map(([label,value,setValue])=><label key={label}>{label} <InputNumber aria-label={'待保存图片'+label} value={value} disabled={draftBusy} onChange={setValue}/></label>)}<select aria-label="待保存图片图层" value={imageLayer} disabled={draftBusy} onChange={event=>setImageLayer(event.target.value as typeof imageLayer)}><option value="below_text">文字下方</option><option value="above_text">文字上方</option></select><Button disabled={draftBusy||imageX===null||imageY===null||!imageWidth||!imageHeight} onClick={()=>{void changeImageDraft(()=>imageDrafts.current!.transform(activeImage.id,{x:imageX!,y:imageY!,width:imageWidth!,height:imageHeight!,layer:imageLayer}))}}>应用图片位置</Button></div>
 <div style={{display:'flex',flexWrap:'wrap',gap:8,alignItems:'center',marginTop:8}}><Button disabled={draftBusy} onClick={()=>bakeImage({kind:'rotate',direction:'cw'})}>图片右转 90°</Button><Button disabled={draftBusy} onClick={()=>bakeImage({kind:'rotate',direction:'ccw'})}>图片左转 90°</Button><Button disabled={draftBusy} onClick={()=>bakeImage({kind:'flip',axis:'horizontal'})}>水平翻转图片</Button><Button disabled={draftBusy} onClick={()=>bakeImage({kind:'flip',axis:'vertical'})}>垂直翻转图片</Button><label>不透明度 (%) <InputNumber aria-label="待保存图片不透明度" value={imageOpacity} min={0} max={100} disabled={draftBusy} onChange={setImageOpacity}/></label><Button disabled={draftBusy||imageOpacity===null} onClick={()=>bakeImage({kind:'opacity',value:imageOpacity!/100})}>应用不透明度</Button></div>
 <div style={{display:'flex',flexWrap:'wrap',gap:8,alignItems:'center',marginTop:8}}>{(['left','top','right','bottom'] as const).map((side,index)=><label key={side}>{['左','上','右','下'][index]}裁剪 (%) <InputNumber aria-label={'待保存图片'+['左','上','右','下'][index]+'裁剪'} min={0} max={99} value={imageCrop[side]} disabled={draftBusy} onChange={value=>setImageCrop(current=>({...current,[side]:value??0}))}/></label>)}<Button disabled={draftBusy||!Object.values(imageCrop).some(Boolean)} onClick={()=>bakeImage({kind:'crop',...Object.fromEntries(Object.entries(imageCrop).map(([key,value])=>[key,value/100]))})}>裁剪待保存图片</Button><label>去背景容差 <InputNumber aria-label="待保存图片去背景容差" min={0} max={100} value={imageTolerance} disabled={draftBusy} onChange={setImageTolerance}/></label><Button disabled={draftBusy||imageTolerance===null} onClick={()=>bakeImage({kind:'cutout',tolerance:imageTolerance!})}>去除图片背景</Button></div>
 <div style={{display:'flex',flexWrap:'wrap',gap:8,alignItems:'center',marginTop:8}}><label>替换图片 <input type="file" aria-label="替换待保存图片" accept="image/png,image/jpeg" disabled={draftBusy} onChange={event=>{const file=event.currentTarget.files?.[0]??null;event.currentTarget.value='';void pickImage(file,activeImage.id)}}/></label><Button danger disabled={draftBusy} onClick={()=>{void changeImageDraft(()=>imageDrafts.current!.remove(activeImage.id))}}>删除待保存图片</Button></div></>}

 </section>}
 <PdfImageDraftOverlay host={host.current} pages={draftOverlayPages} blocks={imageBlocks} selected={selectedImage} disabled={draftBusy||draftPreviewBusy} onSelect={setSelectedImage} onTransform={(id,geometry)=>{void changeImageDraft(()=>imageDrafts.current!.transform(id,geometry))}} onDelete={id=>{void changeImageDraft(()=>imageDrafts.current!.remove(id))}}/>
 {(draftBlocks.length>0)&&<section role="region" aria-label="待保存文字编辑" style={{padding:16,border:'1px solid var(--border)',borderRadius:8,marginBottom:16}}>
 <strong>待保存文字 · {draftBlocks.length} 个</strong><p>选中页面上的文字后可拖动，或在下方修改；点击“保存新版本”后写入 PDF。</p>
 {draftBlocks.length>0&&<select aria-label="选择待保存文字" value={selectedDraft} disabled={draftBusy} onChange={event=>setSelectedDraft(event.target.value)}>{draftBlocks.map(block=><option key={block.id} value={block.id}>第 {block.page} 页 · {block.text.slice(0,35)}</option>)}</select>}
 {activeDraft&&<><Input.TextArea aria-label="待保存文字内容" value={draftText} disabled={draftBusy} onChange={event=>setDraftText(event.target.value)} rows={3} style={{marginTop:8}}/>
 <div style={{display:'flex',flexWrap:'wrap',gap:8,alignItems:'center',marginTop:8}}><label>字号 <InputNumber aria-label="待保存文字字号" value={draftFontSize} min={1} max={1000} disabled={draftBusy} onChange={setDraftFontSize}/></label><label>颜色 <input aria-label="待保存文字颜色" type="color" value={draftColor} disabled={draftBusy} onChange={event=>setDraftColor(event.target.value)}/></label><select aria-label="待保存文字对齐" value={draftAlign} disabled={draftBusy} onChange={event=>setDraftAlign(event.target.value as typeof draftAlign)}><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select><Button disabled={draftBusy||!draftText.trim()||!draftFontSize} onClick={()=>{void changeDraft(()=>textDrafts.current!.edit({id:activeDraft.id,text:draftText,font_size:draftFontSize!,color:draftColor,align:draftAlign}))}}>应用文字修改</Button></div>
 <div style={{display:'flex',flexWrap:'wrap',gap:8,alignItems:'center',marginTop:8}}><label>横坐标 <InputNumber aria-label="待保存文字横坐标" value={draftX} disabled={draftBusy} onChange={setDraftX}/></label><label>纵坐标 <InputNumber aria-label="待保存文字纵坐标" value={draftY} disabled={draftBusy} onChange={setDraftY}/></label><Button disabled={draftBusy||draftX===null||draftY===null} onClick={()=>{void changeDraft(()=>textDrafts.current!.move({id:activeDraft.id,x:draftX!,y:draftY!}))}}>移动文字</Button><Button danger disabled={draftBusy} onClick={()=>{void changeDraft(()=>textDrafts.current!.remove(activeDraft.id))}}>删除待保存文字</Button></div></>}

 </section>}
 <PdfTextDraftOverlay rasterPages={new Set(pdfPages.current.map(page=>page.page))} host={host.current} pages={draftOverlayPages} blocks={draftBlocks} selected={selectedDraft} disabled={draftBusy||draftPreviewBusy} onSelect={setSelectedDraft} onMove={(id,dx,dy)=>{void changeDraft(()=>textDrafts.current!.move({id,dx,dy}))}} onDelete={id=>{void changeDraft(()=>textDrafts.current!.remove(id))}}/>
 {redactionReview&&<section role="region" aria-label="涂黑候选审查" style={{padding:16,border:'1px solid var(--border)',borderRadius:8,marginBottom:16}}>
 <strong>审查涂黑候选 · 已选 {selectedRedactions.length} / {redactionReview.candidates.length}</strong>
 <p>当前仅显示待确认标记，原文尚未删除。确认后会永久删除所选区域的内容，并另存一份 PDF；原文件保留。副本中的水印和页眉页脚会成为普通内容，助手不再按原配置恢复它们。</p>
 <p>仅检索可提取文字，未执行 OCR，图片和未提取文字未检查。{redactionReview.unsupportedPages.length>0&&` 第 ${redactionReview.unsupportedPages.join('、')} 页有无法安全定位的文字，未列为候选。`}</p>
 {redactionReview.truncated&&<p role="alert">候选结果超过处理范围，请缩小匹配类型后重新标记；当前不能生成副本。</p>}
 <div style={{maxHeight:240,overflow:'auto'}}>{redactionReview.candidates.map(candidate=><div key={candidate.id} style={{display:'flex',gap:8,alignItems:'center',marginBottom:6}}><label style={{flex:1}}><input type="checkbox" checked={selectedRedactions.includes(candidate.id)} disabled={savingPdf||saveUnknown} onChange={event=>{setSelectedRedactions(current=>event.target.checked?[...current,candidate.id]:current.filter(id=>id!==candidate.id));setRedactionConfirm(false)}}/> 第 {candidate.page} 页：{candidate.text}</label><Button size="small" onClick={()=>jumpToPdfPage(candidate.page)}>查看位置</Button></div>)}</div>
 {!redactionReview.candidates.length&&<p>没有可定位的候选。</p>}
 {redactionConfirm&&<p role="alert">即将永久删除副本中所选 {selectedRedactions.length} 处区域的内容。请核对页面标记，原文件将保留。</p>}
 <div style={{display:'flex',gap:8,marginTop:12}}><Button danger type="primary" disabled={!selectedRedactions.length||redactionReview.truncated||savingPdf||saveUnknown} loading={savingPdf} onClick={()=>{if(redactionConfirm)void saveRedactedCopy();else setRedactionConfirm(true)}}>{redactionConfirm?'确认永久涂黑并另存':'生成涂黑副本'}</Button><Button disabled={savingPdf||saveUnknown} onClick={clearRedactions}>清除标记</Button></div>
 </section>}
 {replacementPages&&<section role="region" aria-label="替换 PDF 页面" className="pdf-replacement-panel" style={{padding:16,border:'1px solid var(--border)',borderRadius:8,marginBottom:16}}>
  <strong>替换第 {replacementPages.join('、')} 页</strong>
  <p>选择一个 PDF，用其中的全部页面替换这些页。新页面将连续插入首个被替换的位置，确认后保存为新版本。</p>
  <p>来源 PDF 中可见的水印与页眉页脚会作为原文保留；当前文件的助手水印与页码将重新应用。</p>
  <input type="file" accept="application/pdf,.pdf" aria-label="选择替换来源 PDF" disabled={savingPdf} onChange={event=>{
   const file=event.currentTarget.files?.[0]??null
   if(file&&(file.size<1||file.size>64*1024*1024||!file.name.toLowerCase().endsWith('.pdf'))){setReplacementSource(null);setReplacementError('请选择不超过 64 MiB 的 PDF 文件。');event.currentTarget.value='';return}
   setReplacementSource(file);setReplacementError('')
  }}/>
  {replacementSource&&<p>{replacementSource.name} · {(replacementSource.size/1024).toFixed(1)} KiB</p>}
  {replacementError&&<p role="alert">{replacementError}</p>}
  <div style={{display:'flex',gap:8,marginTop:12}}><Button type="primary" disabled={!replacementSource||savingPdf} loading={savingPdf} onClick={()=>{void confirmReplacement()}}>确认替换并保存</Button><Button disabled={savingPdf} onClick={()=>finishReplacement(false)}>取消替换</Button></div>
 </section>}
 <div ref={host} role={format==='pdf'?'region':undefined} aria-label={format==='pdf'?'PDF 页面':undefined} tabIndex={format==='pdf'?0:undefined} style={{maxWidth:'100%',overflowX:'auto'}}/>{pages.map((page,index)=><Card key={index} title={page.name} style={{marginTop:16}}><div style={{overflow:'auto'}}><table><tbody>{page.rows.map((row,i)=><tr key={i}>{row.map((value,j)=><td key={j} style={{border:'1px solid var(--border)',padding:'6px 10px',whiteSpace:'pre-wrap'}}>{value}</td>)}</tr>)}</tbody></table></div></Card>)}
 </Card></section>
 {format==='pdf'&&sharedAssistant?.available&&<aside className="pdf-shared-assistant"><SharedEditorAssistant assistant={sharedAssistant} lang={document.documentElement.lang.startsWith('en')?'en':'zh'} context={`PDF ${name}; page count ${pdfPageCount}. Extracted text:\n${pdfContext}`}/></aside>}
 </div></div></div>
}
