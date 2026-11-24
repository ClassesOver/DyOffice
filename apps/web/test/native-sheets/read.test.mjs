import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {sandboxFixture} from '../helpers/native-sandbox.mjs'
import {createXlsxNativeWorker} from '../../worker/src/native/xlsx.ts'
import JSZip from 'jszip'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {buildSheetsGateway} from '../../server/sheets/build.mjs'
import {configuredSheetsRuntime} from '../../server/src/modules/sheets/runtime.ts'
import {randomUUID} from 'node:crypto'
test('native read adapter reopens captured bytes and resolves sheet names inside each isolated call',async()=>{
 const native=createXlsxNativeWorker(await sandboxFixture('native')),input=await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url))
 const workbook=await native.inspect(input)
 assert.equal(workbook.sheets[0].name,'Acceptance');assert.equal(Object.hasOwn(workbook,'sessionId'),false)
 const range={startRow:1,endRow:1,startColumn:0,endColumn:5}
 for(let i=0;i<2;i++){
  const result=await native.readRange(input,'Acceptance',range)
  assert.equal(result.cells.find(c=>c.column===0).value,12.5)
 }
 await assert.rejects(()=>native.readRange(input,'Missing',range),{code:'UNKNOWN_SHEET'})
 await assert.rejects(()=>native.readRange(input,'Acceptance',{...range,endRow:1000000}),{code:'INPUT_LIMIT'})
})

async function nodeRuntime(t){
 const directory=await mkdtemp(join(tmpdir(),'dyoffice-node-xlsx-styles-'))
 t.after(()=>rm(directory,{recursive:true,force:true}))
 await buildSheetsGateway(join(directory,'gateway.mjs'))
 const runtime=await configuredSheetsRuntime({
  DYOFFICE_AUTH_MODE:'local',DYOFFICE_SANDBOX_MODE:'subprocess',
  DYOFFICE_DEPLOYMENT_ID:randomUUID(),DYOFFICE_XLSX_NODE_ENGINE:join(directory,'xlsx-node-engine.mjs'),
  DYOFFICE_XLSX_GATEWAY_RUNNER:join(directory,'gateway-process.mjs'),
 },{enabled:true})
 t.after(()=>runtime.close())
 return runtime.sheetsNative
}

test('Node XLSX inspection and range reads retain built-in and custom number formats',async t=>{
 const native=await nodeRuntime(t)
 const zip=await JSZip.loadAsync(await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url)))
 zip.file('xl/styles.xml','<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.0000"/></numFmts><fonts count="1"><font/></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="10"/><xf numFmtId="164"/></cellXfs></styleSheet>')
 zip.file('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B1"/><sheetData><row r="1"><c r="A1" s="1"><v>0.125</v></c><c r="B1" s="2"><v>1234.5</v></c></row></sheetData></worksheet>')
 const bytes=await zip.generateAsync({type:'nodebuffer'})
 const workbook=await native.inspect(bytes)
 assert.equal(workbook.styles[1].numberFormat,'0.00%')
 assert.equal(workbook.styles[2].numberFormat,'"$"#,##0.0000')
 const range=await native.readRange(bytes,'Acceptance',{startRow:0,endRow:0,startColumn:0,endColumn:1})
 assert.deepEqual(range.cells.map(cell=>cell.styleIndex),[1,2])
})

