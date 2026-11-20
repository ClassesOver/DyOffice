import type {PdfAnnotationProcessor} from './annotation-job.mjs'
export interface PdfTextInsertOperation {
 readonly page:number;readonly text:string;readonly anchor_text?:string;readonly placement?:'right'|'below'|'above';readonly x?:number;readonly y?:number;readonly font_size?:number;readonly color?:string;readonly max_width?:number;readonly align?:'left'|'center'|'right';readonly font?:'arial'|'times'|'courier';readonly bold?:boolean;readonly italic?:boolean
}
export const pdfTextInsertsSafetyCodes:Set<string>
export function validatePdfTextInsertOperations(input:unknown):readonly PdfTextInsertOperation[]
export function parsePdfTextInsertsRequest(raw:unknown):readonly PdfTextInsertOperation[]
/** JSON planner output in raw PDF coordinates, directly accepted by the native writer. */
export interface PdfPlannedTextInsert {pageIndex:number;origin:[number,number];text:string;fontSize:number;color:[number,number,number];font?:'arial'|'times'|'courier';bold?:boolean;italic?:boolean;lineLeading:number;align?:'left'|'center'|'right';lineXOffsets?:number[];rotate:number}
export function planPdfTextInserts(bytes:Uint8Array,operations:readonly PdfTextInsertOperation[],signal?:AbortSignal):Promise<PdfPlannedTextInsert[]>
export function createPdfTextInsertsJob():PdfAnnotationProcessor

export interface PdfTextInsertPreviewBlock {page:number;text:string;x:number;y:number;width:number;height:number;line_widths:number[];font_size:number;color:string;align:'left'|'center'|'right';font?:'arial'|'times'|'courier';bold?:boolean;italic?:boolean;max_width?:number}
export function createPdfTextInsertsQueryJob():PdfAnnotationProcessor

export interface PdfTextInsertsQueryReport {blocks:PdfTextInsertPreviewBlock[];inserts:PdfPlannedTextInsert[]}
