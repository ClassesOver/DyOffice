import type {PdfAnnotationProcessor} from './annotation-job.mjs'
import type {PlannedPdfFormField} from './form-fields-job.mjs'
import type {PdfDraftInserts} from './draft-inserts-job.mjs'
import type {AnnotDeleteInput,NoteEditInput,TextEditInput,PdfAttachmentOps,DrawingInput,OutlineEntryInput,FormWidgetEditInput,StaticFormFillRecord} from '../../../../pdf/src/shared/ipc.ts'
import type {PdfStampOperation} from '../../../../../packages/web-contracts/src/pdf-stamp-ops.ts'
type Pair=readonly [number,number]
type Rect=readonly [number,number,number,number]
type RGB=readonly [number,number,number]
export interface PdfApplyTextInsert {readonly pageIndex:number;readonly origin:Pair;readonly text:string;readonly fontSize:number;readonly color:RGB;readonly font?:string;readonly bold?:boolean;readonly italic?:boolean;readonly lineLeading?:number;readonly lineXOffsets?:readonly number[];readonly align?:'left'|'center'|'right';readonly rotate?:number;readonly invisible?:boolean}
export type PdfApplyImageEdit=
 |{readonly kind:'insertImage';readonly pageIndex:number;readonly image:string;readonly rect:Rect;readonly layer:'aboveText'|'belowText';readonly rotate?:number}
 |{readonly kind:'replaceImage';readonly pageIndex:number;readonly image:string;readonly oldRect:Rect;readonly rect:Rect;readonly layer?:'aboveText'|'belowText';readonly quarterTurns?:number}
 |{readonly kind:'transformImage';readonly pageIndex:number;readonly oldRect:Rect;readonly rect:Rect;readonly layer?:'aboveText'|'belowText';readonly quarterTurns?:number}
 |{readonly kind:'deleteImage';readonly pageIndex:number;readonly oldRect:Rect}
export interface PdfApplyNote {readonly kind:'note';readonly pageIndex:number;readonly color:RGB;readonly at:Pair;readonly contents:string;readonly author?:string;readonly createdMs?:number;readonly localId?:string;readonly replyToLocalId?:string;readonly replyToSaved?:{readonly objNum:number;readonly rect:Rect;readonly contents:string}}
export type PdfApplyFormValue={readonly name:string;readonly kind:'text'|'radio'|'choice';readonly value:string}|{readonly name:string;readonly kind:'checkbox';readonly checked:boolean}
export interface PdfApplySnapshot {
 readonly fileId:string;readonly baseRevision:string;readonly generation:number
 readonly blankPages?:readonly {readonly pageIndex:number;readonly width:number;readonly height:number}[]
 readonly textEdits?:readonly TextEditInput[]
 readonly annotDeletes?:readonly AnnotDeleteInput[]
 readonly noteEdits?:readonly NoteEditInput[]
 readonly stampOperations?:readonly PdfStampOperation[]
 readonly attachments?:PdfAttachmentOps
 readonly drawings?:readonly Exclude<DrawingInput,{kind:'note'}>[]
 readonly outline?:readonly OutlineEntryInput[]
 readonly formWidgetEdits?:readonly FormWidgetEditInput[]
 readonly staticFormFills?:readonly StaticFormFillRecord[]
 readonly markups:readonly {readonly id:string;readonly pageIndex:number;readonly type:'highlight'|'underline'|'squiggly'|'strikeout';readonly color:RGB;readonly quads:readonly (readonly number[])[]}[]
 readonly notes:readonly {readonly id:string;readonly input:PdfApplyNote}[]
 readonly textInserts:readonly {readonly id:string;readonly input:PdfApplyTextInsert}[]
 readonly imageEdits:readonly {readonly id:string;readonly input:PdfApplyImageEdit}[]
 readonly savedImageEdits?:PdfDraftInserts['imageEdits']
 readonly formEdits:Readonly<Record<string,PdfApplyFormValue>>
 readonly formFields:readonly {readonly id:string;readonly input:Readonly<Omit<PlannedPdfFormField,'rect'|'options'>>&{readonly rect:Rect;readonly options?:readonly string[]}}[]
 readonly rotations:Readonly<Record<number,number>>;readonly deleted:readonly number[];readonly order:readonly number[]|null
 readonly metadata:Readonly<Partial<Record<'title'|'author'|'subject'|'keywords',string>>>|null
}
export const pdfApplyOpsSafetyCodes:Set<string>
export function validatePdfApplySnapshot(input:unknown):PdfApplySnapshot
export function parsePdfApplyOpsRequest(raw:unknown):PdfApplySnapshot
export function createPdfApplyOpsJob():PdfAnnotationProcessor
