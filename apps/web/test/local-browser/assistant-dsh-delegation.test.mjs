import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomBytes,randomUUID} from 'node:crypto'
import {officeBrowserAsset} from '../helpers/office-browser-assets.mjs'
import {execFile} from 'node:child_process'
import {copyFile,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Readable} from 'node:stream'
import {promisify} from 'node:util'
import {expect} from '@playwright/test'
import JSZip from 'jszip'
import {readPdfLeafObjects} from '../../../pdf/src/main/text-edit.ts'
import {backgroundDocumentBytes} from '../helpers/background-documents.mjs'
import {launchTestBrowser,recordVerifiedOfficeEffect} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {stubHomeHero} from '../helpers/home-hero.mjs'
import {realDshBackground} from '../helpers/real-dsh-background.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {createAssistantChannelService} from '../../server/src/modules/assistant-channel/service.ts'
import {createSourceService} from '../../server/src/modules/sources/service.ts'
import {createWorkspaceSourceResults} from '../../server/src/modules/sources/results.ts'
import {createQuerySnapshot} from '../../server/src/modules/sources/provenance.ts'
import {openIsolatedPptxSession} from '../../worker/src/native/pptx-session-host.ts'
import {configuredSheetsRuntime} from '../../server/src/modules/sheets/runtime.ts'
import {buildSheetsGateway} from '../../server/sheets/build.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'

const live=process.env.DYOFFICE_REAL_DSH==='on',fixture=process.env.DYOFFICE_DSH_FIXTURE==='on'
const nativePdfDirectory=process.env.DYOFFICE_TEST_NATIVE_PDF_DIST??process.env.DYOFFICE_DSH_NATIVE_PDF_DIR??(process.env.DYOFFICE_TEST_OFFICE_ASSETS?officeBrowserAsset('pdf'):undefined)
const viewportMarker='Native file viewport row'
async function sheetsFixture(){
 const workbook=await JSZip.loadAsync(await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url)))
 const path='xl/worksheets/sheet1.xml',xml=await workbook.file(path).async('string')
 assert.match(xml,/ref="A1:F3"/)
 workbook.file(path,xml.replace('ref="A1:F3"','ref="A1:F601"').replace('</sheetData>',
  `<row r="601"><c r="A601" t="inlineStr"><is><t>${viewportMarker}</t></is></c></row></sheetData>`))
 return workbook.generateAsync({type:'nodebuffer'})
}
async function fixtureDelivery(t,input){
 const cwd=await mkdtemp(join(tmpdir(),'office-dsh-fixture-'))
 t.after(()=>rm(cwd,{force:true,recursive:true}))
 await writeFile(join(cwd,'delegate-input.json'),JSON.stringify(input),{mode:0o600})
 await copyFile(new URL('../helpers/dsh-delivery-fixture.mjs',import.meta.url),join(cwd,'deliver.mjs'))
 await promisify(execFile)(process.execPath,['deliver.mjs'],{cwd,timeout:30000})
 return JSON.parse(await readFile(join(cwd,'delivery-receipt.json'),'utf8'))
}

