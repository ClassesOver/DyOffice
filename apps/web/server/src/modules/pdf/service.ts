import {validatePdfApplySnapshot,pdfApplyOpsSafetyCodes} from '../../pdf/apply-ops-job.mjs'
import {createIsolatedPdfApplyOpsQueryJob} from '../../pdf/apply-ops-query-isolated.mjs'
import {createIsolatedPdfTextEditsQueryJob,textEditsQuerySafetyCodes} from '../../pdf/text-edits-query.mjs'
import {createIsolatedPdfImagePreviewQueryJob,imagePreviewSafetyCodes} from '../../pdf/image-preview-query.mjs'
import type {TextEditValidation} from '../../../../../pdf/src/shared/ipc.ts'
import {sanitizeAutoRenameBase} from '../../../../../pdf/src/shared/auto-name.ts'
import {createIsolatedPdfApplyOpsJob} from '../../pdf/apply-ops-isolated.mjs'
import {validatePdfPendingImageInsert,validatePdfDraftInserts,pdfDraftInsertsSafetyCodes,type PdfPendingImageInsert,type PdfImageInsertsQueryReport,type PdfDraftInserts} from '../../pdf/draft-inserts-job.mjs'
import {createIsolatedPdfImageInsertsQueryJob,createIsolatedPdfDraftInsertsJob,createIsolatedPdfDraftInsertsQueryJob} from '../../pdf/draft-inserts-isolated.mjs'
import {parsePdfRedactionsRequest,validatePdfRedactionPatterns,pdfRedactionsSafetyCodes,type PdfRedactPattern,type PdfRedactionReport} from '../../pdf/redactions-job.mjs'
import {createIsolatedPdfRedactionsQueryJob,createIsolatedPdfRedactedCopyJob} from '../../pdf/redactions-isolated.mjs'
import {validatePdfReplacePages,framePdfReplacePages,pdfReplacePagesSafetyCodes} from '../../pdf/replace-pages-job.mjs'
import {createIsolatedPdfReplacePagesJob} from '../../pdf/replace-pages-isolated.mjs'
import {validatePdfStampOperation,type PdfStampOperation} from '../../../../../../packages/web-contracts/src/pdf-stamp-ops.ts'
import {pdfStampsSafetyCodes} from '../../pdf/stamps-job.mjs'
import {createIsolatedPdfStampsJob} from '../../pdf/stamps-isolated.mjs'
import {validatePdfImageBakeOperation,pdfImageBakesSafetyCodes,type PdfImageBakeOperation} from '../../pdf/image-bakes-job.mjs'
import {createIsolatedPdfImageBakesJob} from '../../pdf/image-bakes-isolated.mjs'
import {validatePdfImageContentOperation,pdfImageContentSafetyCodes,type PdfImageContentOperation} from '../../pdf/image-content-job.mjs'
import {createIsolatedPdfImageContentJob} from '../../pdf/image-content-isolated.mjs'
import {validatePdfImageEditOperations,pdfImageEditsSafetyCodes,type PdfImageEditOperation,type PdfImageInfo} from '../../pdf/image-edits-job.mjs'
import {createIsolatedPdfImageEditsJob,createIsolatedPdfImageQueryJob} from '../../pdf/image-edits-isolated.mjs'
import {validatePdfBlockMoveOperations,pdfBlockMovesSafetyCodes,type PdfBlockMoveOperation} from '../../pdf/block-moves-job.mjs'
import {createIsolatedPdfBlockMovesJob} from '../../pdf/block-moves-isolated.mjs'
import {validatePdfBlockEditOperations,pdfBlockEditsSafetyCodes,type PdfBlockEditOperation} from '../../pdf/block-edits-job.mjs'
import {createIsolatedPdfBlockEditsJob} from '../../pdf/block-edits-isolated.mjs'
import {validatePdfTextInsertOperations,pdfTextInsertsSafetyCodes,type PdfTextInsertOperation} from '../../pdf/text-inserts-job.mjs'
import {createIsolatedPdfTextInsertsJob} from '../../pdf/text-inserts-isolated.mjs'
import {validatePdfFormValueOperations,pdfFormValuesSafetyCodes,type PdfFormValueOperation} from '../../pdf/form-values-job.mjs'
import {validatePdfFormFieldOperations,type PdfFormFieldOperation} from '../../../../../../packages/web-contracts/src/pdf-form-fields.ts'
import {pdfFormFieldsSafetyCodes} from '../../pdf/form-fields-job.mjs'
import {createIsolatedPdfFormFieldsJob} from '../../pdf/form-fields-isolated.mjs'
import {createIsolatedPdfFormValuesJob} from '../../pdf/form-values-isolated.mjs'
import {createIsolatedPdfTextInsertsQueryJob} from '../../pdf/text-inserts-isolated.mjs'
import type {PdfTextInsertsQueryReport} from '../../pdf/text-inserts-job.mjs'
import { createHash, randomUUID } from 'node:crypto'
import type { createFileService } from '../files/service.ts'
import type { createLeaseService } from '../leases/service.ts'
import type { createRevisionService } from '../revisions/service.ts'
import { authError } from '../auth/sessions.ts'
import {createPdfOcr} from '../../pdf/ocr.ts'
import { inspectPdf } from '../../pdf/capabilities.mjs'
import { createPdfRotationJob } from '../../pdf/rotation-job.mjs'
import { createPdfSavePreparation } from '../../pdf/save-preparation.mjs'
import { validatePdfTextEditOperations } from '../../pdf/text-edit-job.mjs'
import { createIsolatedPdfTextEditJob } from '../../pdf/text-edit-isolated.mjs'
import { validatePdfAnnotationOperations, type PdfAnnotationOperation } from '../../pdf/annotation-job.mjs'
import { createIsolatedPdfAnnotationJob } from '../../pdf/annotation-isolated.mjs'
import { createIsolatedPdfAnnotationsQueryJob } from '../../pdf/annotations-query-isolated.mjs'
import { annotationsQuerySafetyCodes, type PdfAnnotationsQueryReport } from '../../pdf/annotations-query-job.mjs'
import { validatePdfAnnotationDeleteOperations, type PdfAnnotationDeleteOperation } from '../../pdf/annotation-delete-job.mjs'
import { createIsolatedPdfAnnotationDeleteJob } from '../../pdf/annotation-delete-isolated.mjs'
import { validatePdfNoteUpdateOperations, type PdfNoteUpdateOperation } from '../../pdf/note-update-job.mjs'
import { createIsolatedPdfNoteUpdateJob } from '../../pdf/note-update-isolated.mjs'
import { validatePdfPageOperations, type PdfPageOperation } from '../../../../../../packages/web-contracts/src/pdf-page-ops.ts'
import { createIsolatedPdfPageOpsJob } from '../../pdf/page-ops-isolated.mjs'
import { validatePdfExtractPages, pdfExtractSafetyCodes } from '../../pdf/extract-pages-job.mjs'
import { createIsolatedPdfExtractPagesJob } from '../../pdf/extract-pages-isolated.mjs'
import { validatePdfSplitSize, pdfSplitSafetyCodes } from '../../pdf/split-job.mjs'
import { createIsolatedPdfSplitJob } from '../../pdf/split-isolated.mjs'
import { validatePdfPageLayout, pdfPageLayoutSafetyCodes, type PdfPageLayoutOperation } from '../../pdf/page-layout-job.mjs'
import { createIsolatedPdfPageLayoutJob } from '../../pdf/page-layout-isolated.mjs'
import { validatePdfRotationOperations, type PdfRotationOperation } from '../../../../worker/src/sandbox/pdf-rotation-schema.ts'

type Files = ReturnType<typeof createFileService>
type Leases = ReturnType<typeof createLeaseService>
type Revisions = ReturnType<typeof createRevisionService>

export interface PdfUploadInput {
  baseRevision: string
  editorId: string
  leaseEpoch: number
  idempotencyKey?: string
  operations: readonly PdfRotationOperation[]
}
export interface PdfTextUploadInput extends Omit<PdfUploadInput,'operations'> {
  operations: readonly {page:number;oldText:string;newText:string;occurrence?:number}[]
}
export interface PdfAnnotationUploadInput extends Omit<PdfUploadInput,'operations'> {
  operations: readonly Omit<PdfAnnotationOperation,'occurrence'>[]
}
export interface PdfAnnotationDeleteUploadInput extends Omit<PdfUploadInput,'operations'> {
  operations: readonly PdfAnnotationDeleteOperation[]
}