test('Node XLSX resolves theme and indexed colors, borders and alignment from cell styles',async t=>{
 const native=await nodeRuntime(t)
 const zip=await JSZip.loadAsync(await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url)))
 const slots=['lt1','dk1','lt2','dk2','accent1','accent2','accent3','accent4','accent5','accent6','hlink','folHlink']
 zip.file('xl/theme/theme1.xml','<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme>'+
  slots.map(slot=>`<a:${slot}><a:srgbClr val="${slot==='accent1'?'000000':'FFFFFF'}"/></a:${slot}>`).join('')+'</a:clrScheme></a:themeElements></a:theme>')
 zip.file('xl/styles.xml',`<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts><font><name val="Example Font"/><sz val="14"/><b/><i val="0"/><color indexed="2"/></font></fonts>
  <fills><fill><patternFill patternType="solid"><fgColor theme="4" tint="0.5"/></patternFill></fill></fills>
  <borders><border diagonalUp="1"><bottom style="medium"><color rgb="FF123456"/></bottom><diagonal style="thin"/></border></borders>
  <cellXfs><xf fontId="0" fillId="0" borderId="0" numFmtId="10"><alignment horizontal="center" vertical="top" wrapText="1" indent="2"/></xf></cellXfs>
 </styleSheet>`)
 const workbook=await native.inspect(await zip.generateAsync({type:'nodebuffer'}))
 const style=workbook.styles[0]
 assert.equal(workbook.themeColors[4],'#000000')
 assert.equal(style.fillColor,'#808080')
 assert.equal(style.fillColorTheme,4)
 assert.equal(style.fillColorTint,0.5)
 assert.equal(style.fontColor,'#FF0000')
 assert.equal(style.fontFamily,'Example Font')
 assert.equal(style.fontSize,14)
 assert.equal(style.bold,true)
 assert.equal(style.italic,false)
 assert.equal(style.numberFormat,'0.00%')
 assert.equal(style.horizontalAlignment,'center')
 assert.equal(style.verticalAlignment,'top')
 assert.equal(style.wrapText,true)
 assert.equal(style.indent,2)
 assert.deepEqual(style.borderBottom,{style:'medium',color:'#123456'})
 assert.equal(style.borderDiagonal.style,'thin')
 assert.equal(style.diagonalUp,true)
})

test('Node XLSX reports the same workbook, worksheet and cell protection as Rust',async t=>{
 const node=await nodeRuntime(t),rust=createXlsxNativeWorker(await sandboxFixture('native'))
 const zip=await JSZip.loadAsync(await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url)))
 const workbook=await zip.file('xl/workbook.xml').async('string')
 zip.file('xl/workbook.xml',workbook.replace('<sheets>',"<workbookProtection lockStructure='1' workbookPassword='CBEB'/><sheets>"))
 zip.file('xl/styles.xml','<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font/></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="2"><xf/><xf><protection hidden="1"/></xf></cellStyleXfs><cellXfs count="3"><xf/><xf applyProtection="1"><protection locked="0"/></xf><xf xfId="1"/></cellXfs></styleSheet>')
 zip.file('xl/worksheets/sheet1.xml',`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>12</v></c><c r="B1" s="1"><v>18</v></c><c r="C1" s="2"><f>1+2</f><v>3</v></c></row></sheetData><x:sheetProtection sheet='1' password='CBEB' formatCells='0'/><x:protectedRanges><x:protectedRange name='Open &amp; editable' sqref='D1:D2'/><x:protectedRange name='Restricted' sqref='E1:E2' password='CBEB'/></x:protectedRanges></worksheet>`)
 const bytes=await zip.generateAsync({type:'nodebuffer'})
 const bounds={startRow:0,endRow:0,startColumn:0,endColumn:2}
 const expected=await rust.inspect(bytes),actual=await node.inspect(bytes)
 assert.deepEqual(expected.workbookProtection,{lockStructure:true,hasPassword:true})
 assert.equal(expected.styles[1].locked,false)
 assert.equal(expected.styles[2].hidden,true)
 assert.deepEqual(actual.workbookProtection,expected.workbookProtection)
 assert.equal(actual.styles[1].locked,expected.styles[1].locked)
 assert.equal(actual.styles[2].hidden,expected.styles[2].hidden)
 const fromRust=await rust.readRange(bytes,'Acceptance',bounds),fromNode=await node.readRange(bytes,'Acceptance',bounds)
 assert.equal(fromRust.sheetProtection.protected,true)
 assert.equal(fromRust.sheetProtection.allow.formatCells,true)
 assert.deepEqual(fromRust.protectedRanges,[{name:'Open & editable',sqref:'D1:D2',hasPassword:false},{name:'Restricted',sqref:'E1:E2',hasPassword:true}])
 assert.deepEqual(fromNode.sheetProtection,fromRust.sheetProtection)
 assert.deepEqual(fromNode.protectedRanges,fromRust.protectedRanges)
 assert.equal(fromNode.cells.find(cell=>cell.column===1).styleIndex,1)
})


