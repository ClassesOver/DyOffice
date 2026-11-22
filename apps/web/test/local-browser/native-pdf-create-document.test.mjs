import test from 'node:test'
import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {PDFDocument} from 'pdf-lib'
import {expect} from '@playwright/test'
import JSZip from 'jszip'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {readPdfLeafObjects} from '../../../pdf/src/main/text-edit.ts'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {stubHomeHero} from '../helpers/home-hero.mjs'
import {password} from '../helpers/identity.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {officeBrowserAsset} from '../helpers/office-browser-assets.mjs'

const nativePdfDirectory=(process.env.DYOFFICE_TEST_NATIVE_PDF_DIST||process.env.DYOFFICE_TEST_OFFICE_ASSETS)&&officeBrowserAsset('pdf')
test('the homepage blank PDF saves and takes the first heading after Office writes following a connection failure',{skip:!nativePdfDirectory,timeout:90000},async t=>{
 const origin='http://localhost:4248',f=await fileFixture(t,{origin,buildApp:false})
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,
  csrfKey:f.csrfKey,objectStore:f.objects,nativePdfDirectory,localShellDirectory:officeBrowserAsset('local-shell')})
 f.cleanup.unshift(()=>app.close())
 await app.listen({port:4248,host:'127.0.0.1'})
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:1000}})
 await stubHomeHero(page)
 await page.route('**/api/v1/ai/catalog',r=>r.fulfill({json:{entries:[{id:'mock',label:'Office test model'}],defaultId:'mock'}}))
 const heading='Quarterly PDF review'
 let writeResult,failFirstWrite=true
 const modelRequests=[]
 const timeline=[]
 page.on('response',r=>{const p=new URL(r.url()).pathname;if(p.startsWith('/api/v1/files/'))timeline.push([p.split('/').at(-1),r.status()])})
 await page.route('**/api/v1/ai/turns',r=>{
  const {messages,tools}=r.request().postDataJSON().request
  const writable=tools.some(tool=>tool.name==='insert_text')
  modelRequests.push({roles:messages.map(item=>item.role),writable})
  if(writable&&failFirstWrite){
   failFirstWrite=false
   return r.fulfill({contentType:'text/event-stream',body:'event: error\ndata: {"message":"AI stream unavailable"}\n\nevent: done\ndata: {}\n\n'})
  }
  writeResult=messages.find(item=>item.role==='tool')?.results[0]??writeResult
  return r.fulfill({contentType:'text/event-stream',body:!writable
  ?'event: delta\ndata: {"text":"office"}\n\nevent: done\ndata: {}\n\n'
  :!writeResult
  ?'event: tool_call\ndata: '+JSON.stringify({id:'write',name:'insert_text',input:{page:1,text:heading+'\nReviewed by Office',x:30,y:70,font_size:16}})+'\n\nevent: done\ndata: {}\n\n'
  :'event: delta\ndata: {"text":"Draft written"}\n\nevent: done\ndata: {}\n\n'})
 })
 await page.goto(origin)
 await page.getByLabel('用户名',{exact:true}).fill('alice');await page.getByLabel('密码',{exact:true}).fill(password)
 await page.getByRole('button',{name:'登录',exact:true}).click()
 await page.getByText('AI PDF',{exact:true}).first().click()
 const frame=page.frameLocator('iframe[data-document-id]')
 await expect(frame.locator('html')).toHaveAttribute('data-document-loading','ready',{timeout:20000})
 const [blank]=(await f.files.listFiles(f.alice.token)).files
 assert.equal(blank.name,'未命名.pdf')
 assert.equal((await f.files.openFile(f.alice.token,blank.id)).pdfAutoNamePending,true)
 await frame.getByRole('button',{name:'AI 助手',exact:true}).click()
 const assistant=frame.locator('.shared-editor-assistant')
 await assistant.getByRole('textbox',{name:'消息'}).fill('写一段 PDF 季度回顾')
 await assistant.getByRole('button',{name:'发送',exact:true}).click()
 await expect(assistant.getByRole('alert')).toHaveText('AI stream unavailable')
 await expect(assistant.getByRole('textbox',{name:'消息'})).toHaveValue('写一段 PDF 季度回顾')
 assert.equal((await f.files.openFile(f.alice.token,blank.id)).file.revision,blank.revision)
 assert.equal(modelRequests.filter(call=>call.writable).length,1)
 await assistant.getByRole('button',{name:'发送',exact:true}).click()
 await expect(assistant.getByText('Draft written',{exact:true})).toBeVisible()
 assert.ok(writeResult&&!writeResult.isError,JSON.stringify({writeResult,modelRequests,timeline}))
 try{await expect.poll(async()=>(await f.files.openFile(f.alice.token,blank.id)).name,{timeout:12000}).toBe(heading+'.pdf')}
 catch(error){throw Error('PDF file flow: '+JSON.stringify(timeline),{cause:error})}
 await expect(page.locator('iframe[data-document-id]')).toHaveAttribute('title',heading+'.pdf')
 const saved=(await f.files.openFile(f.alice.token,blank.id)).file
 assert.notEqual(saved.revision,blank.revision)
 assert.ok((await readPdfLeafObjects(await f.files.readFile(f.alice.token,blank.id,saved.revision))).some(item=>item.text===heading))
 assert.equal(modelRequests.filter(call=>call.writable).length,3)
})