export interface PdfNoteUpdateUploadInput extends Omit<PdfUploadInput,'operations'> {
  operations: readonly PdfNoteUpdateOperation[]
}

export interface PdfStampsUploadInput extends Omit<PdfUploadInput,'operations'> {operation:PdfStampOperation}

export interface PdfImageBakesUploadInput extends Omit<PdfUploadInput,'operations'> {operation:PdfImageBakeOperation}

export interface PdfImageContentUploadInput extends Omit<PdfUploadInput,'operations'> {operation:PdfImageContentOperation}

export interface PdfImageEditsUploadInput extends Omit<PdfUploadInput,'operations'> {operations:readonly PdfImageEditOperation[]}

export interface PdfBlockMovesUploadInput extends Omit<PdfUploadInput,'operations'> {operations:readonly PdfBlockMoveOperation[]}

export interface PdfBlockEditsUploadInput extends Omit<PdfUploadInput,'operations'> {operations:readonly PdfBlockEditOperation[]}

export interface PdfTextInsertsUploadInput extends Omit<PdfUploadInput,'operations'> {operations:readonly PdfTextInsertOperation[]}

export interface PdfFormFieldsUploadInput extends Omit<PdfUploadInput,'operations'> {operations:readonly PdfFormFieldOperation[]}
export interface PdfFormValuesUploadInput extends Omit<PdfUploadInput,'operations'> {operations:readonly PdfFormValueOperation[]}

export interface PdfPageOpsUploadInput extends Omit<PdfUploadInput,'operations'> {
  operations: readonly PdfPageOperation[]
}

export interface PdfExtractPagesInput extends Omit<PdfUploadInput,'operations'|'idempotencyKey'> {
  pages:readonly number[]
  name?:string
}

export interface PdfSplitInput extends Omit<PdfExtractPagesInput,'pages'|'name'> {pagesPerFile:number}

export interface PdfPageLayoutInput extends Omit<PdfExtractPagesInput,'pages'|'name'> {operation:PdfPageLayoutOperation}

export interface PdfApplyOpsUploadInput {baseRevision:string;editorId:string;leaseEpoch:number;idempotencyKey?:string;snapshot:unknown}
export interface PdfDraftInsertsUploadInput {baseRevision:string;editorId:string;leaseEpoch:number;idempotencyKey?:string;operation:PdfDraftInserts}
export type PdfRedactedCopyInput={baseRevision:string;editorId:string;leaseEpoch:number;name?:string}&
 ({patterns?:PdfRedactPattern[];ids:string[];regions?:never}|{regions:unknown;ids?:never;patterns?:never})
