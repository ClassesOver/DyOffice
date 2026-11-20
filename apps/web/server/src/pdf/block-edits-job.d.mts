import type {PdfAnnotationProcessor} from './annotation-job.mjs'
export interface PdfBlockEditOperation {readonly page:number;readonly paragraph_text:string;readonly new_text:string;readonly font_size?:number;readonly color?:string;readonly font?:'arial'|'times'|'courier';readonly bold?:boolean;readonly italic?:boolean;readonly align?:'left'|'center'|'right'}
export const pdfBlockEditsSafetyCodes:Set<string>
export function validatePdfBlockEditOperations(input:unknown):readonly PdfBlockEditOperation[]
export function parsePdfBlockEditsRequest(raw:unknown):readonly PdfBlockEditOperation[]
export function planPdfBlockEdits(bytes:Uint8Array,operations:readonly PdfBlockEditOperation[],signal?:AbortSignal):Promise<{pageIndex:number;rect:[number,number,number,number];oldText:string;newText:string;fontSize:number;newFontSize?:number;newColor?:[number,number,number];newFont?:string;newBold?:boolean;newItalic?:boolean;origin:[number,number];lineLeading:number;lineXOffsets?:number[];align?:string;blockSource:string}[]>
export function createPdfBlockEditsJob():PdfAnnotationProcessor
