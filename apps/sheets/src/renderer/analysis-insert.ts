import type {PreparedAnalysisContent} from '../../../../packages/web-contracts/src/analysis-document'
import {literalRows} from '../../../../packages/browser-host/src/analysis-literal-content'
import {formatAddress} from '@genoffice/xlsx-gateway/domain/cell-address'
import type {WorkbookOperation} from '@genoffice/xlsx-gateway/domain/workbook-dsl'
const NUMBER_TEXT=/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i

export function invalidatesAnalysisCapture(id:string,fromFormula:boolean,journalSuppressed:boolean):boolean {
 return !journalSuppressed&&!fromFormula&&!id.startsWith('formula.mutation.set-formula-calculation-')&&
  id!=='formula.mutation.set-formula-data'&&id!=='formula.mutation.set-array-formula-data'
}
/** Typed cell for a frozen query result: numeric/boolean columns become real
 * numbers/booleans (so they sum and chart); headers, notes and anything that is
 * not a canonical literal stay text. Plain CSV/report content stays text. */
function typedValue(content:PreparedAnalysisContent,rowIndex:number,columnIndex:number,value:string):string|number|boolean{
 if(content.kind!=='table'||!content.columnTypes||rowIndex<(content.headerRows??0))return value
 const type=content.columnTypes[columnIndex]
 if(type==='number'&&NUMBER_TEXT.test(value)){const number=Number(value);if(Number.isFinite(number))return number}
 if(type==='boolean'&&(value==='TRUE'||value==='FALSE'))return value==='TRUE'
 return value
}
export function analysisCellOperations(content:PreparedAnalysisContent,sheetId:string,row:number,column:number):WorkbookOperation[]{
 if(content.kind==='image')throw new Error('Images cannot be inserted into a workbook; insert the data and create a native chart instead')
 const rows=literalRows(content)
 if(!Number.isInteger(row)||!Number.isInteger(column)||row<0||column<0||row+rows.length>1048576||column+rows[0]!.length>16384)throw new Error('Invalid target range')
 // set_range intentionally interprets leading '=' as formulas; set_cell does
 // not, and the normal operation executor clears any existing formula field.
 return rows.flatMap((values,r)=>values.map((value,c)=>({op:'set_cell' as const,sheetId,address:formatAddress(row+r,column+c),value:typedValue(content,r,c,value)})))
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