for(const format of ['docx','xlsx','pptx','pdf'])test(format+' resumes after '+(live?'official DSH':'an external fixture')+' delivers a report and recovers it from history',{
 skip:(!live&&!fixture)||(format==='pdf'&&!nativePdfDirectory)||(process.env.DYOFFICE_DSH_FORMAT&&process.env.DYOFFICE_DSH_FORMAT!==format),timeout:360000,
},async t=>{
 const port=Number(process.env.DYOFFICE_DSH_PORT??4219),origin='http://localhost:'+port,f=await fileFixture(t,{origin,worker:true}),real=live?await realDshBackground(t):null
 await f.preferences.update(f.alice.token,{language:'zh',showAssistant:true,autoSave:false})
 const keyring={activeKeyId:'browser-dsh',keys:{'browser-dsh':new Uint8Array(32).fill(37)}}
 const entry=real?.entry??{id:'fixture',kind:'chat',providerId:'openai',label:'Fixture',model:'synthetic',baseUrl:'https://provider.example/v1',apiKey:'fixture-key',enabled:true}
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[entry],defaults:{chat:entry.id}})
 const sheetsDir=format==='xlsx'?await mkdtemp(join(tmpdir(),'dsh-sheets-gateway-')):undefined
 if(sheetsDir){
  f.cleanup.push(()=>rm(sheetsDir,{recursive:true,force:true}))
  await buildSheetsGateway(join(sheetsDir,'gateway.mjs'))
 }
 const sheets=format==='xlsx'?await configuredSheetsRuntime({
  DYOFFICE_AUTH_MODE:'local',DYOFFICE_SANDBOX_MODE:'subprocess',DYOFFICE_DEPLOYMENT_ID:f.deploymentId,
  DYOFFICE_XLSX_NODE_ENGINE:join(sheetsDir,'xlsx-node-engine.mjs'),DYOFFICE_XLSX_GATEWAY_RUNNER:join(sheetsDir,'gateway-process.mjs'),
  DYOFFICE_NATIVE_XLSX_DIRECTORY:officeBrowserAsset('sheets'),
 },{enabled:true}):undefined
 if(sheets)f.cleanup.unshift(()=>sheets.close())
 const app=await buildLocalApp({
  db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,
  objectStore:f.objects,globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false,
  assistantChannels:true,assistantBackground:{pool:f.workerPool},realtime:{pollIntervalMs:100},
  slidesHost:{openSession:input=>openIsolatedPptxSession(input,{timeoutMs:60000,unsafeTestOnly:true})},
  ...(format==='pptx'?{nativeSlidesDirectory:officeBrowserAsset('slides')}:{}),
  ...(format==='docx'?{nativeDocsDirectory:process.env.DYOFFICE_TEST_NATIVE_DOCS_DIST??process.env.DYOFFICE_TEST_DOCS_DIST??officeBrowserAsset('docs')}:{}),
  ...(format==='pdf'?{nativePdf:true,nativePdfDirectory}:{}),...sheets,
  localShellDirectory:officeBrowserAsset('local-shell'),
 })
 f.cleanup.unshift(()=>app.close());await app.listen({port,host:'127.0.0.1'})
 const original=format==='xlsx'?await sheetsFixture():await backgroundDocumentBytes(format),name='dsh-delegation.'+format
 const file=(await importFile(f,f.alice.token,original,name)).file
 const sources=createSourceService({transactions:f.transactions,credentialKeys:'test:'+randomBytes(32).toString('base64')})
 const results=createWorkspaceSourceResults({transactions:f.transactions})
 await sources.create(f.alice.token,{sourceId:'metrics',name:'Metrics',kind:'http',config:{timezone:'UTC'},secret:'https://fixture.invalid/data'})
 const data=createQuerySnapshot({sourceId:'metrics',sourceVersion:1,timezone:'UTC',schema:[{name:'amount',type:'number',unit:'CNY'}],rows:[{amount:10},{amount:20},{amount:30}],sourceTruncated:false})
 const frozen=await results.capture(f.alice.token,data,createHash('sha256').update('DSH browser frozen fixture').digest('hex'),file.fileId)
 const channels=createAssistantChannelService({transactions:f.transactions,credentialKey:f.csrfKey,backgroundEnabled:true})
 const {conversationId}=await channels.createConversation(f.alice.token,{fileId:file.fileId})
 await channels.configureBackground(f.alice.token,conversationId,{enabled:true,fileId:file.fileId})
 const {memberToken}=await channels.issueDshToken(f.alice.token,conversationId)
 const {member}=await channels.memberSnapshot(memberToken)
 await channels.connect({kind:'member',token:memberToken},conversationId,{connectionId:randomUUID()})
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 async function signIn(){
  const next=await browser.newPage({viewport:{width:1440,height:1050}})
  if(format==='xlsx')await next.addInitScript(()=>{window.__genofficeDebugHooks=true})
  await stubHomeHero(next)
  await next.goto(origin)
  await next.getByLabel('用户名',{exact:true}).fill('alice')
  await next.getByLabel('密码',{exact:true}).fill(password)
  await next.getByRole('button',{name:'登录',exact:true}).click()
  await expect(next.locator('.home')).toBeVisible()
  return next
 }
 let page=await signIn()
 const selectors={docx:'.tiptap.doc-page',xlsx:'#univer-container canvas',pptx:'.app-main'}
 const railSelector=format==='xlsx'?'.expand-copilot':'.ai-rail'
 const panelSelector=format==='pdf'?'.shared-editor-assistant':format==='xlsx'?'.copilot:not(.collapsed)':'.ai-panel'
 const waitEditor=()=>expect(page.locator(selectors[format]).first()).toBeVisible({timeout:45000})
 async function openDocument(){
  if(format==='pdf'){
   await page.goto(origin+'/native-pdf/?fileId='+file.fileId+'&channel='+conversationId)
   await expect(page.locator('.pdf-thumb')).toHaveCount(1)
   await page.getByRole('button',{name:'AI 助手',exact:true}).click()
   return
  }
  await page.goto(origin+'/native-'+format+'/?fileId='+file.fileId+'&channel='+conversationId)
  await waitEditor()
 }
 const connectPath='/api/v1/assistant-channels/channels/'+conversationId+'/connect'
 await page.route('**'+connectPath,route=>route.fulfill({status:503,body:'Channel unavailable'}),{times:1})
 await openDocument()
 const rail=page.locator(railSelector).first()
 const panel=page.locator(panelSelector).first()
 await expect.poll(async()=>await rail.isVisible()||await panel.locator('textarea').isVisible(),{timeout:45000}).toBe(true)
 if(await rail.isVisible())await rail.click()
 await expect(panel.getByRole('tablist',{name:'Office 助手'}).getByRole('tab')).toHaveCount(2)
 const retry=panel.getByRole('button',{name:'重试连接',exact:true})
 await expect(retry).toBeVisible()
 const connection=page.waitForResponse(response=>new URL(response.url()).pathname===connectPath&&response.request().method()==='POST')
 await retry.click()
 assert.equal((await connection).status(),200)
 await expect(retry).toBeHidden()
 const reportMarker='DSH-RECEIPT-'+randomUUID(),summary=reportMarker+' Total 60 CNY'
 if(!real){
  const tool=(name,input)=>({tool_calls:[{index:0,id:'call_'+name,type:'function',function:{name,arguments:JSON.stringify(input)}}]})
  let turn=0
  const network=mockProviderNetwork(t,()=>{
   let delta
   if(turn===0)delta=tool('list_channel_agents',{})
   else if(turn===1){
    const {messages}=JSON.parse(network.wire.toString())
    const listing=messages.findLast(message=>message.tool_call_id==='call_list_channel_agents')
    const result=JSON.parse(listing?.content??'{}')
    assert.ok(!result.isError,result.output)
    const {agents}=JSON.parse(result.output)
    const target=agents.find(agent=>agent.agentId===member.membershipId)
    assert.equal(target?.displayName,member.displayName)
    assert.equal(target?.kind,member.kind)
    assert.ok(target.agentId!==member.agentId)
    delta=tool('delegate_channel_task',{agentId:target.agentId,instruction:'Total the frozen budget',dataInputs:{sourceIds:[],resultIds:[frozen.resultId]}})
   }else{
    assert.equal(turn,2)
    delta={content:summary}
   }
   turn++
   return Readable.from([Buffer.from('data: '+JSON.stringify({choices:[{delta,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:delta.tool_calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n')])
  })
 }
 const turns=[],channelPosts=[]
 page.on('response',response=>{
  const request=response.request(),path=new URL(response.url()).pathname
  if(request.method()!=='POST')return
  if(path==='/api/v1/ai/turns'){
   const {tools,messages}=request.postDataJSON().request
   const calls=messages.flatMap(message=>message.toolCalls??[])
   turns.push({status:response.status(),channelTools:tools.map(tool=>tool.name).filter(name=>name.includes('channel')),calls:calls.map(call=>call.name),delegates:calls.filter(call=>call.name==='delegate_channel_task').map(({input})=>({keys:Object.keys(input),membershipId:input.agentId===member.membershipId,harnessId:input.agentId===member.agentId,dataInputs:input.dataInputs===null?'null':typeof input.dataInputs})),toolErrors:messages.flatMap(message=>(message.results??[]).filter(result=>result.isError).map(result=>result.name))})
  }
  if(path.startsWith('/api/v1/assistant-channels/'))channelPosts.push([path.split('/').at(-1),response.status()])
 })
 await panel.getByRole('tab',{name:'对话',exact:true}).click()
 const marker='DSH-CHECK-'+randomUUID()
 const instruction=marker+'：先调用 list_channel_agents，找到 DSH DyOffice，再用 delegate_channel_task 委派计算总额并提交报告。必须传 dataInputs='+JSON.stringify({sourceIds:[],resultIds:[frozen.resultId]})+'。仅委派一次；完成后照抄 DSH 整行结果。不要编辑文档，不要使用其他工具。'
 await panel.locator('textarea').fill(instruction)
 await panel.getByRole('button',{name:'发送',exact:true}).click()
 const snapshot=()=>channels.snapshot(f.alice.token,conversationId)
 let parent,child
 try{await expect.poll(async()=>{
  const {tasks}=await snapshot()
  parent=tasks.find(task=>task.instruction.includes(marker)&&task.from==='office'&&task.to==='office')
  child=tasks.find(task=>task.parentTaskId===parent?.taskId&&task.to===member.membershipId)
  return [parent?.state,child?.state]
 },{timeout:60000}).toEqual(['waiting_peer','queued'])}
 catch(cause){throw Error('No waiting Office parent and queued delegate: '+JSON.stringify({turns,channelPosts,states:(await snapshot()).tasks.map(task=>task.state)}),{cause})}
 t.diagnostic('Office parent waiting for DSH child '+child.taskId)
 const baseURL=origin+'/api/v1/assistant-channels'
 const delivery=real?await real.deliverDelegate(baseURL,memberToken,child.taskId,reportMarker,frozen.resultId):
  await fixtureDelivery(t,{baseURL,memberToken,taskId:child.taskId,marker:reportMarker,resultId:frozen.resultId})
 assert.equal(delivery.summary,summary)
 assert.equal(delivery.sha256,createHash('sha256').update(summary).digest('hex'))
 const parentId=parent.taskId,childId=child.taskId
 await expect.poll(async()=>{
  const {tasks}=await snapshot()
  return [tasks.find(task=>task.taskId===parentId)?.state,tasks.find(task=>task.taskId===childId)?.state]
 },{timeout:60000}).toEqual(['succeeded','succeeded'])
 const {tasks}=await snapshot()
 assert.equal(tasks.find(task=>task.taskId===childId).summary,summary)
 assert.ok(tasks.find(task=>task.taskId===parentId).summary.includes(summary))
 assert.equal(tasks.filter(task=>task.parentTaskId===parentId).length,1)
 const head=async()=>(await f.files.openFile(f.alice.token,file.fileId)).file.revision
 assert.equal(await head(),file.revision)
 const viewport=Promise.withResolvers()
 let viewportReadPending=false
 if(format==='xlsx'){
  t.after(()=>viewport.resolve())
  await page.route('**/sheets/range',async route=>{
   const {range}=route.request().postDataJSON()
   if(range.startRow<=600&&range.endRow>=600&&range.startColumn===0){
    viewportReadPending=true
    await viewport.promise
   }
   await route.continue()
  })
 }
 if(format!=='pdf'){
  await page.reload()
  await waitEditor()
 }else{
  await page.close()
  page=await signIn()
  await openDocument()
 }
 const reopenedRail=page.locator(railSelector).first()
 const reopenedPanel=page.locator(panelSelector).first()
 await expect.poll(async()=>await reopenedRail.isVisible()||await reopenedPanel.locator('textarea').isVisible(),{timeout:45000}).toBe(true)
 if(await reopenedRail.isVisible())await reopenedRail.click()
 await reopenedPanel.getByRole('tab',{name:'任务',exact:true}).click()
 const deliveries=reopenedPanel.locator('.analysis-deliveries')
 const history=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/v1/agents/deliveries'&&response.request().method()==='GET')
 await deliveries.locator('summary').click()
 const historyResponse=await history
 assert.equal(historyResponse.status(),200)
 await expect(deliveries.getByRole('heading',{name:'历史交付',exact:true})).toBeVisible()
 const report=deliveries.locator('li').filter({hasText:'dsh-budget-report.txt'})
 await expect(report.locator('code')).toHaveText(delivery.sha256)
 if(!real)recordVerifiedOfficeEffect('shared','list_channel_agents')
 recordVerifiedOfficeEffect('shared','delegate_channel_task')
 if(format==='xlsx'){
  await page.evaluate(()=>window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange('J10').activate())
  const selected=()=>page.evaluate(()=>{
   const range=window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveRange()
   return range ? [range.getRow(),range.getColumn()] : null
  })
  const viewportValue=()=>page.evaluate(()=>window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange('A601').getValue())
  await expect.poll(()=>viewportReadPending,{timeout:30000}).toBe(true)
  await expect.poll(selected).toEqual([9,9])
  assert.notEqual(await viewportValue(),viewportMarker)
  // Release the real viewport read only after the insertion captured J10.
  await page.route('**/api/v1/agents/artifacts/*/content',async route=>{
   viewport.resolve()
   try{
    await expect.poll(viewportValue,{timeout:15000}).toBe(viewportMarker)
    await page.evaluate(()=>window.__genofficeDebug.univerAPI.executeCommand('formula.mutation.set-formula-calculation-notification',{}))
   }finally{await route.continue()}
  },{times:1})
  await page.evaluate(()=>{
   const commands=[]
   window.__dyofficeInsertionCommands=commands
   window.__genofficeDebug.univerAPI.onCommandExecuted(({id},options)=>{
    if(commands.length<100)commands.push([id,options?.fromFormula===true])
   })
  })
 }
 const insert={docx:'插入文档',xlsx:'写入当前选区',pptx:'插入当前幻灯片',pdf:'追加到 PDF'}[format]
 await report.getByRole('button',{name:insert,exact:true}).click()
 const save=report.getByRole('button',{name:'保存文档',exact:true})
 try{
  await expect(deliveries.getByRole('status')).toBeVisible({timeout:15000})
  await expect(deliveries.getByRole('status')).toHaveText('已插入，尚未保存',{timeout:1000})
 }catch(error){
  if(format==='xlsx')t.diagnostic(JSON.stringify(await page.evaluate(expected=>{
   const workbook=window.__genofficeDebug?.univerAPI.getActiveWorkbook()
   const range=workbook?.getActiveRange()
   return {commands:window.__dyofficeInsertionCommands,selection:range?[range.getRow(),range.getColumn()]:null,
    reportWritten:workbook?.getActiveSheet()?.getRange('J10').getValue()===expected}
  },summary).catch(()=>({editorUnavailable:true}))))
  throw error
 }
 await expect(save).toBeVisible()
 assert.equal(await head(),file.revision)
 await save.click()
 await expect.poll(head,{timeout:30000}).not.toBe(file.revision)
 const revision=await head(),savedBytes=await f.files.readFile(f.alice.token,file.fileId,revision)
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
 if(format==='pdf'){
  const leaves=await readPdfLeafObjects(savedBytes)
  const appendix=leaves.filter(item=>item.page===1&&item.type===1).map(item=>item.text).join('\n')
  assert.ok(appendix.includes(summary)&&appendix.includes(delivery.sha256))
  await page.reload()
  await expect(page.locator('.pdf-thumb')).toHaveCount(2)
  await page.locator('.pdf-thumb').last().click()
  await expect(page.getByText(summary,{exact:true}).first()).toBeAttached()
  return
 }
 if(format==='xlsx'){
  const {cells}=await sheets.sheetsNative.readRange(savedBytes,'Acceptance',{startRow:9,endRow:30,startColumn:9,endColumn:9})
  assert.ok(cells.some(cell=>cell.row===9&&cell.value===summary))
  assert.ok(cells.some(cell=>String(cell.value).includes(delivery.sha256)))
  const viewport=await sheets.sheetsNative.readRange(savedBytes,'Acceptance',{startRow:600,endRow:600,startColumn:0,endColumn:0})
  assert.equal(viewport.cells[0]?.value,viewportMarker)
  await page.reload();await waitEditor()
  await expect.poll(()=>page.evaluate(()=>window.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getSheetByName('Acceptance')?.getRange('J10').getValue()),{timeout:30000}).toBe(summary)
  return
 }
 const saved=await JSZip.loadAsync(savedBytes)
 if(format==='docx'){
  const xml=await saved.file('word/document.xml').async('string')
  assert.ok(xml.includes(summary)&&xml.includes(delivery.sha256))
  await page.reload()
  await expect(page.locator(selectors.docx).first()).toContainText(summary,{timeout:45000})
  return
 }
 const slide=await saved.file('ppt/slides/slide1.xml').async('string')
 assert.ok(slide.includes(summary))
 assert.ok(slide.includes(delivery.sha256))
 await page.reload()
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready',{timeout:45000})
 await expect.poll(()=>page.evaluate(async summary=>{
  const [slide]=await window.slidesApi.getRenderSlides()
  const normalize=text=>text.replace(/\s+/g,'')
  return slide?.nodes.some(node=>node.text&&normalize(node.text.lines.flatMap(line=>line.runs.map(run=>run.text)).join('')).includes(normalize(summary)))??false
 },summary),{timeout:15000}).toBe(true)
})
