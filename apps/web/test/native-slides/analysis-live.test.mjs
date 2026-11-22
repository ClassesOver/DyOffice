import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {Readable} from 'node:stream'
import {fileURLToPath} from 'node:url'
import {expect} from '@playwright/test'
import JSZip from 'jszip'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {stubHomeHero} from '../helpers/home-hero.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {openIsolatedPptxSession} from '../../worker/src/native/pptx-session-host.ts'

const liveConfig=process.env.DYOFFICE_LIVE_PPTX_HARNESS_CONFIG
const python=process.env.DYOFFICE_TEST_ANALYSIS_PYTHON
const dist=name=>fileURLToPath(new URL('../../'+name,import.meta.url))
const marker='PPTX-CODEX-RESULT-27'
function calculationScript(helper){
 return [
  'import base64, hashlib, io, json, os, subprocess, uuid',
  'import matplotlib.pyplot as plt',
  ...(helper?[`helper=${JSON.stringify(helper)}`]:[]),
  'def execute(operation, args):',
  '    return json.loads(subprocess.check_output(helper+["execute",operation,"--args",json.dumps(args)],text=True))["detail"]',
  'total=8+19',
  'assert total==27',
  'fig,ax=plt.subplots(figsize=(2,1.5),dpi=72)',
  'ax.bar(["A","B"],[8,19])',
  'png=io.BytesIO()',
  'fig.savefig(png,format="png")',
  'plt.close(fig)',
  'ids=[]',
  `for name, media, role, raw in [("report.txt","text/plain","report",b"${marker}"),("table.csv","text/csv","table",f"Metric,Value\\nSum,{total}\\n".encode()),("chart.png","image/png","chart",png.getvalue())]:`,
  '    ids.append(execute("artifacts.stage",dict(name=name,mediaType=media,role=role,inputResultIds=[],sha256=hashlib.sha256(raw).hexdigest(),bytesBase64=base64.b64encode(raw).decode()))["artifactId"])',
  'execute("artifacts.commit",dict(commandId=str(uuid.uuid4()),summary=f"Sum: {total}",artifactIds=ids,inputs=[],limitations=[],runtimeManifestSha256=os.environ["OFFICE_ANALYSIS_RUNTIME_MANIFEST_SHA256"]))',
 ].join('\n')
}
function fixedModel(t){
 const helper=fileURLToPath(new URL('../../../../.dyoffice-analysis-build/harness-data.mjs',import.meta.url))
 const script=calculationScript([process.execPath,helper])
 let call=0
 const tool=(name,args)=>({tool_calls:[{index:0,id:'call_'+ ++call,type:'function',function:{name,arguments:JSON.stringify(args)}}]})
 const turns=[
  tool('delegate_agent_task',{instruction:'Wait for the user to cancel this test task',agentId:'codex',dataInputs:{sourceIds:[],resultIds:[]}}),
  tool('exec_command',{cmd:'sleep 60',yield_time_ms:10000,max_output_tokens:1000}),
  {content:'No delivery was confirmed for the first task.'},
  tool('delegate_agent_task',{instruction:'Generate and commit the report, table and chart',agentId:'codex',dataInputs:{sourceIds:[],resultIds:[]}}),
  tool('exec_command',{cmd:`python - <<'PY'\n${script}\nPY`,max_output_tokens:1000}),
  {content:'The script completed.'},
  {content:'The three files were submitted.'},
 ]
 return mockProviderNetwork(t,()=>{
  const delta=turns.shift()
  assert.ok(delta,'Unexpected model round')
  return Readable.from([Buffer.from(`data: ${JSON.stringify({choices:[{delta,finish_reason:null}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:delta.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:120,completion_tokens:30}})}\n\ndata: [DONE]\n\n`)])
 })
}

