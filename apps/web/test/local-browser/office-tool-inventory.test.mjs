import {stubHomeHero} from '../helpers/home-hero.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {officeBrowserAsset as dist} from '../helpers/office-browser-assets.mjs'
import {execFileSync} from 'node:child_process'
import {createServer} from 'node:https'
import {PDFDocument} from 'pdf-lib'
import JSZip from 'jszip'
import {PNG} from 'pngjs'
import {expect} from '@playwright/test'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,docxBytes,importFile} from '../helpers/files.mjs'
import {createCrossPlatformProcess} from '../../worker/src/sandbox/cross-platform-process.ts'
import {sheetsGateway} from '../helpers/sheets-gateway.mjs'
import {createXlsxNativeWorker} from '../../worker/src/native/xlsx.ts'
import {openIsolatedPptxSession} from '../../worker/src/native/pptx-session-host.ts'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {Readable} from 'node:stream'
import {ASSISTANT_FORMAT_TOOLS} from '../../../../packages/web-contracts/src/assistant.ts'

for(const mode of ['creation','no-word','all'])test(mode==='no-word'
 ? 'Excel offers workspace creation formats without DOCX when native Word is unavailable'
 : mode==='creation'?'Word and Excel expose only executable creation formats, including standalone CSV download'
 : 'native Office editors scope model tools, save WebP images in Excel and complete Harness delegation',{timeout:180000},async t=>{
 const creationOnly=mode!=='all',noWord=mode==='no-word'
 const directory=await mkdtemp(join(tmpdir(),'dyoffice-office-tools-'))
 let app,browser,server
 t.after(async()=>{
  await browser?.close()
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
  await app?.close();await rm(directory,{recursive:true,force:true})
 })
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(directory,'key.pem'),'-out',join(directory,'cert.pem'),'-days','1','-subj','/CN=localhost'],{stdio:'pipe'})
 server=createServer({key:await readFile(join(directory,'key.pem')),cert:await readFile(join(directory,'cert.pem'))},(req,res)=>app.routing(req,res))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const origin=`https://127.0.0.1:${server.address().port}`,f=await fileFixture(t,{origin,buildApp:false})
 const keyring={activeKeyId:'tools',keys:{tools:new Uint8Array(32).fill(29)}}
 const configs=createGlobalConfigService({transactions:f.transactions,keyring})
 const baseline=await configs.saveGlobalConfig(f.adminSigned.token,0,{upserts:[{id:'chat',kind:'chat',providerId:'deepseek',label:'Office model',model:'synthetic',baseUrl:'https://provider.example/v1',enabled:true,apiKey:'test-key'}],defaults:{chat:'chat'}})
 await f.preferences.update(f.alice.token,{language:'zh',autoSave:false,showAssistant:true})
 const gateway=await sheetsGateway(t),metadata=JSON.parse(await readFile(new URL('../../../../.dyoffice-native-build/host-manifest.json',import.meta.url),'utf8'))
 const sheetsNative=createXlsxNativeWorker(createCrossPlatformProcess({deploymentId:f.deploymentId,binary:metadata.nativeBinary,sha256:metadata.nativeSha256,allowedCommands:['open','read_range','read_formula_cells','read_row_outline','read_media','recalc_cells','save_archive','close']}))
 const slidesHost=creationOnly?undefined:{openSession(input){return openIsolatedPptxSession({fileId:input.fileId,revision:input.revision,bytes:input.bytes},{timeoutMs:60000,unsafeTestOnly:true})}}
 const sources=[['docx',await docxBytes()],['xlsx',await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url))]]
 let directPdf
 if(!creationOnly){
  const pdf=await PDFDocument.create();pdf.addPage([400,300]).drawText('Office assistant tools')
  const pdfBytes=Buffer.from(await pdf.save())
  sources.push(['pptx',await readFile(new URL('../fixtures/slides/acceptance.pptx',import.meta.url))],['pdf',pdfBytes])
  directPdf=(await importFile(f,f.alice.token,pdfBytes,'Direct tools.pdf')).file
 }
 const files={},directFiles={}
 for(const [format,bytes] of sources)files[format]=(await importFile(f,f.alice.token,bytes,'tools.'+format)).file
 // A direct editor opens its own file, so it does not race the previous
 // workspace iframe's pagehide lease release.
 if(creationOnly)for(const [format,bytes] of sources)directFiles[format]=(await importFile(f,f.alice.token,bytes,'direct-tools.'+format)).file
 if(directPdf)directFiles.pdf=directPdf
 let releaseTask
 const taskRuns=[]
 const finishTask=new Promise(resolve=>{releaseTask=resolve})
 const adapter={
  descriptor:{id:'test-coding',name:'Test coding',origin:'builtin',capabilities:['coding']},
  async run(task,_signal,context){
   taskRuns.push(task.instruction)
   assert.equal(task.agentId,'test-coding')
   assert.match(task.instruction,/^Calculate fixture total for (docx|xlsx|pptx|pdf)$/)
   assert.equal(context.modelId,'chat')
   context.onProgress({kind:'output',text:'PDF Harness working'})
   if(task.instruction.endsWith(' for pdf'))await finishTask
   return {summary:'Fixture total is 42',output:'42'}
  },
 }
 // Match the SaaS request limit: this fixture cold-loads a number of editors from one IP.
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,rateLimit:{max:5000,windowMs:60000},globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:{adapters:[adapter],defaultId:adapter.descriptor.id},...(!noWord?{nativeDocsDirectory:dist('docs'),nativePdfDirectory:dist('pdf')}:{}),nativeSheetsDirectory:dist('sheets'),...(!creationOnly?{nativeSlidesDirectory:dist('slides'),slidesHost}:{}),localShellDirectory:dist('local-shell'),sheetsNative,sheetsPlanner:gateway.planWorkbookSave,sheetsPackageReader:gateway.readWorkbookPackage})
 browser=await launchTestBrowser()

 const frames=[],exportsByType=new Map()
 const remoteImage='https://images.example/blue.webp'
 let attachedImagePath,attachedImageSheet
 const toolCall=(name,input,id='excel-'+name)=>({tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(input)}}]})
 const network=mockProviderNetwork(t,()=>{try{
  const {tools,messages}=JSON.parse(network.wire.toString())
  const content=messages.findLast(message=>message.role==='user')?.content
  const prompt=typeof content==='string'?content:content?.map(part=>part.text??'').join(' ')
  const probe=prompt?.match(/Office capability probe ([\w-]+ [\w-]+)/)?.[1]
  if(probe)frames.push(tools.map(tool=>tool.function))
  if(probe==='video-only docx'){
   assert.ok(content.some(part=>part.type==='image_url'),'The chat model should still get the attached image')
   assert.ok(!prompt.includes('Current message image attachments (analyze_media'),'Video-only media should not advertise an image attachment index')
  }
  let delta={content:probe?'Office tool inventory received '+probe:'Fixture reply'}
  if(prompt?.includes('Word mind map probe')){
   const result=messages.at(-1)
   if(result.role==='tool'){
    assert.match(result.content,/Mind map rendered as an interactive card/)
    delta={content:'Word mind map is ready'}
   }else{
    assert.ok(tools.some(tool=>tool.function.name==='generate_mindmap'))
    delta=toolCall('generate_mindmap',{root:{label:'Office overview',children:[{label:'First section',block:0},{label:'Second section'}]}})
   }
  }else if(prompt?.includes('Office Harness probe')){
   const format=prompt.match(/Office Harness probe (docx|xlsx|pptx|pdf)/)?.[1]
   assert.ok(format)
   const result=messages.at(-1)
   if(result.role==='tool'){
    assert.match(result.content,/Fixture total is 42/)
    delta={content:format+' parent turn resumed with total 42'}
   }else{
    delta={tool_calls:[{index:0,id:'office-harness-probe',type:'function',function:{name:'delegate_agent_task',arguments:JSON.stringify({instruction:'Calculate fixture total for '+format})}}]}
   }
  }else if(prompt?.includes('Excel reply length probe')){
   delta={content:'这里只完成了开头。',...toolCall('create_document',{title:'Must not download'})}
   return Readable.from([Buffer.from('data: '+JSON.stringify({choices:[{delta,finish_reason:'length'}]})+'\n\n')])
  }else if(prompt?.includes('Standalone Excel CSV probe')){
   const result=messages.findLast(message=>message.role==='tool')
   if(result){
    assert.match(JSON.parse(result.content).output,/Downloaded Office CSV probe\.csv/)
    delta={content:'Standalone worksheet downloaded'}
   }else{
    const create=tools.find(tool=>tool.function.name==='create_document')
    assert.deepEqual(create.function.parameters.properties.type.enum,['csv'])
    delta=toolCall('create_document',{title:'Office CSV probe'})
   }
  }else if(/Excel workspace export (xlsx|docx|pdf)/.test(prompt??'')){
   const type=prompt.match(/Excel workspace export (xlsx|docx|pdf)/)[1]
   const result=messages.at(-1)
   const title='Office export '+type
   if(result.role==='tool'){
    const outcome=JSON.parse(result.content)
    exportsByType.set(type,outcome)
    delta={content:'Finished '+type+' export'}
   }else{
    assert.ok(tools.find(tool=>tool.function.name==='create_document')?.function.parameters.properties.type.enum.includes(type))
    delta=toolCall('create_document',{type,title,...(type==='xlsx'?{}:{content:'<p>Quarterly revenue checkpoint</p>'})},'excel-create-'+type)
   }
  }else if(prompt?.includes('Excel WebP probe')){
   const results=messages.slice(messages.findLastIndex(message=>message.role==='user')+1)
    .filter(message=>message.role==='tool').map(message=>JSON.parse(message.content))
   for(const result of results)assert.ok(!result.isError,result.output)
   if(!results.length)delta=toolCall('get_workbook_context',{})
   else if(results.length===1)delta=toolCall('generate_image',{prompt:'Synthetic WebP'})
   else if(results.length===2)delta=toolCall('image_search',{query:'Synthetic blue image',maxResults:1})
   else if(results.length===3){
    const sheetId=results[0].output.match(/^Active sheet: .*?\(id=([^,)]+)/)?.[1]
    const path=results[1].output.match(/https:\/\/generated-image\.invalid\/[\w-]+/)?.[0]
    assert.ok(sheetId,results[0].output)
    assert.ok(path,results[1].output)
    assert.doesNotMatch(results[1].output,/base64/)
    assert.ok(results[2].output.includes(remoteImage),results[2].output)
    const attachment=prompt.match(/(https:\/\/attached-image\.invalid\/[\w-]+) \| "green\.png"/)?.[1]
    assert.ok(attachment,'Model request must contain a usable image attachment reference.')
    assert.ok(content.some(part=>part.type==='image_url'),'Model request must include the attached image.')
    attachedImagePath=attachment
    attachedImageSheet=sheetId
    delta=toolCall('propose_operations',{summary:'Place generated, downloaded and attached images',operations:[
     {op:'add_image',sheetId,path,anchorCell:'B2'},
     {op:'add_image',sheetId,path:remoteImage,anchorCell:'D4'},
     {op:'add_image',sheetId,path:attachment,anchorCell:'F6'},
    ]})
   }else{
    assert.equal(results.length,4)
    delta={content:'Excel images placed at B2, D4 and F6'}
   }
  }else if(prompt?.includes('Excel stale attachment probe')){
   const result=messages.slice(messages.findLastIndex(message=>message.role==='user')+1).find(message=>message.role==='tool')
   if(result){
    assert.equal(JSON.parse(result.content).isError,true)
    delta={content:'Excel rejected the old attachment'}
   }else{
    assert.doesNotMatch(prompt,/Current message image attachments/)
    delta={tool_calls:[{index:0,id:'excel-expired-attachment',type:'function',function:{name:'propose_operations',arguments:JSON.stringify({summary:'Try an expired image reference',operations:[
     {op:'add_image',sheetId:attachedImageSheet,path:attachedImagePath,anchorCell:'H8'},
    ]})}}]}
   }
  }
  const end=prompt?.includes('Office Harness probe')?'':'data: [DONE]\n\n'
  return Readable.from([Buffer.from('data: '+JSON.stringify({choices:[{delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]})+'\n\n'+end)])
 }catch(error){t.diagnostic(error.stack);throw error}})
 const page=await browser.newPage({ignoreHTTPSErrors:true})
 const taskRequests=[]
 page.on('request',request=>{
  if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/v1/agents/tasks')taskRequests.push(request.postDataJSON())
 })
 const loadErrors=[]
 page.on('pageerror',error=>loadErrors.push(error.message))
 page.on('response',response=>{
  if(response.status()>=400&&new URL(response.url()).origin===origin&&!response.url().includes('/ai/turns'))loadErrors.push(response.status()+' '+new URL(response.url()).pathname)
 })
 await stubHomeHero(page)
 await page.context().addCookies([{name:'__Host-dyoffice-session',value:f.alice.token,url:origin,secure:true,httpOnly:true,sameSite:'Lax'}])
 const formats=['docx','xlsx','pptx','pdf']
 const openAssistant=async(format,stage,direct=false)=>{
  const id=(direct?directFiles[format]:files[format]).fileId
  const navigation=await page.goto(origin+(direct?'/native-'+format+'/?fileId='+id:'/?entry='+stage+'-'+format+'#/file/'+id))
  assert.equal(navigation.status(),200,stage+' '+format+' navigation')
  const editor=direct?page:page.frameLocator(`iframe[data-document-id="${id}"]`)
  const rail=editor.locator(format==='xlsx'?'.expand-copilot':'.ai-rail').first()
  const panel=editor.locator(format==='xlsx'?'.copilot:not(.collapsed)':'.ai-panel').first()
  const input=panel.locator('textarea')
  try{
   // The workbook renders its composer inside an inert shell until its first range loads.
   if(format==='xlsx'){
    await expect(editor.locator('html'),stage+' XLSX workbook becomes ready').toHaveAttribute('data-document-loading','ready',{timeout:45000})
    await expect.poll(()=>editor.locator('main.app-shell').evaluate(node=>!node.hasAttribute('inert')),{timeout:15000,message:stage+' XLSX shell becomes interactive'}).toBe(true)
   }
   await expect.poll(async()=>{
    if(await rail.isVisible()||await input.isVisible())return 'available'
    return (await editor.locator('html').getAttribute('data-document-loading',{timeout:1000}).catch(()=>null))??'not mounted'
   },{timeout:45000,message:stage+' '+format+' assistant becomes available'}).toBe('available')
  }
  catch(error){t.diagnostic(loadErrors.join('\n'));throw error}
  if(await rail.isVisible())await rail.click()
  return panel
 }
 const conditional={
  docx:['web_search','image_search','generate_image','analyze_media'],
  xlsx:['web_search','image_search','generate_image'],
  pptx:['web_search','image_search','generate_image','analyze_media'],
  pdf:['image_search','generate_image'],
 }
 const probe=async(format,stage,{configured=false,direct=false,videoOnly=false}={})=>{
  const panel=await openAssistant(format,stage,direct)
  if(format==='docx'&&videoOnly){
   await panel.locator('.ai-plus-btn').click()
   const chooser=page.waitForEvent('filechooser')
   await panel.getByRole('menuitem',{name:'添加文件',exact:true}).click()
   const image=new PNG({width:1,height:1});image.data.set([255,0,0,255])
   await (await chooser).setFiles({name:'pixel.png',mimeType:'image/png',buffer:PNG.sync.write(image)})
   await expect(panel.getByRole('img',{name:'pixel.png',exact:true})).toBeVisible()
  }
  await panel.locator('textarea').fill('Office capability probe '+stage+' '+format)
  await expect(panel.getByRole('button',{name:'发送',exact:true})).toBeEnabled({timeout:15000})
  const previous=frames.length
  await panel.getByRole('button',{name:'发送',exact:true}).click()
  await expect(panel.getByText('Office tool inventory received '+stage+' '+format,{exact:true})).toBeVisible({timeout:15000})
  assert.equal(frames.length,previous+1,format+' should send one turn')
  const absent=new Set(configured?[]:conditional[format])
  // This fixture has no source analysis service. Media configuration and the
  // coding adapter do not make a frozen query result available for insertion.
  absent.add('insert_data_result')
  // No starred files; native PDF rotates through apply_ops.
  if(format==='docx'){
   for(const name of ['read_knowledge_file','search_knowledge_base'])absent.add(name)
   if(direct)absent.add('create_document')
  }
  if(format==='pdf'){
   absent.add('rotate_pages')
   absent.add('read_attachment') // Offered only to the turn with a text attachment.
   // Creating and opening a separate file requires the workspace parent.
   if(direct)for(const name of ['create_document','extract_pages','split_pdf','split_pages','merge_pages','confirm_pdf_copies'])absent.add(name)
  }
  const expected=[...ASSISTANT_FORMAT_TOOLS[format]].filter(name=>!absent.has(name))
  expected.push('list_agents','list_agent_data','delegate_agent_task')
  const tools=frames.at(-1)
  assert.deepEqual(tools.map(tool=>tool.name).sort(),expected.sort(),stage+' '+format+' model tools')
  if((format==='docx'&&!direct)||format==='xlsx'){
   const creation=tools.find(tool=>tool.name==='create_document')
   assert.deepEqual(creation.parameters.properties.type.enum,format==='docx'?['docx','pdf']:direct?['csv']:noWord?['xlsx','csv','pdf']:['xlsx','csv','docx','pdf'])
  }
  if(configured&&(format==='docx'||format==='pptx')){
   const analysis=tools.find(tool=>tool.name==='analyze_media')
   const {properties,required}=analysis.parameters
   assert.equal(/images/i.test(analysis.description),!videoOnly)
   assert.equal(/video or audio/i.test(analysis.description),videoOnly)
   assert.equal('blockIndex' in properties,format==='docx'&&!videoOnly)
   assert.equal('attachmentIndex' in properties,format==='docx'&&!videoOnly)
   assert.equal(required.includes('mediaUrls'),format==='pptx'||videoOnly)
  }
  return panel
 }
 if(noWord){
  const config=await app.inject({method:'GET',url:'/api/v1/capabilities',headers:{cookie:`__Host-dyoffice-session=${f.alice.token}`}})
  assert.equal(config.statusCode,200)
  assert.equal(config.json().docx,'unsupported')
  await probe('xlsx','chat-only')
  return
 }
 if(creationOnly){
  await probe('docx','chat-only')
  const workbook=await probe('xlsx','chat-only')
  const source=files.xlsx
  for(const type of ['xlsx','docx','pdf']){
   if(type!=='xlsx')await page.getByText('tools.xlsx',{exact:true}).first().click()
   const input=workbook.locator('textarea')
   await input.click()
   await input.fill('Excel workspace export '+type)
   await workbook.getByRole('button',{name:'发送',exact:true}).click()
   await expect(workbook.getByText('Finished '+type+' export',{exact:true})).toBeAttached({timeout:45000})
   const outcome=exportsByType.get(type)
   assert.ok(outcome&&!outcome.isError,JSON.stringify({type,outcome,loadErrors}))
   const name='Office export '+type+'.'+type
   assert.ok(outcome.output.includes(name),outcome.output)
   const exports=(await f.files.listFiles(f.alice.token)).files.filter(entry=>entry.name===name)
   assert.equal(exports.length,1)
   const {file:saved}=await f.files.openFile(f.alice.token,exports[0].id)
   assert.notEqual(saved.fileId,source.fileId)
   await expect(page).toHaveURL(url=>url.origin===origin&&url.hash==='#/file/'+saved.fileId)
   const opened=page.frameLocator(`iframe[data-document-id="${saved.fileId}"]`)
   await expect(opened.locator('html')).toHaveAttribute('data-document-loading','ready',{timeout:30000})
   if(type==='xlsx')await expect(opened.locator('main.app-shell:not([inert])')).toBeVisible()
   const bytes=await f.files.readFile(f.alice.token,saved.fileId,saved.revision)
   if(type==='pdf'){
    const {readPdfLeafObjects}=await import('../../../pdf/src/main/text-edit.ts')
    assert.ok((await readPdfLeafObjects(bytes)).some(leaf=>leaf.text==='Quarterly revenue checkpoint'))
   }else{
    const archive=await JSZip.loadAsync(bytes)
    if(type==='docx')assert.match(await archive.file('word/document.xml').async('string'),/Quarterly revenue checkpoint/)
    else{
     const sheet=await archive.file('xl/worksheets/sheet1.xml').async('string')
     assert.match(sheet,/<c r="A1"[^>]*><is><t\b[^>]*>Revenue<\/t><\/is><\/c>/)
     assert.match(sheet,/<c r="B2"[^>]*><v>25<\/v><\/c>/)
     assert.doesNotMatch(sheet,/<f[\s>]/)
    }
   }
  }
  assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,source.revision)
  assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),sources.find(([format])=>format==='xlsx')[1])
  await probe('docx','direct',{direct:true})
  const directWorkbook=await probe('xlsx','direct',{direct:true})
  const downloads=[]
  page.on('download',download=>downloads.push(download.suggestedFilename()))
  const before=network.writes
  await directWorkbook.locator('textarea').fill('Excel reply length probe')
  await directWorkbook.getByRole('button',{name:'发送',exact:true}).click()
  await expect(directWorkbook.getByText('这里只完成了开头。',{exact:true})).toBeVisible()
  await expect(directWorkbook.locator('.ai-chat')).toContainText('长度限制被截断')
  await expect(page.locator('.status-msg')).toContainText('长度限制被截断')
  assert.equal(network.writes,before+1)
  assert.deepEqual(downloads,[])
  assert.equal((await f.files.openFile(f.alice.token,directFiles.xlsx.fileId)).file.revision,directFiles.xlsx.revision)
  await directWorkbook.locator('textarea').fill('Standalone Excel CSV probe')
  const [csv]=await Promise.all([page.waitForEvent('download',{timeout:30000}),directWorkbook.getByRole('button',{name:'发送',exact:true}).click()])
  assert.equal(csv.suggestedFilename(),'Office CSV probe.csv')
  assert.match(await readFile(await csv.path(),'utf8'),/^Revenue,Formula,Date,Percent,Mass,Named formula/)
  await expect(directWorkbook.getByText('Standalone worksheet downloaded',{exact:true})).toBeVisible({timeout:30000})
  return
 }
 for(const format of formats)await probe(format,'chat-only')
 const search=[['web_search','web-search'],['image_search','image-search']].map(([kind,id])=>({id,kind,providerId:'serper',label:id,model:'',baseUrl:'https://google.serper.dev',enabled:true,apiKey:'test-key'}))
 const media=[
  {id:'image-gen',kind:'image_generation',providerId:'custom',label:'Custom images',model:'test-image',baseUrl:'https://images.example/v1',enabled:true},
  {id:'image-analysis',kind:'image_analysis',providerId:'openai',label:'Test vision',model:'gpt-4.1',baseUrl:'https://images.example/v1',enabled:true,apiKey:'test-key'},
 ]
 const configured=await configs.saveGlobalConfig(f.adminSigned.token,baseline.revision,{upserts:[...search,...media],defaults:{chat:'chat',...Object.fromEntries([...search,...media].map(entry=>[entry.kind,entry.id]))}})
 await probe('pdf','direct',{configured:true,direct:true})
 const word=await probe('docx','configured',{configured:true})
 const wordEditor=page.frameLocator(`iframe[data-document-id="${files.docx.fileId}"]`)
 const paragraphs=wordEditor.locator('.tiptap.doc-page')
 const wordImages=paragraphs.locator('img')
 const imageCount=await wordImages.count()
 await word.locator('textarea').fill('Word mind map probe')
 await word.getByRole('button',{name:'发送',exact:true}).click()
 await expect(word.getByText('Word mind map is ready',{exact:true})).toBeVisible()
 const map=word.locator('.ai-mindmap')
 await expect(map).toContainText('Office overview')
 await expect(map).toContainText('First section')
 await expect(wordImages).toHaveCount(imageCount)
 await map.getByRole('button',{name:'插入文档',exact:true}).click()
 await expect(wordImages).toHaveCount(imageCount+1)
 assert.equal((await f.files.openFile(f.alice.token,files.docx.fileId)).file.revision,files.docx.revision)
 const workbook=await probe('xlsx','configured',{configured:true})
 await page.route('**/api/v1/ai/search',route=>{
  assert.deepEqual(route.request().postDataJSON(),{kind:'image_search',query:'Synthetic blue image',maxResults:1})
  return route.fulfill({json:{method:'serper',images:[{title:'Blue',imageUrl:remoteImage,sourceUrl:'https://images.example',source:'Test'}]}})
 },{times:1})
 const imageRequests=[]
 await page.route('**/api/v1/ai/media',route=>{
  const request=route.request().postDataJSON()
  imageRequests.push(request.action)
  if(request.action==='generate_image'){
   assert.deepEqual(request,{action:'generate_image',prompt:'Synthetic WebP'})
   return route.fulfill({json:{url:'data:image/webp;base64,UklGRhwAAABXRUJQVlA4TA8AAAAvA8AAAAcQ/Y/+ByKi/wEA'}})
  }
  if(request.url!==remoteImage)return route.abort()
  return route.fulfill({json:{mime:'image/webp',base64:'UklGRhwAAABXRUJQVlA4TA8AAAAvAkAAAAcQ0f/+ByKi/wEA'}})
 })
 const green=new PNG({width:4,height:4})
 for(let i=0;i<16;i++)green.data.set([0,255,0,255],i*4)
 await workbook.locator('.ai-plus-btn').click()
 const chooser=page.waitForEvent('filechooser')
 await workbook.getByRole('menuitem',{name:'添加文件',exact:true}).click()
 await (await chooser).setFiles({name:'green.png',mimeType:'image/png',buffer:PNG.sync.write(green)})
 await expect(workbook.locator('.ai-attachments').getByRole('img',{name:'green.png',exact:true})).toBeVisible()
 await workbook.locator('textarea').fill('Excel WebP probe')
 await workbook.getByRole('button',{name:'发送',exact:true}).click()
 await expect(workbook.getByText('Excel images placed at B2, D4 and F6',{exact:true})).toBeVisible({timeout:30000})
 await workbook.locator('textarea').fill('Excel stale attachment probe')
 await workbook.getByRole('button',{name:'发送',exact:true}).click()
 await expect(workbook.getByText('Excel rejected the old attachment',{exact:true})).toBeVisible()
 assert.deepEqual(imageRequests,['generate_image','fetch_image'])
 const source=files.xlsx
 const xlsxFrame=page.frameLocator(`iframe[data-document-id="${source.fileId}"]`)
 const save=xlsxFrame.getByRole('button',{name:/^保存（(?:Ctrl\+S|⌘S)）$/})
 const head=async()=>(await f.files.openFile(f.alice.token,source.fileId)).file.revision
 const original=await f.files.readFile(f.alice.token,source.fileId,source.revision)
 assert.equal(await head(),source.revision)
 await expect(save).toBeEnabled()
 await save.click()
 await expect.poll(head,{timeout:30000}).not.toBe(source.revision)
 await expect(save).toBeDisabled()
 const revision=await head()
 const output=await f.files.readFile(f.alice.token,source.fileId,revision)
 const before=await sheetsNative.inspect(original),after=await sheetsNative.inspect(output)
 const images=after.visuals.filter(visual=>visual.kind==='image'&&!before.visuals.some(previous=>previous.id===visual.id))
  .sort((a,b)=>a.anchor.fromRow-b.anchor.fromRow)
 assert.deepEqual(images.map(image=>[image.sheetId,image.anchor.fromRow,image.anchor.fromColumn]),[
  [after.sheets[0].id,1,1],[after.sheets[0].id,3,3],[after.sheets[0].id,5,5],
 ])
 const expectedPixels=[[4,4,255,0,0,255],[3,2,0,0,255,255],[4,4,0,255,0,255]]
 const assertImage=(result,index)=>{
  assert.equal(result.mediaType,'image/png')
  const png=PNG.sync.read(Buffer.from(result.base64,'base64'))
  assert.deepEqual([png.width,png.height,...png.data.subarray(0,4)],expectedPixels[index])
 }
 for(const [index,image] of images.entries())assertImage(await sheetsNative.readMedia(output,image.id),index)
 // Only accept media requested by the reopened document, and read each body
 // as soon as its response arrives; Chromium can discard bodies on navigation.
 let reloadCommitted=false
 const trackReload=frame=>{if(frame===page.mainFrame())reloadCommitted=true}
 const mediaRequests=new WeakSet()
 const trackMedia=request=>{
  if(reloadCommitted&&request.method()==='POST'&&request.url()===`${origin}/api/v1/files/${source.fileId}/sheets/media`)mediaRequests.add(request)
 }
 page.on('framenavigated',trackReload)
 page.on('request',trackMedia)
 try{
  const reopened=images.map(image=>page.waitForResponse(response=>{
   const request=response.request()
   if(!response.ok()||!mediaRequests.has(request))return false
   const payload=request.postDataJSON()
   return payload.revision===revision&&payload.visualId===image.id
  }).then(response=>response.json()))
  const [media]=await Promise.all([Promise.all(reopened),page.reload()])
  for(const [index,result] of media.entries())assertImage(result,index)
 }finally{
  page.off('request',trackMedia)
  page.off('framenavigated',trackReload)
 }
 assert.equal(await head(),revision)
 assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),original)
 await probe('pptx','configured',{configured:true})
 const panel=await probe('pdf','configured',{configured:true})
 await panel.locator('textarea').fill('Office Harness probe pdf')
 await panel.getByRole('button',{name:'发送',exact:true}).click()
 const card=panel.locator('.ai-chat .assistant-task-message')
 try{
  await expect(card.locator('[data-state="running"]')).toBeVisible({timeout:15000})
  const log=card.locator('.assistant-task-log')
  await expect(log.getByText('PDF Harness working',{exact:true})).toBeVisible()
  await expect(panel.getByText('pdf parent turn resumed with total 42',{exact:true})).toHaveCount(0)
 }finally{releaseTask()}
 await expect(panel.getByText('pdf parent turn resumed with total 42',{exact:true})).toBeVisible({timeout:15000})
 await expect(card.locator('[data-state="succeeded"]')).toBeVisible()
 await configs.saveGlobalConfig(f.adminSigned.token,configured.revision,{
  upserts:[{id:'video',kind:'video_analysis',providerId:'gemini',label:'Test video',model:'gemini-2.5-flash',baseUrl:'https://images.example/v1beta',enabled:true,apiKey:'test-key'}],
  defaults:{image_analysis:null,video_analysis:'video'},
 })
 for(const format of ['docx','pptx'])await probe(format,'video-only',{configured:true,videoOnly:true})
 for(const format of ['docx','xlsx','pptx']){
  const panel=await openAssistant(format,'delegate')
  const fileId=files[format].fileId
  const head=async()=>(await f.files.openFile(f.alice.token,fileId)).file.revision
  const before=await head()
  await panel.locator('textarea').fill('Office Harness probe '+format)
  await panel.getByRole('button',{name:'发送',exact:true}).click()
  await expect(panel.getByText(format+' parent turn resumed with total 42',{exact:true})).toBeVisible({timeout:15000})
  await expect(panel.locator('.assistant-task-message:visible [data-state="succeeded"]')).toBeVisible()
  assert.equal(await head(),before,format+' delegation does not save the document')
 }
 const delegated=['pdf','docx','xlsx','pptx']
 assert.deepEqual(taskRuns,delegated.map(format=>'Calculate fixture total for '+format))
 assert.deepEqual(taskRequests.map(task=>[task.modelId,task.documentId]),delegated.map(format=>['test-coding',files[format].fileId]))
 assert.equal(new Set(taskRequests.map(task=>task.turnId)).size,delegated.length)
})
