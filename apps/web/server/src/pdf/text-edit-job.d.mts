export interface PdfTextEditOperation {
  readonly page:number
  readonly oldText:string
  readonly newText:string
  readonly occurrence:number
}
export interface PdfTextEditResult {
  bytes:Buffer
  inputSha256:string
  sha256:string
  size:number
}
export interface PdfTextEditProcessor {
  execute(input:Buffer,raw:string,signal?:AbortSignal):Promise<PdfTextEditResult>
}
export function validatePdfTextEditOperations(value:unknown):readonly PdfTextEditOperation[]
export function parsePdfTextEditRequest(raw:unknown):readonly PdfTextEditOperation[]
export function createPdfTextEditJob():PdfTextEditProcessor
