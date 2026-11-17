import JSZip from 'jszip'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile,mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL,fileURLToPath} from 'node:url'
import {build} from 'esbuild'
import {sheetsSaveRequest} from '../helpers/sheets-request.mjs'
test('web gateway uses the desktop save mapping for cells, names, styles and sheet operations',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'dyoffice-plan-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const output=join(dir,'gateway.mjs')
 await build({entryPoints:[fileURLToPath(new URL('../../server/sheets/gateway.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',outfile:output,banner:{js:"import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"},logLevel:'silent'})
 const {planWorkbookSave,planFromWorkbook,readWorkbookPackage}=await import(pathToFileURL(output).href)
 const bytes=await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url))
 const metadata=await readWorkbookPackage(bytes)
 assert.deepEqual(metadata.redactions,{status:'absent'})
 assert.deepEqual(metadata.connections,{connections:[]})
 assert.deepEqual(metadata.slicers,[])
 const broken=await JSZip.loadAsync(bytes);broken.file('xl/gxRedactions.json','{broken')
 assert.equal((await readWorkbookPackage(await broken.generateAsync({type:'nodebuffer'}))).redactions.status,'unreadable')
 const request=sheetsSaveRequest('1',[{row:1,column:0,writeValue:true,value:23,style:{numberFormat:'0.000'}}])
 request.definedNamesState={names:[{name:'Revenue',formula:'Acceptance!$A$2:$A$4'}],preserveNames:[]}
 request.chartEdits=[{chartPath:'xl/charts/chart1.xml',title:'Updated revenue'}]
 const plan=await planWorkbookSave(bytes,[{id:'1',name:'Acceptance'}],request)
 assert.match(plan.replaced.get('xl/worksheets/sheet1.xml'),/<v>23<\/v>/)
 assert.match(plan.replaced.get('xl/workbook.xml'),/Acceptance!\$A\$2:\$A\$4/)
 assert.match(plan.replaced.get('xl/styles.xml'),/0\.000/)
 assert.match(plan.replaced.get('xl/charts/chart1.xml'),/Updated revenue/)
 const renamed=await planWorkbookSave(bytes,[{id:'1',name:'Acceptance'}],{...request,definedNamesState:null,sheetOps:[{kind:'rename-sheet',sheetId:'1',newName:'Renamed'}]})
 assert.match(renamed.replaced.get('xl/workbook.xml'),/name="Renamed"/)
 assert.equal(plan.replaced.has('customXml/t09-preserve.xml'),false)
 await assert.rejects(()=>planWorkbookSave(bytes,[{id:'other',name:'Acceptance'}],request),{statusCode:400})
 await assert.rejects(()=>planWorkbookSave(bytes,[{id:'1',name:'Acceptance'}],{...request,targetPath:'/tmp/escape.xlsx'}))
 const nativeRequest=sheetsSaveRequest('sheet-1',[{row:1,column:0,writeValue:true,value:23}])
 assert.match((await planFromWorkbook(bytes,nativeRequest)).replaced.get('xl/worksheets/sheet1.xml'),/<v>23<\/v>/)
 // Byte-derived identity must agree with the same existing parsers used by
 // native opens and mutation planning, including entity/prefix normalization.
 const workbook=await (await JSZip.loadAsync(bytes)).file('xl/workbook.xml').async('string')
 for(const xml of [workbook.replace('name="Acceptance"','name="A &amp; B &gt; C"'),workbook.replace('name="Acceptance"','name="&#x4e2d;&#25991;"')]){
   const zip=await JSZip.loadAsync(bytes);zip.file('xl/workbook.xml',xml)
   assert.match((await planFromWorkbook(await zip.generateAsync({type:'nodebuffer'}),nativeRequest)).replaced.get('xl/worksheets/sheet1.xml'),/<v>23<\/v>/)
 }
 for(const patch of [
   xml=>xml.replace('</sheets>','<sheet name="Duplicate" sheetId="1" r:id="rId1"/></sheets>'),
   xml=>xml.replace('sheetId="1"',''),
   xml=>xml.replace('r:id="rId1"','r:id="missing"'),
   xml=>xml.replace('sheetId="1"',"sheetId='1'"),
   xml=>xml.replace('<sheet name=', '<sheet custom=\' name="Forged" sheetId="2"\' name='),
   xml=>xml.replace('<sheets>','<sheets><!--<sheet name="Forged" sheetId="2" r:id="rId1"/>-->'),
 ]){
   const zip=await JSZip.loadAsync(bytes);zip.file('xl/workbook.xml',patch(workbook))
   await assert.rejects(async()=>planFromWorkbook(await zip.generateAsync({type:'nodebuffer'}),nativeRequest),{statusCode:400})
 }
 await assert.rejects(()=>planFromWorkbook(bytes,sheetsSaveRequest('forged-id',[{row:1,column:0,writeValue:true,value:1}])),{statusCode:400})
 await assert.rejects(()=>planFromWorkbook(bytes,{...nativeRequest,targetPath:'/tmp/escape.xlsx'}),{statusCode:400})
})
