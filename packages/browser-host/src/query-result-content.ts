import {analysisInsertLimits as limits, type AnalysisColumnType, type PreparedAnalysisContent} from '../../web-contracts/src/analysis-document.ts'
import type {QueryCell, QueryColumn} from '../../web-contracts/src/sources.ts'

/** One page of GET /api/v1/workspace/data-results/:id. */
export interface QueryResultPage {
 artifact:{resultId:string;sourceId?:string;sourceVersion?:number}
 schema:readonly QueryColumn[]
 timezone:string
 rows:readonly Readonly<Record<string,QueryCell>>[]
 offset:number
 nextOffset:number|null
 totalRows:number
 sourceTruncated:boolean
 sha256:string
}
export interface QueryResultSelection {columns?:readonly string[];maxRows?:number}

const fail=(message='Cannot prepare query result content'):never=>{throw new Error(message)}
const control=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u

function cellText(value:QueryCell):string {
 if(value===null||value===undefined)return ''
 if(typeof value==='number')return Number.isFinite(value)?String(value):fail()
 if(typeof value==='boolean')return value?'TRUE':'FALSE'
 if(typeof value!=='string')return fail()
 // Strip C0 controls rather than rejecting a whole result for one stray byte.
 return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'')
}

/**
 * Turn frozen query-result pages into literal table content. Values are taken
 * from the server's frozen snapshot, never from model text. The table carries a
 * header row (with units), the selected rows and provenance notes; it refuses to
 * insert more than the document limits instead of silently truncating.
 */
export function queryResultTable(pages:readonly QueryResultPage[],selection:QueryResultSelection={},format?:'docx'|'xlsx'|'pptx'):Extract<PreparedAnalysisContent,{kind:'table'}> {
 if(!pages.length)return fail()
 const first=pages[0]!
 if(!/^[a-f0-9]{64}$/.test(first.sha256)||!Array.isArray(first.schema)||!first.schema.length)return fail()
 for(const page of pages)if(page.sha256!==first.sha256||page.artifact.resultId!==first.artifact.resultId)return fail('Query result changed while it was being read')
 const available=first.schema.map(column=>column.name)
 const names=selection.columns?.length?[...selection.columns]:available
 if(new Set(names).size!==names.length||names.some(name=>!available.includes(name)))return fail('Unknown or duplicate column; use the names returned by the query schema')
 const columns=names.map(name=>first.schema.find(column=>column.name===name)!)
 if(columns.length>limits.maxColumns)return fail(`At most ${limits.maxColumns} columns can be inserted`)
 const all=pages.flatMap(page=>page.rows)
 const wanted=selection.maxRows===undefined?all.length:selection.maxRows
 if(!Number.isInteger(wanted)||wanted<1)return fail('maxRows must be a positive integer')
 const rows=all.slice(0,wanted)
 const omitted=first.totalRows-rows.length
 const notes=[
  `Source: ${first.artifact.sourceId??'unknown'}${first.artifact.sourceVersion!==undefined?' v'+first.artifact.sourceVersion:''}; frozen result ${first.artifact.resultId}; SHA-256 ${first.sha256}`,
  `Rows inserted: ${rows.length} of ${first.totalRows}${omitted>0?` (${omitted} not inserted)`:''}`,
  first.sourceTruncated?'TRUNCATED at the source query limit: not the full dataset; no full-population conclusion is established.':'Source truncation not reported.',
  `Timezone: ${first.timezone||'not recorded'}`,
 ]
 const header=columns.map(column=>column.unit?`${column.name} (${column.unit})`:column.name)
 const body=rows.map(row=>columns.map(column=>cellText(row[column.name] as QueryCell)))
 const width=columns.length
 const table=[header,...body]
 const withNotes=format==='pptx'?table:[...table,...notes.map(note=>[note,...Array(width-1).fill('')])]
 const cells=withNotes.length*width,bytes=new TextEncoder().encode(withNotes.flat().join('\n')).length
 if(withNotes.length>limits.maxRows||cells>limits.maxCells||bytes>limits.maxBytes)
  return fail(`Too large to insert (${body.length} rows × ${width} columns; limit ${limits.maxCells} cells and ${limits.maxRows} rows including header and notes). Aggregate in SQL, select fewer columns, or pass maxRows.`)
 if(withNotes.some(row=>row.some(cell=>cell.length>limits.maxCellUnits||control.test(cell))))return fail('A cell is too long to insert')
 const columnTypes:AnalysisColumnType[]=columns.map(column=>column.type)
 return {kind:'table',rows:withNotes,columnTypes,headerRows:1,...(format==='pptx'?{provenance:notes}:{})}
}
