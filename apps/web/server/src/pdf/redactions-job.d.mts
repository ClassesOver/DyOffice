export type PdfRedactPattern='phone'|'email'|'credit-card'|'ssn'|'date'|'iban'
export interface PdfRedactionReport {revision:string;candidates:{id:string;page:number;text:string;rect:[number,number,number,number];displayRect:{left:number;top:number;width:number;height:number}}[];truncated:boolean;scannedPages:number[];unsupportedPages:number[]}
export const pdfRedactionsSafetyCodes:Set<string>
export function validatePdfRedactionPatterns(input?:unknown):PdfRedactPattern[]
export function parsePdfRedactionsRequest(raw:unknown):
 {revision:string;patterns:PdfRedactPattern[];ids?:string[]}|{revision:string;regions:import('../../../../pdf/src/shared/ipc').RedactionInput[]}
export function createPdfRedactionsJob(action:'redactionsQuery'|'redactedCopy'):ReturnType<typeof import('./text-inserts-job.mjs').createPdfTextInsertsJob>
