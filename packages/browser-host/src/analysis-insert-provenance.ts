import type {PreparedAnalysisContent} from '../../web-contracts/src/analysis-document.ts'
import type {AnalysisReceipt,AnalysisFile} from './analysis-delivery-client.ts'
import {analysisInsertLimits as limits} from './analysis-insert-content.ts'
/** Fixed, literal evidence labels. A server commit proves references/bytes,
 * never the correctness or completeness of model-authored conclusions. */
export function withAnalysisProvenance(content:PreparedAnalysisContent,receipt:AnalysisReceipt,artifact:AnalysisFile,format?:'docx'|'xlsx'|'pptx'|'pdf'):PreparedAnalysisContent {
 const fail=():never=>{throw Error('Cannot confirm analysis insertion provenance')}
 const committed=receipt.artifacts.find(x=>x.artifactId===artifact.artifactId)
 if(!committed||committed.sha256!==artifact.sha256||JSON.stringify(committed.inputResultIds)!==JSON.stringify(artifact.inputResultIds))return fail()
 const notes=['Unverified analysis. File integrity does not verify conclusions.',`Artifact SHA-256: ${artifact.sha256}`,`Commit receipt: ${receipt.commandId}`]
 if(!artifact.inputResultIds.length)notes.push('No input snapshots recorded; scope and completeness are unknown.')
 for(const id of artifact.inputResultIds){
  const input=receipt.inputs.find(x=>x.resultId===id);if(!input)return fail()
  notes.push(`Input: ${input.sourceId} v${input.sourceVersion}; ${input.rowCount} rows; ${input.truncated?'TRUNCATED: not the full dataset; no full-population conclusion is established.':'Truncation not reported; completeness is not independently verified.'}`)
  notes.push(`Snapshot: ${id}; SHA-256: ${input.sha256}; Query SHA-256: ${input.queryHash}`)
  if(input.timezone&&input.schema){
   notes.push(`Input timezone: ${input.timezone}`)
   for(const column of input.schema)notes.push(`Input column: ${column.name}; type: ${column.type}; unit: ${column.unit??'not specified'}`)
  }else notes.push('Units and timezone: not recorded in this delivery receipt; verify the original frozen inputs.')
 }
 if(!artifact.inputResultIds.length)notes.push('Units and timezone: no frozen input metadata recorded.')
 for(const line of receipt.limitations)notes.push('Model-supplied limitation: '+line)
 if(!receipt.limitations.length)notes.push('No model limitations supplied; this is not a completeness guarantee.')
 if(notes.some(line=>/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(line)))return fail()
 if(content.kind==='text'){
  const text=content.text+'\n\n[Analysis provenance]\n'+notes.join('\n')
  if(text.length>limits.maxTextUnits||new TextEncoder().encode(text).length>limits.maxBytes||text.split(/\r\n|\r|\n/).length>limits.maxRows||text.split(/\r\n|\r|\n/).some(line=>line.length>limits.maxCellUnits))return fail()
  return {kind:'text',text}
 }
 const width=content.rows[0]?.length??0
 if(!width||width>limits.maxColumns||content.rows.some(row=>row.length!==width))return fail()
 const rows=[...content.rows.map(row=>[...row]),...notes.map(note=>[note,...Array(width-1).fill('')])]
 if(rows.length>limits.maxRows||rows.length*width>limits.maxCells||rows.some(row=>row.some(cell=>cell.length>limits.maxCellUnits))||new TextEncoder().encode(rows.flat().join('\n')).length>limits.maxBytes)return fail()
 if(format==='pptx')return {kind:'table',rows:content.rows,provenance:notes}
 return {kind:'table',rows}
}
