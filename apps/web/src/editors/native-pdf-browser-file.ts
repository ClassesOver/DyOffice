import {createSessionFileHost} from '../../../../packages/browser-host/src/files.ts'
import {createPreferencesClient} from '../../../../packages/browser-host/src/preferences'
import {PDF_READ_CHUNK_BYTES,type PageImageRef,type PagePreviewResult,type PdfApi,type PdfConvertFormat,type TextEditInput,type TextEditValidation} from '../../../pdf/src/shared/ipc'
import {createLocalShellClient} from '../shell/local-client'
import {createNativePdfSave} from './native-pdf-save'
import {isRevisionRef,type OpenFileResult,type RevisionRef} from '../../../../packages/web-contracts/src/api'
import {queryPdfPendingPreview} from './pdf-pending-preview'
import type {PdfImageInfo} from './pdf-types'
import type {PdfHostImageBake,PdfOcrLine,PdfSignatureInfo} from '../../../pdf/src/shared/ipc'
import type {PreparedAiDocumentCreator} from '../shell/pdf-create-document-skill'
import {createPdfExtraction} from './pdf-extraction'
import {queryPdfRedactions} from './pdf-redactions'
import type {PdfHostConversionDraft} from '../../../pdf/src/renderer/App'
import type {PdfPendingSnapshot} from './pdf-pending-ops'

const byteRangeMarker=new TextEncoder().encode('/ByteRange')
function hasSignatureMarker(bytes:Uint8Array){
 for(let index=bytes.indexOf(byteRangeMarker[0]!);index!==-1;index=bytes.indexOf(byteRangeMarker[0]!,index+1)){
  if(byteRangeMarker.every((byte,offset)=>bytes[index+offset]===byte))return true
 }
 return false
}

/** Session-bound file grant for the desktop PDF renderer in a browser. */
export type PresentWorkspaceCopy=(receipt:RevisionRef,proof:string,signal?:AbortSignal)=>Promise<void>

