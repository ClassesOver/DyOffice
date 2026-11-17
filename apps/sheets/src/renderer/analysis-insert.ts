import type {PreparedAnalysisContent} from '../../../../packages/web-contracts/src/analysis-document'
import {literalRows} from '../../../../packages/browser-host/src/analysis-literal-content'
import {formatAddress} from '@genoffice/xlsx-gateway/domain/cell-address'
import type {WorkbookOperation} from '@genoffice/xlsx-gateway/domain/workbook-dsl'
export function analysisCellOperations(content:PreparedAnalysisContent,sheetId:string,row:number,column:number):WorkbookOperation[]{
 const rows=literalRows(content)
 if(!Number.isInteger(row)||!Number.isInteger(column)||row<0||column<0||row+rows.length>1048576||column+rows[0]!.length>16384)throw new Error('Invalid target range')
 // set_range intentionally interprets leading '=' as formulas; set_cell does
 // not, and the normal operation executor clears any existing formula field.
 return rows.flatMap((values,r)=>values.map((value,c)=>({op:'set_cell' as const,sheetId,address:formatAddress(row+r,column+c),value})))
}

type SheetCaptureState={identity:object;runtime:object;workbookId:string;sheetId:string;row:number;column:number;selection:string;epoch:number;fingerprint:string}
export function captureSheetAnalysis(o:{current:(forSave?:boolean)=>SheetCaptureState|null;hold:()=>void;run:(ops:WorkbookOperation[],check:()=>boolean)=>Promise<boolean>}){
 const value=o.current();if(!value)throw new Error('Editor unavailable')
 const initial={...value}
 const matches=()=>{const now=o.current();return !!now&&(Object.keys(initial) as (keyof SheetCaptureState)[]).every(key=>now[key]===initial[key])}
 const matchesForSave=()=>{const now=o.current(true);return !!now&&(['identity','runtime','workbookId','fingerprint'] as const).every(key=>now[key]===initial[key])}
 return {matches,matchesForSave,async apply(content:PreparedAnalysisContent,authorized:()=>boolean){
  const ops=analysisCellOperations(content,initial.sheetId,initial.row,initial.column)
  if(!authorized()||!matches())return false
  o.hold()
  // The original operation queue calls this again after its async prechecks,
  // immediately before the first mutation. No authority is inferred from text.
  return o.run(ops,()=>authorized()&&matches())
 }}
}
