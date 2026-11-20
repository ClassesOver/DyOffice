import type { RevisionRef } from './api.ts'
export type PreparedAnalysisContent =
 | {kind:'text';text:string}
 | {kind:'table';rows:readonly (readonly string[])[];provenance?:readonly string[]}
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

export const analysisInsertLimits = Object.freeze({maxBytes:65536,maxTextUnits:100000,maxRows:500,maxColumns:64,maxCells:2000,maxCellUnits:4096})
