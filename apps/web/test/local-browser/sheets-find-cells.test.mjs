import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {test} from 'node:test'
import {createServer} from 'node:http'
import {Readable} from 'node:stream'
import {expect} from '@playwright/test'
import JSZip from 'jszip'
import {buildLocalApp} from '../../server/src/app.ts'
import {buildSheetsGateway} from '../../server/sheets/build.mjs'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {configuredSheetsRuntime} from '../../server/src/modules/sheets/runtime.ts'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {stubHomeHero} from '../helpers/home-hero.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {workbookRangeResultSchema} from '../../../sheets/src/shared/desktop-api.ts'

const liveConfig=process.env.DYOFFICE_LIVE_SHEETS_FIND_CONFIG
const sheetsDirectory=process.env.DYOFFICE_TEST_SHEETS_DIST
const nativeAudit=process.env.DYOFFICE_TEST_XLSX_AUDIT_RUST==='1'
for(const live of [false,true])test((live?'Live model':'Fixture model')+' finds XLSX cells beyond the loaded grid',{
 skip:live?!liveConfig:!sheetsDirectory,timeout:180000,
},async t=>{
 const server=createServer()
 t.after(async()=>{server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve))})
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
 const origin='http://127.0.0.1:'+server.address().port
 const f=await fileFixture(t,{origin,buildApp:false})
 await f.preferences.update(f.alice.token,{language:'zh',autoSave:false})
 const keyring={activeKeyId:'find-test',keys:{'find-test':new Uint8Array(32).fill(66)}}
 const entry=live?JSON.parse(await readFile(liveConfig,'utf8')).entry:
  {id:'fixture',kind:'chat',providerId:'openai',label:'Fixture',model:'synthetic',baseUrl:'https://provider.example/v1',apiKey:'fixture-key',enabled:true}
 assert.ok(entry?.enabled&&entry?.apiKey&&entry?.kind==='chat','Enabled test model configuration required')
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[entry],defaults:{chat:entry.id}})
 const dir=await mkdtemp(join(tmpdir(),'dyoffice-browser-sheets-find-'))
 f.cleanup.push(()=>rm(dir,{recursive:true,force:true}))
 await buildSheetsGateway(join(dir,'gateway.mjs'))
 const hostManifest=nativeAudit?JSON.parse(await readFile(new URL('../../../../.dyoffice-native-build/host-manifest.json',import.meta.url),'utf8')):null
 const runtime=await configuredSheetsRuntime({
  DYOFFICE_AUTH_MODE:'local',DYOFFICE_SANDBOX_MODE:'subprocess',DYOFFICE_DEPLOYMENT_ID:f.deploymentId,
  DYOFFICE_XLSX_GATEWAY_RUNNER:join(dir,'gateway-process.mjs'),
  ...(hostManifest?{DYOFFICE_NATIVE_BINARY:hostManifest.nativeBinary,DYOFFICE_NATIVE_SHA256:hostManifest.nativeSha256}:{DYOFFICE_XLSX_NODE_ENGINE:join(dir,'xlsx-node-engine.mjs')}),
  DYOFFICE_NATIVE_XLSX_DIRECTORY:sheetsDirectory,
 },{enabled:true})
 f.cleanup.unshift(()=>runtime.close())
 const marker='FIND-'+randomUUID()
 const zip=await JSZip.loadAsync(await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url)))
 zip.file('xl/worksheets/sheet1.xml',`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:AZ25001"/><sheetData><row r="25001"><c r="AZ25001" t="inlineStr"><is><t>${marker}</t></is></c></row></sheetData></worksheet>`)
 // Keep the range-paged formula checks off-screen without scanning the distant native-find marker twice.
 const append=async(path,tag,value)=>zip.file(path,(await zip.file(path).async('string')).replace(tag,value+tag))
 await append('xl/workbook.xml','</sheets>','<sheet name="Audit" sheetId="2" r:id="rIdAudit"/>')
 await append('xl/_rels/workbook.xml.rels','</Relationships>','<Relationship Id="rIdAudit" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>')
 await append('[Content_Types].xml','</Types>','<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>')
 zip.file('xl/worksheets/sheet2.xml',`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:AB1002"/>
  <sheetData>
   <row r="1"><c r="A1"><v>7</v></c><c r="B1" s="2"><v>0.25</v></c><c r="C1"><f>A1+A2</f><v>18</v></c></row>
   <row r="2"><c r="A2"><v>11</v></c></row>
   <row r="1001"><c r="AA1001" t="inlineStr"><is><t>REPORT-12345</t></is></c></row>
   <row r="1002"><c r="AB1002" t="e"><f>1/0</f><v>#DIV/0!</v></c></row>
  </sheetData>
  <sheetProtection sheet="1"/>
  <autoFilter ref="A1:C2">
   <filterColumn colId="0"><filters><filter val="11"/></filters></filterColumn>
   <filterColumn colId="1"><customFilters and="1"><customFilter operator="greaterThan" val="0"/><customFilter val="0.25"/></customFilters></filterColumn>
  </autoFilter>
  <customSheetViews><customSheetView guid="{11111111-1111-1111-1111-111111111111}"><autoFilter ref="A1:A2"/></customSheetView></customSheetViews>
 </worksheet>`)
 const original=await zip.generateAsync({type:'nodebuffer'})
 const auditSheet=(await runtime.sheetsNative.inspect(original)).sheets.find(sheet=>sheet.name==='Audit')
 assert.ok(auditSheet)
 const sheetId=auditSheet.id
 const filterArea={startRow:0,endRow:1,startColumn:0,endColumn:2}
 const filtered=await runtime.sheetsNative.readRange(original,'Audit',filterArea)
 assert.deepEqual(filtered.autoFilter,filterArea)
 assert.deepEqual(filtered.autoFilterColumns,[
  {colId:0,values:['11']},
  {colId:1,customs:{and:true,filters:[{operator:'greaterThan',val:'0'},{val:'0.25'}]}},
 ])
 const auditCalls=[
  ['read_cells',{sheetId,addresses:['A1','C1']},[/A1: 7/,/=A1\+A2/]],
  ['aggregate_range',{sheetId,range:'A1:A2'},[/numeric cells: 2, sum: 18/]],
  ['read_formats',{sheetId,range:'B1'},[/B1:.*number format.*%/]],
  ['trace_precedents',{sheetId,address:'C1'},[/C1 = 18/,/A1=7/,/A2=11/]],
  ['trace_dependents',{sheetId,address:'A1'},[/Audit!C1 = 18/]],
  ['load_guide',{guides:['writing']},[/set_range/]],
  ['select_range',{sheetId,range:'A1:C2'},[/Selected Audit!A1:C2/]],
  ['read_sheet_features',{sheetId},[/Status: visible, protected/,/AutoFilter[^\n]*A1:C2/i]],
 ]
 const {file}=await importFile(f,f.alice.token,original,'search.xlsx')
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,codingHarnesses:false,localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url)),globalConfigKeyring:keyring,providerGateway:{mode:'shared'},...runtime})
 f.cleanup.unshift(()=>app.close())
 await app.ready()
 server.on('request',app.routing)
 const browser=await launchTestBrowser()
 f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],toolReceipts=[],auditReads=[]
 page.on('response',async response=>{
  if(!response.url().endsWith('/sheets/range'))return
  const {sheetName,range}=response.request().postDataJSON()
  if(sheetName!=='Audit'||range.startRow!==0)return
  const diagnostic={range,status:response.status()}
  auditReads.push(diagnostic)
  try{
   const body=await response.json(),parsed=workbookRangeResultSchema.safeParse(body)
   diagnostic.loaded=[body.indexingComplete,body.indexedThroughRow]
   diagnostic.schema=parsed.success?[]:parsed.error.issues.map(issue=>[issue.path,issue.code])
  }catch{diagnostic.loaded=null}
 })
 page.on('pageerror',error=>errors.push(error.message))
 page.on('request',request=>{
  if(request.method()!=='POST'||!request.url().endsWith('/api/v1/ai/turns'))return
  const messages=request.postDataJSON()?.request?.messages??[]
  toolReceipts.push(...messages.flatMap(message=>(message.results??[]).filter(result=>result.name==='find_cells'&&!result.isError).map(result=>result.output)))
 })
 await stubHomeHero(page)
 await page.goto(origin)
 await page.getByLabel('用户名',{exact:true}).fill('alice')
 await page.getByLabel('密码',{exact:true}).fill(password)
 await page.getByRole('button',{name:'登录',exact:true}).click()
 await expect(page.locator('.home')).toBeVisible()
 await page.goto(origin+'/native-xlsx/?fileId='+file.fileId)
 await expect(page.locator('#univer-container canvas').first()).toBeVisible({timeout:30000})
 const rail=page.locator('.expand-copilot')
 if(await rail.isVisible())await rail.click()
 const assistant=page.locator('.copilot:not(.collapsed)')
 if(!live){
  const network=mockProviderNetwork(t,()=>{try{
   const {tools,messages}=JSON.parse(network.wire.toString())
   const user=messages.findLastIndex(message=>message.role==='user')
   const results=messages.slice(user+1).filter(message=>message.role==='tool')
   if(messages[user].content.includes('审计工作表工具')){
    const action=auditCalls[results.length]
    if(results.length){
     const {isError,output}=JSON.parse(results.at(-1).content)
     const [name,,patterns]=auditCalls[results.length-1]
     assert.ok(!isError,name+': '+output)
     for(const pattern of patterns)assert.match(output,pattern,name+': '+output)
    }
    const delta=action?{tool_calls:[{index:0,id:'audit-'+action[0],type:'function',function:{name:action[0],arguments:JSON.stringify(action[1])}}]}:{content:'已核对审计工作表'}
    return Readable.from([Buffer.from('data: '+JSON.stringify({choices:[{delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n')])
   }
   const regexTurn=messages[user].content.includes('regex:true')
   let delta
   if(results.length===(regexTurn?2:1)){
    const addresses=regexTurn?['AA1001','AB1002']:['AZ25001']
    for(const [index,address] of addresses.entries()){
     const result=JSON.parse(results[index].content)
     assert.ok(!result.isError,result.output)
     assert.match(result.output,new RegExp((regexTurn?'Audit':'Acceptance')+'!'+address))
    }
    delta={content:addresses.join('、')}
   }else{
    assert.ok(tools.some(tool=>tool.function.name==='find_cells'))
    const input=regexTurn?{sheetId:auditSheet.id,...(results.length?{errors_only:true}:{query:'^REPORT-[0-9]{5}$',regex:true})}:{query:marker}
    delta={tool_calls:[{index:0,id:'find-'+(regexTurn?'audit-'+results.length:'marker'),type:'function',function:{name:'find_cells',arguments:JSON.stringify(input)}}]}
   }
   return Readable.from([Buffer.from('data: '+JSON.stringify({choices:[{delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n')])
  }catch(error){t.diagnostic(error.stack);throw error}})
 }
 const response=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/v1/files/${file.fileId}/sheets/find`,{timeout:60000})
 await assistant.locator('textarea').fill(`请调用 find_cells 搜索单元格中的文字 ${marker}，只返回找到的工作表名称和单元格地址，不修改工作簿。`)
 await assistant.getByRole('button',{name:'发送',exact:true}).click()
 const result=await response
 assert.equal(result.status(),200)
 assert.equal(result.request().postDataJSON().revision,file.revision)
 assert.deepEqual((await result.json()).matches.map(({row,column,value})=>[row,column,value]),[[25000,51,marker]])
 await expect.poll(()=>toolReceipts.some(output=>String(output).includes('AZ25001')),{timeout:30000}).toBe(true)
 await expect(assistant.locator('.ai-msg-streaming')).toHaveCount(0,{timeout:30000})
 await expect(assistant.locator('.ai-msg-error')).toHaveCount(0)
 const range=page.waitForResponse(async response=>{
  if(!response.ok()||!response.url().endsWith('/sheets/range'))return false
  const {sheetName,range}=response.request().postDataJSON()
  return sheetName==='Audit'&&range.endRow>=1001&&range.startRow<=1000&&range.endColumn>=27
 },{timeout:60000})
 await assistant.locator('textarea').fill(`请用 find_cells 在 Audit 工作表（sheetId: ${auditSheet.id}）执行两次搜索：第一次设置 regex:true，查询 ^REPORT-[0-9]{5}$；第二次单独设置 errors_only:true 查公式错误。报告两类结果的单元格地址，不修改工作簿。`)
 await assistant.getByRole('button',{name:'发送',exact:true}).click()
 const rangeCells=(await (await range).json()).cells
 assert.ok(rangeCells.some(cell=>cell.row===1000&&cell.column===26&&cell.value==='REPORT-12345'))
 assert.ok(rangeCells.some(cell=>cell.row===1001&&cell.column===27&&cell.value==='#DIV/0!'))
 await expect.poll(()=>['AA1001','AB1002'].every(address=>toolReceipts.some(output=>String(output).includes(address))),{timeout:60000}).toBe(true)
 await expect(assistant.locator('.ai-msg-error')).toHaveCount(0)
 if(!live){
  await expect(assistant.getByText('AA1001、AB1002',{exact:true})).toBeVisible()
  await assistant.locator('textarea').fill('审计工作表工具')
  await assistant.getByRole('button',{name:'发送',exact:true}).click()
  const success=assistant.getByText('已核对审计工作表',{exact:true})
  await expect(success.or(assistant.locator('.ai-msg-error'))).toBeVisible({timeout:60000})
  assert.equal(await success.isVisible(),true,'Audit range responses: '+JSON.stringify(auditReads))
  await expect(page.getByRole('tab',{name:'Audit',exact:true})).toHaveAttribute('aria-selected','true')
 }
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
 assert.deepEqual(errors,[])
})