for(const live of [false,true])test(`PPTX ${live?'saves real Codex artifacts with a live model':'cancels a real Codex task, then saves a new delivery with a fixed model'}`,{skip:!python||live&&!liveConfig,timeout:live?360000:90000},async t=>{
 const origin='http://127.0.0.1:4255',f=await fileFixture(t,{origin,buildApp:false})
 const keyring={activeKeyId:'live-pptx',keys:{'live-pptx':new Uint8Array(32).fill(66)}}
 const entry=live?JSON.parse(await readFile(liveConfig,'utf8')).entry:{id:'fixture',kind:'chat',providerId:'openai',label:'Fixture',model:'synthetic',baseUrl:'https://provider.example/v1',apiKey:'fixture-key',enabled:true}
 assert.ok(entry?.enabled&&entry?.apiKey&&entry?.kind==='chat','Enabled test model configuration required')
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[entry],defaults:{chat:entry.id}})
 await f.preferences.update(f.alice.token,{language:'zh',showAssistant:true,autoSave:false})
 const original=await readFile(new URL('../fixtures/slides/acceptance.pptx',import.meta.url))
 const file=(await importFile(f,f.alice.token,original,'harness-target.pptx')).file
 const slidesHost={openSession(input){return openIsolatedPptxSession(input,{timeoutMs:60000,unsafeTestOnly:true})}}
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,slidesHost,globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:{analysisPython:python,cliPath:process.env.DYOFFICE_TEST_CODEX_BINARY},nativeSlidesDirectory:process.env.DYOFFICE_TEST_SLIDES_DIST??dist('dist-slides'),localShellDirectory:dist('dist-local-shell')})
 const network=live?undefined:fixedModel(t)
 const artifactOperations=[]
 const inject=app.inject.bind(app)
 t.mock.method(app,'inject',async input=>{
  const response=await inject(input)
  if(input.method==='POST'&&input.url?.endsWith('/data/execute')&&typeof input.payload==='string'){
   const {operation}=JSON.parse(input.payload)
   if(operation==='artifacts.stage'||operation==='artifacts.commit')artifactOperations.push([operation,response.statusCode])
  }
  return response
 })
 f.cleanup.unshift(()=>app.close())
 await app.listen({port:4255,host:'127.0.0.1'})
 const browser=await launchTestBrowser()
 f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[]
 page.on('pageerror',error=>errors.push(error.message))
 await stubHomeHero(page)
 await page.goto(origin)
 await page.getByLabel('用户名',{exact:true}).fill('alice')
 await page.getByLabel('密码',{exact:true}).fill(password)
 await page.getByRole('button',{name:'登录',exact:true}).click()
 await expect(page.locator('.home')).toBeVisible()
 await page.goto(origin+'/native-pptx/?fileId='+file.fileId)
 const panel=page.locator('.ai-panel'),composer=panel.locator('textarea')
 const rail=page.getByRole('button',{name:'展开 AI 助手',exact:true})
 const openAssistant=async()=>{
  await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready',{timeout:45000})
  await expect(composer.or(rail)).toBeVisible({timeout:30000})
  if(await rail.isVisible())await rail.click()
  await expect(composer).toBeVisible({timeout:30000})
 }
 await openAssistant()
 const nextTask=()=>page.waitForResponse(response=>new URL(response.url()).pathname==='/api/v1/agents/tasks'&&response.request().method()==='POST',{timeout:60000})
 const deliveries=page.locator('.analysis-deliveries')
 if(network){
  const firstDispatch=nextTask()
  await composer.fill('委派一个等待取消的测试任务');await panel.getByRole('button',{name:'发送',exact:true}).click()
  const first=await firstDispatch,turnId=first.request().postDataJSON().turnId
  assert.equal(first.status(),200)
  const card=panel.locator('.assistant-task-message:visible').filter({hasText:'Wait for the user to cancel this test task'})
  try {
   await expect(card.getByText('正在执行命令',{exact:true})).toBeVisible({timeout:15000})
  } catch (error) {
   const state=await card.locator('.assistant-task-state').getAttribute('data-state',{timeout:1000}).catch(()=>null)
   const details=await card.textContent({timeout:1000}).catch(()=>null)
   throw new Error(`Fixed-model cancellation did not reach command execution (model requests: ${network.writes}, state: ${state}, card: ${details?.slice(0,800)})`,{cause:error})
  }
  const cancel=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/v1/agents/tasks/${turnId}/cancel`&&response.request().method()==='POST')
  await card.getByRole('button',{name:'请求取消',exact:true}).click()
  assert.equal((await cancel).status(),204)
  await expect(card.locator('.assistant-task-state')).toHaveAttribute('data-state','unknown_outcome')
  await expect(panel.getByText('No delivery was confirmed for the first task.',{exact:true})).toBeVisible({timeout:15000})
  await expect(deliveries.locator('summary')).toContainText('(0)')
  assert.deepEqual(artifactOperations,[])
 }
 const dispatched=nextTask()
 await composer.fill('请只委派一次 delegate_agent_task 给内置 Codex，传 dataInputs={sourceIds:[],resultIds:[]}。把以下 Python 脚本完整传给 Codex，请它用一次命令运行，不读取数据源，不下载依赖，不调用幻灯片编辑工具。Codex 只需在脚本开头声明 helper 为其任务说明里给出的两个绝对路径（Node 可执行文件和 Office data helper 脚本）的 Python 列表，运行并简报。\n'+calculationScript())
 await panel.getByRole('button',{name:'发送',exact:true}).click()
 const task=await dispatched
 assert.equal(task.status(),200)
 const request=task.request().postDataJSON()
 assert.equal(request.modelId,'codex')
 assert.deepEqual(JSON.parse(request.request.messages[0].text).dataInputs,{sourceIds:[],resultIds:[]})
 try {
  await expect(deliveries.locator('summary')).toContainText('(1)',{timeout:live?240000:30000})
 } catch(cause) {
  throw Error(`No delivered result; helper operation statuses: ${JSON.stringify(artifactOperations)}`,{cause})
 }
 assert.deepEqual(artifactOperations.filter(([,status])=>status===200),[['artifacts.stage',200],['artifacts.stage',200],['artifacts.stage',200],['artifacts.commit',200]])
 if(network){
  await expect(panel.getByText('The three files were submitted.',{exact:true})).toBeVisible()
  await page.reload()
  await openAssistant()
 }
 await panel.getByRole('tab',{name:'任务',exact:true}).click()
 const history=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/v1/agents/deliveries'&&response.request().method()==='GET')
 await deliveries.locator('summary').click()
 const historyResponse=await history
 assert.equal(historyResponse.status(),200)
 const {deliveries:receipts}=await historyResponse.json()
 const restored=receipts.find(item=>item.artifacts.some(file=>file.name==='chart.png'))
 assert.ok(restored,'The committed chart is listed by the delivery history endpoint')
 await expect(deliveries.getByText(restored.commandId,{exact:true})).toBeVisible()
 const report=deliveries.locator('li').filter({hasText:'report.txt'})
 const table=deliveries.locator('li').filter({hasText:'table.csv'})
 await expect(report).toBeVisible()
 await expect(table).toBeVisible()
 const head=async()=>(await f.files.openFile(f.alice.token,file.fileId)).file.revision
 const chart=deliveries.locator('li').filter({hasText:'chart.png'})
 for(const artifact of [report,table,chart]){
  await artifact.getByRole('button',{name:'插入当前幻灯片',exact:true}).click()
  await expect(artifact.getByRole('button',{name:'保存文档',exact:true})).toBeVisible({timeout:10000})
 }
 assert.equal(await head(),file.revision)
 await chart.getByRole('button',{name:'保存文档',exact:true}).click()
 await expect.poll(head,{timeout:30000}).not.toBe(file.revision)
 const revision=await head(),saved=await JSZip.loadAsync(await f.files.readFile(f.alice.token,file.fileId,revision))
 const slide=await saved.file('ppt/slides/slide1.xml').async('string')
 assert.ok(slide.includes(marker))
 assert.match(slide,/<a:tbl[ >][\s\S]*?<a:t>Metric<\/a:t>[\s\S]*?<a:t>27<\/a:t>/)
 assert.ok(slide.includes(await table.locator('code').innerText()),'Table provenance hash is present in the saved slide')
 const chartHash=await chart.locator('code').innerText()
 const images=await Promise.all(saved.file(/^ppt\/media\/.+\.png$/i).map(part=>part.async('nodebuffer')))
 assert.ok(images.some(bytes=>createHash('sha256').update(bytes).digest('hex')===chartHash),'The saved deck contains the committed chart bytes')
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
 await page.reload()
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready',{timeout:45000})
 await expect.poll(()=>page.evaluate(async marker=>{
  const slide=(await window.slidesApi?.getRenderSlides())?.[0]
  if(!slide)return null
  const text=layout=>layout?.lines.flatMap(line=>line.runs.map(run=>run.text)).join('')??''
  return {report:slide.nodes.some(node=>text(node.text).includes(marker)),table:slide.nodes.some(node=>node.type==='table'&&node.cells.some(cell=>text(cell.text)==='Metric')&&node.cells.some(cell=>text(cell.text)==='27'))}
 },marker),{timeout:15000}).toEqual({report:true,table:true})
 assert.deepEqual(errors,[])
 if(network)assert.equal(network.writes,7)
})