export interface PdfReplacePagesInput {baseRevision:string;editorId:string;leaseEpoch:number;idempotencyKey?:string;pages?:number[];afterPageIndex?:number}
export function createPdfService({
  files,
  leases,
  revisions,
}: {
  files: Files
  leases: Leases
  revisions: Revisions
}) {
  const recognizeOcr = createPdfOcr()
  const processor = createPdfRotationJob()
  const preparation = createPdfSavePreparation({ files, leases, revisions, processor })
  const textPreparation = createPdfSavePreparation({ files, leases, revisions, processor:createIsolatedPdfTextEditJob() })
  const annotationPreparation = createPdfSavePreparation({ files, leases, revisions, processor:createIsolatedPdfAnnotationJob() })
  const annotationDeletePreparation = createPdfSavePreparation({ files, leases, revisions, processor:createIsolatedPdfAnnotationDeleteJob() })

  const noteUpdatePreparation = createPdfSavePreparation({ files, leases, revisions, processor:createIsolatedPdfNoteUpdateJob() })

  const stampsPreparation=createPdfSavePreparation({files,leases,revisions,processor:createIsolatedPdfStampsJob()})
  const imageBakesPreparation=createPdfSavePreparation({files,leases,revisions,processor:createIsolatedPdfImageBakesJob()})
  const imageContentPreparation=createPdfSavePreparation({files,leases,revisions,processor:createIsolatedPdfImageContentJob()})
  const imageEditsPreparation=createPdfSavePreparation({files,leases,revisions,processor:createIsolatedPdfImageEditsJob()})
  const imageQueryProcessor=createIsolatedPdfImageQueryJob()

  const blockMovesPreparation=createPdfSavePreparation({files,leases,revisions,processor:createIsolatedPdfBlockMovesJob()})

  const blockEditsPreparation=createPdfSavePreparation({files,leases,revisions,processor:createIsolatedPdfBlockEditsJob()})

  const textInsertsPreparation=createPdfSavePreparation({files,leases,revisions,processor:createIsolatedPdfTextInsertsJob()})

  const applyOpsPreparation=createPdfSavePreparation({files,leases,revisions,processor:createIsolatedPdfApplyOpsJob()})
  const formFieldsPreparation=createPdfSavePreparation({files,leases,revisions,processor:createIsolatedPdfFormFieldsJob()})
  const formValuesPreparation=createPdfSavePreparation({files,leases,revisions,processor:createIsolatedPdfFormValuesJob()})

  const pageOpsPreparation = createPdfSavePreparation({ files, leases, revisions, processor:createIsolatedPdfPageOpsJob() })

  const extractionProcessor=createIsolatedPdfExtractPagesJob()
  const splitProcessor=createIsolatedPdfSplitJob()
  const layoutProcessor=createIsolatedPdfPageLayoutJob()

  return {
    async stageSplit(token:string,fileId:string,input:PdfSplitInput,signal?:AbortSignal){
      let pagesPerFile:number
      try{pagesPerFile=validatePdfSplitSize(input.pagesPerFile)}catch{throw authError(400)}
      const check=()=>signal?.throwIfAborted()
      const authorize=async()=>{
        check()
        const lease=await leases.getLease(token,fileId);check()
        if(!lease.active||!lease.heldByCurrentSession||lease.editorId!==input.editorId||lease.leaseEpoch!==input.leaseEpoch)throw authError(409)
        const current=await files.openFile(token,fileId);check()
        if(current.format!=='pdf')throw authError(415)
        if(current.file.revision!==input.baseRevision)throw authError(409)
        return current
      }
      const uploads:Awaited<ReturnType<Files['stageUpload']>>[]=[]
      try{
        const current=await authorize(),source=await files.download(token,fileId,input.baseRevision);check()
        if(source.format!=='pdf')throw authError(415)
        const inputSha256=createHash('sha256').update(source.bytes).digest('hex')
        if(current.file.sha256!==inputSha256)throw new Error('PDF_OUTPUT_BINDING')
        const before=await authorize()
        if(before.file.sha256!==inputSha256)throw authError(409)
        const result=await splitProcessor.execute(source.bytes,JSON.stringify({version:1,action:'splitPdf',pagesPerFile}),signal);check()
        let total=0
        if(result.inputSha256!==inputSha256||!Array.isArray(result.files)||result.files.length<2||result.files.length>100||result.files.some(file=>!Buffer.isBuffer(file.bytes)||file.bytes.length<1||(total+=file.bytes.length)>64*1024*1024||file.size!==file.bytes.length||file.sha256!==createHash('sha256').update(file.bytes).digest('hex')))throw new Error('PDF_OUTPUT_BINDING')
        const after=await authorize()
        if(after.file.sha256!==inputSha256)throw authError(409)
        const prepared=[]
        for(let index=0;index<result.files.length;index++){
          const output=result.files[index]!,name=`${source.name.replace(/\.pdf$/i,'').slice(0,230)}-part-${index+1}.pdf`
          check()
          const upload=await files.stageUpload(token,{name,size:output.size});uploads.push(upload);check()
          await files.receiveUpload(token,upload.uploadId,output.bytes);check()
          prepared.push({uploadId:upload.uploadId,fileId:upload.fileId,sha256:output.sha256,size:output.size})
        }
        const final=await authorize()
        if(final.file.sha256!==inputSha256)throw authError(409)
        return {files:prepared}
      }catch(error){
        for(const upload of uploads)await files.cancelUpload(token,upload.uploadId).catch(()=>{})
        check()
        if((error as {statusCode?:number})?.statusCode)throw error
        const code=(error as {code?:string})?.code??''
        if(pdfSplitSafetyCodes.has(code))throw Object.assign(authError(400),{detail:code})
        throw Object.assign(authError(500),{detail:'PDF_SPLIT_FAILED'})
      }
    },
    async stagePageLayout(token:string,fileId:string,input:PdfPageLayoutInput,signal?:AbortSignal){
      let operation:PdfPageLayoutOperation
      try{operation=validatePdfPageLayout(input.operation)}catch{throw authError(400)}
      const check=()=>signal?.throwIfAborted()
      const authorize=async()=>{
        check()
        const lease=await leases.getLease(token,fileId);check()
        if(!lease.active||!lease.heldByCurrentSession||lease.editorId!==input.editorId||lease.leaseEpoch!==input.leaseEpoch)throw authError(409)
        const current=await files.openFile(token,fileId);check()
        if(current.format!=='pdf')throw authError(415)
        if(current.file.revision!==input.baseRevision)throw authError(409)
        return current
      }
      let upload:Awaited<ReturnType<Files['stageUpload']>>|undefined
      try{
        const current=await authorize()
        const source=await files.download(token,fileId,input.baseRevision);check()
        if(source.format!=='pdf')throw authError(415)
        const inputSha256=createHash('sha256').update(source.bytes).digest('hex')
        if(current.file.sha256!==inputSha256)throw new Error('PDF_OUTPUT_BINDING')
        const before=await authorize()
        if(before.file.sha256!==inputSha256)throw authError(409)
        const result=await layoutProcessor.execute(source.bytes,JSON.stringify({version:1,action:'pageLayout',operation}),signal);check()
        if(!Buffer.isBuffer(result.bytes)||result.bytes.length<1||result.bytes.length>64*1024*1024||result.inputSha256!==inputSha256||result.size!==result.bytes.length||result.sha256!==createHash('sha256').update(result.bytes).digest('hex'))throw new Error('PDF_OUTPUT_BINDING')
        const after=await authorize()
        if(after.file.sha256!==inputSha256)throw authError(409)
        const name=`${source.name.replace(/\.pdf$/i,'').slice(0,230)}-${operation.kind==='split'?'split-pages':'merged-pages'}.pdf`
        upload=await files.stageUpload(token,{name,size:result.size});check()
        await files.receiveUpload(token,upload.uploadId,result.bytes);check()
        const final=await authorize()
        if(final.file.sha256!==inputSha256)throw authError(409)
        return {uploadId:upload.uploadId,fileId:upload.fileId,sha256:result.sha256,size:result.size}
      }catch(error){
        if(upload)await files.cancelUpload(token,upload.uploadId).catch(()=>{})
        check()
        if((error as {statusCode?:number})?.statusCode)throw error
        const code=(error as {code?:string})?.code??''
        if(pdfPageLayoutSafetyCodes.has(code))throw Object.assign(authError(400),{detail:code})
        throw Object.assign(authError(500),{detail:'PDF_PAGE_LAYOUT_FAILED'})
      }
    },
    async stageExtractPages(token:string,fileId:string,input:PdfExtractPagesInput,signal?:AbortSignal){
      let pages:readonly number[]
      try{pages=validatePdfExtractPages(input.pages)}catch{throw authError(400)}
      if(input.name!==undefined&&(typeof input.name!=='string'||!input.name.trim()||input.name.length>255||!input.name.toLowerCase().endsWith('.pdf')))throw authError(400)
      const check=()=>signal?.throwIfAborted()
      const authorize=async()=>{
        check()
        const lease=await leases.getLease(token,fileId);check()
        if(!lease.active||!lease.heldByCurrentSession||lease.editorId!==input.editorId||lease.leaseEpoch!==input.leaseEpoch)throw authError(409)
        const current=await files.openFile(token,fileId);check()
        if(current.format!=='pdf')throw authError(415)
        if(current.file.revision!==input.baseRevision)throw authError(409)
        return current
      }
      let upload:Awaited<ReturnType<Files['stageUpload']>>|undefined
      try{
        const current=await authorize()
        const source=await files.download(token,fileId,input.baseRevision);check()
        if(source.format!=='pdf')throw authError(415)
        const inputSha256=createHash('sha256').update(source.bytes).digest('hex')
        if(current.file.sha256!==inputSha256)throw new Error('PDF_OUTPUT_BINDING')
        const before=await authorize()
        if(before.file.sha256!==inputSha256)throw authError(409)
        const result=await extractionProcessor.execute(source.bytes,JSON.stringify({version:1,action:'extractPages',pages}),signal);check()
        if(!Buffer.isBuffer(result.bytes)||result.bytes.length<1||result.bytes.length>64*1024*1024||result.inputSha256!==inputSha256||result.size!==result.bytes.length||result.sha256!==createHash('sha256').update(result.bytes).digest('hex'))throw new Error('PDF_OUTPUT_BINDING')
        const after=await authorize()
        if(after.file.sha256!==inputSha256)throw authError(409)
        const name=input.name?.trim()||`${source.name.replace(/\.pdf$/i,'').slice(0,240)}-pages.pdf`
        upload=await files.stageUpload(token,{name,size:result.size});check()
        await files.receiveUpload(token,upload.uploadId,result.bytes);check()
        const final=await authorize()
        if(final.file.sha256!==inputSha256)throw authError(409)
        return {uploadId:upload.uploadId,fileId:upload.fileId,sha256:result.sha256,size:result.size}
      }catch(error){
        if(upload)await files.cancelUpload(token,upload.uploadId).catch(()=>{})
        check()
        if((error as {statusCode?:number})?.statusCode)throw error
        const code=(error as {code?:string})?.code??''
        if(pdfExtractSafetyCodes.has(code))throw Object.assign(authError(400),{detail:code})
        throw Object.assign(authError(500),{detail:'PDF_EXTRACT_FAILED'})
      }
    },
    async stagePageOps(token:string,fileId:string,input:PdfPageOpsUploadInput,signal?:AbortSignal){
      let operations:ReturnType<typeof validatePdfPageOperations>
      try{operations=validatePdfPageOperations(input.operations)}catch{throw authError(400)}
      try{
        return await pageOpsPreparation.prepare({token,fileId,baseRevision:input.baseRevision,editorId:input.editorId,leaseEpoch:input.leaseEpoch,idempotencyKey:input.idempotencyKey??randomUUID(),request:JSON.stringify({version:1,action:'pageOps',operations})},{signal})
      }catch(error){
        if((error as {statusCode?:number})?.statusCode)throw error
        const code=(error as {code?:string})?.code??''
        if(['MAGIC_MISMATCH','PASSWORD','UNREADABLE','PDF_EDIT_LIMIT','SIGNATURE_EDIT_REFUSED','PDF_EDIT_UNSUPPORTED_STRUCTURE','INVALID_PDF_PAGE_OPS','PDF_PAGE_OPS_VERIFY_FAILED'].includes(code))throw Object.assign(authError(400),{detail:code})
        throw Object.assign(authError(500),{detail:'PDF_PAGE_OPS_FAILED'})
      }
    },
    async pageOpsAndCommit(token:string,fileId:string,input:PdfPageOpsUploadInput,signal?:AbortSignal){
      const prepared=await this.stagePageOps(token,fileId,input,signal)
      signal?.throwIfAborted()
      return revisions.commitRevision(token,prepared.commitInput)
    },
    async queryImagePreview(token:string,fileId:string,{revision,operation}: {revision:string;operation:unknown},signal?:AbortSignal){
      const check=()=>signal?.throwIfAborted()
      try{
        check();const current=await files.openFile(token,fileId);check()
        if(current.format!=='pdf')throw authError(415)
        if(current.file.revision!==revision)throw authError(409)
        const source=await files.download(token,fileId,revision);check()
        if(source.format!=='pdf'||createHash('sha256').update(source.bytes).digest('hex')!==current.file.sha256)throw authError(409)
        const result=await createIsolatedPdfImagePreviewQueryJob().execute(source.bytes,JSON.stringify({version:1,action:'imagePreviewQuery',operations:operation}),signal);check()
        const fresh=await files.openFile(token,fileId);check()
        if(fresh.file.revision!==revision||fresh.file.sha256!==result.inputSha256)throw authError(409)
        return {revision,result:JSON.parse(result.bytes.toString()).result as unknown}
      }catch(error){
        check();if((error as {statusCode?:number})?.statusCode)throw error
        const code=(error as {code?:string})?.code??''
        if(imagePreviewSafetyCodes.has(code))throw Object.assign(authError(400),{detail:code})
        throw Object.assign(authError(500),{detail:'PDF_IMAGE_PREVIEW_FAILED'})
      }
    },
    async queryImages(token:string,fileId:string,input:{revision:string},signal?:AbortSignal):Promise<{revision:string;images:PdfImageInfo[]}>{
      signal?.throwIfAborted()
      const source=await files.download(token,fileId,input.revision)
      if(source.format!=='pdf')throw authError(415)
      signal?.throwIfAborted()
      try{
        const result=await imageQueryProcessor.execute(source.bytes,JSON.stringify({version:1,action:'imageQuery',operations:[]}),signal)
        signal?.throwIfAborted()
        if(result.inputSha256!==createHash('sha256').update(source.bytes).digest('hex')||result.size!==result.bytes.length||result.sha256!==createHash('sha256').update(result.bytes).digest('hex'))throw new Error('PDF_OUTPUT_BINDING')
        const report=JSON.parse(result.bytes.toString('utf8')) as {images:PdfImageInfo[]}
        if(!Array.isArray(report.images)||report.images.length>1000||report.images.some(image=>!Number.isInteger(image.page)||image.page<1||image.page>100||!Number.isInteger(image.image_number)||image.image_number<1||image.image_number>1000||![image.x,image.y,image.width,image.height].every(Number.isFinite)||image.width<=0||image.height<=0||!['above_text','below_text'].includes(image.layer)))throw new Error('PDF_OUTPUT_BINDING')
        // Reauthorize after isolated processing; a revoked grant must not leak a late catalog.
        await files.openFile(token,fileId);signal?.throwIfAborted()
        return {revision:input.revision,images:report.images}
      }catch(error){
        if((error as {statusCode?:number})?.statusCode)throw error
        const code=(error as {code?:string})?.code??''
        if(pdfImageEditsSafetyCodes.has(code))throw Object.assign(authError(400),{detail:code})
        throw Object.assign(authError(500),{detail:'PDF_IMAGE_QUERY_FAILED'})
      }
    },
    async stageDraftInserts(token:string,fileId:string,input:PdfDraftInsertsUploadInput,signal?:AbortSignal){
      let operation:PdfDraftInserts;try{operation=validatePdfDraftInserts(input.operation)}catch{throw authError(400)}
      const preparation=createPdfSavePreparation({files,leases,revisions,processor:createIsolatedPdfDraftInsertsJob()})
      try{return await preparation.prepare({token,fileId,baseRevision:input.baseRevision,editorId:input.editorId,leaseEpoch:input.leaseEpoch,idempotencyKey:input.idempotencyKey??randomUUID(),request:JSON.stringify({version:1,action:'draftInserts',operation})},{signal})}
      catch(error){if((error as {statusCode?:number})?.statusCode)throw error;const code=(error as {code?:string})?.code??'';if(pdfDraftInsertsSafetyCodes.has(code))throw Object.assign(authError(400),{detail:code});throw Object.assign(authError(500),{detail:'PDF_DRAFT_INSERTS_FAILED'})}
    },
    async queryImageInserts(token:string,fileId:string,input:{revision:string;operation:PdfPendingImageInsert;rotationDelta?:number},signal?:AbortSignal){
      let operation:PdfPendingImageInsert;try{operation=validatePdfPendingImageInsert(input.operation)}catch{throw authError(400)}
      const check=()=>signal?.throwIfAborted()
      try{
        check();const current=await files.openFile(token,fileId);check()
        if(current.format!=='pdf')throw authError(415)
        if(current.file.revision!==input.revision)throw authError(409)
        const source=await files.download(token,fileId,input.revision);check()
        const inputSha256=createHash('sha256').update(source.bytes).digest('hex')
        if(source.format!=='pdf'||current.file.sha256!==inputSha256)throw authError(409)
        const result=await createIsolatedPdfImageInsertsQueryJob().execute(source.bytes,JSON.stringify({version:1,action:'imageInsertsQuery',operation,rotationDelta:input.rotationDelta}),signal);check()
        if(result.inputSha256!==inputSha256||result.size!==result.bytes.length||result.sha256!==createHash('sha256').update(result.bytes).digest('hex'))throw Error('PDF_OUTPUT_BINDING')
        const fresh=await files.openFile(token,fileId);check()
        if(fresh.file.revision!==input.revision||fresh.file.sha256!==inputSha256)throw authError(409)
        const report=JSON.parse(result.bytes.toString()) as PdfImageInsertsQueryReport
        return {revision:input.revision,image:report.image,edit:report.edit}
      }catch(error){check();if((error as {statusCode?:number})?.statusCode)throw error;const code=(error as {code?:string})?.code??'';if(pdfDraftInsertsSafetyCodes.has(code))throw Object.assign(authError(400),{detail:code});throw Object.assign(authError(500),{detail:'PDF_IMAGE_INSERT_QUERY_FAILED'})}
    },
    async queryDraftInserts(token:string,fileId:string,input:{revision:string;operation:PdfDraftInserts},signal?:AbortSignal){
      let operation:PdfDraftInserts;try{operation=validatePdfDraftInserts(input.operation)}catch{throw authError(400)}
      const check=()=>signal?.throwIfAborted()
      try{
        check();const current=await files.openFile(token,fileId);check()
        if(current.format!=='pdf')throw authError(415)
        if(current.file.revision!==input.revision)throw authError(409)
        const source=await files.download(token,fileId,input.revision);check()
        const inputSha256=createHash('sha256').update(source.bytes).digest('hex')
        if(source.format!=='pdf'||current.file.sha256!==inputSha256)throw authError(409)
        const result=await createIsolatedPdfDraftInsertsQueryJob().execute(source.bytes,JSON.stringify({version:1,action:'draftInsertsQuery',operation}),signal);check()
        if(result.inputSha256!==inputSha256||result.size!==result.bytes.length||result.sha256!==createHash('sha256').update(result.bytes).digest('hex'))throw Error('PDF_OUTPUT_BINDING')
        const fresh=await files.openFile(token,fileId);check()
        if(fresh.file.revision!==input.revision||fresh.file.sha256!==inputSha256)throw authError(409)
        return {revision:input.revision,pages:(JSON.parse(result.bytes.toString()) as {pages:{page:number;width:number;height:number;png:string}[]}).pages}
      }catch(error){check();if((error as {statusCode?:number})?.statusCode)throw error;const code=(error as {code?:string})?.code??'';if(pdfDraftInsertsSafetyCodes.has(code))throw Object.assign(authError(400),{detail:code});throw Object.assign(authError(500),{detail:'PDF_DRAFT_INSERT_QUERY_FAILED'})}
    },
    async queryAnnotations(token:string,fileId:string,input:{revision:string;operations:readonly PdfAnnotationOperation[]},signal?:AbortSignal){
      let operations:readonly PdfAnnotationOperation[];try{operations=validatePdfAnnotationOperations(input.operations)}catch{throw authError(400)}
      const check=()=>signal?.throwIfAborted()
      try{
        check();const current=await files.openFile(token,fileId);check()
        if(current.format!=='pdf')throw authError(415)
        if(current.file.revision!==input.revision)throw authError(409)
        const source=await files.download(token,fileId,input.revision);check()
        const inputSha256=createHash('sha256').update(source.bytes).digest('hex')
        if(source.format!=='pdf'||current.file.sha256!==inputSha256)throw authError(409)
        const result=await createIsolatedPdfAnnotationsQueryJob().execute(source.bytes,JSON.stringify({version:1,action:'annotationsQuery',operations}),signal);check()
        if(result.inputSha256!==inputSha256||result.size!==result.bytes.length||result.sha256!==createHash('sha256').update(result.bytes).digest('hex'))throw Error('PDF_OUTPUT_BINDING')
        const fresh=await files.openFile(token,fileId);check()
        if(fresh.file.revision!==input.revision||fresh.file.sha256!==inputSha256)throw authError(409)
        return {revision:input.revision,...JSON.parse(result.bytes.toString()) as PdfAnnotationsQueryReport}
      }catch(error){
        check();if((error as {statusCode?:number})?.statusCode)throw error
        const code=(error as {code?:string})?.code??''
        if(annotationsQuerySafetyCodes.has(code))throw Object.assign(authError(400),{detail:code})
        throw Object.assign(authError(500),{detail:'PDF_ANNOTATIONS_QUERY_FAILED'})
      }
    },
    async queryTextInserts(token:string,fileId:string,input:{revision:string;operations:readonly PdfTextInsertOperation[];rotationDeltas?:readonly number[]},signal?:AbortSignal){
      let operations:readonly PdfTextInsertOperation[];try{operations=validatePdfTextInsertOperations(input.operations)}catch{throw authError(400)}
      const check=()=>signal?.throwIfAborted()
      try{
        check();const current=await files.openFile(token,fileId);check()
        if(current.format!=='pdf')throw authError(415)
        if(current.file.revision!==input.revision)throw authError(409)
        const source=await files.download(token,fileId,input.revision);check()
        const inputSha256=createHash('sha256').update(source.bytes).digest('hex')
        if(source.format!=='pdf'||current.file.sha256!==inputSha256)throw authError(409)
        const result=await createIsolatedPdfTextInsertsQueryJob().execute(source.bytes,JSON.stringify({version:1,action:'textInsertsQuery',operations,rotationDeltas:input.rotationDeltas}),signal);check()
        if(result.inputSha256!==inputSha256||result.size!==result.bytes.length||result.sha256!==createHash('sha256').update(result.bytes).digest('hex'))throw Error('PDF_OUTPUT_BINDING')
        const fresh=await files.openFile(token,fileId);check()
        if(fresh.file.revision!==input.revision||fresh.file.sha256!==inputSha256)throw authError(409)
        const report=JSON.parse(result.bytes.toString()) as PdfTextInsertsQueryReport
        return {revision:input.revision,blocks:report.blocks,inserts:report.inserts}
      }catch(error){
        check();if((error as {statusCode?:number})?.statusCode)throw error
        if(pdfTextInsertsSafetyCodes.has((error as {code?:string})?.code??''))throw Object.assign(authError(400),{detail:(error as {code:string}).code})
        throw Object.assign(authError(500),{detail:'PDF_TEXT_INSERT_QUERY_FAILED'})
      }
    },
    async queryRedactions(token:string,fileId:string,input:{revision:string;patterns?:PdfRedactPattern[]},signal?:AbortSignal){
      let patterns:PdfRedactPattern[];try{patterns=validatePdfRedactionPatterns(input.patterns)}catch{throw authError(400)}
      const check=()=>signal?.throwIfAborted()
      try{
        check();const current=await files.openFile(token,fileId);check()
        if(current.format!=='pdf')throw authError(415)
        if(current.file.revision!==input.revision)throw authError(409)
        const source=await files.download(token,fileId,input.revision);check()
        const inputSha256=createHash('sha256').update(source.bytes).digest('hex')
        if(source.format!=='pdf'||current.file.sha256!==inputSha256)throw authError(409)
        const result=await createIsolatedPdfRedactionsQueryJob().execute(source.bytes,JSON.stringify({version:1,action:'redactionsQuery',revision:input.revision,patterns}),signal);check()
        if(result.inputSha256!==inputSha256||result.size!==result.bytes.length||result.sha256!==createHash('sha256').update(result.bytes).digest('hex'))throw Error('PDF_OUTPUT_BINDING')
        const fresh=await files.openFile(token,fileId);check()
        if(fresh.file.revision!==input.revision||fresh.file.sha256!==inputSha256)throw authError(409)
        return JSON.parse(result.bytes.toString()) as PdfRedactionReport
      }catch(error){
        check();if((error as {statusCode?:number})?.statusCode)throw error
        if(pdfRedactionsSafetyCodes.has((error as {code?:string})?.code??''))throw Object.assign(authError(400),{detail:(error as {code:string}).code})
        throw Object.assign(authError(500),{detail:'PDF_REDACTION_QUERY_FAILED'})
      }
    },
    async stageRedactedCopy(token:string,fileId:string,input:PdfRedactedCopyInput,signal?:AbortSignal){
      const raw=JSON.stringify({version:1,action:'redactedCopy',revision:input.baseRevision,patterns:input.patterns,ids:input.ids,regions:input.regions})
      try{parsePdfRedactionsRequest(raw)}catch{throw authError(400)}
      if(input.name!==undefined&&(typeof input.name!=='string'||!input.name.trim()||input.name.length>255||!input.name.toLowerCase().endsWith('.pdf')))throw authError(400)
      const check=()=>signal?.throwIfAborted(),authorize=async()=>{
        check();const lease=await leases.getLease(token,fileId);check()
        if(!lease.active||!lease.heldByCurrentSession||lease.editorId!==input.editorId||lease.leaseEpoch!==input.leaseEpoch)throw authError(409)
        const current=await files.openFile(token,fileId);check()
        if(current.format!=='pdf')throw authError(415)
        if(current.file.revision!==input.baseRevision)throw authError(409)
        return current
      }
      let upload:Awaited<ReturnType<Files['stageUpload']>>|undefined
      try{
        const current=await authorize(),source=await files.download(token,fileId,input.baseRevision);check()
        const inputSha256=createHash('sha256').update(source.bytes).digest('hex')
        if(source.format!=='pdf'||current.file.sha256!==inputSha256)throw authError(409)
        const before=await authorize();if(before.file.sha256!==inputSha256)throw authError(409)
        const result=await createIsolatedPdfRedactedCopyJob().execute(source.bytes,raw,signal);check()
        if(result.inputSha256!==inputSha256||!Buffer.isBuffer(result.bytes)||result.size!==result.bytes.length||result.bytes.length>64*1024*1024||result.sha256!==createHash('sha256').update(result.bytes).digest('hex'))throw Error('PDF_OUTPUT_BINDING')
        const after=await authorize();if(after.file.sha256!==inputSha256)throw authError(409)
        const name=input.name?.trim()||`${source.name.replace(/\.pdf$/i,'').slice(0,230)}-涂黑副本.pdf`
        upload=await files.stageUpload(token,{name,size:result.size});check()
        await files.receiveUpload(token,upload.uploadId,result.bytes);check()
        const final=await authorize();if(final.file.sha256!==inputSha256)throw authError(409)
        return {uploadId:upload.uploadId,fileId:upload.fileId,sha256:result.sha256,size:result.size}
      }catch(error){
        if(upload)await files.cancelUpload(token,upload.uploadId).catch(()=>{})
        check();if((error as {statusCode?:number})?.statusCode)throw error
        if(pdfRedactionsSafetyCodes.has((error as {code?:string})?.code??''))throw Object.assign(authError(400),{detail:(error as {code:string}).code})
        throw Object.assign(authError(500),{detail:'PDF_REDACTED_COPY_FAILED'})
      }
    },
    async stageReplacePages(token:string,fileId:string,input:PdfReplacePagesInput,source:Buffer,signal?:AbortSignal){
      let pages:number[]|undefined
      try{
        if(input.afterPageIndex===undefined)pages=validatePdfReplacePages(input.pages)
        else if(input.pages!==undefined||!Number.isSafeInteger(input.afterPageIndex)||input.afterPageIndex< -1||input.afterPageIndex>=100)throw Error()
        if(!Buffer.isBuffer(source)||!source.length||source.length>64*1024*1024)throw Error()
      }catch{throw authError(400)}
      const sourceBytes=Buffer.from(source),sourceSha256=createHash('sha256').update(sourceBytes).digest('hex'),isolated=createIsolatedPdfReplacePagesJob()
      const prepare=createPdfSavePreparation({files,leases,revisions,processor:{async execute(target:Buffer,raw:string,currentSignal?:AbortSignal){
        const result=await isolated.execute(framePdfReplacePages(target,sourceBytes),raw,currentSignal)
        if(result.sourceSha256!==sourceSha256)throw Object.assign(Error('PDF_OUTPUT_BINDING'),{code:'PDF_OUTPUT_BINDING'})
        return result
      }}})
      const request=pages
        ?{version:1,action:'replacePages',pages}
        :{version:1,action:'insertPages',afterPageIndex:input.afterPageIndex}
      try{return await prepare.prepare({token,fileId,baseRevision:input.baseRevision,editorId:input.editorId,leaseEpoch:input.leaseEpoch,idempotencyKey:input.idempotencyKey??randomUUID(),request:JSON.stringify(request)},{signal})}
      catch(error){
        if((error as {statusCode?:number})?.statusCode)throw error
        const code=(error as {code?:string})?.code??''
        if(pdfReplacePagesSafetyCodes.has(code))throw Object.assign(authError(400),{detail:code})
        throw Object.assign(authError(500),{detail:'PDF_REPLACE_PAGES_FAILED'})
      }
    },
    async stageStamps(token:string,fileId:string,input:PdfStampsUploadInput,signal?:AbortSignal){
      let operation:PdfStampOperation
      try{operation=validatePdfStampOperation(input.operation)}catch{throw authError(400)}
      try{return await stampsPreparation.prepare({token,fileId,baseRevision:input.baseRevision,editorId:input.editorId,leaseEpoch:input.leaseEpoch,idempotencyKey:input.idempotencyKey??randomUUID(),request:JSON.stringify({version:1,action:'stamps',operation})},{signal})}
      catch(error){
        if((error as {statusCode?:number})?.statusCode)throw error
        const code=(error as {code?:string})?.code??''
        if(pdfStampsSafetyCodes.has(code))throw Object.assign(authError(400),{detail:code})
        throw Object.assign(authError(500),{detail:'PDF_STAMP_FAILED'})
      }
    },
    async stageImageBakes(token:string,fileId:string,input:PdfImageBakesUploadInput,signal?:AbortSignal){
      let operation:PdfImageBakeOperation
      try{operation=validatePdfImageBakeOperation(input.operation)}catch{throw authError(400)}
      try{return await imageBakesPreparation.prepare({token,fileId,baseRevision:input.baseRevision,editorId:input.editorId,leaseEpoch:input.leaseEpoch,idempotencyKey:input.idempotencyKey??randomUUID(),request:JSON.stringify({version:1,action:'imageBakes',operation})},{signal})}
      catch(error){
        if((error as {statusCode?:number})?.statusCode)throw error
        const code=(error as {code?:string})?.code??''
        if(pdfImageBakesSafetyCodes.has(code))throw Object.assign(authError(400),{detail:code})
        throw Object.assign(authError(500),{detail:'PDF_IMAGE_BAKE_FAILED'})
      }
    },
    async stageImageContent(token:string,fileId:string,input:PdfImageContentUploadInput,signal?:AbortSignal){
      let operation:PdfImageContentOperation
      try{operation=validatePdfImageContentOperation(input.operation)}catch{throw authError(400)}
      try{return await imageContentPreparation.prepare({token,fileId,baseRevision:input.baseRevision,editorId:input.editorId,leaseEpoch:input.leaseEpoch,idempotencyKey:input.idempotencyKey??randomUUID(),request:JSON.stringify({version:1,action:'imageContent',operation})},{signal})}
      catch(error){
        if((error as {statusCode?:number})?.statusCode)throw error
        const code=(error as {code?:string})?.code??''
        if(pdfImageContentSafetyCodes.has(code))throw Object.assign(authError(400),{detail:code})
        throw Object.assign(authError(500),{detail:'PDF_IMAGE_CONTENT_FAILED'})
      }
    },
    async stageImageEdits(token:string,fileId:string,input:PdfImageEditsUploadInput,signal?:AbortSignal){
      let operations:ReturnType<typeof validatePdfImageEditOperations>
      try{operations=validatePdfImageEditOperations(input.operations)}catch{throw authError(400)}
      try{return await imageEditsPreparation.prepare({token,fileId,baseRevision:input.baseRevision,editorId:input.editorId,leaseEpoch:input.leaseEpoch,idempotencyKey:input.idempotencyKey??randomUUID(),request:JSON.stringify({version:1,action:'imageEdits',operations})},{signal})}
      catch(error){
        if((error as {statusCode?:number})?.statusCode)throw error
        const code=(error as {code?:string})?.code??''
        if(pdfImageEditsSafetyCodes.has(code))throw Object.assign(authError(400),{detail:code})
        throw Object.assign(authError(500),{detail:'PDF_IMAGE_EDIT_FAILED'})
      }
    },
    async stageBlockMoves(token:string,fileId:string,input:PdfBlockMovesUploadInput,signal?:AbortSignal){
      let operations:ReturnType<typeof validatePdfBlockMoveOperations>
      try{operations=validatePdfBlockMoveOperations(input.operations)}catch{throw authError(400)}
      try{return await blockMovesPreparation.prepare({token,fileId,baseRevision:input.baseRevision,editorId:input.editorId,leaseEpoch:input.leaseEpoch,idempotencyKey:input.idempotencyKey??randomUUID(),request:JSON.stringify({version:1,action:'blockMoves',operations})},{signal})}
      catch(error){
        if((error as {statusCode?:number})?.statusCode)throw error
        const code=(error as {code?:string})?.code??''
        if(pdfBlockMovesSafetyCodes.has(code))throw Object.assign(authError(400),{detail:code})
        throw Object.assign(authError(500),{detail:'PDF_BLOCK_MOVE_FAILED'})
      }
    },
    async stageBlockEdits(token:string,fileId:string,input:PdfBlockEditsUploadInput,signal?:AbortSignal){
      let operations:ReturnType<typeof validatePdfBlockEditOperations>
      try{operations=validatePdfBlockEditOperations(input.operations)}catch{throw authError(400)}
      try{return await blockEditsPreparation.prepare({token,fileId,baseRevision:input.baseRevision,editorId:input.editorId,leaseEpoch:input.leaseEpoch,idempotencyKey:input.idempotencyKey??randomUUID(),request:JSON.stringify({version:1,action:'blockEdits',operations})},{signal})}
      catch(error){
        if((error as {statusCode?:number})?.statusCode)throw error
        const code=(error as {code?:string})?.code??''
        if(pdfBlockEditsSafetyCodes.has(code))throw Object.assign(authError(400),{detail:code})
        throw Object.assign(authError(500),{detail:'PDF_BLOCK_EDIT_FAILED'})
      }
    },
    async stageTextInserts(token:string,fileId:string,input:PdfTextInsertsUploadInput,signal?:AbortSignal){
      let operations:ReturnType<typeof validatePdfTextInsertOperations>
      try{operations=validatePdfTextInsertOperations(input.operations)}catch{throw authError(400)}
      try{return await textInsertsPreparation.prepare({token,fileId,baseRevision:input.baseRevision,editorId:input.editorId,leaseEpoch:input.leaseEpoch,idempotencyKey:input.idempotencyKey??randomUUID(),request:JSON.stringify({version:1,action:'textInserts',operations})},{signal})}
      catch(error){
        if((error as {statusCode?:number})?.statusCode)throw error
        const code=(error as {code?:string})?.code??''
        if(pdfTextInsertsSafetyCodes.has(code))throw Object.assign(authError(400),{detail:code})
        throw Object.assign(authError(500),{detail:'PDF_TEXT_INSERT_FAILED'})
      }
    },
    async queryTextEdits(token:string,fileId:string,input:{revision:string;edits:unknown[]},signal?:AbortSignal){
      const check=()=>signal?.throwIfAborted()
      const {revision,edits}=input
      try{
        check();const current=await files.openFile(token,fileId);check()
        if(current.format!=='pdf')throw authError(415)
        if(current.file.revision!==revision)throw authError(409)
        const source=await files.download(token,fileId,revision);check()
        if(source.format!=='pdf'||createHash('sha256').update(source.bytes).digest('hex')!==current.file.sha256)throw authError(409)
        const result=await createIsolatedPdfTextEditsQueryJob().execute(source.bytes,JSON.stringify({version:1,action:'textEditsQuery',operations:edits}),signal);check()
        const fresh=await files.openFile(token,fileId);check()
        if(fresh.file.revision!==revision||fresh.file.sha256!==result.inputSha256)throw authError(409)
        const report=JSON.parse(result.bytes.toString()) as TextEditValidation[]
        if(!Array.isArray(report)||report.length!==edits.length)throw Error('Invalid text edit report')
        return {revision,edits:report}
      }catch(error){
        check();if((error as {statusCode?:number})?.statusCode)throw error
        const code=(error as {code?:string})?.code??''
        if(textEditsQuerySafetyCodes.has(code))throw Object.assign(authError(400),{detail:code})
        throw Object.assign(authError(500),{detail:'PDF_TEXT_EDITS_QUERY_FAILED'})
      }
    },
    async queryApplyOps(token:string,fileId:string,input:{revision:string;snapshot:unknown},signal?:AbortSignal):Promise<{revision:string;generation:number;pdf:string}>{
      const check=()=>signal?.throwIfAborted()
      check()
      const revision=input.revision
      let snapshot:ReturnType<typeof validatePdfApplySnapshot>
      try{
        snapshot=validatePdfApplySnapshot(input.snapshot)
        if(snapshot.fileId!==fileId||snapshot.baseRevision!==revision)throw Error('Snapshot authority mismatch')
      }catch{throw authError(400)}
      try{
        const current=await files.openFile(token,fileId);check()
        if(current.format!=='pdf')throw authError(415)
        if(current.file.revision!==revision)throw authError(409)
        const source=await files.download(token,fileId,revision);check()
        const inputSha256=createHash('sha256').update(source.bytes).digest('hex')
        if(source.format!=='pdf'||current.file.sha256!==inputSha256)throw authError(409)
        const result=await createIsolatedPdfApplyOpsQueryJob().execute(source.bytes,JSON.stringify({version:1,action:'applyOpsQuery',snapshot}),signal);check()
        // Base64 transports at most 64 MiB decoded; never stage this temporary PDF.
        if(!Buffer.isBuffer(result.bytes)||!result.bytes.length||result.bytes.length>64*1024*1024||!result.bytes.subarray(0,5).equals(Buffer.from('%PDF-'))||result.inputSha256!==inputSha256||result.size!==result.bytes.length||result.sha256!==createHash('sha256').update(result.bytes).digest('hex'))throw Error('PDF_OUTPUT_BINDING')
        const fresh=await files.openFile(token,fileId);check()
        if(fresh.file.revision!==revision||fresh.file.sha256!==inputSha256)throw authError(409)
        return {revision,generation:snapshot.generation,pdf:result.bytes.toString('base64')}
      }catch(error){
        check();if((error as {statusCode?:number})?.statusCode)throw error
        const code=(error as {code?:string})?.code??''
        if(pdfApplyOpsSafetyCodes.has(code))throw Object.assign(authError(400),{detail:code})
        throw Object.assign(authError(500),{detail:'PDF_APPLY_OPS_QUERY_FAILED'})
      }
    },
    async stageApplyOps(token:string,fileId:string,input:PdfApplyOpsUploadInput,signal?:AbortSignal){
      let snapshot:ReturnType<typeof validatePdfApplySnapshot>
      try{
        snapshot=validatePdfApplySnapshot(input.snapshot)
        if(snapshot.fileId!==fileId||snapshot.baseRevision!==input.baseRevision)throw Error('Snapshot authority mismatch')
      }catch{throw authError(400)}
      const heading = snapshot.textInserts.map(item=>item.input).filter(item=>!snapshot.deleted.includes(item.pageIndex))
        .sort((a,b)=>a.pageIndex-b.pageIndex||b.origin[1]-a.origin[1])[0]?.text.split('\n')[0]?.trim()
      const stem = heading && sanitizeAutoRenameBase(heading)
      try{return await applyOpsPreparation.prepare({token,fileId,baseRevision:input.baseRevision,editorId:input.editorId,leaseEpoch:input.leaseEpoch,idempotencyKey:input.idempotencyKey??randomUUID(),request:JSON.stringify({version:1,action:'applyOps',snapshot})},{signal,autoPdfName:stem?stem+'.pdf':undefined})}
      catch(error){
        if((error as {statusCode?:number})?.statusCode)throw error
        const code=(error as {code?:string})?.code??''
        if(pdfApplyOpsSafetyCodes.has(code))throw Object.assign(authError(400),{detail:code})
        throw Object.assign(authError(500),{detail:'PDF_APPLY_OPS_FAILED'})
      }
    },
    async stageFormFields(token:string,fileId:string,input:PdfFormFieldsUploadInput,signal?:AbortSignal){
      let operations:ReturnType<typeof validatePdfFormFieldOperations>
      try{operations=validatePdfFormFieldOperations(input.operations)}catch{throw authError(400)}
      try{return await formFieldsPreparation.prepare({token,fileId,baseRevision:input.baseRevision,editorId:input.editorId,leaseEpoch:input.leaseEpoch,idempotencyKey:input.idempotencyKey??randomUUID(),request:JSON.stringify({version:1,action:'formFields',operations})},{signal})}
      catch(error){
        if((error as {statusCode?:number})?.statusCode)throw error
        const code=(error as {code?:string})?.code??''
        if(pdfFormFieldsSafetyCodes.has(code))throw Object.assign(authError(400),{detail:code})
        throw Object.assign(authError(500),{detail:'PDF_FORM_FIELDS_FAILED'})
      }
    },
    async stageFormValues(token:string,fileId:string,input:PdfFormValuesUploadInput,signal?:AbortSignal){
      let operations:ReturnType<typeof validatePdfFormValueOperations>
      try{operations=validatePdfFormValueOperations(input.operations)}catch{throw authError(400)}
      try{return await formValuesPreparation.prepare({token,fileId,baseRevision:input.baseRevision,editorId:input.editorId,leaseEpoch:input.leaseEpoch,idempotencyKey:input.idempotencyKey??randomUUID(),request:JSON.stringify({version:1,action:'formValues',operations})},{signal})}
      catch(error){
        if((error as {statusCode?:number})?.statusCode)throw error
        const code=(error as {code?:string})?.code??''
        if(pdfFormValuesSafetyCodes.has(code))throw Object.assign(authError(400),{detail:code})
        throw Object.assign(authError(500),{detail:'PDF_FORM_VALUES_FAILED'})
      }
    },
    async stageUpdateNotes(token:string,fileId:string,input:PdfNoteUpdateUploadInput,signal?:AbortSignal){
      let operations:ReturnType<typeof validatePdfNoteUpdateOperations>
      try{operations=validatePdfNoteUpdateOperations(input.operations)}catch{throw authError(400)}
      try{
        return await noteUpdatePreparation.prepare({token,fileId,baseRevision:input.baseRevision,editorId:input.editorId,leaseEpoch:input.leaseEpoch,idempotencyKey:input.idempotencyKey??randomUUID(),request:JSON.stringify({version:1,action:'updateNotes',operations})},{signal})
      }catch(error){
        if((error as {statusCode?:number})?.statusCode)throw error
        const code=(error as {code?:string})?.code??''
        if(['MAGIC_MISMATCH','PASSWORD','UNREADABLE','PDF_EDIT_LIMIT','SIGNATURE_EDIT_REFUSED','PDF_EDIT_UNSUPPORTED_STRUCTURE','PDF_ANNOTATION_NOT_FOUND','PDF_ANNOTATION_VERIFY_FAILED','INVALID_PDF_NOTE_UPDATE'].includes(code))throw Object.assign(authError(400),{detail:code})
        throw Object.assign(authError(500),{detail:'PDF_NOTE_UPDATE_FAILED'})
      }
    },
    async updateNotesAndCommit(token:string,fileId:string,input:PdfNoteUpdateUploadInput,signal?:AbortSignal){
      const prepared=await this.stageUpdateNotes(token,fileId,input,signal)
      signal?.throwIfAborted()
      return revisions.commitRevision(token,prepared.commitInput)
    },
    async stageDeleteAnnotations(token:string,fileId:string,input:PdfAnnotationDeleteUploadInput,signal?:AbortSignal){
      let operations:ReturnType<typeof validatePdfAnnotationDeleteOperations>
      try{operations=validatePdfAnnotationDeleteOperations(input.operations)}catch{throw authError(400)}
      try{
        return await annotationDeletePreparation.prepare({token,fileId,baseRevision:input.baseRevision,editorId:input.editorId,leaseEpoch:input.leaseEpoch,idempotencyKey:input.idempotencyKey??randomUUID(),request:JSON.stringify({version:1,action:'deleteAnnotations',operations})},{signal})
      }catch(error){
        if((error as {statusCode?:number})?.statusCode)throw error
        const code=(error as {code?:string})?.code??''
        if(['MAGIC_MISMATCH','PASSWORD','UNREADABLE','PDF_EDIT_LIMIT','SIGNATURE_EDIT_REFUSED','PDF_EDIT_UNSUPPORTED_STRUCTURE','PDF_ANNOTATION_NOT_FOUND','PDF_ANNOTATION_VERIFY_FAILED','INVALID_PDF_ANNOTATION_DELETE'].includes(code))throw Object.assign(authError(400),{detail:code})
        throw Object.assign(authError(500),{detail:'PDF_ANNOTATION_DELETE_FAILED'})
      }
    },
    async deleteAnnotationsAndCommit(token:string,fileId:string,input:PdfAnnotationDeleteUploadInput,signal?:AbortSignal){
      const prepared=await this.stageDeleteAnnotations(token,fileId,input,signal)
      signal?.throwIfAborted()
      return revisions.commitRevision(token,prepared.commitInput)
    },
    async stageAnnotate(token:string,fileId:string,input:PdfAnnotationUploadInput,signal?:AbortSignal){
      let operations:ReturnType<typeof validatePdfAnnotationOperations>
      try{operations=validatePdfAnnotationOperations(input.operations)}catch{throw authError(400)}
      try{
        return await annotationPreparation.prepare({token,fileId,baseRevision:input.baseRevision,editorId:input.editorId,leaseEpoch:input.leaseEpoch,idempotencyKey:input.idempotencyKey??randomUUID(),request:JSON.stringify({version:1,action:'annotateText',operations})},{signal})
      }catch(error){
        if((error as {statusCode?:number})?.statusCode)throw error
        const code=(error as {code?:string})?.code??''
        if(['MAGIC_MISMATCH','PASSWORD','UNREADABLE','PDF_EDIT_LIMIT','SIGNATURE_EDIT_REFUSED','PDF_EDIT_UNSUPPORTED_STRUCTURE','PDF_ANNOTATION_TEXT_NOT_FOUND','PDF_ANNOTATION_VERIFY_FAILED','INVALID_PDF_ANNOTATION'].includes(code))throw Object.assign(authError(400),{detail:code})
        throw Object.assign(authError(500),{detail:'PDF_ANNOTATION_FAILED'})
      }
    },
    async annotateAndCommit(token:string,fileId:string,input:PdfAnnotationUploadInput,signal?:AbortSignal){
      const prepared=await this.stageAnnotate(token,fileId,input,signal)
      signal?.throwIfAborted()
      return revisions.commitRevision(token,prepared.commitInput)
    },
    async stageTextEdit(token:string,fileId:string,input:PdfTextUploadInput,signal?:AbortSignal){
      let operations:ReturnType<typeof validatePdfTextEditOperations>
      try{operations=validatePdfTextEditOperations(input.operations)}catch{throw authError(400)}
      try{
        return await textPreparation.prepare({token,fileId,baseRevision:input.baseRevision,editorId:input.editorId,leaseEpoch:input.leaseEpoch,idempotencyKey:input.idempotencyKey??randomUUID(),request:JSON.stringify({version:1,action:'editText',operations})},{signal})
      }catch(error){
        if((error as {statusCode?:number})?.statusCode)throw error
        const code=(error as {code?:string})?.code??''
        if(['MAGIC_MISMATCH','PASSWORD','UNREADABLE','PDF_EDIT_LIMIT','SIGNATURE_EDIT_REFUSED','PDF_EDIT_UNSUPPORTED_STRUCTURE','PDF_TEXT_NOT_FOUND','PDF_TEXT_EDIT_REFUSED','PDF_TEXT_VERIFY_FAILED','INVALID_PDF_TEXT_EDIT'].includes(code))throw Object.assign(authError(400),{detail:code})
        throw Object.assign(authError(500),{detail:'PDF_TEXT_EDIT_FAILED'})
      }
    },
    async editTextAndCommit(token:string,fileId:string,input:PdfTextUploadInput,signal?:AbortSignal){
      const prepared=await this.stageTextEdit(token,fileId,input,signal)
      signal?.throwIfAborted()
      return revisions.commitRevision(token,prepared.commitInput)
    },
    async ocr(token: string, fileId: string, revision: string, png: string, signal?: AbortSignal) {
      const authorize = async () => {
        signal?.throwIfAborted()
        const current = await files.openFile(token, fileId)
        signal?.throwIfAborted()
        if (current.format !== 'pdf') throw authError(415)
        if (current.file.revision !== revision) throw authError(409)
      }
      await authorize()
      try {
        const lines = await recognizeOcr(png,signal)
        await authorize()
        return {revision,lines}
      } catch(error) {
        signal?.throwIfAborted()
        if (error instanceof Error) {
          if (error.message==='INVALID_IMAGE') throw authError(400)
          if (error.message==='OCR_BUSY') throw authError(429)
          if (error.message==='OCR_FAILED') throw authError(503)
        }
        throw error
      }
    },

    async inspect(token: string, fileId: string, revision: string, signal?: AbortSignal) {
      signal?.throwIfAborted()
      const source = await files.download(token, fileId, revision)
      if (source.format !== 'pdf') throw authError(415)
      signal?.throwIfAborted()
      let report: Awaited<ReturnType<typeof inspectPdf>>
      try {
        report = await inspectPdf(source.bytes)
      } catch (error) {
        const code = (error as { code?: string })?.code
        throw Object.assign(authError(400), { detail: code ?? 'UNREADABLE' })
      }
      signal?.throwIfAborted()
      await files.openFile(token, fileId)
      return report
    },

    async stageRotate(token: string, fileId: string, input: PdfUploadInput, signal?: AbortSignal) {
      let operations: readonly PdfRotationOperation[]
      try {
        operations = validatePdfRotationOperations(input.operations)
      } catch {
        throw authError(400)
      }
      const idempotencyKey = input.idempotencyKey ?? randomUUID()
      const request = JSON.stringify({
        version: 1,
        action: 'rotatePages',
        operations: operations.map(op => ({ page: op.page, degrees: op.degrees })),
      })
      try {
        const prepared = await preparation.prepare(
          {
            token,
            fileId,
            baseRevision: input.baseRevision,
            editorId: input.editorId,
            leaseEpoch: input.leaseEpoch,
            idempotencyKey,
            request,
          },
          { signal },
        )
        return {
          uploadId: prepared.commitInput.uploadId,
          baseRevision: prepared.commitInput.baseRevision,
          leaseEpoch: prepared.commitInput.leaseEpoch,
          idempotencyKey: prepared.commitInput.idempotencyKey,
          sha256: prepared.sha256,
          size: prepared.size,
        }
      } catch (error) {
        if ((error as { statusCode?: number })?.statusCode) throw error
        const code = (error as { code?: string })?.code ?? ''
        if (
          [
            'MAGIC_MISMATCH',
            'PDF_EDIT_LIMIT',
            'INVALID_PDF_ROTATION',
            'PASSWORD',
            'SIGNATURE_EDIT_REFUSED',
            'PDF_EDIT_UNSUPPORTED_STRUCTURE',
            'PDF_FORMAT_REQUIRED',
          ].includes(code)
        ) {
          throw Object.assign(authError(400), { detail: code })
        }
        throw Object.assign(authError(500), { detail: code || 'PDF_PREPARE_FAILED' })
      }
    },

    async rotateAndCommit(token: string, fileId: string, input: PdfUploadInput, signal?: AbortSignal) {
      const staged = await this.stageRotate(token, fileId, input, signal)
      signal?.throwIfAborted()
      return revisions.commitRevision(token, {
        fileId,
        uploadId: staged.uploadId,
        baseRevision: staged.baseRevision,
        leaseEpoch: staged.leaseEpoch,
        idempotencyKey: staged.idempotencyKey,
      })
    },
  }
}