test('opening viewport matches a normal Node range and skips oversized cell text',async t=>{
 const native=await nodeRuntime(t)
 const bytes=await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url))
 assert.equal((await native.inspect(bytes)).openingViewport,undefined)
 const {openingViewport:preview,sheets}=await native.inspect(bytes,undefined,true)
 assert.ok(preview)
 assert.equal(preview.sheetId,sheets[0].id)
 assert.deepEqual(preview.result,await native.readRange(bytes,sheets[0].name,{startRow:0,startColumn:0,endRow:preview.endRow,endColumn:preview.endColumn}))
 const zip=await JSZip.loadAsync(bytes)
 const rows=Array.from({length:12},(_,i)=>`<row r="${i+1}"><c r="A${i+1}" t="inlineStr"><is><t>${'x'.repeat(32000)}</t></is></c></row>`).join('')
 zip.file('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'+rows+'</sheetData></worksheet>')
 const large=await native.inspect(await zip.generateAsync({type:'nodebuffer'}),undefined,true)
 assert.equal(large.openingViewport,undefined)
 assert.equal(large.sheets[0].rowCount,12)
})

test('Node XLSX keeps sparse layout beyond the last value and returns intersecting merges',async t=>{
 const native=await nodeRuntime(t)
 const zip=await JSZip.loadAsync(await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url)))
 zip.file('xl/worksheets/sheet1.xml',`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews><sheetView workbookViewId="0"><pane state="frozenSplit" ySplit="2"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="18" customHeight="1" defaultColWidth="12"/>
  <cols><col min="2" max="4" width="28" customWidth="1"/></cols>
  <sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="8" ht="36" customHeight="1"/></sheetData>
  <mergeCells><mergeCell ref="B8:D8"/><mergeCell ref="A10:A11"/></mergeCells>
  <conditionalFormatting sqref="B8:D8 A10:A11"><cfRule type="colorScale" priority="3"><colorScale>
    <cfvo type="min"/><cfvo type="percentile" val="50"/><cfvo type="max"/>
    <color rgb="FFFF0000"/><color rgb="FFFFFF00"/><color rgb="FF00FF00"/>
  </colorScale></cfRule></conditionalFormatting></worksheet>`)
 const bytes=await zip.generateAsync({type:'nodebuffer'}),sheet=(await native.inspect(bytes)).sheets[0]
 assert.deepEqual(sheet.freeze,{frozenColumns:0,frozenRows:2})
 assert.deepEqual(sheet.columnWidths,[{startColumn:1,endColumn:3,width:28,hidden:false}])
 assert.deepEqual([sheet.defaultRowHeight,sheet.defaultRowHeightFixed,sheet.defaultColumnWidth],[18,true,12])
 assert.ok(sheet.rowCount>=11 && sheet.columnCount>=4)
 assert.deepEqual([sheet.valueCellCount,sheet.valueRowCount,sheet.valueColumnCount],[1,1,1])
 const range=await native.readRange(bytes,'Acceptance',{startRow:7,endRow:7,startColumn:2,endColumn:2})
 assert.deepEqual(range.rows,[{row:7,height:36,customHeight:true,hidden:false}])
 assert.deepEqual(range.merges,[{startRow:7,endRow:7,startColumn:1,endColumn:3}])
 const [rule]=range.conditionalRules
 assert.deepEqual(rule.colors,['#FF0000','#FFFF00','#00FF00'])
 assert.deepEqual(rule.cfvos,[{kind:'min'},{kind:'percentile',value:'50'},{kind:'max'}])
 assert.equal(rule.ranges.length,2)
})
})
