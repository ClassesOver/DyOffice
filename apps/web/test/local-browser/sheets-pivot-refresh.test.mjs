import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {expect} from '@playwright/test'
import JSZip from 'jszip'
import {buildLocalApp} from '../../server/src/app.ts'
import {buildSheetsGateway} from '../../server/sheets/build.mjs'
import {configuredSheetsRuntime} from '../../server/src/modules/sheets/runtime.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {stubHomeHero} from '../helpers/home-hero.mjs'
import {sheetsSaveRequest} from '../helpers/sheets-request.mjs'

const liveConfig=process.env.DYOFFICE_LIVE_SHEETS_PIVOT_CONFIG
test('existing XLSX pivot refresh saves one version and reopens with the recomputed totals'+(liveConfig?' with a real model':' from the ribbon'),{timeout:180000},async t=>{
 const origin='http://127.0.0.1:4253'
 const f=await fileFixture(t,{origin,buildApp:false})
 await f.preferences.update(f.alice.token,{language:'zh',autoSave:false})
 const keyring={activeKeyId:'pivot-test',keys:{'pivot-test':new Uint8Array(32).fill(64)}}
 if(liveConfig){
  const entry=JSON.parse(await readFile(liveConfig,'utf8')).entry
  assert.ok(entry?.enabled&&entry?.apiKey&&entry?.kind==='chat','Enabled test model configuration required')
  await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[entry],defaults:{chat:entry.id}})
 }
 const manifest=JSON.parse(await readFile(new URL('../../../../.dyoffice-native-build/host-manifest.json',import.meta.url)))
 const directory=await mkdtemp(join(tmpdir(),'dyoffice-browser-pivot-'))
 f.cleanup.push(()=>rm(directory,{recursive:true,force:true}))
 await buildSheetsGateway(join(directory,'gateway.mjs'))
 const runtime=await configuredSheetsRuntime({DYOFFICE_AUTH_MODE:'local',DYOFFICE_SANDBOX_MODE:'subprocess',DYOFFICE_DEPLOYMENT_ID:f.deploymentId,DYOFFICE_NATIVE_BINARY:manifest.nativeBinary,DYOFFICE_NATIVE_SHA256:manifest.nativeSha256,DYOFFICE_XLSX_GATEWAY_RUNNER:join(directory,'gateway-process.mjs'),DYOFFICE_NATIVE_XLSX_DIRECTORY:process.env.DYOFFICE_TEST_SHEETS_DIST},{enabled:true})
 f.cleanup.push(()=>runtime.close())
 const zip=await JSZip.loadAsync(await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url)))
 const rows=[['Region','Amount'],['East',100],['West',50],['East',50]]
 zip.file('xl/worksheets/sheet1.xml',`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:G4"/><sheetData>${rows.map((row,i)=>`<row r="${i+1}">${row.map((value,j)=>`<c r="${'AB'[j]}${i+1}"${typeof value==='number'?`><v>${value}</v>`:` t="inlineStr"><is><t>${value}</t></is>`}</c>`).join('')}</row>`).join('')}</sheetData></worksheet>`)
 const base=await zip.generateAsync({type:'nodebuffer'}),request=sheetsSaveRequest('sheet-1',[])
 request.pivotAdditions=[{sheetId:'sheet-1',sourceSheetId:'sheet-1',sourceArea:{startRow:0,startColumn:0,endRow:3,endColumn:1},location:{startRow:0,startColumn:5,endRow:3,endColumn:6},name:'Sales',fieldNames:['Region','Amount'],rowFieldIndices:[0],rowItems:['East','West'],values:[{fieldIndex:1,agg:'sum'}]}]
 const original=(await runtime.sheetsNative.savePlan(base,await runtime.sheetsWorkbookPlanner(base,request))).bytes
 const initial=(await importFile(f,f.alice.token,original,'pivot.xlsx')).file
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,codingHarnesses:false,localShellDirectory:fileURLToPath(new URL('../../dist-local-shell',import.meta.url)),...(liveConfig?{globalConfigKeyring:keyring,providerGateway:{mode:'shared'}}:{}),...runtime})
 f.cleanup.unshift(()=>app.close())
 await app.listen({port:4253,host:'127.0.0.1'})
 const browser=await launchTestBrowser()
 f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[]
 await page.addInitScript(()=>{window.__genofficeDebugHooks=true})
 page.on('pageerror',error=>{errors.push(error.message);t.diagnostic(error.message)})
 await stubHomeHero(page)
 await page.goto(origin)
 await page.getByLabel('用户名',{exact:true}).fill('alice')
 await page.getByLabel('密码',{exact:true}).fill(password)
 await page.getByRole('button',{name:'登录',exact:true}).click()
 await expect(page.locator('.home')).toBeVisible()
 const api='/api/v1/files/'+initial.fileId
 const pathOf=response=>new URL(response.url()).pathname
 const pivotRead=page.waitForResponse(response=>pathOf(response)===api+'/sheets/pivot-definition')
 await page.goto(origin+'/native-xlsx/?fileId='+initial.fileId)
 await expect(page.locator('#univer-container canvas').first()).toBeVisible({timeout:30000})
 const definition=await pivotRead
 assert.equal(definition.status(),200,JSON.stringify({request:definition.request().postDataJSON(),response:await definition.text()}))
 const {cachePath}=definition.request().postDataJSON()
 assert.equal((await definition.json()).sourceRef,'A1:B4')

 const status=page.getByRole('navigation',{name:'工作簿'}).getByRole('status')
 await expect.poll(()=>page.evaluate(()=>window.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange('B2').getValue()),{timeout:30000}).toBe(100)
 if(liveConfig){
  const rail=page.locator('.expand-copilot')
  if(await rail.isVisible())await rail.click()
  const assistant=page.locator('.copilot:not(.collapsed)')
  const composer=assistant.locator('textarea')
  await expect(composer).toBeVisible({timeout:30000})
  await page.evaluate(()=>{
   const fetch=window.fetch.bind(window)
   const turns=window.pivotTestTurns=[]
   window.fetch=async(input,init)=>{
    const response=await fetch(input,init)
    if(String(input).endsWith('/api/v1/ai/turns')&&init?.method==='POST'){
     turns.push(response.clone().text().then(stream=>({
      ok:response.ok&&!stream.includes('event: error'),
      operations:[...stream.matchAll(/^event: tool_call\ndata: (.+)$/gm)].map(match=>JSON.parse(match[1]))
       .filter(call=>call.name==='propose_operations').flatMap(call=>call.input.operations??[]).map(op=>op.op),
     })))
    }
    return response
   }
  })
  await composer.fill('请刷新 Acceptance 工作表已有的 Sales 数据透视表。加载透视表操作指南，然后通过 propose_operations 执行一次 refresh_pivot。不要创建新表、改源数据或保存文件。')
  await assistant.getByRole('button',{name:'发送',exact:true}).click()
  await expect.poll(async()=>{
   const turns=await page.evaluate(()=>Promise.all(window.pivotTestTurns))
   if(turns.some(turn=>!turn.ok))throw Error('Real model stream failed')
   return turns.flatMap(turn=>turn.operations)
  },{timeout:90000}).toEqual(['refresh_pivot'])
  await expect(assistant.locator('.ai-msg-streaming')).toHaveCount(0,{timeout:30000})
  await expect(assistant.locator('.ai-msg-error')).toHaveCount(0)
 }else{
  await page.getByRole('button',{name:'数据',exact:true}).click()
  await page.getByRole('button',{name:'全部刷新',exact:true}).click()
  await expect(status).toContainText('刷新了 1 个数据透视表')
 }
 const save=page.getByRole('button',{name:/^保存（(?:Ctrl\+S|⌘S)）$/})
 await expect(save).toBeEnabled({timeout:10000})
 assert.equal((await f.files.openFile(f.alice.token,initial.fileId)).file.revision,initial.revision)
 const stages=[],commits=[]
 page.on('request',request=>{
  const path=pathOf(request)
  if(request.method()==='POST'&&path===api+'/sheets/uploads')stages.push(request)
  if(request.method()==='POST'&&path===api+'/commits')commits.push(request)
 })
 await save.click()
 const head=async()=>(await f.files.openFile(f.alice.token,initial.fileId)).file.revision
 await expect.poll(head,{timeout:30000}).not.toBe(initial.revision)
 const revision=await head()
 await expect(save).toBeDisabled({timeout:30000})
 const saved=await JSZip.loadAsync(await f.files.readFile(f.alice.token,initial.fileId,revision))
 assert.match(await saved.file(cachePath).async('string'),/refreshOnLoad="1"/)
 assert.deepEqual(await f.files.readFile(f.alice.token,initial.fileId,initial.revision),Buffer.from(original))

 const reopened=page.waitForResponse(response=>{
  if(pathOf(response)!==api+'/sheets/range'||!response.ok())return false
  const body=response.request().postDataJSON(),range=body.range
  return body.revision===revision&&range.startRow<=1&&range.endRow>=3&&range.startColumn<=6&&range.endColumn>=6
 })
 await page.reload()
 await expect(page.locator('#univer-container canvas').first()).toBeVisible({timeout:30000})
 const values=(await (await reopened).json()).cells.filter(cell=>cell.column===6&&cell.row>=1&&cell.row<=3).sort((a,b)=>a.row-b.row)
 assert.deepEqual(values.map(cell=>cell.value),[150,50,200])
 assert.equal(stages.length,1)
 assert.equal(commits.length,1)
 const history=await page.evaluate(async url=>{
  const response=await fetch(url)
  if(!response.ok)throw new Error('Cannot read revision history: '+response.status)
  return (await response.json()).revisions.map(({revision,parentRevision})=>({revision,parentRevision}))
 },api+'/revisions')
 assert.deepEqual(history,[{revision,parentRevision:initial.revision},{revision:initial.revision,parentRevision:null}])
 assert.equal(await head(),revision)
 assert.deepEqual(errors,[])
})
