import {csvRows} from '../../xlsx-gateway/src/gateway/csv-import.ts'
import {analysisInsertLimits,type PreparedAnalysisContent} from '../../web-contracts/src/analysis-document.ts'
/** Lower than the artifact download cap. Exceeding a limit rejects the whole
 * insertion; these limits are not a statement that analysis is complete. */
export {analysisInsertLimits} from '../../web-contracts/src/analysis-document.ts'
export interface AnalysisInsertArtifact {readonly role:string;readonly mediaType:string;readonly bytes:Uint8Array}
/** Content preparation only: caller must independently authorize an explicit
 * insert, verify the receipt/hash, and fence the active document and selection.
 * Markdown and HTML-looking strings stay literal text, never executable markup.
 * Preparing content does not insert, persist, or save a document. */
export function prepareAnalysisInsertContent(input:AnalysisInsertArtifact):PreparedAnalysisContent {
 const fail=():never=>{throw Error('Cannot prepare analysis content')}
 if(!input||!((input.role==='report'&&['text/plain','text/markdown'].includes(input.mediaType))||(input.role==='table'&&input.mediaType==='text/csv'))||
  !(input.bytes instanceof Uint8Array)||!input.bytes.byteLength||input.bytes.byteLength>analysisInsertLimits.maxBytes)return fail()
 let text:string
 try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(input.bytes)}catch{return fail()}
 if(!text.length||text.length>analysisInsertLimits.maxTextUnits||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text))return fail()
 if(input.role==='report'){
  const lines=text.split(/\r\n|\r|\n/)
  if(lines.length>analysisInsertLimits.maxRows||lines.some(line=>line.length>analysisInsertLimits.maxCellUnits))return fail()
  return {kind:'text',text}
 }
 // Delimiters are explicit, never sniffed. No sep= dialect directives and no
 // numeric/date conversion: adapters must insert these strings as literal cells.
 if(/^\uFEFF?sep=/i.test(text))return fail()
 const rows:string[][]=[];let cells=0
 try {
  for(const row of csvRows(text,',',{strict:true})) {
   if(rows.length&&row.length!==rows[0]!.length)return fail()
   cells+=row.length
   if(rows.length>=analysisInsertLimits.maxRows||row.length>analysisInsertLimits.maxColumns||cells>analysisInsertLimits.maxCells||row.some(cell=>cell.length>analysisInsertLimits.maxCellUnits))return fail()
   rows.push(row)
  }
 }catch{return fail()}
 if(!rows.length)return fail()
 return {kind:'table',rows}
}
