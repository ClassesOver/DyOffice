import type {PdfTextInsertOperation} from './text-inserts-job.mjs'
import type {PdfImageEditOperation} from './image-edits-job.mjs'
import type {PdfImageBakeOperation} from './image-bakes-job.mjs'
import type {PdfImageContentOperation} from './image-content-job.mjs'
import type {PdfAnnotationProcessor} from './annotation-job.mjs'
export interface PdfPendingImageInsert {page:number;image:{base64:string;mime:'image/png'|'image/jpeg'};anchor_text?:string;placement?:'above'|'below'|'left'|'right';x?:number;y?:number;width?:number;height?:number;layer?:'above_text'|'below_text'}
export interface PdfPendingImagePreview {page:number;x:number;y:number;width:number;height:number;layer:'above_text'|'below_text';pixelWidth:number;pixelHeight:number}
export interface PdfDraftInserts {texts:readonly PdfTextInsertOperation[];images:PdfPendingImageInsert[];imageEdits?:readonly (PdfImageEditOperation|PdfImageBakeOperation|Extract<PdfImageContentOperation,{op:'replace_image'}>)[]}
export const pdfDraftInsertsSafetyCodes:Set<string>
export function validatePdfPendingImageInsert(input:unknown):PdfPendingImageInsert
export function validatePdfDraftInserts(input:unknown):PdfDraftInserts
export function parsePdfDraftInsertsRequest(raw:unknown):{operation:PdfPendingImageInsert;rotationDelta:number}|PdfDraftInserts
export function createPdfDraftInsertsJob(action:'imageInsertsQuery'|'draftInserts'|'draftInsertsQuery'):PdfAnnotationProcessor

/** JSON planner output in raw PDF coordinates, directly accepted by the native writer. */
export interface PdfPlannedImageInsert {kind:'insertImage';pageIndex:number;rect:[number,number,number,number];rotate:0|90|180|270;layer:'aboveText'|'belowText';image:string}
export interface PdfImageInsertsQueryReport {image:PdfPendingImagePreview;edit:PdfPlannedImageInsert}
