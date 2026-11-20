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

test('Node XLSX inspection and range reads retain built-in and custom number formats',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'dyoffice-node-xlsx-styles-'))
 t.after(()=>rm(directory,{recursive:true,force:true}))
 await buildSheetsGateway(join(directory,'gateway.mjs'))
 const runtime=await configuredSheetsRuntime({
  DYOFFICE_AUTH_MODE:'local',DYOFFICE_SANDBOX_MODE:'subprocess',
  DYOFFICE_DEPLOYMENT_ID:randomUUID(),DYOFFICE_XLSX_NODE_ENGINE:join(directory,'xlsx-node-engine.mjs'),
  DYOFFICE_XLSX_GATEWAY_RUNNER:join(directory,'gateway-process.mjs'),
 },{enabled:true})
 t.after(()=>runtime.close())
 const zip=await JSZip.loadAsync(await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url)))
 zip.file('xl/styles.xml','<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.0000"/></numFmts><fonts count="1"><font/></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="10"/><xf numFmtId="164"/></cellXfs></styleSheet>')
 zip.file('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B1"/><sheetData><row r="1"><c r="A1" s="1"><v>0.125</v></c><c r="B1" s="2"><v>1234.5</v></c></row></sheetData></worksheet>')
 const bytes=await zip.generateAsync({type:'nodebuffer'})
 const workbook=await runtime.sheetsNative.inspect(bytes)
 assert.equal(workbook.styles[1].numberFormat,'0.00%')
 assert.equal(workbook.styles[2].numberFormat,'"$"#,##0.0000')
 const range=await runtime.sheetsNative.readRange(bytes,'Acceptance',{startRow:0,endRow:0,startColumn:0,endColumn:1})
 assert.deepEqual(range.cells.map(cell=>cell.styleIndex),[1,2])
})
