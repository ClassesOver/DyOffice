import {test} from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import JSZip from 'jszip'

const spreadsheet='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const officeRels='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const fixture=new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url)
const sidecar=fileURLToPath(new URL('../../server/sheets/xlsx-node-engine.ts',import.meta.url))

test('Node XLSX inspection exposes the table names, bands, and ranges used by the renderer',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'dyoffice-node-xlsx-tables-'))
 t.after(()=>rm(directory,{recursive:true,force:true}))
 const zip=await JSZip.loadAsync(await readFile(fixture))
 zip.file('xl/worksheets/sheet1.xml',`<worksheet xmlns="${spreadsheet}" xmlns:r="${officeRels}">
  <sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>
  <tableParts count="3"><tablePart r:id="tableFirst"/><tablePart r:id="tableSecond"/><tablePart r:id="external"/></tableParts>
 </worksheet>`)
 zip.file('xl/worksheets/_rels/sheet1.xml.rels',`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="tableSecond" Type="${officeRels}/table" Target="/xl/tables/second.xml"/>
  <Relationship Id="tableFirst" Type="${officeRels}/table" Target="../tables/first.xml"/>
  <Relationship Id="external" Type="${officeRels}/table" Target="https://example.com/table.xml" TargetMode="External"/>
 </Relationships>`)
 zip.file('xl/tables/first.xml',`<x:table xmlns:x="${spreadsheet}" id="1" ref="\u0024B\u00242:\u0024C\u00246" displayName="Revenue_2026" name="Legacy" totalsRowCount="1">
  <x:autoFilter ref="B2:C5"><x:filterColumn colId="0"><x:filters><x:filter val="North"/></x:filters></x:filterColumn></x:autoFilter>
  <x:tableColumns count="2"><x:tableColumn id="1" name="Region"/><x:tableColumn id="2" name="Net &amp; tax"/></x:tableColumns>
  <x:tableStyleInfo name="TableStyleMedium2" showRowStripes="true" showColumnStripes="1"/>
  <x:extLst><x:ext uri="extension"><x14:table xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" altText="Revenue"/></x:ext></x:extLst>
 </x:table>`)
 zip.file('xl/tables/second.xml',`<table xmlns="${spreadsheet}" id="2" ref="E8:E11" name="Inputs" headerRowCount="0">
  <autoFilter ref="E8:E11"><filterColumn colId="0" hiddenButton="1"/></autoFilter>
  <tableColumns count="1"><tableColumn id="1" name="Units"/></tableColumns>
  <tableStyleInfo name="LocalBand" showFirstColumn="1" showRowStripes="1"/>
 </table>`)
 zip.file('xl/styles.xml',`<styleSheet xmlns="${spreadsheet}">
  <dxfs count="2">
   <dxf><fill><patternFill><bgColor rgb="FF234567"/></patternFill></fill></dxf>
   <dxf><fill><patternFill><bgColor rgb="FFABCDEF"/></patternFill></fill></dxf>
  </dxfs>
  <tableStyles count="1"><tableStyle name="LocalBand" table="1" count="2">
   <tableStyleElement type="firstRowStripe" dxfId="0"/><tableStyleElement type="firstColumn" dxfId="1"/>
  </tableStyle></tableStyles>
 </styleSheet>`)
 const path=join(directory,'tables.xlsx')
 await writeFile(path,await zip.generateAsync({type:'nodebuffer'}))
 const stdout=execFileSync(process.execPath,['--import','tsx',sidecar],{
  input:JSON.stringify({version:1,requestId:'open',command:'open',path,locale:'en'})+'\n',
  encoding:'utf8',
  timeout:30_000,
 })
 const response=JSON.parse(stdout)
 assert.equal(response.ok,true,stdout)
 const [sheet]=response.result.sheets
 assert.deepEqual(sheet.tables.map(table=>({
  name:table.name,columns:table.columns,range:table.range,headerRows:table.headerRowCount,
  totalsRows:table.totalsRowCount,filter:table.filterActive,style:table.styleName,
  bandedRows:table.showRowStripes,bandedColumns:table.showColumnStripes,
 })),[
  {name:'Revenue_2026',columns:['Region','Net & tax'],range:{startRow:1,endRow:5,startColumn:1,endColumn:2},
   headerRows:1,totalsRows:1,filter:true,style:'TableStyleMedium2',bandedRows:true,bandedColumns:true},
  {name:'Inputs',columns:['Units'],range:{startRow:7,endRow:10,startColumn:4,endColumn:4},
   headerRows:0,totalsRows:0,filter:false,style:'LocalBand',bandedRows:true,bandedColumns:false},
 ])
 assert.equal(sheet.tables[0].headerFontColor,'#FFFFFF')
 assert.equal(sheet.tables[0].totalRowBorderStyle,'double')
 assert.equal(sheet.tables[1].stripeFill,'#234567')
 assert.equal(sheet.tables[1].firstColumnFill,'#ABCDEF')
 assert.equal(sheet.rowCount,11)
 assert.equal(sheet.columnCount,5)
})
