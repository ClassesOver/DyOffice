import type {PdfAnnotationProcessor} from './annotation-job.mjs'
export interface PdfBlockMoveOperation {readonly page:number;readonly paragraph_text:string;readonly dx:number;readonly dy:number}
export const pdfBlockMovesSafetyCodes:Set<string>
export function validatePdfBlockMoveOperations(input:unknown):readonly PdfBlockMoveOperation[]
export function parsePdfBlockMovesRequest(raw:unknown):readonly PdfBlockMoveOperation[]
export function planPdfBlockMoves(bytes:Uint8Array,operations:readonly PdfBlockMoveOperation[],signal?:AbortSignal):Promise<{pageIndex:number;rect:[number,number,number,number];oldText:string;newText:string;fontSize:number;origin:[number,number];lineLeading:number;align?:string;blockSource:string;translate:[number,number]}[]>
export function createPdfBlockMovesJob():PdfAnnotationProcessor
