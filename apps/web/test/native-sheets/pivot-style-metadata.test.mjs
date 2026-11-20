import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile,mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
import {randomUUID} from 'node:crypto'
import JSZip from 'jszip'
import {buildSheetsGateway} from '../../server/sheets/build.mjs'
import {configuredSheetsRuntime} from '../../server/src/modules/sheets/runtime.ts'
import {sheetsSaveRequest} from '../helpers/sheets-request.mjs'

async function fixture(gateway,customTheme){
 const base=await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url)),request=sheetsSaveRequest('sheet-1',[])
 request.pivotAdditions=[{sheetId:'sheet-1',sourceSheetId:'sheet-1',sourceArea:{startRow:0,startColumn:0,endRow:3,endColumn:1},location:{startRow:0,startColumn:5,endRow:5,endColumn:6},name:'Sales',fieldNames:['Region','Amount'],rowFieldIndices:[0],rowItems:['East','West'],values:[{fieldIndex:1,agg:'sum'}]}]
 const plan=await gateway.planFromWorkbook(base,request),zip=await JSZip.loadAsync(base)
 for(const [path,value]of [...plan.replaced,...plan.added])zip.file(path,value)
 for(const [path,value]of plan.addedBinary)zip.file(path,value)
 const table=await zip.file('xl/pivotTables/pivotTable1.xml').async('string'),rels=await zip.file('xl/pivotTables/_rels/pivotTable1.xml.rels').async('string')
 const styles=[...['Light','Medium','Dark'].flatMap(family=>Array.from({length:28},(_,i)=>`PivotStyle${family}${i+1}`)),'CustomPivotStyle']
 const pivotRels=[],pivotParts=[],contentTypes=[]
 for(let i=0;i<styles.length;i++){
  // One worksheet carries all built-in variants and an unknown custom name.
  // Four flag combinations exercise row/column gating independently.
  for(let flags=0;flags<4;flags++){
   const id=i*4+flags+1,part=`xl/pivotTables/pivotTable${id}.xml`
   let xml=table.replace(/name="Sales"/,'name="Sales'+id+'"').replace(/<pivotTableDefinition\b/,'<pivotTableDefinition rowGrandTotals="'+(flags===0?'0':'1')+'"')
   xml=xml.replace(/(<location[^>]*\bref=")[^"]*/,`$1F${(id-1)*8+1}:G${(id-1)*8+7}`)
   xml=xml.replace(/<pivotTableStyleInfo[^>]*\/>/,`<pivotTableStyleInfo name="${styles[i]}" showRowStripes="${flags&1?1:0}" showColStripes="${flags&2?1:0}"/>`)
   xml=xml.replace(/<pivotFields[\s\S]*?<\/pivotFields>/,'<pivotFields count="3"><pivotField axis="axisRow"/><pivotField axis="axisRow"/><pivotField dataField="1"/></pivotFields>')
   xml=xml.replace(/<rowFields[\s\S]*?<\/rowFields>/,'<rowFields count="2"><field x="0"/><field x="1"/></rowFields>')
   xml=xml.replace(/<rowItems[\s\S]*?<\/rowItems>/,'<rowItems count="5"><i><x/></i><i r="1"><x/></i><i r="1"><x v="1"/></i><i t="default"><x/></i><i t="grand"><x/></i></rowItems>')
   if(flags>=2){
    xml=xml.replace('<pivotFields count="3">','<pivotFields count="4">').replace('<pivotField dataField="1"/>','<pivotField axis="axisRow"/><pivotField dataField="1"/>').replace('<rowFields count="2"><field x="0"/><field x="1"/></rowFields>','<rowFields count="3"><field x="0"/><field x="1"/><field x="2"/></rowFields>').replace(/<rowItems[\s\S]*?<\/rowItems>/,'<rowItems count="6"><i><x/></i><i r="1"><x/></i><i r="2"><x/></i><i t="default"><x/></i><i t="grand"><x/></i><i t="blank"/></rowItems>')
    if(flags===3)xml=xml.replace('<pivotField axis="axisRow"/>','<pivotField axis="axisRow" outline="0"/>')
   }
   zip.file(part,xml);zip.file(`xl/pivotTables/_rels/pivotTable${id}.xml.rels`,rels)
   pivotParts.push(`<pivotTablePart r:id="pivot${id}"/>`);contentTypes.push(`<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml"/>`)
   pivotRels.push(`<Relationship Id="pivot${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotTable" Target="../pivotTables/pivotTable${id}.xml"/>`)
  }
 }
 zip.file('xl/worksheets/sheet1.xml',(await zip.file('xl/worksheets/sheet1.xml').async('string')).replace(/<pivotTableParts[\s\S]*?<\/pivotTableParts>/,`<pivotTableParts count="${pivotParts.length}">${pivotParts.join('')}</pivotTableParts>`))
 zip.file('[Content_Types].xml',(await zip.file('[Content_Types].xml').async('string')).replace(/<Override\b[^>]*PartName="\/xl\/pivotTables\/[^"]*"[^>]*\/>/g,'').replace('</Types>',contentTypes.join('')+'</Types>'))
 zip.file('xl/worksheets/_rels/sheet1.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+pivotRels.join('')+'</Relationships>')
 if(customTheme){
  const colors={dk1:'123456',lt1:'FFFFFF',dk2:'1F497D',lt2:'EEECE1',accent1:'CC4422',accent2:'C0504D',accent3:'9BBB59',accent4:'8064A2',accent5:'4BACC6',accent6:'F79646',hlink:'0000FF',folHlink:'800080'}
  zip.file('xl/theme/theme1.xml','<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="Custom">'+Object.entries(colors).map(([slot,hex])=>`<a:${slot}>${slot==='dk1'?`<a:sysClr val="windowText" lastClr="${hex}"/>`:`<a:srgbClr val="${hex}"/>`}</a:${slot}>`).join('')+'</a:clrScheme></a:themeElements></a:theme>')
 }

 return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'})
}
const pivots=metadata=>metadata.sheets[0].pivotTables.toSorted((a,b)=>a.path.localeCompare(b.path))

test('Node pivot style metadata matches Rust palettes, flags, theme, row bands and save/reopen',{timeout:120000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'dyoffice-pivot-styles-'));t.after(()=>rm(directory,{recursive:true,force:true}))
 await buildSheetsGateway(join(directory,'gateway.mjs'));const gateway=await import(pathToFileURL(join(directory,'gateway.mjs')).href)
 const manifest=JSON.parse(await readFile(new URL('../../../../.dyoffice-native-build/host-manifest.json',import.meta.url)))
 const setup=async node=>{
  const runtime=await configuredSheetsRuntime({DYOFFICE_AUTH_MODE:'local',DYOFFICE_SANDBOX_MODE:'subprocess',DYOFFICE_DEPLOYMENT_ID:randomUUID(),...(node?{DYOFFICE_XLSX_NODE_ENGINE:join(directory,'xlsx-node-engine.mjs')}:{}),DYOFFICE_NATIVE_BINARY:manifest.nativeBinary,DYOFFICE_NATIVE_SHA256:manifest.nativeSha256,DYOFFICE_XLSX_GATEWAY_RUNNER:join(directory,'gateway-process.mjs')},{enabled:true})
  t.after(()=>runtime.close());return runtime
 }
 const rust=await setup(false),node=await setup(true)
 for(const customTheme of [false,true]){
  const bytes=await fixture(gateway,customTheme),expected=pivots(await rust.sheetsNative.inspect(bytes)),actual=pivots(await node.sheetsNative.inspect(bytes))
  assert.equal(expected.length,340)
  assert.ok(expected.some(pivot=>pivot.rowGrandTotals===false));assert.ok(expected.some(pivot=>pivot.rowKinds==='sddtg'));assert.ok(expected.some(pivot=>pivot.rowKinds==='sSdtgb'));assert.ok(expected.some(pivot=>pivot.rowKinds==='dSdtgb'))
  for(let index=0;index<expected.length;index++)assert.deepEqual(actual[index],expected[index],`${customTheme?'custom':'default'} theme ${expected[index].path}`)
  const edit=sheetsSaveRequest('sheet-1',[{row:10,column:0,writeValue:true,value:'saved-pivot-styles'}]),savePlan=await gateway.planFromWorkbook(bytes,edit)
  const reopened=[]
  for(const runtime of [rust,node]){
   const saved=await runtime.sheetsNative.savePlan(bytes,savePlan)
   reopened.push(pivots(await runtime.sheetsNative.inspect(saved.bytes)))
  }
  assert.deepEqual(reopened[0],expected);assert.deepEqual(reopened[1],expected)
 }
})
