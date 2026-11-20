import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {Readable} from 'node:stream'
import {createServer} from 'node:http'
import {expect} from '@playwright/test'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {buildSheetsGateway} from '../../server/sheets/build.mjs'
import {configuredSheetsRuntime} from '../../server/src/modules/sheets/runtime.ts'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {stubHomeHero} from '../helpers/home-hero.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'

const sheetsDirectory=process.env.DYOFFICE_TEST_SHEETS_DIST
for(const manualEdit of [false,true])test(manualEdit
 ?'a manual XLSX edit wins when the resumed assistant returns a conflicting tool call'
 :'refresh skips stale XLSX continuations and applies the recoverable edit once',{skip:!sheetsDirectory,timeout:120000},async t=>{
 const server=createServer()
 t.after(async()=>{server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve))})
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
 const origin=`http://127.0.0.1:${server.address().port}`,f=await fileFixture(t,{origin,buildApp:false})
 await f.preferences.update(f.alice.token,{language:'zh',autoSave:false})
 const keyring={activeKeyId:'sheets-recovery',keys:{'sheets-recovery':new Uint8Array(32).fill(42)}}
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[{id:'fixture',kind:'chat',providerId:'openai',label:'Fixture',model:'synthetic',baseUrl:'https://provider.example/v1',apiKey:'fixture-key',enabled:true}],defaults:{chat:'fixture'}})
 const directory=await mkdtemp(join(tmpdir(),'dyoffice-sheets-recovery-'))
 f.cleanup.push(()=>rm(directory,{recursive:true,force:true}))
 await buildSheetsGateway(join(directory,'gateway.mjs'))
 const runtime=await configuredSheetsRuntime({
  DYOFFICE_AUTH_MODE:'local',DYOFFICE_SANDBOX_MODE:'subprocess',DYOFFICE_DEPLOYMENT_ID:f.deploymentId,
  DYOFFICE_XLSX_NODE_ENGINE:join(directory,'xlsx-node-engine.mjs'),DYOFFICE_XLSX_GATEWAY_RUNNER:join(directory,'gateway-process.mjs'),
  DYOFFICE_NATIVE_XLSX_DIRECTORY:sheetsDirectory,
 },{enabled:true})
 f.cleanup.push(()=>runtime.close())
 const original=await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url))
 const {file}=await importFile(f,f.alice.token,original,'recover-task.xlsx')
 const book=await runtime.sheetsNative.inspect(original)
 let runs=0,release,allowInspect,allowTool,toolRequested
 const gate=new Promise(resolve=>{release=resolve}),inspectGate=new Promise(resolve=>{allowInspect=resolve})
 const toolGate=new Promise(resolve=>{allowTool=resolve}),toolStarted=new Promise(resolve=>{toolRequested=resolve})
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,
  localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url)),globalConfigKeyring:keyring,providerGateway:{mode:'shared'},...runtime,
  codingHarnesses:{defaultId:'fixture-calc',adapters:[{descriptor:{id:'fixture-calc',name:'Calculator',capabilities:['coding'],origin:'external'},async run(_input,signal,context){
   runs++;context.onProgress({kind:'status',text:'Computing workbook total'});await gate;signal.throwIfAborted()
   return {summary:'Recovered workbook total: 42',output:'42'}
  }}]},
 })
 f.cleanup.unshift(async()=>{release();allowInspect();allowTool();await app.close()})
 await app.ready()
 server.on('request',app.routing)
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:1000}})
 if(manualEdit)await page.addInitScript(()=>{window.__genofficeDebugHooks=true})
 await stubHomeHero(page)
 await page.goto(origin)
 await page.getByLabel('用户名',{exact:true}).fill('alice')
 await page.getByLabel('密码',{exact:true}).fill(password)
 await page.getByRole('button',{name:'登录',exact:true}).click()
 await expect(page.locator('.home')).toBeVisible()
 await page.goto(origin+'/native-xlsx/?fileId='+file.fileId)
 const assistant=page.locator('.copilot:not(.collapsed)'),composer=assistant.locator('textarea')
 async function showAssistant(){
  await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready',{timeout:30000})
  const rail=page.locator('.expand-copilot')
  if(await rail.isVisible())await rail.click()
  await expect(composer).toBeVisible()
 }
 await showAssistant()
 const instruction='请委派计算任务，并更新工作簿的 H2。',success='已根据任务结果更新工作簿。'
 let editCalls=0
 const network=mockProviderNetwork(t,()=>{try{
  const {tools,messages}=JSON.parse(network.wire.toString())
  const result=id=>messages.find(message=>message.role==='tool'&&message.tool_call_id===id)
  const call=(id,name,input)=>({tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(input)}}]})
  let delta
  if(result('xlsx-edit')){
   assert.ok(!manualEdit,'A resumed tool must not execute after a manual edit')
   const edit=JSON.parse(result('xlsx-edit').content)
   assert.ok(!edit.isError,edit.output)
   delta={content:success}
  }else if(result('xlsx-delegate')){
   assert.ok(!tools.some(tool=>tool.function.name==='delegate_agent_task'))
   const users=messages.filter(message=>message.role==='user')
   assert.equal(users.length,1)
   assert.ok(users[0].content.startsWith(instruction))
   assert.match(result('xlsx-delegate').content,/Recovered workbook total: 42/)
   assert.equal(++editCalls,1)
   const sheetId=JSON.parse(result('xlsx-context').content).output.match(/Active sheet: .* \(id=([^,)]+)/)[1]
   delta=call('xlsx-edit','propose_operations',{summary:'Write the recovered total',operations:[{op:'set_cell',sheetId,address:'H2',value:42}]})
  }else if(result('xlsx-context'))delta=call('xlsx-delegate','delegate_agent_task',{instruction:'Calculate the workbook total'})
  else delta=call('xlsx-context','get_workbook_context',{})
  const packet=Buffer.from('data: '+JSON.stringify({choices:[{delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n')
  if(manualEdit&&result('xlsx-delegate'))return Readable.from((async function*(){toolRequested();await toolGate;yield packet})())
  return Readable.from([packet])
 }catch(error){t.diagnostic(error.stack);throw error}})
 const submissions=[],cancellations=[],claims=[]
 page.on('request',request=>{
  const path=new URL(request.url()).pathname
  if(request.method()==='POST'&&path==='/api/v1/agents/tasks')submissions.push(request.postDataJSON())
  if(path.startsWith('/api/v1/agents/tasks/')&&path.endsWith('/cancel'))cancellations.push(path)
  if(path.startsWith('/api/v1/agents/tasks/')&&path.endsWith('/continuation'))claims.push(path)
 })
 await composer.fill(instruction)
 await assistant.getByRole('button',{name:'发送',exact:true}).click()
 await expect(assistant.locator('.assistant-task-message:visible').getByText('Computing workbook total',{exact:true})).toBeVisible({timeout:15000})
 assert.equal(submissions.length,1)
 const {turnId,documentId}=submissions[0]
 assert.equal(documentId,file.fileId)
 const expiredTurn='10000000-0000-4000-8000-000000000099'
 const retiredTurns=['10000000-0000-4000-8000-000000000097','10000000-0000-4000-8000-000000000098']
 const expiredPath=`/api/v1/agents/tasks/${expiredTurn}`
 if(!manualEdit){
  await page.evaluate(({documentId,turnIds})=>{
   sessionStorage.setItem('dyoffice.harness.tasks:'+documentId,JSON.stringify(turnIds))
  },{documentId,turnIds:[...retiredTurns,expiredTurn,turnId]})
  const status=(id,model)=>({turnId:id,documentId,agentId:'fixture-calc',state:'succeeded',hasContinuation:true,continuationModelId:model,result:{summary:'Expired task',output:'0'}})
  const waitForStatus=id=>page.waitForResponse(response=>new URL(response.url()).pathname===`/api/v1/agents/tasks/${id}/status`)
  const retiredRestored=Promise.all(retiredTurns.map(waitForStatus))
  const expiredRestored=waitForStatus(expiredTurn)
  for(const id of retiredTurns)await page.route(`**/api/v1/agents/tasks/${id}/status?*`,route=>route.fulfill({json:status(id,'retired-model')}))
  await page.route('**'+expiredPath+'/status?*',async route=>{
   await retiredRestored
   await route.fulfill({json:status(expiredTurn,'fixture')})
  })
  await page.route('**'+expiredPath+'/continuation',route=>route.fulfill({status:409,json:{error:'Harness continuation unavailable'}}))
  await page.route(`**/api/v1/agents/tasks/${turnId}/status?*`,async route=>{await expiredRestored;await route.continue()},{times:1})
 }
 await page.route(`**/files/${file.fileId}/sheets/inspect`,async route=>{await inspectGate;await route.continue()})
 const restoring=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/v1/agents/tasks/${turnId}/status`)
 await page.reload()
 const recoveredTask=await restoring
 assert.equal(recoveredTask.status(),200)
 const finished=page.waitForResponse(async response=>new URL(response.url()).pathname===`/api/v1/agents/tasks/${turnId}/status`&&response.ok()&&(await response.json()).state==='succeeded')
 release()
 await finished
 await expect(page.locator('html')).not.toHaveAttribute('data-document-loading','ready')
 assert.deepEqual(claims,[])
 allowInspect()
 await showAssistant()
 await expect(assistant.locator('.assistant-task-message:visible').getByText('Recovered workbook total: 42',{exact:true})).toBeVisible({timeout:15000})
 const cellValue=manualEdit?99:42
 const reply=manualEdit?/document changed while Office was continuing the Harness task/i:success
 const save=page.getByRole('button',{name:/^保存（(?:Ctrl\+S|⌘S)）$/})
 if(manualEdit){
  try{
   await toolStarted
   await expect(save).toBeDisabled()
   await page.evaluate(value=>window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange('H2').setValue(value),cellValue)
   await expect(save).toBeEnabled()
  }finally{allowTool()}
  await expect(page.locator('.status-msg')).toContainText(reply,{timeout:10000})
 }
 await expect(assistant.getByText(reply,{exact:true})).toBeVisible({timeout:10000})
 await expect(assistant.getByText(instruction,{exact:true})).toHaveCount(1)
 assert.equal(runs,1)
 assert.equal(submissions.length,1)
 assert.deepEqual(cancellations,[])
 const expectedClaims=[...(!manualEdit?[expiredPath+'/continuation']:[]),`/api/v1/agents/tasks/${turnId}/continuation`]
 assert.deepEqual(claims,expectedClaims)
 assert.equal(editCalls,1)
 const head=async()=>(await f.files.openFile(f.alice.token,file.fileId)).file.revision
 assert.equal(await head(),file.revision)
 await expect(save).toBeEnabled()
 await save.click()
 await expect.poll(head,{timeout:30000}).not.toBe(file.revision)
 await expect(save).toBeDisabled({timeout:30000})
 const bytes=await f.files.readFile(f.alice.token,file.fileId,await head())
 const cell=await runtime.sheetsNative.readRange(bytes,book.sheets[0].name,{startRow:1,endRow:1,startColumn:7,endColumn:7})
 assert.deepEqual(cell.cells.map(cell=>cell.value),[cellValue])
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
 if(!manualEdit)await page.evaluate(({documentId,turnId})=>{
  sessionStorage.setItem('dyoffice.harness.tasks:'+documentId,JSON.stringify([turnId]))
 },{documentId,turnId})
 await page.reload()
 await showAssistant()
 await expect(assistant.getByText(reply,{exact:true})).toBeVisible()
 await expect(assistant.getByText(instruction,{exact:true})).toHaveCount(1)
 assert.equal(submissions.length,1)
 assert.deepEqual(claims,expectedClaims)
})
