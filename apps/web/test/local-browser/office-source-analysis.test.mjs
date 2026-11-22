import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomBytes,randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {Readable} from 'node:stream'
import {createServer} from 'node:https'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {officeBrowserAsset as dist} from '../helpers/office-browser-assets.mjs'
import {Pool} from 'pg'
import {PDFDocument} from 'pdf-lib'
import {createCrossPlatformProcess} from '../../worker/src/sandbox/cross-platform-process.ts'
import {createXlsxNativeWorker} from '../../worker/src/native/xlsx.ts'
import {openIsolatedPptxSession} from '../../worker/src/native/pptx-session-host.ts'
import {sheetsGateway} from '../helpers/sheets-gateway.mjs'
import {expect} from '@playwright/test'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,docxBytes,importFile} from '../helpers/files.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {stubHomeHero} from '../helpers/home-hero.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {createCsrfService} from '../../server/src/modules/auth/csrf.ts'
import {createSourceService} from '../../server/src/modules/sources/service.ts'
import {assistantSourceTools} from '../../../../packages/web-contracts/src/assistant.ts'

const liveConfig=process.env.DYOFFICE_LIVE_ANALYSIS_CONFIG
test('Office reads an allowed PostgreSQL schema and Coding plots the frozen result until refresh in the four editors',{timeout:220000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'office-source-analysis-'))
 t.after(()=>rm(directory,{recursive:true,force:true}))
 const key=join(directory,'key.pem'),cert=join(directory,'cert.pem')
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost'],{stdio:'pipe'})
 let app,browser
 const server=createServer({key:await readFile(key),cert:await readFile(cert)},(req,res)=>app.routing(req,res))
 t.after(async()=>{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app?.close()})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const origin='https://127.0.0.1:'+server.address().port
 const f=await fileFixture(t,{origin,buildApp:false})
 const target=new URL(process.env.DYOFFICE_TEST_DATABASE_URL)
 target.pathname='/'+f.database
 const owner=new Pool({connectionString:target.href})
 const reader='office_reader_'+randomBytes(5).toString('hex'),password=randomBytes(24).toString('hex')
 await owner.query(`CREATE ROLE "${reader}" LOGIN NOINHERIT PASSWORD '${password}';
   ALTER ROLE "${reader}" SET default_transaction_read_only=on;
   REVOKE TEMPORARY ON DATABASE "${f.database}" FROM PUBLIC;
   CREATE SCHEMA sales; CREATE SCHEMA confidential;
   CREATE TABLE sales.orders(paid_at date,order_amount integer,paid_amount integer);
   CREATE TABLE confidential.payroll(pay integer);
   INSERT INTO sales.orders VALUES ('2026-01-10',12,10),('2026-01-12',24,20),('2026-02-01',50,40),('2026-03-01',105,100);
   GRANT USAGE ON SCHEMA sales,confidential TO "${reader}";
   GRANT SELECT ON sales.orders,confidential.payroll TO "${reader}"`)
 f.cleanup.push(async()=>{
  await owner.query('DROP SCHEMA sales CASCADE; DROP SCHEMA confidential CASCADE')
  await owner.end()
  await f.admin.query('DROP ROLE "'+reader+'"')
 })
 target.username=reader;target.password=password
 const sourcesCredentialKeys='analysis:'+randomBytes(32).toString('base64')
 await createSourceService({transactions:f.transactions,credentialKeys:sourcesCredentialKeys}).create(f.adminSigned.token,{
  sourceId:'sales-db',name:'Sales DB',kind:'postgres',config:{database:f.database,allowedSchemas:['sales'],units:{amount:'CNY'}},secret:target.href,
 })
 const keyring={activeKeyId:'office',keys:{office:new Uint8Array(32).fill(37)}}
 const model=liveConfig ? JSON.parse(await readFile(liveConfig,'utf8')).entry
  : {id:'chat',kind:'chat',providerId:'deepseek',label:'Office model',model:'fixture',baseUrl:'https://provider.example/v1',enabled:true,apiKey:'fixture'}
 if(liveConfig)assert.ok(model?.enabled&&model?.kind==='chat'&&model?.apiKey,'An enabled real-model entry is required')
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[model],defaults:{chat:model.id}})
 await f.preferences.update(f.adminSigned.token,{language:'zh',showAssistant:true})
 const file=(await importFile(f,f.adminSigned.token,await docxBytes(),'Source analysis.docx')).file
 const pdf=await PDFDocument.create()
 pdf.addPage([400,300]).drawText('Source analysis')
 const siblings={}
 for(const [format,bytes] of [
  ['xlsx',await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url))],
  ['pptx',await readFile(new URL('../fixtures/slides/acceptance.pptx',import.meta.url))],
  ['pdf',Buffer.from(await pdf.save())],
 ]) siblings[format]=(await importFile(f,f.adminSigned.token,bytes,'Source analysis.'+format)).file
 const gateway=await sheetsGateway(t)
 const native=JSON.parse(await readFile(new URL('../../../../.dyoffice-native-build/host-manifest.json',import.meta.url),'utf8'))
 const sheetsNative=createXlsxNativeWorker(createCrossPlatformProcess({
  deploymentId:f.deploymentId,binary:native.nativeBinary,sha256:native.nativeSha256,allowedCommands:['open','read_range','read_formula_cells','read_row_outline','read_media','recalc_cells','save_archive','close'],
 }))
 const slidesHost={openSession(data){return openIsolatedPptxSession(data,{timeoutMs:60000,unsafeTestOnly:true})}}
 const input=process.env.DYOFFICE_TEST_ANALYSIS_PYTHON??fileURLToPath(new URL('../../../../.dyoffice-analysis-build/runtime/bin/python',import.meta.url))
 let first,committed,actualSeries,plotBytes
 const adapter={
  descriptor:{id:'test-python',name:'Python fixture',capabilities:['coding'],origin:'external'},
  async run(instruction,_signal,ctx){
   const {grant}=ctx.data
   assert.deepEqual(instruction.dataInputs,{sourceIds:[],resultIds:[first.artifact.resultId]})
   assert.deepEqual(grant.inputs,instruction.dataInputs)
   const request=async(operation,args,status=200)=>{
    const response=await app.inject({method:'POST',url:'/api/v1/agents/tasks/'+grant.taskId+'/data/execute',headers:{authorization:'Bearer '+grant.credential},payload:{operation,arguments:args}})
    if(response.statusCode!==status)t.diagnostic('Python fixture '+operation+': HTTP '+response.statusCode+' (expected '+status+')')
    assert.equal(response.statusCode,status,response.body)
    return response.json()
   }
   await request('sources.query',{sourceId:'sales-db',sql:'SELECT 1'},403)
   const manifest=(await request('results.get_manifest',{resultId:first.artifact.resultId})).artifact
   const rows=await app.inject({url:'/api/v1/agents/tasks/'+grant.taskId+'/data/results/'+manifest.resultId+'/content',headers:{authorization:'Bearer '+grant.credential}})
   assert.equal(rows.statusCode,200,rows.body);assert.equal(rows.json().sha256,first.sha256)
   const monthColumn=rows.json().schema.find(column=>column.type==='string')?.name
   const amountColumn=rows.json().schema.find(column=>column.type==='number'&&/amount|paid|total/i.test(column.name))?.name
   assert.ok(monthColumn&&amountColumn,'Monthly snapshot must have month and amount columns')
   const plotted=JSON.parse(execFileSync(input,['-c',`
import base64, io, json, sys
from matplotlib.figure import Figure
rows = json.load(sys.stdin)['rows']
x, y = [], []
for row in rows:
    x.append(str(row[sys.argv[1]]))
    y.append(row[sys.argv[2]])
fig = Figure()
line, = fig.subplots().plot(x, y, marker='o')
png = io.BytesIO()
fig.savefig(png, format='png')
print(json.dumps(dict(series=line.get_ydata().tolist(), total=sum(line.get_ydata().tolist()), png=base64.b64encode(png.getvalue()).decode())))
`,monthColumn,amountColumn],{input:rows.body,encoding:'utf8',env:{...process.env,MPLBACKEND:'Agg',MPLCONFIGDIR:f.directory}}))
   actualSeries=plotted.series;plotBytes=Buffer.from(plotted.png,'base64')
   const chart=await request('artifacts.stage',{name:'monthly-sales.png',mediaType:'image/png',role:'chart',inputResultIds:[manifest.resultId],sha256:createHash('sha256').update(plotBytes).digest('hex'),bytesBase64:plotted.png})
   const ref=Object.fromEntries(['resultId','sha256','sourceId','sourceVersion','queryHash','rowCount','truncated'].map(k=>[k,manifest[k]]))
   committed=await request('artifacts.commit',{commandId:randomUUID(),summary:'Python total '+plotted.total,artifactIds:[chart.artifactId],inputs:[ref],runtimeManifestSha256:'a'.repeat(64),limitations:['Deterministic Python fixture']})
   return {summary:committed.summary,output:'Monthly sales chart generated'}
  },
 }
 const sql="SELECT to_char(date_trunc('month', paid_at), 'YYYY-MM') AS month, sum(paid_amount) AS amount FROM sales.orders WHERE paid_at >= DATE '2026-01-01' AND paid_at < DATE '2026-03-01' GROUP BY 1 ORDER BY 1"
 const toolFrames=[]
 if(!liveConfig){
 const network=mockProviderNetwork(t,()=>{try{
  const {tools,messages}=JSON.parse(network.wire.toString())
  toolFrames.push(tools.map(tool=>tool.function.name))
  const user=messages.findLastIndex(m=>m.role==='user')
  const content=messages[user].content
  const prompt=typeof content==='string'?content:content.map(part=>part.text??'').join(' '),results=messages.slice(user+1).filter(m=>m.role==='tool')
  const output=()=>{
   const result=JSON.parse(results.at(-1).content)
   assert.equal(result.isError,false,result.output)
   return JSON.parse(result.output)
  }
  let action,answer
  if(prompt.includes('有哪些表')){
   if(!results.length)action=['sources_list',{}]
   else if(results.length===1)action=['sources_describe',{sourceId:'sales-db'}]
   else {
    const desc=output()
    assert.ok(desc.metadata,results.at(-1).content)
    assert.deepEqual(desc.metadata.rows.map(r=>[r.table_schema,r.table_name]),[['sales','orders']])
    answer='可见表 sales.orders'
   }
  }else if(prompt.includes('有哪些字段')){
   if(!results.length)action=['sources_describe',{sourceId:'sales-db',table:'sales.orders'}]
   else answer=output().metadata.rows.map(r=>r.column_name).join(', ')
  }else if(prompt.includes('Python')){
   if(!results.length)action=['delegate_agent_task',{instruction:'Plot the previous result and sum it',agentId:'test-python',dataInputs:{sourceIds:[],resultIds:[first.artifact.resultId]}}]
   else {assert.match(results.at(-1).content,/Python total 70/);answer='Python total 70'}
  }else{
   if(!results.length)action=['sources_query',{sourceId:'sales-db',sql}]
   else {
    const result=output()
    const amounts=result.preview.map(r=>r.amount)
    if(!first){first=result;assert.deepEqual(amounts,[30,40])}
    else {assert.notEqual(result.artifact.resultId,first.artifact.resultId);assert.notEqual(result.sha256,first.sha256);assert.deepEqual(amounts,[35,40])}
    answer='CNY '+amounts.reduce((a,b)=>a+b,0)
   }
  }
  const delta=action?{tool_calls:[{index:0,id:'fixture_'+toolFrames.length,type:'function',function:{name:action[0],arguments:JSON.stringify(action[1])}}]}:{content:answer}
  return Readable.from([Buffer.from(`data: ${JSON.stringify({choices:[{delta}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:action?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`)])
 }catch(error){t.diagnostic(error.stack);throw error}})
 }
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,globalConfigKeyring:keyring,providerGateway:{mode:'shared'},assistantSourceMode:'read-only-analysis',sourcesCredentialKeys,sourcesEgressTargets:[{kind:'postgres',endpoint:'postgresql://'+target.host,username:reader,database:f.database,addresses:['127.0.0.1'],allowInsecure:true}],codingHarnesses:{adapters:[adapter],defaultId:adapter.descriptor.id},nativeDocsDirectory:dist('docs'),nativeSheetsDirectory:dist('sheets'),nativeSlidesDirectory:dist('slides'),nativePdfDirectory:dist('pdf'),localShellDirectory:dist('local-shell'),sheetsNative,sheetsPlanner:gateway.planWorkbookSave,sheetsPackageReader:gateway.readWorkbookPackage,slidesHost})
 await app.ready()
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin,key:f.csrfKey})
 const probe=await app.inject({method:'POST',url:'/api/v1/ai/sources/execute',headers:{origin,cookie:'__Host-dyoffice-session='+f.adminSigned.token,'x-csrf-token':csrf.sessionToken(f.adminSigned.token)},payload:{name:'sources.describe',arguments:{sourceId:'sales-db'}}})
 assert.equal(probe.statusCode,200,probe.body)
 browser=await launchTestBrowser()
 const page=await browser.newPage({ignoreHTTPSErrors:true})
 await stubHomeHero(page)
 await page.context().addCookies([{name:'__Host-dyoffice-session',value:f.adminSigned.token,url:origin,secure:true,httpOnly:true,sameSite:'Lax'}])
 await page.goto(origin)
 await expect(page.locator('.home')).toBeVisible()
 await page.locator('.account-btn').click()
 await page.getByRole('menuitem',{name:'数据连接',exact:true}).click()
 await owner.query(`REVOKE SELECT ON confidential.payroll FROM "${reader}"`)
 await page.getByRole('button',{name:'新建数据连接',exact:true}).click()
 const saveAndTest=page.getByRole('button',{name:'保存并测试',exact:true})
 await saveAndTest.click()
 await expect(page.getByLabel('连接名称',{exact:true})).toBeFocused()
 await page.getByLabel('连接名称',{exact:true}).fill('连接引导验收')
 await page.getByLabel('连接标识',{exact:true}).fill('connection-guide')
 const wrongTarget=new URL(target)
 wrongTarget.pathname='/unapproved'
 await page.getByLabel('连接凭据',{exact:true}).fill(wrongTarget.href)
 await saveAndTest.click()
 await expect(page.getByRole('alert').filter({hasText:'连接已保存，但测试未通过'})).toBeVisible()
 await page.getByLabel('凭据操作',{exact:true}).selectOption('replace')
 await page.getByLabel('连接凭据',{exact:true}).fill(target.href)
 await page.getByRole('tab',{name:'可见范围',exact:true}).click()
 await expect(page.getByText('连接凭据有未保存的更改。请先保存可用的连接凭据。',{exact:true})).toBeVisible()
 await expect(page.getByRole('button',{name:'读取目录和表',exact:true})).toBeDisabled()
 await page.getByRole('button',{name:'前往连接设置',exact:true}).click()
 await saveAndTest.click()
 await expect(page.getByText('连接已保存，测试通过。',{exact:true})).toBeVisible()
 await page.getByRole('button',{name:'选择可见范围',exact:true}).click()
 await expect(page.getByLabel('搜索表',{exact:true})).toBeVisible()
 await page.getByLabel('搜索目录',{exact:true}).fill('sal')
 await expect(page.getByRole('button',{name:'浏览 confidential 的表',exact:true})).toHaveCount(0)
 await page.getByRole('combobox',{name:'目录范围',exact:true}).selectOption('selected')
 await page.getByRole('combobox',{name:'表可见范围',exact:true}).selectOption('all')
 await page.getByLabel('搜索表',{exact:true}).fill('not_found')
 await expect(page.getByText('没有匹配的表。',{exact:true})).toBeVisible()
 await page.getByLabel('搜索表',{exact:true}).fill('orders')
 await page.getByRole('button',{name:'改为勾选指定表',exact:true}).click()
 await expect(page.getByLabel('搜索表',{exact:true})).toHaveValue('orders')
 await page.getByLabel('搜索表',{exact:true}).fill('not_found')
 await page.getByRole('button',{name:'清除表搜索',exact:true}).click()
 await expect(page.getByLabel('搜索表',{exact:true})).toBeFocused()
 await page.getByRole('button',{name:'勾选当前目录（1）',exact:true}).click()
 await expect(page.getByText('当前列表已勾选 1 / 1 张表。',{exact:true})).toBeVisible()
 await page.getByRole('button',{name:'取消勾选当前目录（1）',exact:true}).click()
 await page.getByLabel('搜索表',{exact:true}).fill('orders')
 await page.getByRole('button',{name:'勾选搜索结果（1）',exact:true}).click()
 await expect(page.getByRole('checkbox',{name:'允许表 sales.orders',exact:true})).toBeChecked()
 await page.getByRole('button',{name:'取消勾选搜索结果（1）',exact:true}).click()
 await expect(page.getByRole('checkbox',{name:'允许表 sales.orders',exact:true})).not.toBeChecked()
 await page.getByRole('button',{name:'勾选搜索结果（1）',exact:true}).click()
 await page.getByRole('button',{name:'允许此目录',exact:true}).click()
 await expect(page.getByRole('checkbox',{name:'允许目录 sales',exact:true})).toBeChecked()
 await expect(page.getByLabel('搜索表',{exact:true})).toHaveValue('orders')
 await expect(page.getByText('已选 1 个目录、1 张表',{exact:true})).toBeVisible()
 await page.getByLabel('搜索表',{exact:true}).fill('not_found')
 await page.getByRole('button',{name:'移除表 sales.orders',exact:true}).click()
 await expect(page.getByText('尚未选择表，保存后助手将看不到任何表。',{exact:true})).toBeVisible()
 await page.getByLabel('搜索表',{exact:true}).fill('orders')
 await page.getByRole('checkbox',{name:'允许表 sales.orders',exact:true}).check()
 await page.getByRole('button',{name:'保存连接',exact:true}).click()
 await expect(page.getByText('连接已保存并生效，可测试连接。',{exact:true})).toBeVisible()
 await page.getByRole('tab',{name:'连接设置',exact:true}).click()
 await page.getByRole('checkbox',{name:'确认删除此连接',exact:true}).check()
 await page.getByRole('button',{name:'删除连接',exact:true}).click()
 await owner.query(`GRANT SELECT ON confidential.payroll TO "${reader}"`)
 await page.getByRole('button',{name:'Sales DB',exact:true}).click()
 await expect(page.getByRole('tab',{name:'连接设置',exact:true})).toHaveAttribute('aria-selected','true')
 await page.getByRole('tab',{name:'可见范围',exact:true}).click()
 await page.getByRole('button',{name:'读取目录和表',exact:true}).click()
 await expect(page.getByRole('checkbox',{name:'允许目录 sales'})).toBeChecked()
 await expect(page.getByRole('checkbox',{name:'允许目录 confidential'})).not.toBeChecked()
 await page.getByRole('button',{name:'浏览 sales 的表',exact:true}).click()
 await page.getByRole('combobox',{name:'表可见范围',exact:true}).selectOption('selected')
 await page.getByRole('checkbox',{name:'允许表 sales.orders',exact:true}).check()
 await page.getByRole('button',{name:'保存连接',exact:true}).click()
 await expect(page.getByText('连接已保存并生效，可测试连接。',{exact:true})).toBeVisible()
 await page.goto(origin+'/native-docx/?fileId='+file.fileId)
 await expect(page.locator('.tiptap.doc-page').first()).toBeVisible({timeout:45000})
 if(await page.locator('.ai-rail').isVisible())await page.locator('.ai-rail').click()
 const composer=page.locator('.ai-panel textarea')
 let queries=0
 const queryResults=[]
 page.on('response',async res=>{
  if(!res.url().endsWith('/api/v1/ai/sources/execute'))return
  if(!res.ok()){
   const call=res.request().postDataJSON()
   t.diagnostic('Office source response '+res.status()+' for '+call?.name)
   if(liveConfig&&call?.name==='sources.query') t.diagnostic('Synthetic fixture SQL: '+JSON.stringify(call.arguments?.sql))
   return
  }
  if(res.request().postDataJSON()?.name==='sources.query'){
   try{
    queryResults.push(await res.json())
    if(liveConfig)t.diagnostic('Accepted synthetic fixture SQL: '+JSON.stringify(res.request().postDataJSON().arguments?.sql))
   }catch(error){t.diagnostic(String(error))}
  }
 })
 page.on('request',req=>{if(req.url().endsWith('/api/v1/ai/sources/execute')&&req.postDataJSON()?.name==='sources.query')queries++})
 async function turn(prompt,answer){
  await composer.fill(prompt);await composer.press('Enter')
  const message=page.locator('.ai-chat .ai-msg-assistant').last()
  await expect(message).toContainText(answer,{timeout:liveConfig?90000:25000})
  await expect(message).not.toHaveClass(/ai-msg-streaming/,{timeout:liveConfig?90000:25000})
  await expect(message).toContainText(answer)
 }
 await turn('销售数据源有哪些表？',liveConfig?'orders':'可见表 sales.orders')
 if(!liveConfig){
  for (const name of assistantSourceTools('read-only-analysis')) assert.equal(toolFrames[0].filter(n=>n===name).length,1)
  assert.equal(toolFrames[0].filter(name=>name==='insert_data_result').length,1)
  assert.ok(!toolFrames[0].includes('sources_save_result'))
 }
 await turn('订单表有哪些字段？',liveConfig?'paid_amount':'paid_at, order_amount, paid_amount')
 const monthlyResults=()=>queryResults.filter(result=>result.totalRows===2&&!result.sourceTruncated)
 await turn('按 UTC 自然月汇总 2026 年 1–2 月的实收金额。只需查月份、实收金额两列，合计直接用这两个月的金额相加。','70')
 if(liveConfig){
  await expect.poll(()=>monthlyResults().length).toBe(1)
  first=monthlyResults()[0]
  assert.deepEqual(first.preview.map(row=>Object.values(row).find(value=>typeof value==='number')),[30,40])
 }
 const queriesBeforeCoding=queries
 if(!liveConfig)assert.equal(queriesBeforeCoding,1)
 await owner.query("INSERT INTO sales.orders VALUES ('2026-01-14', 7, 5)")
 await turn('用 Python fixture 复核刚才按月汇总的两行结果，并画折线图。不重查库。',liveConfig?'70':'Python total 70')
 await expect.poll(()=>Boolean(committed?.artifacts?.length),{message:'Python must commit a downloadable chart',timeout:10000}).toBe(true)
 assert.equal(queries,queriesBeforeCoding);assert.deepEqual(actualSeries,[30,40])
 assert.ok(committed?.artifacts?.length,'Python must commit a downloadable chart')
 const chart=committed.artifacts[0]
 await page.getByRole('tab',{name:/任务/}).click()
 await page.locator('.analysis-deliveries summary').click()
 await expect(page.locator('.analysis-delivery').getByText('monthly-sales.png',{exact:false})).toBeVisible()
 await expect(page.locator('.analysis-delivery').getByRole('button',{name:'下载',exact:true})).toBeVisible()
 await page.getByRole('tab',{name:'对话',exact:true}).click()
 const chartResponse=await app.inject({url:'/api/v1/agents/artifacts/'+chart.artifactId+'/content',headers:{cookie:'__Host-dyoffice-session='+f.adminSigned.token,'x-csrf-token':csrf.sessionToken(f.adminSigned.token)}})
 assert.equal(chartResponse.statusCode,200)
 assert.equal(chart.mediaType,'image/png')
 assert.deepEqual(chartResponse.rawPayload,plotBytes)
 assert.equal(plotBytes.subarray(1,4).toString(),'PNG')
 await turn('刷新汇总','75')
 if(liveConfig){
  await expect.poll(()=>monthlyResults().length).toBe(2)
  const refreshed=monthlyResults()[1]
  assert.notEqual(refreshed.artifact.resultId,first.artifact.resultId)
  assert.notEqual(refreshed.sha256,first.sha256)
  assert.deepEqual(refreshed.preview.map(row=>Object.values(row).find(value=>typeof value==='number')),[35,40])
  t.diagnostic('Python reused frozen result '+first.artifact.resultId.slice(0,8)+'… (sha256 '+first.sha256.slice(0,12)+'…), committed verified PNG, then refresh produced a new result.')
  return
 }
 assert.equal(queries,2)
 for(const [format,entry] of Object.entries(siblings)){
  const start=toolFrames.length
  const errors=[]
  const observe=error=>errors.push(error.message)
  page.on('pageerror',observe)
  await page.goto(origin+'/native-'+format+'/?fileId='+entry.fileId,{waitUntil:'commit'})
  const rail=page.locator(format==='xlsx'?'.expand-copilot':'.ai-rail').first()
  const panel=page.locator(format==='xlsx'?'.copilot:not(.collapsed)':'.ai-panel').first()
  const input=panel.locator('textarea')
  try{await expect.poll(async()=>await input.isVisible()||await rail.isVisible(),{timeout:25000,message:format+' shows the Office assistant'}).toBe(true)}
  catch(error){t.diagnostic(JSON.stringify({format,errors,body:(await page.locator('body').innerText()).slice(0,1200)}));throw error}
  finally{page.off('pageerror',observe)}
  if(await rail.isVisible())await rail.click()
  await input.fill('有哪些表？');await input.press('Enter')
  await expect(panel.getByText('可见表 sales.orders',{exact:true})).toBeVisible({timeout:25000})
  const names=toolFrames[start]
  for(const name of assistantSourceTools('read-only-analysis'))assert.equal(names.filter(offered=>offered===name).length,1,format+': '+name)
  assert.equal(names.filter(name=>name==='insert_data_result').length,format==='pdf'?0:1)
  assert.ok(!names.includes('sources_save_result'),format+' must not offer saving a source snapshot')
 }
})
