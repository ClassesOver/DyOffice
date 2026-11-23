import type { RevisionRef } from './api.ts'
export type AnalysisColumnType = 'string' | 'number' | 'boolean'
export type PreparedAnalysisContent =
 | {kind:'text';text:string}
 /** columnTypes (frozen query results only) lets a spreadsheet write typed
  * cells; every other adapter still inserts the literal strings. */
 | {kind:'table';rows:readonly (readonly string[])[];provenance?:readonly string[];columnTypes?:readonly AnalysisColumnType[];headerRows?:number}
 /** A verified raster image (PNG/JPEG); width/height come from the file header. */
 | {kind:'image';mediaType:'image/png'|'image/jpeg';base64:string;width:number;height:number;alt:string;provenance?:readonly string[]}
export type AnalysisTargetCapture = Readonly<{token:string;fileId:string;baseRevision:RevisionRef['revision']} & ({format:'docx'|'xlsx'|'pptx';leaseEpoch:number}|{format:'pdf'})>
export type AnalysisApplyResult = {status:'applied_uncommitted';applicationId:string}
export type AnalysisSaveResult = {status:'saved';applicationId:string;receipt:RevisionRef}|{status:'not_confirmed';reason:'conflict'|'unknown'|'newer_edits'|'unavailable'}
export interface AnalysisDocumentTarget {
 readonly fileId:string
 readonly format:'docx'|'xlsx'|'pptx'|'pdf'
 capture():AnalysisTargetCapture
 apply(capture:AnalysisTargetCapture,content:PreparedAnalysisContent,artifact:{artifactId:string;sha256:string},authorized:()=>boolean):Promise<AnalysisApplyResult>
 save(applicationId:string,authorized:()=>boolean):Promise<AnalysisSaveResult>
 dispose():void
}
/** Native captures never leave the trusted renderer; matches must check current
 * document identity, editing intents and selection, including queued apply. */
export interface NativeAnalysisEditor {
 captureAnalysis():{matches():boolean;matchesForSave?():boolean;apply(content:PreparedAnalysisContent,authorized:()=>boolean):Promise<boolean>}
}

export const analysisInsertLimits = Object.freeze({maxBytes:65536,maxTextUnits:100000,maxRows:500,maxColumns:64,maxCells:2000,maxCellUnits:4096,maxImageBytes:8*1024*1024,maxImageSide:20000})
