import {analysisInsertLimits as limits, type PreparedAnalysisContent} from '../../web-contracts/src/analysis-document.ts'
/** Defense at the mutation boundary; even a trusted UI must not pass active
 * content, arbitrarily large matrices or nonliteral cell objects. */
export function literalRows(content:PreparedAnalysisContent):string[][] {
 const rows=content.kind==='text'?(typeof content.text==='string'?content.text.split(/\r\n|\r|\n/).map(v=>[v]):[]):content.kind==='table'?content.rows:[]
 if(!Array.isArray(rows)||!rows.length||rows.length>limits.maxRows)throw new Error('Unsupported content')
 let bytes=0,cells=0;const width=rows[0]?.length
 if(!width||width>limits.maxColumns)throw new Error('Unsupported content')
 return rows.map(row=>{if(!Array.isArray(row)||row.length!==width)throw new Error('Unsupported content');return row.map(value=>{if(typeof value!=='string'||value.length>limits.maxCellUnits||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))throw new Error('Unsupported content');bytes+=new TextEncoder().encode(value).length;if(++cells>limits.maxCells||bytes>limits.maxBytes)throw new Error('Content limit');return value})})
}
export function literalHtml(content:PreparedAnalysisContent):string {
 const rows=literalRows(content),escape=(v:string)=>v.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')
 return content.kind==='text'?rows.map(r=>`<p>${escape(r[0]!)}</p>`).join(''):`<table>${rows.map(r=>`<tr>${r.map(v=>`<td><p>${escape(v)}</p></td>`).join('')}</tr>`).join('')}</table>`
}