export async function openNativePdfBrowserFile({fileId,fetchImpl=fetch,expectedRevision,editorId}:{fileId:string;editorId?:string|undefined;fetchImpl?:typeof fetch;expectedRevision?:string|undefined}){
 const client=createLocalShellClient(fetchImpl),session=await client.bindSession()
 const host=createSessionFileHost({fetchImpl,expectedRevision,...(editorId?{editorId}:{})})
 let disposed=false,pending=true,chunks:Promise<Uint8Array>|undefined
 let account:[deploymentId:string,userId:string]|undefined
 const assertActive=()=>{if(disposed)throw Error('PDF file grant is closed')}
 const assertSession=async()=>{
  assertActive()
  await client.bindSession(session.proof)
  assertActive()
 }
 try{
  const opened=await host.open(fileId)
  await assertSession()
  if(opened.format!=='pdf')throw Error('Expected a PDF document')
  const revision=Object.freeze({...opened.file})
  let current=revision,pageCount=0
  let signatureRevision:RevisionRef|undefined
  const signatureRequests=new AbortController()
  let bakePreview:{base:RevisionRef;key:string;bytes:Uint8Array}|undefined
  // The renderer needs a basename for its title. This path is never sent to the server.
  const name=opened.name?.trim()&&!/[\\/\u0000-\u001f\u007f]/.test(opened.name)?opened.name:'document.pdf'
  let autoNamePending=opened.pdfAutoNamePending===true
  const refreshAutoName=async()=>{
   const details=await session.request<OpenFileResult>(`/api/v1/files/${fileId}`)
   assertActive()
   if(details.file.fileId!==fileId||details.format!=='pdf')throw Error('Invalid PDF metadata')
   autoNamePending=details.pdfAutoNamePending===true
   return details
  }
  const path=`/web-pdf/${revision.fileId}/${name}`
  const assertPath=(candidate:string)=>{
   assertActive()
   if(candidate!==path)throw Error('PDF path is not granted')
  }
  const load=()=>host.readBytes(revision.fileId,current.revision)
  const writer=createNativePdfSave({
   editGrantId:editorId,
   fileId:revision.fileId,path,request:session.request,
   getRevision:()=>current.revision,getPageCount:()=>pageCount,
   async onSaved(receipt){
    assertActive()
    if(!isRevisionRef(receipt))throw Error('Invalid PDF save receipt')
    current=Object.freeze({...receipt})
    chunks=undefined
    bakePreview=undefined
    if(autoNamePending)try{
     const details=await refreshAutoName()
     if(!autoNamePending&&details.name&&details.name!==name&&window.parent!==window){
      window.parent.postMessage({type:'dyoffice-pdf-auto-name',previous:name,name:details.name},location.origin)
     }
    }catch{/* Metadata refresh cannot make a confirmed PDF save fail. */}
   },
  })
  async function imagePreview<T>(candidate:string,operation:object){
   assertPath(candidate)
   const base=current
   const response=await session.request<{revision:string;result:T}>(`/api/v1/files/${fileId}/pdf/image-previews/query`,'POST',{revision:base.revision,operation})
   assertActive()
   if(current!==base||response.revision!==base.revision)throw Error('The PDF revision changed during image preview')
   return response.result
  }
  const api:Pick<PdfApi,'consumePending'|'readFile'|'readFileChunk'|'validateTextEdits'|'listPageImages'|'pageImagePng'|'pagePreviewPng'|'listDigitalSignatures'>={
   async listDigitalSignatures(candidate){
    assertPath(candidate)
    const base=current
    if(signatureRevision!==base)return []
    const result=await session.request<{revision:string;signatures:PdfSignatureInfo[]}>(`/api/v1/files/${fileId}/pdf/signatures/query`,'POST',{revision:base.revision},signatureRequests.signal)
    assertActive()
    if(current!==base||result.revision!==base.revision||!Array.isArray(result.signatures))throw Error('Invalid PDF signature report')
    return result.signatures
   },
   listPageImages:candidate=>imagePreview<PageImageRef[]>(candidate,{kind:'list'}),
   pageImagePng:({path:candidate,pageIndex,rect,scale=1})=>imagePreview<string|null>(candidate,{kind:'source',pageIndex,rect,scale}),
   pagePreviewPng:({path:candidate,pageIndex,excludeRects,clip,pxWidth,rotate,imageBakes})=>excludeRects.length
    ? imagePreview<PagePreviewResult|null>(candidate,{kind:'erase',pageIndex,excludeRects,clip,pxWidth,rotate,...(imageBakes?.length?{imageBakes}:{})}) : Promise.resolve(null),
   async validateTextEdits({path: candidate,edits}){
    assertPath(candidate)
    const base=current
    const result=await session.request<{revision:string;edits:TextEditValidation[]}>(`/api/v1/files/${fileId}/pdf/text-edits/query`,'POST',{revision:base.revision,edits})
    assertActive()
    if(current!==base||result.revision!==base.revision||!Array.isArray(result.edits)||result.edits.length!==edits.length)throw Error('Invalid PDF text validation result')
    return result.edits
   },
   async consumePending(){
    if(!pending||disposed)return null
    await assertSession()
    if(!pending)return null
    pending=false
    return path
   },
   async readFile(candidate){
    assertPath(candidate)
    await assertSession()
    const bytes=await load()
    await assertSession()
    return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer
   },
   async readFileChunk(candidate,start,end){
    assertPath(candidate)
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end-start>PDF_READ_CHUNK_BYTES)throw Error('Invalid PDF chunk range')
    await assertSession()
    const transfer=chunks??=load()
    try{
     const bytes=await transfer
     await assertSession()
     if(end>=bytes.length&&chunks===transfer)chunks=undefined
     return {data:bytes.slice(start,end),fileSize:bytes.length}
    }catch(error){
     if(chunks===transfer)chunks=undefined
     throw error
    }
   },
  }
  return {path,revision,api,current:()=>current,async accountIdentity(signal:AbortSignal){
   assertActive()
   if(!account){
    const {deploymentId,user}=await session.request<{deploymentId:string;user:{id:string}}>('/api/v1/auth/me','GET',undefined,signal)
    const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
    assertActive()
    if(typeof deploymentId!=='string'||typeof user?.id!=='string'||!uuid.test(deploymentId)||!uuid.test(user.id)){
     throw Error('The account identity is unavailable')
    }
    account=[deploymentId,user.id]
   }else{
    await client.bindSession(session.proof,signal)
    assertActive()
   }
   return account
  },inspectSignatureMarker(bytes:Uint8Array,encrypted:boolean){
   signatureRevision=!encrypted&&hasSignatureMarker(bytes)?current:undefined
 },async reduceSize(signal:AbortSignal){
   assertActive()
   const base=current
   const blob=await session.download(`/api/v1/files/${fileId}/pdf/reduce-size`,{body:{revision:base.revision},signal})
   assertActive()
   signal.throwIfAborted()
   if(base!==current||blob.size>=base.size)throw Error('PDF reduction is no longer available.')
   return {blob,bytesBefore:base.size}
 },async convertOffice(format:PdfConvertFormat,password:string|undefined,signal:AbortSignal,draft?:PdfHostConversionDraft){
   assertActive()
   const base=current
   const convert=(snapshot?:PdfPendingSnapshot)=>session.download(`/api/v1/files/${fileId}/pdf/convert-office`,{
    body:{revision:base.revision,format,password,snapshot},signal,
   })
   let blob:Blob|undefined
   if(draft){
    pageCount=draft.pageCount
    const result=await writer.save(draft.draft,undefined,draft.stamps,draft.imageBakes,async snapshot=>{
     blob=await convert(snapshot)
    })
    if(!result.ok)throw Error(result.error)
   }else{
    blob=await convert()
   }
   assertActive()
   if(current!==base||!blob?.size||blob.size>64*1024*1024)throw Error('The PDF conversion is no longer available.')
   return blob
  },async recognizeOcr(png:string,signal?:AbortSignal){
   const base=current
   const reply=await session.request<{revision:string;lines:PdfOcrLine[]|null}>(`/api/v1/files/${fileId}/pdf/ocr`,'POST',{revision:base.revision,png},signal)
   assertActive()
   if(current!==base||reply.revision!==base.revision||(reply.lines!==null&&!Array.isArray(reply.lines)))throw Error('The PDF changed during OCR.')
   return reply.lines
  },async canAutoSave(){
   if(!autoNamePending)return false
   const details=await refreshAutoName()
   return autoNamePending&&details.file.revision===current.revision
  },pageCopies(open:PresentWorkspaceCopy,reveal?:PresentWorkspaceCopy,saved?:PresentWorkspaceCopy){
   const present=(deliver:PresentWorkspaceCopy)=>async(receipt:RevisionRef,signal?:AbortSignal)=>{
    assertActive()
    await deliver(receipt,session.proof,signal)
   }
   return createPdfExtraction({
    fileId,name,request:session.request,getRevision:()=>current.revision,
    onCreated:present(open),
    onSaved:saved&&present(saved),
    onBatchPublished:reveal&&present(reveal),
   })
  },async queryRedactions(patterns:readonly string[],signal?:AbortSignal){
   const base=current
   const result=await queryPdfRedactions(session.request,fileId,base.revision,patterns,signal)
   assertActive()
   if(current!==base)throw Error('PDF 版本已变更，请重新查找。')
   return result
  },async documentCreation(prepare:(signal:AbortSignal|undefined,proof:string)=>Promise<PreparedAiDocumentCreator>){
   const capabilities=await session.request<Record<string,string>>('/api/v1/capabilities')
   assertActive()
   return {docxEditable:capabilities.docx==='editable',prepare:async(signal?:AbortSignal)=>{
    await assertSession()
    signal?.throwIfAborted()
    const prepared=await prepare(signal,session.proof)
    assertActive()
    return {...prepared,save:async(...args:Parameters<PreparedAiDocumentCreator['save']>)=>{
     assertActive()
     return prepared.save(...args)
    }}
   }}
  },async listImages(signal?:AbortSignal){
   const base=current
   const result=await session.request<{revision:string;images:PdfImageInfo[]}>(`/api/v1/files/${fileId}/pdf/images/query`,'POST',{revision:base.revision},signal)
   assertActive()
   if(current!==base||result.revision!==base.revision)throw Error('The PDF revision changed during image lookup')
   return result.images
  },async previewImageBakes(imageBakes:readonly PdfHostImageBake[],signal?:AbortSignal){
   assertActive()
   signal?.throwIfAborted()
   const base=current,key=JSON.stringify(imageBakes)
   const cached=bakePreview
   if(cached?.base===base&&cached.key===key){
    await assertSession()
    signal?.throwIfAborted()
    if(current!==base)throw Error('The PDF revision changed during validation')
    return cached.bytes
   }
   const {bytes}=await queryPdfPendingPreview(session.request,{
    fileId:base.fileId,baseRevision:base.revision,generation:0,savedImageEdits:imageBakes,
    markups:[],notes:[],textInserts:[],imageEdits:[],formEdits:{},formFields:[],rotations:{},deleted:[],order:null,metadata:null,
   },signal)
   assertActive()
   if(current!==base)throw Error('The PDF revision changed during validation')
   bakePreview={base,key,bytes}
   return bytes
  },async validateTextEdit(edit:TextEditInput,signal?:AbortSignal){
   const base=current
   await queryPdfPendingPreview(session.request,{
    fileId:base.fileId,baseRevision:base.revision,generation:0,textEdits:[edit],
    markups:[],notes:[],textInserts:[],imageEdits:[],formEdits:{},formFields:[],rotations:{},deleted:[],order:null,metadata:null,
   },signal)
   assertActive()
   if(current!==base)throw Error('The PDF revision changed during validation')
  },workspaceRequest:session.request,writer:{
   save(draft:Parameters<typeof writer.save>[0],count:number,check?:()=>boolean,stamps?:Parameters<typeof writer.save>[2],imageBakes?:Parameters<typeof writer.save>[3]){
    pageCount=count
    return writer.save(draft,check,stamps,imageBakes)
   },
   async saveCopy(draft:Parameters<typeof writer.save>[0],count:number,name:string,modified:boolean,stamps:Parameters<typeof writer.save>[2],imageBakes:Parameters<typeof writer.save>[3],signal:AbortSignal,folderId?:string){
    const base=current
    const check=()=>{
     assertActive()
     signal.throwIfAborted()
     if(editorId||expectedRevision||base!==current)throw Error('PDF copy authorization changed.')
    }
    check()
    await assertSession()
    check()
    pageCount=count
    return writer.save(draft,undefined,stamps,imageBakes,async snapshot=>{
     const bytes=modified?(await queryPdfPendingPreview(session.request,snapshot,signal)).bytes:await load()
     check()
     const blob=new Blob([bytes.slice().buffer as ArrayBuffer],{type:'application/pdf'})
     let upload:string|undefined,finishStarted=false
     try{
      const {uploadId}=await session.request<{uploadId:string}>('/api/v1/files/uploads','POST',{name,size:blob.size,folderId},signal)
      upload='/api/v1/uploads/'+encodeURIComponent(uploadId)
      check()
      await session.request(upload+'/content','PUT',blob,signal)
      check()
      finishStarted=true
      await session.request(upload+'/finish','POST',undefined,signal)
     }catch(error){
      if(upload&&!finishStarted&&!signal.aborted)await session.request(upload,'DELETE',undefined,signal).catch(()=>{})
      if(finishStarted)throw Error('Could not confirm the copy. Check your workspace before retrying.')
      throw error
     }
    })
   },
   confirm:writer.confirm,
   restoreRevision:writer.restoreRevision,
   pageGeometry:writer.pageGeometry,
   replacePages:writer.replacePages,
   insertPdf:writer.insertPdf,
  },getPreferences:createPreferencesClient(session.request).getPreferences,username:async()=>{
   if(editorId)return 'DSH'
   const {user}=await session.request<{user:{username:string;displayName?:string}}>('/api/v1/auth/me')
   return user.displayName||user.username
  },dispose(){
   disposed=true;signatureRequests.abort();chunks=undefined;bakePreview=undefined;client.invalidateSession();host.dispose()
  }}
 }catch(error){
  host.dispose()
  throw error
 }
}