test('native PDF assistant creates saved PDF and DOCX separately from the source',{skip:!nativePdfDirectory,timeout:90000},async t=>{
 const origin='http://localhost:4247',f=await fileFixture(t,{origin,buildApp:false})
 const keyring={activeKeyId:'creation',keys:{creation:new Uint8Array(32).fill(37)}}
 const seed=await PDFDocument.create()
 seed.addPage([400,300]).drawText('Source text',{x:30,y:250})
 const original=Buffer.from(await seed.save()),{file}=await importFile(f,f.alice.token,original,'source.pdf')
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[{id:'fixture',kind:'chat',providerId:'openai',label:'Fixture',model:'synthetic',baseUrl:'https://provider.example/v1',apiKey:'fixture-key',enabled:true}],defaults:{chat:'fixture'}})
 const app=await buildLocalApp({
  db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,
  globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false,nativePdfDirectory,
  nativeDocsDirectory:officeBrowserAsset('docs'),localShellDirectory:officeBrowserAsset('local-shell'),
 })
 f.cleanup.unshift(()=>app.close())
 await app.listen({port:4247,host:'127.0.0.1'})
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:1000}})
 await stubHomeHero(page)
 await page.goto(origin)
 await page.getByLabel('用户名',{exact:true}).fill('alice')
 await page.getByLabel('密码',{exact:true}).fill(password)
 await page.getByRole('button',{name:'登录',exact:true}).click()
 await expect(page.locator('.home')).toBeVisible()
 const sourceFrame=page.frameLocator(`iframe[data-document-id="${file.fileId}"]`)
 const assistant=sourceFrame.locator('.shared-editor-assistant')
 let turn=0,readAttachment=false
 const sourceFact='Intake checkpoint Q7X4'
 const limitedPrompt='先测试模型长度上限'
 const types=['pdf','docx']
 const network=mockProviderNetwork(t,()=>{
  const last=JSON.parse(network.wire.toString()).messages.at(-1)
  if(last.role==='user'&&typeof last.content==='string'&&last.content.includes(limitedPrompt)){
   const response={choices:[{delta:{content:'这里只完成了开头。',tool_calls:[{index:0,id:'cutoff',type:'function',function:{name:'create_document',arguments:JSON.stringify({title:'Must not be created',content:'<p>Pending</p>'})}}]},finish_reason:'length'}]}
   return Readable.from([Buffer.from('data: '+JSON.stringify(response)+'\n\n')])
  }
  if(!readAttachment){
   const payload=last.content
   assert.ok(Array.isArray(payload))
   assert.match(payload.find(part=>part.type==='text').text,/Reference notes\.txt/)
   assert.ok(payload.some(part=>part.type==='image_url'&&part.image_url.url.startsWith('data:image/png;base64,')))
   readAttachment=true
   const response={choices:[{delta:{tool_calls:[{index:0,id:'read-ref',type:'function',function:{name:'read_attachment',arguments:'{"index":0}'}}]},finish_reason:'tool_calls'}]}
   return Readable.from([Buffer.from('data: '+JSON.stringify(response)+'\n\ndata: [DONE]\n\n')])
  }
  if(turn===0){
   assert.equal(last.tool_call_id,'read-ref')
   assert.match(last.content,new RegExp(sourceFact))
  }
  const index=Math.floor(turn/2),type=types[index],isTool=turn++%2===0
  const delta=isTool?{tool_calls:[{index:0,id:'create-'+type,type:'function',function:{name:'create_document',arguments:JSON.stringify({...(type==='docx'?{type}:{}),title:'Report '+type,content:'<p>Independent report '+type+'</p>'+(type==='pdf'?'<p>'+sourceFact+'</p>':'')})}}]}:{content:'Created result '+type}
  return Readable.from([Buffer.from('data: '+JSON.stringify({choices:[{delta,finish_reason:isTool?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n')])
 })
 for(const type of types){
  if(type==='pdf'){
   await page.goto(origin+'/#/file/'+file.fileId)
   await expect(sourceFrame.locator('html')).toHaveAttribute('data-document-loading','ready')
   await sourceFrame.getByRole('button',{name:'AI 助手',exact:true}).click()
   await assistant.getByRole('textbox',{name:'消息'}).fill(limitedPrompt)
   const savedCutoff=page.waitForResponse(response=>response.ok()&&new URL(response.url()).pathname===`/api/v1/files/${file.fileId}/assistant-chat`
    &&response.request().postDataJSON()?.updates?.some(update=>update.role==='assistant'&&update.state==='failed'&&update.text==='这里只完成了开头。'))
   await assistant.getByRole('button',{name:'发送',exact:true}).click()
   await expect(assistant.getByText('这里只完成了开头。',{exact:true})).toBeVisible()
   await expect(assistant.getByRole('alert')).toHaveText(/长度上限.*分段/)
   assert.equal(network.writes,1)
   assert.equal((await f.files.listFiles(f.alice.token)).files.length,1)
   await savedCutoff
   await page.reload()
   await expect(sourceFrame.locator('html')).toHaveAttribute('data-document-loading','ready')
   await sourceFrame.getByRole('button',{name:'AI 助手',exact:true}).click()
   const restored=assistant.locator('.ai-msg-assistant').filter({hasText:'这里只完成了开头。'})
   await expect(restored.getByText('未完成',{exact:true})).toBeVisible()
   assert.equal(network.writes,1)
   const choose=page.waitForEvent('filechooser')
   const parsed=page.waitForResponse(response=>response.url().includes('/api/v1/ai/attachments/parse?')&&response.ok())
   await assistant.locator('.ai-plus-btn').click()
   await assistant.getByRole('menuitem',{name:'添加文件',exact:true}).click()
   await (await choose).setFiles({name:'Reference notes.txt',mimeType:'text/plain',buffer:Buffer.from(sourceFact)})
   await parsed
   await expect(assistant.getByText('Reference notes.txt',{exact:true})).toBeVisible()
   await assistant.getByRole('textbox',{name:'消息'}).evaluate(textarea=>{
    const data=new DataTransfer()
    const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII='),c=>c.charCodeAt(0))
    data.items.add(new File([bytes],'pixel.png',{type:'image/png'}))
    const paste=new ClipboardEvent('paste',{bubbles:true,cancelable:true})
    // Firefox drops files supplied through the synthetic ClipboardEvent initializer.
    Object.defineProperty(paste,'clipboardData',{value:data})
    textarea.dispatchEvent(paste)
   })
   await expect(assistant.getByRole('button',{name:'移除附件 pixel.png',exact:true})).toBeVisible()
  }else{
   await page.getByText('source.pdf',{exact:true}).first().click()
  }
  const composer=assistant.getByRole('textbox',{name:'消息'})
  // After switching back to the PDF, focus its iframe before filling the composer.
  await composer.click()
  const prompt='创建一个独立的 '+type.toUpperCase()+' 报告'
  await composer.fill(prompt)
  await expect(composer).toHaveValue(prompt)
  const [request]=await Promise.all([
   page.waitForRequest(req=>req.method()==='POST'&&new URL(req.url()).pathname==='/api/v1/ai/turns'),
   assistant.getByRole('button',{name:'发送',exact:true}).click(),
  ])
  const tools=request.postDataJSON().request.tools
  if(type==='pdf')assert.ok(tools.some(tool=>tool.name==='read_attachment'))
  else assert.ok(!tools.some(tool=>tool.name==='read_attachment'))
  assert.deepEqual(tools.find(tool=>tool.name==='create_document')?.inputSchema.properties.type.enum,['pdf','docx'])
  await expect(assistant.getByText('Created result '+type,{exact:true})).toBeAttached({timeout:45000})
  const reply=JSON.parse(network.wire.toString()).messages.filter(message=>message.role==='tool').at(-1)
  const created=(await f.files.listFiles(f.alice.token)).files.find(entry=>entry.name==='Report '+type+'.'+type)
  assert.ok(created,reply?.content)
  await expect(page).toHaveURL(origin+'/#/file/'+created.id)
  const saved=(await f.files.openFile(f.alice.token,created.id)).file
  assert.ok(reply.content.includes(saved.fileId)&&reply.content.includes(saved.revision),reply.content)
  const bytes=await f.files.readFile(f.alice.token,saved.fileId,saved.revision)
  if(type==='docx'){
   const archive=await JSZip.loadAsync(bytes)
   assert.match(await archive.file('word/document.xml').async('string'),/Independent report docx/)
  }else{
   const text=(await readPdfLeafObjects(bytes)).map(leaf=>leaf.text)
   assert.ok(text.includes('Independent report pdf'))
   assert.ok(text.includes(sourceFact))
  }
 }
 assert.equal((await f.files.listFiles(f.alice.token)).files.length,3)
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
})
