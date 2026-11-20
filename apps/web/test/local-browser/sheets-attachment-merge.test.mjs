import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {Readable} from 'node:stream'
import {createServer} from 'node:http'
import {expect} from '@playwright/test'
import JSZip from 'jszip'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {buildSheetsGateway} from '../../server/sheets/build.mjs'
import {configuredSheetsRuntime} from '../../server/src/modules/sheets/runtime.ts'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {stubHomeHero} from '../helpers/home-hero.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'

const liveConfig=process.env.DYOFFICE_LIVE_SHEETS_MERGE_CONFIG
const sheetsDirectory=process.env.DYOFFICE_TEST_SHEETS_DIST
for(const legacy of [true,false])test(legacy?'browser assistant merges BIFF XLS, truncated XLSX and truncated CSV and reopens every sheet':'real XLSX assistant merges original bytes of a truncated attachment and reopens all rows',{skip:legacy?!sheetsDirectory:!liveConfig,timeout:180000},async t=>{
 const server=createServer()
 t.after(async()=>{server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve))})
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
 const origin=`http://127.0.0.1:${server.address().port}`,f=await fileFixture(t,{origin,buildApp:false})
 await f.preferences.update(f.alice.token,{language:'zh',autoSave:false})
 const keyring={activeKeyId:'merge-test',keys:{'merge-test':new Uint8Array(32).fill(65)}}
 const entry=legacy
  ?{id:'fixture',kind:'chat',providerId:'openai',label:'Fixture',model:'synthetic',baseUrl:'https://provider.example/v1',apiKey:'fixture-key',enabled:true}
  :JSON.parse(await readFile(liveConfig,'utf8')).entry
 assert.ok(entry?.enabled&&entry?.apiKey&&entry?.kind==='chat','Enabled test model configuration required')
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[entry],defaults:{chat:entry.id}})
 const directory=await mkdtemp(join(tmpdir(),'dyoffice-sheets-browser-merge-'))
 f.cleanup.push(()=>rm(directory,{recursive:true,force:true}))
 await buildSheetsGateway(join(directory,'gateway.mjs'))
 const runtime=await configuredSheetsRuntime({
  DYOFFICE_AUTH_MODE:'local',DYOFFICE_SANDBOX_MODE:'subprocess',DYOFFICE_DEPLOYMENT_ID:f.deploymentId,
  DYOFFICE_XLSX_NODE_ENGINE:join(directory,'xlsx-node-engine.mjs'),DYOFFICE_XLSX_GATEWAY_RUNNER:join(directory,'gateway-process.mjs'),
  DYOFFICE_NATIVE_XLSX_DIRECTORY:process.env.DYOFFICE_TEST_SHEETS_DIST,
 },{enabled:true})
 f.cleanup.unshift(()=>runtime.close())
 const base=await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url))
 const source=await JSZip.loadAsync(base),marker='FINAL-ROW-40-COMPLETE-ORIGINAL-XLSX'
 const values=Array.from({length:40},(_,i)=>`row-${i+1}:`+'x'.repeat(29900)+(i===39?marker:''))
 source.file('xl/worksheets/sheet1.xml',`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:A40"/><sheetData>${values.map((value,i)=>`<row r="${i+1}"><c r="A${i+1}" t="inlineStr"><is><t>${value}</t></is></c></row>`).join('')}</sheetData></worksheet>`)
 const attachment=await source.generateAsync({type:'nodebuffer',compression:'DEFLATE'})
 const initial=(await importFile(f,f.alice.token,base,'target.xlsx')).file
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,codingHarnesses:false,localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url)),globalConfigKeyring:keyring,providerGateway:{mode:'shared'},...runtime})
 f.cleanup.unshift(()=>app.close())
 await app.ready()
 server.on('request',app.routing)
 const browser=await launchTestBrowser()
 f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:1000}})
 await stubHomeHero(page)
 await page.goto(origin)
 await page.getByLabel('用户名',{exact:true}).fill('alice')
 await page.getByLabel('密码',{exact:true}).fill(password)
 await page.getByRole('button',{name:'登录',exact:true}).click()
 await expect(page.locator('.home')).toBeVisible()
 await page.goto(origin+'/native-xlsx/?fileId='+initial.fileId)
 await expect(page.locator('#univer-container canvas').first()).toBeVisible({timeout:30000})
 const rail=page.locator('.expand-copilot')
 if(await rail.isVisible())await rail.click()
 const assistant=page.locator('.copilot:not(.collapsed)'),composer=assistant.locator('textarea')
 await expect(composer).toBeVisible({timeout:30000})
 if(legacy){
  const provider=mockProviderNetwork(t,()=>{
   const {tools,messages}=JSON.parse(provider.wire.toString())
   const tool=tools?.find(tool=>tool.function.name==='merge_attached_workbooks')
   if(tool)assert.match(tool.function.description,/\bxls\b/)
   const result=messages.findLast(message=>message.role==='tool')
   if(result)assert.match(JSON.parse(result.content).output,/Merged 3 sheets from 3 files/)
   const delta=!tool?{content:'office'}:result?{content:'All attachments were merged.'}:{tool_calls:[{index:0,id:'import_xls',type:'function',function:{name:'merge_attached_workbooks',arguments:'{}'}}]}
   return Readable.from([Buffer.from('data: '+JSON.stringify({choices:[{delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n')])
  })
 }
 const attach=async(name,mimeType,buffer)=>{
  await assistant.locator('.ai-plus-btn').click()
  const chooser=page.waitForEvent('filechooser')
  await assistant.getByRole('menuitem',{name:'添加文件',exact:true}).click()
  const parsed=page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/v1/ai/attachments/parse'&&url.searchParams.get('name')===name})
  await (await chooser).setFiles({name,mimeType,buffer})
  const result=await (await parsed).json()
  await expect(assistant.locator('.ai-attachments').getByText(name,{exact:true})).toBeVisible()
  return result
 }
 const result=await attach('large-source.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',attachment)
 assert.ok(result.ok&&result.truncated&&result.text.length===1_000_000&&!result.text.includes(marker))
 if(legacy){
  const original=await readFile(new URL('../../../../apps/sheets/native/xlsx-engine/tests/fixtures/cell-styles.xls',import.meta.url))
  const result=await attach('legacy.xls','application/vnd.ms-excel',original)
  assert.ok(result.ok&&!result.truncated&&result.text.includes('Chair'))
  const csvMarker='COMPLETE-CSV-FINAL-ROW'
  const csv=Buffer.from(values.map((value,i)=>i===39?csvMarker:value).join('\n'))
  const parsed=await attach('large-table.csv','text/csv',csv)
  assert.ok(parsed.ok&&parsed.truncated&&!parsed.text.includes(csvMarker))
 }
 const mergeOpened=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/sheets/merge-sources/open'))
 await composer.fill('请用 merge_attached_workbooks 将附件的全部工作表原样合并到当前工作簿，然后简短汇报。请勿改写数据、创建其他文件或保存。')
 await assistant.getByRole('button',{name:'发送',exact:true}).click()
 assert.equal((await mergeOpened).status(),200)
 const save=page.getByRole('button',{name:/^保存（(?:Ctrl\+S|⌘S)）$/})
 await expect(save).toBeEnabled({timeout:30000})
 await expect(assistant.locator('.ai-msg-streaming')).toHaveCount(0,{timeout:60000})
 await expect(assistant.locator('.ai-msg-error')).toHaveCount(0)
 if(legacy)await expect(assistant.getByText('All attachments were merged.',{exact:true})).toBeVisible()
 const head=async()=>(await f.files.openFile(f.alice.token,initial.fileId)).file.revision
 assert.equal(await head(),initial.revision)
 await save.click()
 await expect.poll(head,{timeout:30000}).not.toBe(initial.revision)
 const revision=await head()
 await expect(save).toBeDisabled({timeout:30000})
 const output=await f.files.readFile(f.alice.token,initial.fileId,revision)
 const before=await runtime.sheetsNative.inspect(base),after=await runtime.sheetsNative.inspect(output)
 const imported=after.sheets.filter(sheet=>!before.sheets.some(old=>old.name===sheet.name))
 assert.equal(imported.length,legacy?3:1)
 const reopened=await runtime.sheetsNative.readRange(output,imported[0].name,{startRow:0,endRow:39,startColumn:0,endColumn:0})
 const cells=[...reopened.cells].sort((a,b)=>a.row-b.row)
 assert.equal(cells.length,40)
 assert.ok(cells.every((cell,i)=>cell.value===values[i]),'all 40 saved cells must match the source')
 if(legacy){
  const reopened=await runtime.sheetsNative.readRange(output,imported[1].name,{startRow:2,endRow:2,startColumn:0,endColumn:2})
  assert.deepEqual(reopened.cells.map(cell=>cell.value),['Chair',6,200.5])
  assert.ok(reopened.cells.every(cell=>!cell.formula))
  const csv=await runtime.sheetsNative.readRange(output,imported[2].name,{startRow:39,endRow:39,startColumn:0,endColumn:0})
  assert.deepEqual(csv.cells.map(cell=>cell.value),['COMPLETE-CSV-FINAL-ROW'])
 }
 await page.reload()
 for(const sheet of imported)await expect(page.getByRole('tab',{name:sheet.name,exact:true})).toBeVisible({timeout:30000})
 assert.deepEqual(await f.files.readFile(f.alice.token,initial.fileId,initial.revision),base)
})
