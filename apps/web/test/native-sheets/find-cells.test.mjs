import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import JSZip from 'jszip'
import {buildSheetsGateway} from '../../server/sheets/build.mjs'
import {configuredSheetsRuntime} from '../../server/src/modules/sheets/runtime.ts'
import {createCsrfService} from '../../server/src/modules/auth/csrf.ts'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {restrictedOrigin} from '../helpers/restricted.mjs'

for(const engine of ['node','rust'])test(`XLSX ${engine} find searches sparse cells beyond the renderer scan cap and pages without overlap`,async t=>{
 const dir=await mkdtemp(join(tmpdir(),'dyoffice-sheets-find-'))
 t.after(()=>rm(dir,{recursive:true,force:true}))
 await buildSheetsGateway(join(dir,'gateway.mjs'))
 const f=await fileFixture(t,{buildApp:false})
 const manifest=engine==='rust'?JSON.parse(await readFile(new URL('../../../../.dyoffice-native-build/host-manifest.json',import.meta.url))):null
 const runtime=await configuredSheetsRuntime({
  DYOFFICE_AUTH_MODE:'local',DYOFFICE_SANDBOX_MODE:'subprocess',DYOFFICE_DEPLOYMENT_ID:f.deploymentId,
  DYOFFICE_XLSX_GATEWAY_RUNNER:join(dir,'gateway-process.mjs'),
  ...(manifest?{DYOFFICE_NATIVE_BINARY:manifest.nativeBinary,DYOFFICE_NATIVE_SHA256:manifest.nativeSha256}:{DYOFFICE_XLSX_NODE_ENGINE:join(dir,'xlsx-node-engine.mjs')}),
 },{enabled:true})
 f.cleanup.push(()=>runtime.close())
 const {buildLocalApp}=await import('../../server/src/app.ts')
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin:restrictedOrigin,csrfKey:f.csrfKey,objectStore:f.objects,codingHarnesses:false,...runtime})
 f.cleanup.unshift(()=>app.close())
 const zip=await JSZip.loadAsync(await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url)))
 zip.file('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:AZ25003"/><sheetData><row r="25001"><c r="AZ25001" t="inlineStr"><is><t>Tail*Marker</t></is></c></row><row r="25002"><c r="AZ25002" t="str"><f>"Tail*Marker"</f><v>Tail*Marker</v></c></row><row r="25003"><c r="AZ25003" t="inlineStr"><is><t>TailXMarker</t></is></c></row></sheetData></worksheet>')
 const {file}=await importFile(f,f.alice.token,await zip.generateAsync({type:'nodebuffer'}),'find.xlsx')
 const inspected=(await runtime.sheetsNative.inspect(await f.files.readFile(f.alice.token,file.fileId,file.revision))).sheets[0]
 assert.equal(inspected.rowCount,25003,'the last stored row must be searchable')
 assert.equal(inspected.columnCount,52,'column AZ must be searchable')
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey})
 const request=(payload,token=f.alice.token)=>app.inject({method:'POST',url:`/api/v1/files/${file.fileId}/sheets/find`,headers:{cookie:'__Host-dyoffice-session='+token,origin:restrictedOrigin,'x-csrf-token':csrf.sessionToken(token)},payload:{revision:file.revision,sheetName:'Acceptance',query:'tail~*mark?r',matchCase:false,matchEntireCell:true,lookIn:'values',wildcards:true,limit:1,...payload}})
 const first=await request({})
 assert.equal(first.statusCode,200,first.body)
 assert.deepEqual(first.json().matches.map(({row,column,value})=>[row,column,value]),[[25000,51,'Tail*Marker']])
 assert.equal(first.json().complete,false)
 const {row,column}=first.json().nextCursor
 const second=await request({resumeAt:{row,column}})
 assert.equal(second.statusCode,200,second.body)
 assert.deepEqual(second.json().matches.map(({row,column,formulaText})=>[row,column,formulaText]),[[25001,51,'="Tail*Marker"']])
 assert.equal(second.json().complete,true)
 const formulas=await request({query:'Tail*Marker',wildcards:false,matchEntireCell:false,lookIn:'formulas_only'})
 assert.equal(formulas.statusCode,200,formulas.body)
 assert.deepEqual(formulas.json().matches.map(({row})=>row),[25001])
 assert.equal((await request({},f.bob.token)).statusCode,404)
 assert.equal((await request({resumeAt:{row:0,column:16384}})).statusCode,400)
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
})
