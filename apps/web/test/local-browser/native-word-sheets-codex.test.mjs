import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {expect} from '@playwright/test'
import JSZip from 'jszip'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {buildSheetsGateway} from '../../server/sheets/build.mjs'
import {configuredSheetsRuntime} from '../../server/src/modules/sheets/runtime.ts'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {docxBytes,fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'

const configPath=process.env.DYOFFICE_LIVE_WORD_SHEETS_HARNESS_CONFIG
for(const format of ['docx','xlsx']){
 const word=format==='docx',directory=word?process.env.DYOFFICE_TEST_NATIVE_DOCS_DIST:process.env.DYOFFICE_TEST_SHEETS_DIST
 test(`${format} writes and reopens an edit based on the real model and built-in Codex`,{skip:!configPath||!directory,timeout:360000},async t=>{
  const port=word?43718:43719,origin=`http://localhost:${port}`,f=await fileFixture(t,{origin,buildApp:false})
  await f.preferences.update(f.alice.token,{language:'zh',showAssistant:true,autoSave:false})
  const original=word?await docxBytes():await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url))
  const {file}=await importFile(f,f.alice.token,original,'calculator.'+format)
  const keyring={activeKeyId:'office-codex',keys:{'office-codex':new Uint8Array(32).fill(57)}}
  const {entry}=JSON.parse(await readFile(configPath,'utf8'))
  assert.ok(entry?.enabled&&entry?.kind==='chat'&&entry?.apiKey,'An enabled test model is required')
  await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[entry],defaults:{chat:entry.id}})
  let native={nativeDocsDirectory:directory}
  if(!word){
   const engine=await mkdtemp(join(tmpdir(),'office-codex-xlsx-'))
   f.cleanup.push(()=>rm(engine,{recursive:true,force:true}))
   await buildSheetsGateway(join(engine,'gateway.mjs'))
   native=await configuredSheetsRuntime({DYOFFICE_AUTH_MODE:'local',DYOFFICE_SANDBOX_MODE:'subprocess',DYOFFICE_DEPLOYMENT_ID:f.deploymentId,DYOFFICE_NATIVE_XLSX_DIRECTORY:directory,DYOFFICE_XLSX_NODE_ENGINE:join(engine,'xlsx-node-engine.mjs'),DYOFFICE_XLSX_GATEWAY_RUNNER:join(engine,'gateway-process.mjs')},{enabled:true})
   f.cleanup.unshift(()=>native.close())
  }
  const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:{},localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY,...native})
  f.cleanup.unshift(()=>app.close())
  await app.listen({port,host:'127.0.0.1'})
  const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
  const page=await browser.newPage({viewport:{width:1440,height:1000}})
  if(!word)await page.addInitScript(()=>{window.__genofficeDebugHooks=true})
  const {csrfToken}=await (await page.request.get(origin+'/api/v1/auth/csrf')).json()
  assert.equal((await page.request.post(origin+'/api/v1/auth/login',{headers:{origin,'x-csrf-token':csrfToken},data:{username:'alice',password}})).status(),200)
  const turns=[],tasks=[]
  page.on('response',response=>{
   const request=response.request(),path=new URL(request.url()).pathname
   if(request.method()!=='POST')return
   if(path==='/api/v1/ai/turns')turns.push(request.postDataJSON().request)
   if(path==='/api/v1/agents/tasks'){
    const submission=request.postDataJSON()
    const taskText=submission.request?.messages?.[0]?.text
    tasks.push({status:response.status(),id:submission.turnId,requestedData:typeof taskText==='string'&&taskText.includes('"dataInputs":')})
   }
  })
  const editor=page.locator('.tiptap.doc-page'),panel=page.locator(word?'.ai-panel':'.copilot:not(.collapsed)'),rail=page.locator(word?'.ai-rail':'.expand-copilot'),composer=panel.locator('textarea')
  const ready=()=>expect(page.locator('html')).toHaveAttribute('data-document-loading','ready',{timeout:30000})
  const head=async()=>(await f.files.openFile(f.alice.token,file.fileId)).file.revision
  const marker='CODEX-WRITE-VERIFIED',editTool=word?'insert_content':'propose_operations'
  const cellValue=()=>page.evaluate(()=>window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange('H2').getValue())
  await page.goto(origin+'/native-'+format+'/?fileId='+file.fileId)
  await ready()
  await expect(composer.or(rail)).toBeVisible({timeout:30000})
  if(await rail.isVisible())await rail.click()
  await composer.fill(`用 delegate_agent_task 委派给默认执行器一次：让它实际运行代码算 143 + 298，并且在任务工作区写 total.json，格式为 {"total": 数值}。不要直接心算。收到结果后，${word?'用 insert_content 在当前 Word 文末插入一段，正文为 Verified total: 加上文件给出的数字。':'先用 get_workbook_context 确认工作表 ID，再用 propose_operations 把文件给出的数字写入当前工作表 H2 单元格，不改其他单元格。'} 写入成功后单独回复一行 ${marker}，我会手动保存。`)
  await panel.getByRole('button',{name:'发送',exact:true}).click()
  try{
   await expect(panel.getByText(marker,{exact:true})).toBeVisible({timeout:240000})
  }catch(error){
   const reply=await panel.locator(word?'.ai-msg-assistant,.ai-msg-error':'.ai-chat').allTextContents().catch(()=>[])
   const results=turns.at(-1)?.messages.flatMap(message=>message.results??[])??[]
   t.diagnostic(JSON.stringify({reply:reply.join('\n').slice(-1200),tasks,tools:results.map(({name,isError})=>({name,isError}))}))
   throw error
  }
  assert.deepEqual(tasks.map(task=>task.status),[200])
  await expect(panel.locator('.assistant-task-message:visible')).toHaveAttribute('data-team-task','harness:'+tasks[0].id)
  const results=turns.at(-1).messages.flatMap(message=>message.results??[])
  const delivery=JSON.parse(results.find(result=>result.name==='delegate_agent_task'&&!result.isError).output)
  assert.equal(delivery.agent.id,'codex')
  assert.match(delivery.output,/^total\.json\n/)
  assert.equal(JSON.parse(delivery.output.slice('total.json\n'.length)).total,441)
  assert.ok(results.some(result=>result.name===editTool&&!result.isError),editTool)
  if(word)await expect(editor.getByText('Verified total: 441',{exact:true})).toHaveCount(1)
  else await expect.poll(cellValue).toBe(441)
  assert.equal(await head(),file.revision)
  if(word)await page.keyboard.press('Control+s')
  else await page.getByRole('button',{name:/^保存（(?:Ctrl\+S|⌘S)）$/}).click()
  await expect.poll(head,{timeout:30000}).not.toBe(file.revision)
  const bytes=await f.files.readFile(f.alice.token,file.fileId,await head())
  if(word)assert.match(await (await JSZip.loadAsync(bytes)).file('word/document.xml').async('string'),/Verified total: 441/)
  else {
   const {sheets}=await native.sheetsNative.inspect(bytes)
   const range=await native.sheetsNative.readRange(bytes,sheets[0].name,{startRow:1,endRow:1,startColumn:7,endColumn:7})
   assert.deepEqual(range.cells.map(cell=>cell.value),[441])
  }
  assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
  await page.reload()
  await ready()
  if(word)await expect(editor.getByText('Verified total: 441',{exact:true})).toHaveCount(1)
  else await expect.poll(cellValue).toBe(441)
  assert.equal(tasks.length,1)
 })
}
