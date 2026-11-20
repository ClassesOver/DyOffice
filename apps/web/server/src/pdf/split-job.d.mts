export interface PdfSplitResult {inputSha256:string;files:{bytes:Buffer;sha256:string;size:number}[]}
export interface PdfSplitProcessor {execute(input:Buffer,raw:string,signal?:AbortSignal):Promise<PdfSplitResult>}
export const pdfSplitSafetyCodes:Set<string>
export function validatePdfSplitSize(value:unknown):number
export function parsePdfSplitRequest(raw:unknown):number
export function createPdfSplitJob():PdfSplitProcessor
