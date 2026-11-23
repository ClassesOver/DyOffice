import test from 'node:test'
import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {PDFDocument,PDFName,PDFString} from 'pdf-lib'
import {expect} from '@playwright/test'
import {readPdfLeafObjects} from '../../../pdf/src/main/text-edit.ts'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {stubHomeHero} from '../helpers/home-hero.mjs'
import {password} from '../helpers/identity.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'

const nativePdfDirectory=process.env.DYOFFICE_TEST_NATIVE_PDF_DIST
const liveConfig=process.env.DYOFFICE_LIVE_PDF_HARNESS_CONFIG
test('a new PDF tab resumes the parent conversation and saves its draft once',{skip:!nativePdfDirectory,timeout:90000},async t=>{
 const origin='http://localhost:4260',f=await fileFixture(t,{origin,buildApp:false})
 const doc=await PDFDocument.create()
 doc.addPage().drawText('Resume harness fixture')
 const original=Buffer.from(await doc.save()),{file}=await importFile(f,f.alice.token,original,'recover-task.pdf')
 const keyring={activeKeyId:'pdf-recovery',keys:{'pdf-recovery':new Uint8Array(32).fill(42)}}
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[{id:'fixture',kind:'chat',providerId:'openai',label:'Fixture',model:'synthetic',baseUrl:'https://provider.example/v1/chat/completions',apiKey:'fixture-key',enabled:true}],defaults:{chat:'fixture'}})
 let runs=0,release
 const gate=new Promise(resolve=>{release=resolve})
 const app=await buildLocalApp({
  db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,
  globalConfigKeyring:keyring,providerGateway:{mode:'shared'},nativePdfDirectory,
  localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url)),
  codingHarnesses:{defaultId:'fixture-calc',adapters:[{descriptor:{id:'fixture-calc',name:'Calculator',capabilities:['coding'],origin:'external'},async run(_input,signal,context){
   runs++
   context.onProgress({kind:'status',text:'Computing fixture total'})
   await gate
   signal.throwIfAborted()
   return {summary:'Recovered total: 42',output:'42'}
  }}]},
 })
 f.cleanup.unshift(async()=>{release();await app.close()})
 await app.listen({port:4260,host:'127.0.0.1'})
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const context=await browser.newContext({viewport:{width:1360,height:900}})
 let page=await context.newPage()
 await stubHomeHero(page)
 await page.goto(origin)
 await page.getByLabel('用户名',{exact:true}).fill('alice')
 await page.getByLabel('密码',{exact:true}).fill(password)
 await page.getByRole('button',{name:'登录',exact:true}).click()
 await expect(page.locator('.home')).toBeVisible()
 const documentUrl=origin+'/#/file/'+file.fileId
 await page.goto(documentUrl)
 let editor=page.frameLocator(`iframe[data-document-id="${file.fileId}"]`)
 const showAssistant=async()=>{
  await expect(editor.locator('html')).toHaveAttribute('data-document-loading','ready',{timeout:20000})
  await editor.getByRole('button',{name:'AI 助手',exact:true}).click()
 }
 await showAssistant()
 const instruction='请委派计算任务，并改写 PDF 原文。',success='已根据任务结果更新 PDF 草稿。',revised='Resume harness result: 42'
 const previous='记录这份 PDF 的审阅上下文。',previousAnswer='已记录审阅上下文。'
 const followup='前一轮的计算结果是什么？',followupAnswer='计算结果是 42。'
 let editCalls=0
 const network=mockProviderNetwork(t,()=>{try{
  const {tools,messages}=JSON.parse(network.wire.toString())
  const delegated=messages.find(message=>message.role==='tool'&&message.tool_call_id==='recover-fixture')
  const edited=messages.find(message=>message.role==='tool'&&message.tool_call_id==='recover-edit')
  const call=(id,name,input)=>({tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(input)}}]})
  const latest=messages.findLast(message=>message.role==='user')?.content
  let delta
  if(typeof latest==='string'&&latest.includes(previous))delta={content:previousAnswer}
  else if(typeof latest==='string'&&latest.includes(followup)){
   assert.equal(messages.filter(message=>message.role==='user'&&typeof message.content==='string'&&message.content.includes(previous)).length,1)
   assert.equal(messages.filter(message=>message.role==='assistant'&&message.content===previousAnswer).length,1)
   delta={content:followupAnswer}
  }else if(edited){assert.match(edited.content,/unsaved/i);delta={content:success}}
  else if(delegated){
   assert.ok(!tools.some(tool=>tool.function.name==='delegate_agent_task'))
   assert.match(delegated.content,/Recovered total: 42/)
   assert.equal(++editCalls,1)
   delta=call('recover-edit','edit_text',{page:1,old_text:'Resume harness fixture',new_text:revised})
  }else delta=call('recover-fixture','delegate_agent_task',{instruction:'Calculate the fixture total'})
  return Readable.from([Buffer.from('data: '+JSON.stringify({choices:[{delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n')])
 }catch(error){t.diagnostic(error.stack);throw error}})
 const submissions=[],cancellations=[],claims=[],recoveryResponses=[],modelResumes=[]
 context.on('request',request=>{
  const path=new URL(request.url()).pathname
  if(request.method()==='POST'&&path==='/api/v1/agents/tasks')submissions.push(request.postDataJSON())
  if(path.startsWith('/api/v1/agents/tasks/')&&path.endsWith('/cancel'))cancellations.push(path)
  if(path.startsWith('/api/v1/agents/tasks/')&&path.endsWith('/continuation'))claims.push(path)
  if(path==='/api/v1/ai/turns'&&request.postDataJSON()?.harnessResume)modelResumes.push(request.postDataJSON().harnessResume.taskId)
 })
 context.on('response',response=>{
  const path=new URL(response.url()).pathname
  if(path==='/api/v1/ai/turns'||path.endsWith('/continuation'))recoveryResponses.push([path,response.status()])
 })
 let assistant=editor.locator('.shared-editor-assistant')
 const send=async text=>{
  await assistant.getByRole('textbox',{name:'消息'}).fill(text)
  await assistant.getByRole('button',{name:'发送',exact:true}).click()
 }
 await send(previous)
 await expect(assistant.getByText(previousAnswer,{exact:true})).toBeVisible({timeout:15000})
 await send(instruction)
 await expect(assistant.locator('.assistant-task-message:visible').getByText('Computing fixture total',{exact:true})).toBeVisible({timeout:15000})
 assert.equal(submissions.length,1)
 const {turnId,documentId}=submissions[0]
 assert.equal(documentId,file.fileId)
 let task=assistant.locator(`.assistant-task-message[data-team-task="harness:${turnId}"]:visible`)
 await expect(task).toBeVisible()
 await page.close()
 page=await context.newPage()
 await stubHomeHero(page)
 await page.goto(documentUrl)
 editor=page.frameLocator(`iframe[data-document-id="${file.fileId}"]`)
 assistant=editor.locator('.shared-editor-assistant')
 task=assistant.locator(`.assistant-task-message[data-team-task="harness:${turnId}"]:visible`)
 await showAssistant()
 await expect(task.getByText('Computing fixture total',{exact:true})).toBeVisible({timeout:15000})
 await expect(task.getByText('Calculate the fixture total',{exact:true}).first()).toBeVisible()
 const continuationPath='/api/v1/agents/tasks/'+turnId+'/continuation'
 let received
 const lostReceipt=new Promise(resolve=>{received=resolve})
 await page.route('**'+continuationPath,async route=>{
  const request=route.request()
  const response=await app.inject({method:'POST',url:continuationPath,headers:await request.allHeaders(),payload:request.postData()})
  await route.fulfill({status:502,body:'Upstream response lost'})
  received(response.statusCode)
 },{times:1})
 release()
 assert.equal(await lostReceipt,200)
 await expect(task.getByText('Recovered total: 42',{exact:true})).toBeVisible({timeout:15000})
 try{await expect(assistant.getByText(success,{exact:true})).toBeVisible({timeout:15000})}
 catch(error){t.diagnostic(JSON.stringify({claims,modelResumes,recoveryResponses,editCalls,alert:await assistant.getByRole('alert').allTextContents()}));throw error}
 await expect(assistant.getByText(instruction,{exact:true})).toHaveCount(1)
 assert.equal(runs,1)
 assert.equal(submissions.length,1)
 assert.deepEqual(cancellations,[])
 assert.deepEqual(claims,[continuationPath,continuationPath])
 assert.equal(editCalls,1)
 await send(followup)
 await expect(assistant.getByText(followupAnswer,{exact:true})).toBeVisible({timeout:15000})
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
 await editor.getByRole('button',{name:'保存',exact:true}).click()
 await expect(editor.locator('.dyoffice-pdf-persistence-state')).toHaveText('已保存',{timeout:15000})
 const revision=(await f.files.openFile(f.alice.token,file.fileId)).file.revision
 assert.notEqual(revision,file.revision)
 const leaves=await readPdfLeafObjects(await f.files.readFile(f.alice.token,file.fileId,revision))
 assert.deepEqual(leaves.map(leaf=>leaf.text),[revised])
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
 await page.reload()
 await showAssistant()
 await expect(assistant.getByText(success,{exact:true})).toBeVisible()
 await expect(assistant.getByText(instruction,{exact:true})).toHaveCount(1)
 assert.equal(submissions.length,1)
 assert.equal(claims.length,2)
})

for(const mode of ['external','codex','live'])test('native PDF assistant uses '+(mode==='live'?'a live model and built-in Codex':mode==='codex'?'the built-in Codex':'an external Harness')+' to revise original text and a note in one explicit save',{
 skip:!nativePdfDirectory||mode==='codex'&&process.env.DYOFFICE_TEST_CODEX_CLI!=='1'||mode==='live'&&!liveConfig,timeout:mode==='live'?360000:90000,
},async t=>{
 const live=mode==='live',realCodex=mode!=='external'
 const port={external:43701,codex:43702,live:43703}[mode]
 const origin=`http://localhost:${port}`,f=await fileFixture(t,{origin,buildApp:false})
 const pdf=await PDFDocument.create(),pdfPage=pdf.addPage([400,300])
 pdfPage.drawText('Line items: 17 and 25',{x:24,y:250})
 pdfPage.drawText('Verified total: pending',{x:24,y:220})
 const savedNote=pdf.context.register(pdf.context.obj({Type:'Annot',Subtype:'Text',Rect:[280,210,300,230],P:pdfPage.ref,Contents:PDFString.of('Awaiting calculation'),T:PDFString.of('Reviewer'),F:4}))
 pdfPage.node.addAnnot(savedNote)
 const original=Buffer.from(await pdf.save()),{file}=await importFile(f,f.alice.token,original,'calculation.pdf')
 const keyring={activeKeyId:'pdf-harness',keys:{'pdf-harness':new Uint8Array(32).fill(41)}}
 const entry=live?JSON.parse(await readFile(liveConfig,'utf8')).entry:{id:'fixture',kind:'chat',providerId:'openai',label:'Fixture',model:'synthetic',baseUrl:'https://provider.example/v1/chat/completions',apiKey:'fixture-key',enabled:true}
 assert.ok(entry?.enabled&&entry?.apiKey&&entry?.kind==='chat','Enabled test model configuration required')
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[entry],defaults:{chat:entry.id}})
 const calls=[],agent=realCodex
  ?{id:'codex',name:'Codex',capabilities:['coding'],origin:'builtin'}
  :{id:'pdf-calculator',name:'PDF Calculator',capabilities:['coding'],origin:'external'}
 const instruction='Add the two line items from the given PDF context.'
 const app=await buildLocalApp({
  db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,
  globalConfigKeyring:keyring,providerGateway:{mode:'shared'},nativePdfDirectory,
  localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url)),
  codingHarnesses:realCodex?{}:{defaultId:agent.id,adapters:[{descriptor:agent,async run(input,signal,context){
   signal.throwIfAborted()
   calls.push({input,modelId:context.modelId})
   const [left,right]=input.context.match(/\d+/g).map(Number)
   return {summary:'Calculated the total',output:JSON.stringify({total:left+right})}
  }}]},
 })
 f.cleanup.unshift(()=>app.close())
 await app.listen({port,host:'127.0.0.1'})
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1360,height:900}}),errors=[]
 page.on('pageerror',error=>errors.push(error.message))
 await stubHomeHero(page)
 await page.goto(origin)
 await page.getByLabel('用户名',{exact:true}).fill('alice')
 await page.getByLabel('密码',{exact:true}).fill(password)
 await page.getByRole('button',{name:'登录',exact:true}).click()
 await expect(page.locator('.home')).toBeVisible()
 await page.goto(origin+'/#/file/'+file.fileId)
 const editor=page.frameLocator(`iframe[data-document-id="${file.fileId}"]`)
 await expect(editor.locator('html')).toHaveAttribute('data-document-loading','ready')
 await editor.getByRole('button',{name:'AI 助手',exact:true}).click()
 const assistant=editor.locator('.shared-editor-assistant')
 const toolOrder=['read_pages','list_agents','delegate_agent_task','edit_text','read_annotations','edit_note']
 const toolsReceived=[]
 let revised,note,codexRounds=0
 const reply=delta=>Readable.from([Buffer.from('data: '+JSON.stringify({choices:[{delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n')])
 const call=(name,input,id)=>({tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(input)}}]})
 const network=live?undefined:mockProviderNetwork(t,()=>{try{
  const {tools,messages}=JSON.parse(network.wire.toString())
  if(realCodex&&tools.some(tool=>tool.function.name==='exec_command')){
   if(++codexRounds===1){
    assert.match(JSON.stringify(messages),/Line items: 17 and 25/)
    // Keep the running state observable before the short calculation ends.
    const script="from pathlib import Path; import json, time; time.sleep(1); Path('total.json').write_text(json.dumps({'total': 17 + 25}))"
    return reply({...call('exec_command',{cmd:'python3 -c '+JSON.stringify(script),max_output_tokens:100},'pdf_calc'),content:'Calculating the two PDF line items.'})
   }
   assert.equal(codexRounds,2)
   return reply({content:'Calculated the total in the workspace.'})
  }
  toolsReceived.push(tools.map(tool=>tool.function.name))
  const outputs=messages.filter(message=>message.role==='tool').map(message=>JSON.parse(message.content))
  for(const result of outputs)assert.ok(!result.isError,result.output)
  let input,delta
  const name=toolOrder[outputs.length]
  switch(name){
   case 'read_pages':input={start:1};break
   case 'list_agents':input={};break
   case 'delegate_agent_task':{
    const line=outputs[0].output.match(/Line items: 17 and 25/)[0]
    const selected=JSON.parse(outputs[1].output).find(entry=>entry.name===agent.name)
    assert.deepEqual(selected,agent)
    input={agentId:selected.id,instruction,context:line};break
   }
   case 'edit_text':{
    const result=JSON.parse(outputs[2].output)
    assert.equal(result.agent.id,agent.id)
    if(realCodex)assert.match(result.output,/^total\.json\n/)
    revised='Verified total: '+JSON.parse(realCodex?result.output.split('\n')[1]:result.output).total
    input={page:1,old_text:'Verified total: pending',new_text:revised};break
   }
   case 'read_annotations':input={start:1,end:1};break
   case 'edit_note':{
    const id=outputs[4].output.match(/Note (S\d+)/)[1]
    assert.equal(id,'S'+savedNote.objectNumber)
    note=revised+' (calculated by '+agent.name+')'
    input={page:1,note_id:id,text:note};break
   }
   default:
    assert.equal(outputs.length,toolOrder.length)
    assert.match(outputs[3].output,/unsaved/i)
    assert.match(outputs[5].output,/Edited note/)
    delta={content:'Calculation applied to unsaved PDF edits'}
  }
  return reply(delta??call(name,input,'pdf-harness-'+outputs.length))
 }catch(error){t.diagnostic(error.stack);throw error}})
 const tasks=[],officeTurns=[]
 page.on('response',response=>{
  const request=response.request()
  const path=new URL(response.url()).pathname
  if(path==='/api/v1/agents/tasks'&&request.method()==='POST')tasks.push({status:response.status(),id:request.postDataJSON().turnId})
  if(realCodex&&path==='/api/v1/ai/turns'&&request.method()==='POST')officeTurns.push(request.postDataJSON())
 })
 const marker='PDF-HARNESS-VERIFIED'
 await assistant.getByRole('textbox',{name:'消息'}).fill(live
  ?`先用 read_pages 读取第一页，并用 list_agents 发现内置 Codex。调用 delegate_agent_task 一次，将读到的两个条目放入 context，要求 Codex 实际运行代码求和，在任务工作区写入 total.json，格式为 {"total": 数值}，不要另写报告。拿到该文件结果后，用 edit_text 将原文 Verified total: pending 替换成 Verified total: 合计数字。然后用 read_annotations 获取第一页已有审阅便笺的 ID，用 edit_note 修改这条便笺为 Verified total: 合计数字 (calculated by Codex)，不要新增便笺。两项写入都成功后，回复单独一行 ${marker}。我会手动保存。`
  :'请使用 Harness 计算条目合计，更新 PDF 原文和现有审阅便笺，我会手动保存。')
 await assistant.getByRole('button',{name:'发送',exact:true}).click()
 const outputLog=assistant.locator('.assistant-task-message:visible').getByLabel('实时输出')
 let outputHeight
 if(realCodex&&!live){
  await expect(assistant.locator('.assistant-task-message:visible').getByText('正在执行命令',{exact:true})).toBeVisible({timeout:30000})
  await expect(outputLog).toBeVisible()
  await expect(outputLog).toContainText('Calculating the two PDF line items.')
  const box=await outputLog.boundingBox()
  assert.ok(box)
  outputHeight=box.height
 }
 await expect(assistant.getByText(live?marker:'Calculation applied to unsaved PDF edits',{exact:true})).toBeVisible({timeout:live?240000:30000})
 if(outputHeight!==undefined){
  await expect(outputLog).toContainText('Calculated the total in the workspace.')
  assert.equal((await outputLog.boundingBox()).height,outputHeight)
 }
 for(const offered of toolsReceived)for(const name of toolOrder)assert.ok(offered.includes(name),name)
 assert.deepEqual(tasks.map(task=>task.status),[200])
 await expect(assistant.locator('.assistant-task-message:visible')).toHaveAttribute('data-team-task','harness:'+tasks[0].id)
 if(realCodex){
  const messages=officeTurns.at(-1)?.request.messages??[]
  const results=messages.flatMap(message=>message.role==='tool'?message.results:[])
  for(const name of toolOrder)assert.ok(results.some(result=>result.name===name&&!result.isError),name)
  const result=JSON.parse(results.find(result=>result.name==='delegate_agent_task'&&!result.isError).output)
  assert.equal(result.agent.id,'codex')
  assert.match(result.output,/^total\.json\n/)
  assert.equal(JSON.parse(result.output.split('\n')[1]).total,42)
  if(live){revised='Verified total: 42';note=revised+' (calculated by Codex)'}
  else assert.equal(codexRounds,2)
 }else assert.deepEqual(calls,[{input:{agentId:agent.id,instruction,context:'Line items: 17 and 25'},modelId:'fixture'}])
 assert.equal(revised,'Verified total: 42')
 const head=async()=>(await f.files.openFile(f.alice.token,file.fileId)).file.revision
 assert.equal(await head(),file.revision)
 await expect(editor.locator('.dyoffice-pdf-persistence-state')).toHaveAttribute('data-dirty','true')
 const save=editor.getByRole('button',{name:'保存',exact:true})
 const commitPath=`/api/v1/files/${file.fileId}/commits`
 const commits=[], commitStatuses=[]
 await page.route('**'+commitPath,async route=>{
  const request=route.request()
  commits.push(request.postDataJSON())
  if(commits.length>2)return route.continue()
  try{
   // Deliver to the real commit handler without the provider DNS mock.
   const response=await app.inject({method:'POST',url:commitPath,headers:await request.allHeaders(),payload:request.postData()})
   commitStatuses.push(response.statusCode)
  }finally{await route.abort('failed')}
 })
 await save.click()
 await expect(editor.locator('.dyoffice-pdf-persistence-state')).toHaveAttribute('data-attention','true',{timeout:15000})
 assert.equal(commits.length,2)
 assert.deepEqual(commitStatuses,[200,200])
 const committed=await head()
 assert.notEqual(committed,file.revision)
 await save.click()
 await expect(editor.locator('.dyoffice-pdf-persistence-state')).toHaveText('已保存',{timeout:15000})
 const revision=await head()
 assert.equal(revision,committed)
 assert.equal(commits.length,3)
 for(const commit of commits.slice(1))assert.deepEqual(commit,commits[0])
 const bytes=await f.files.readFile(f.alice.token,file.fileId,revision)
 const contents=(await readPdfLeafObjects(bytes)).map(leaf=>leaf.text)
 assert.ok(contents.includes('Line items: 17 and 25'))
 assert.ok(contents.includes(revised))
 assert.ok(!contents.includes('Verified total: pending'))
 const persisted=await PDFDocument.load(bytes)
 const [noteRef]=persisted.getPage(0).node.Annots().asArray()
 const annotation=persisted.context.lookup(noteRef)
 assert.equal(annotation.lookup(PDFName.of('Contents')).decodeText(),note)
 assert.equal(annotation.lookup(PDFName.of('T')).decodeText(),'Reviewer')
 const count=await f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async connection=>(await connection.query('SELECT count(*)::int AS count FROM file_revisions WHERE file_id=$1',[file.fileId])).rows[0].count)
 assert.equal(count,2)
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
 await page.reload()
 await expect(editor.getByText(revised,{exact:true}).first()).toBeAttached({timeout:15000})
 await editor.locator('.ribbon-tab').getByText('视图',{exact:true}).click()
 await editor.getByRole('button',{name:'批注',exact:true}).click()
 const comments=editor.getByRole('list',{name:'批注',exact:true})
 await expect(comments.getByRole('button')).toHaveCount(1)
 await expect(comments.getByText(note,{exact:true})).toBeVisible()
 await expect(comments.getByText('Reviewer',{exact:true})).toBeVisible()
 assert.deepEqual(errors,[])
})
