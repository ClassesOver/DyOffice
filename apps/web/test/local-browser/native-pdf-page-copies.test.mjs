import test from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {Readable} from 'node:stream'
import {fileURLToPath} from 'node:url'
import {PDFDocument} from 'pdf-lib'
import {expect} from '@playwright/test'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {launchTestBrowser,recordVerifiedOfficeEffect} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {stubHomeHero} from '../helpers/home-hero.mjs'
import {password} from '../helpers/identity.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'

const nativePdfDirectory=process.env.DYOFFICE_TEST_NATIVE_PDF_DIST
const cases=[
 ['extract_pages',{pages:'3,1'},[['source-提取.pdf',[400,600]]]],
 ['split_pdf',{pages_per_file:2},[]],
 ['confirm_pdf_copies',{},[['source-part-1.pdf',[400,500]],['source-part-2.pdf',[600]]]],
 ['split_pages',{per_page:2},[['source-split-pages.pdf',[200,200,250,250,300,300]]]],
 ['merge_pages',{per_sheet:2},[['source-merged-pages.pdf',2]]],
 ['crop_pages',{pages:'1',left:.1,top:.1,right:.9,bottom:.9},[]],
 ['crop_pages',{pages:'2',left:.1,top:.1,right:.9,bottom:.9},[]],
 ['set_page_size',{width:420,height:595},[]],
 ['insert_blank_page',{after_page:1},[]],
 ['extract_pages',{pages:'2'},[]],
]
test('native PDF assistant and ribbon save separate page copies',{skip:!nativePdfDirectory,timeout:150000},async t=>{
 const origin='http://localhost:4290',f=await fileFixture(t,{origin,buildApp:false})
 const keyring={activeKeyId:'copies',keys:{copies:new Uint8Array(32).fill(37)}}
 const source=await PDFDocument.create()
 for(const width of [400,500,600])source.addPage([width,300]).drawText('Source '+width,{x:30,y:250})
 const original=Buffer.from(await source.save()),{file}=await importFile(f,f.alice.token,original,'source.pdf')
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[{id:'fixture',kind:'chat',providerId:'openai',label:'Fixture',model:'synthetic',baseUrl:'https://provider.example/v1',apiKey:'fixture-key',enabled:true}],defaults:{chat:'fixture'}})
 const app=await buildLocalApp({
  db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,rateLimit:{max:5000,windowMs:60000},
  globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false,nativePdfDirectory,
  localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url)),
 })
 f.cleanup.unshift(()=>app.close())
 await app.listen({port:4290,host:'127.0.0.1'})
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:1000}})
 await stubHomeHero(page)
 await page.goto(origin)
 await page.getByLabel('用户名',{exact:true}).fill('alice')
 await page.getByLabel('密码',{exact:true}).fill(password)
 await page.getByRole('button',{name:'登录',exact:true}).click()
 await expect(page.locator('.home')).toBeVisible()
 await page.goto(origin+'/#/file/'+file.fileId)
 const frame=page.frameLocator(`iframe[data-document-id="${file.fileId}"]`)
 await expect(frame.locator('html')).toHaveAttribute('data-document-loading','ready')
 await frame.getByRole('button',{name:'AI 助手',exact:true}).click()
 const assistant=frame.locator('.shared-editor-assistant')
 let confirmationCount=0
 page.on('dialog',async dialog=>{
  if(dialog.type()!=='confirm'){await dialog.dismiss();return}
  confirmationCount++
  if(confirmationCount===1)await dialog.dismiss()
  else await dialog.accept()
 })
 let turn=0
 let dropped=false
 await page.route('**/api/v1/uploads/*/finish',async route=>{
  if(turn!==3||dropped){await route.continue();return}
  try{
   const request=route.request()
   const response=await app.inject({method:'POST',url:new URL(request.url()).pathname,headers:await request.allHeaders()})
   dropped=response.statusCode===200
   if(!dropped)t.diagnostic('finish response: '+response.statusCode)
  }finally{await route.abort('failed')}
 })
 const network=mockProviderNetwork(t,()=>{
  const index=Math.floor(turn/2),[name,input]=cases[index],isTool=turn++%2===0
  const delta=isTool?{tool_calls:[{index:0,id:'call-'+turn,type:'function',function:{name,arguments:JSON.stringify(input)}}]}:{content:'Finished case '+index}
  return Readable.from([Buffer.from('data: '+JSON.stringify({choices:[{delta,finish_reason:isTool?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n')])
 })
 for(const [index,[name,,outputs]] of cases.entries()){
  const request=page.waitForRequest(req=>req.method()==='POST'&&new URL(req.url()).pathname==='/api/v1/ai/turns')
  await assistant.getByRole('textbox',{name:'消息'}).fill(name+' '+index)
  await assistant.getByRole('button',{name:'发送',exact:true}).click()
  const {tools,system}=(await request).postDataJSON().request
  assert.ok(tools.some(tool=>tool.name===name),`Missing native PDF tool ${name}`)
  if(index===0){
   assert.match(system,/Ordinary edits create unsaved drafts/)
   assert.match(system,/crop_pages, set_page_size, replace_pages.*user confirmation.*new revision/)
   assert.match(system,/extract_pages, split_pdf, split_pages, merge_pages.*separate saved PDF/)
  }
  await expect(assistant.getByText('Finished case '+index,{exact:true})).toBeAttached({timeout:20000})
  const reply=JSON.parse(network.wire.toString()).messages.filter(message=>message.role==='tool').at(-1)
  if(name==='split_pdf'){
   assert.equal(dropped,true)
   assert.match(reply.content,/batch incomplete.*confirm_pdf_copies/)
   await expect(page).toHaveURL(origin+'/#/file/'+file.fileId)
   continue
  }
  if(name==='insert_blank_page'){
   assert.match(reply.content,/blank page/i)
   continue
  }
  if(name==='crop_pages'||name==='set_page_size'){
   if(name==='crop_pages'&&confirmationCount===1){
    assert.match(reply.content,/user canceled/)
    assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
    continue
   }
   assert.match(reply.content,/saved a new revision/i)
   const {file:saved}=await f.files.openFile(f.alice.token,file.fileId)
   assert.notEqual(saved.revision,file.revision)
   const pdf=await PDFDocument.load(await f.files.readFile(f.alice.token,file.fileId,saved.revision))
   if(name==='crop_pages'){
    assert.equal(pdf.getPage(0).getCropBox().width,400)
    assert.equal(pdf.getPage(1).getCropBox().width,400)
    assert.equal(pdf.getPage(1).getCropBox().height,240)
    assert.equal(pdf.getPage(1).getWidth(),500)
   }else assert.deepEqual(pdf.getPages().map(item=>item.getSize()),Array(3).fill({width:420,height:595}))
   continue
  }
  if(!outputs.length){
   assert.match(reply.content,/Save or discard PDF changes/)
   continue
  }
  const entries=(await f.files.listFiles(f.alice.token)).files
  let last
  for(const [output,geometry] of outputs){
   const entry=entries.find(item=>item.name===output)
   assert.ok(entry,reply?.content)
   last=entry.id
   const {file:saved}=await f.files.openFile(f.alice.token,entry.id)
   assert.ok(reply.content.includes(saved.fileId)&&reply.content.includes(saved.revision),reply.content)
   const bytes=await f.files.readFile(f.alice.token,entry.id,saved.revision)
   const pdf=await PDFDocument.load(bytes)
   assert.deepEqual(Array.isArray(geometry)?pdf.getPages().map(item=>item.getWidth()):pdf.getPageCount(),geometry)
   if(name==='merge_pages'){
    const text=execFileSync('pdftotext',['-','-'],{input:bytes,encoding:'utf8'})
    assert.deepEqual(text.match(/Source \d+/g),['Source 400','Source 500','Source 600'])
   }
  }
  await expect(page).toHaveURL(origin+'/#/file/'+last)
  await expect(page.frameLocator(`iframe[data-document-id="${last}"]`).locator('html')).toHaveAttribute('data-document-loading','ready')
  await page.getByText('source.pdf',{exact:true}).first().click()
 }
 assert.equal((await f.files.listFiles(f.alice.token)).files.length,6)
 assert.equal(confirmationCount,3)
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
 for(const effect of ['extract_pages','confirm_pdf_copies','split_pages','merge_pages','crop_pages','set_page_size']){
  recordVerifiedOfficeEffect('pdf',effect)
 }
 await frame.getByRole('button',{name:/^撤销/}).click()
 await frame.getByRole('button',{name:'页面',exact:true}).click()
 await frame.getByRole('button',{name:'抽取本页',exact:true}).click()
 await frame.getByPlaceholder(/页码或范围/).fill('2')
 let ribbonFile
 await page.route('**/api/v1/uploads/*/finish',async route=>{
  try{
   const request=route.request()
   const response=await app.inject({method:'POST',url:new URL(request.url()).pathname,headers:await request.allHeaders()})
   assert.equal(response.statusCode,200)
   ribbonFile=response.json().file
  }finally{await route.abort('failed')}
 },{times:1})
 await frame.getByPlaceholder(/页码或范围/).press('Enter')
 const confirm=frame.getByRole('button',{name:'确认副本保存结果'})
 await expect(confirm).toBeVisible({timeout:20000})
 assert.ok(ribbonFile)
 const last=ribbonFile.fileId
 await confirm.click()
 await expect(page).toHaveURL(origin+'/#/file/'+last)
 await expect(page.frameLocator(`iframe[data-document-id="${last}"]`).locator('html')).toHaveAttribute('data-document-loading','ready')
 assert.equal((await f.files.listFiles(f.alice.token)).files.length,7)
 assert.notEqual(last,file.fileId)
 const {file:actual}=await f.files.openFile(f.alice.token,last)
 assert.equal((await PDFDocument.load(await f.files.readFile(f.alice.token,last,actual.revision))).getPageCount(),1)

 const casesFromRibbon=[
  ['拆分 PDF',[1,2],async modal=>{
   await modal.getByPlaceholder(/每 N 页/).fill('2')
   await modal.getByPlaceholder(/每 N 页/).press('Enter')
  }],
  ['拆分页面',[6],modal=>modal.getByRole('button',{name:'1 分 2',exact:true}).click()],
  ['合并页面',[1],async modal=>{
   await modal.getByLabel('每张合并页数').fill('3')
   await modal.getByLabel('显示分隔线').check()
   await modal.getByLabel('每张合并页数').press('Enter')
  }],
 ]
 const sourceRevision=(await f.files.openFile(f.alice.token,file.fileId)).file.revision
 const sourceBytes=await f.files.readFile(f.alice.token,file.fileId,sourceRevision)
 const layoutResponses=[]
 page.on('response',response=>{
  if(/\/(lease|page-layout\/uploads)$/.test(response.url()))layoutResponses.push(response)
 })
 for(const [label,expected,submit] of casesFromRibbon){
  await page.getByRole('tab',{name:'source.pdf',exact:true}).click()
  await expect.poll(()=>frame.locator('html').evaluate(()=>window.dyofficeEditorCanClose())).toBe(true)
  const previous=new Set((await f.files.listFiles(f.alice.token)).files.map(item=>item.id))
  await frame.getByRole('button',{name:label,exact:true}).click()
  await submit(frame.locator('.pdf-modal'))
  const added=async()=>(await f.files.listFiles(f.alice.token)).files.filter(item=>!previous.has(item.id))
  try{
   await expect.poll(async()=>(await added()).length,{timeout:15000,message:label}).toBe(expected.length)
  }catch(error){
   for(const response of layoutResponses)t.diagnostic(`${response.request().method()} ${new URL(response.url()).pathname} ${response.status()} ${response.ok()?'':await response.text()}`)
   t.diagnostic(await frame.locator('.dyoffice-pdf-persistence-state').getAttribute('title')??'No persistence error')
   throw error
  }
  const newFiles=await added()
  const pageCounts=[]
  for(const item of newFiles){
   const {file:saved}=await f.files.openFile(f.alice.token,item.id)
   const output=await PDFDocument.load(await f.files.readFile(f.alice.token,item.id,saved.revision))
   pageCounts.push(output.getPageCount())
   await expect(page.locator(`iframe[data-document-id="${item.id}"]`)).toBeAttached()
  }
  assert.deepEqual(pageCounts.sort((a,b)=>a-b),expected,label)
  assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,sourceRevision)
 }
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,sourceRevision),sourceBytes)
 await page.getByRole('tab',{name:'source.pdf',exact:true}).click()
 const targetFrame=page.frameLocator(`iframe[data-document-id="${file.fileId}"]`)
 const imported=await PDFDocument.create()
 imported.addPage([700,300]).drawText('Imported marker',{x:25,y:260})
 const importedBytes=Buffer.from(await imported.save())
 const chooser=page.waitForEvent('filechooser')
 await targetFrame.getByRole('button',{name:'导入页面',exact:true}).click()
 await targetFrame.getByLabel('选择来源 PDF', {exact:true}).click()
 const fileChooser=await chooser
 await fileChooser.setFiles({name:'import.pdf',mimeType:'application/pdf',buffer:importedBytes})
 const route='/api/v1/files/'+file.fileId
 const saved=page.waitForResponse(response=>{
  if(response.request().method()!=='POST')return false
  const path=new URL(response.url()).pathname
  return path===route+'/commits'||path===route+'/pdf/insert-pages/uploads'&&!response.ok()
 },{timeout:25000})
 await targetFrame.getByRole('button',{name:'确认导入并保存'}).click()
 const saveResponse=await saved
 assert.ok(saveResponse.ok(),await saveResponse.text())
 const {revision}=await saveResponse.json()
 const {file:inserted}=await f.files.openFile(f.alice.token,file.fileId)
 assert.equal(inserted.revision,revision)
 assert.notEqual(inserted.revision,sourceRevision)
 const insertedBytes=await f.files.readFile(f.alice.token,file.fileId,inserted.revision)
 const insertedDoc=await PDFDocument.load(insertedBytes)
 assert.equal(insertedDoc.getPageCount(),4)
 const insertedText=await (await import('../../../pdf/src/main/text-edit.ts')).readPdfLeafObjects(insertedBytes)
 assert.ok(insertedText.some(item=>item.type===1&&item.text.includes('Imported marker')))
 const pageTexts=execFileSync('pdftotext',['-','-'],{input:insertedBytes,encoding:'utf8'}).split('\f').map(text=>text.trim())
 assert.equal(pageTexts.filter(text=>text.includes('Imported marker')).length,1)
 assert.equal(pageTexts.filter(text=>text.includes('Source 400')).length,1)
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,sourceRevision),sourceBytes)
})

test('native PDF assistant replaces only the confirmed page and splits the saved result',{skip:!nativePdfDirectory,timeout:120000},async t=>{
 const port=4290,origin='http://localhost:'+port,f=await fileFixture(t,{origin,buildApp:false})
 const keyring={activeKeyId:'replace',keys:{replace:new Uint8Array(32).fill(37)}}
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{
  upserts:[{id:'fixture',kind:'chat',providerId:'openai',label:'Fixture',model:'synthetic',baseUrl:'https://provider.example/v1',apiKey:'fixture-key',enabled:true}],
  defaults:{chat:'fixture'},
 })
 const originalDoc=await PDFDocument.create()
 for(const width of [400,500,600])originalDoc.addPage([width,300]).drawText('Source '+width,{x:30,y:250})
 const original=Buffer.from(await originalDoc.save()),{file}=await importFile(f,f.alice.token,original,'replace-source.pdf')
 const app=await buildLocalApp({
  db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,
  globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false,nativePdfDirectory,
  localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url)),
 })
 f.cleanup.unshift(()=>app.close())
 await app.listen({port,host:'127.0.0.1'})
 const network=mockProviderNetwork(t,()=>{
  const {messages}=JSON.parse(network.wire.toString()),last=messages.at(-1)
  const content=messages.findLast(message=>message.role==='user')?.content
  const prompt=typeof content==='string'?content:content?.map(part=>part.text??'').join(' ')
  const split=prompt?.includes('每两页另存为副本')
  const action=split?{name:'split_pdf',arguments:'{"pages_per_file":2}'}:{name:'replace_pages',arguments:'{"pages":"2"}'}
  const result=last.role==='tool'?JSON.parse(last.content):undefined
  if(result){
   assert.ok(!result.isError,result.output)
   assert.match(result.output,split?/Saved and opened 2 PDF file/:/Replaced the selected pages and saved a new revision/)
  }
  const delta=result?{content:split?'已保存两个副本':'已保存替换页'}:{tool_calls:[{index:0,id:action.name,type:'function',function:action}]}
  return Readable.from([Buffer.from('data: '+JSON.stringify({choices:[{delta,finish_reason:result?'stop':'tool_calls'}]})+'\n\ndata: [DONE]\n\n')])
 })
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage()
 await stubHomeHero(page)
 await page.goto(origin)
 await page.getByLabel('用户名',{exact:true}).fill('alice')
 await page.getByLabel('密码',{exact:true}).fill(password)
 await page.getByRole('button',{name:'登录',exact:true}).click()
 await expect(page.locator('.home')).toBeVisible()
 await page.goto(origin+'/#/file/'+file.fileId)
 const frame=page.frameLocator(`iframe[data-document-id="${file.fileId}"]`)
 const assistant=frame.locator('.shared-editor-assistant')
 async function send(prompt){
  await expect(frame.locator('html')).toHaveAttribute('data-document-loading','ready',{timeout:30000})
  await expect(frame.locator('.dyoffice-pdf-persistence-state')).toHaveText('已保存')
  const composer=assistant.getByRole('textbox',{name:'消息'})
  if(!await composer.isVisible())await frame.getByRole('button',{name:'AI 助手',exact:true}).click()
  await composer.fill(prompt)
  await assistant.getByRole('button',{name:'发送',exact:true}).click()
 }
 await send('替换第二页')
 const dialog=frame.getByRole('dialog',{name:'替换第 2 页',exact:true})
 await expect(dialog).toBeVisible({timeout:20000})
 const confirm=dialog.getByRole('button',{name:'确认替换并保存'})
 await expect(confirm).toBeDisabled()
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
 const replacement=await PDFDocument.create()
 replacement.addPage([710,300]).drawText('Replacement marker',{x:25,y:260})
 await dialog.getByLabel('选择来源 PDF',{exact:true}).setInputFiles({name:'replacement.pdf',mimeType:'application/pdf',buffer:Buffer.from(await replacement.save())})
 const stage=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/v1/files/'+file.fileId+'/pdf/replace-pages/uploads')
 await confirm.click()
 const staged=await stage
 assert.ok(staged.ok(),await staged.text())
 await expect(assistant.getByText('已保存替换页',{exact:true})).toBeAttached({timeout:30000})
 const {file:replaced}=await f.files.openFile(f.alice.token,file.fileId)
 assert.notEqual(replaced.revision,file.revision)
 const bytes=await f.files.readFile(f.alice.token,file.fileId,replaced.revision)
 assert.deepEqual((await PDFDocument.load(bytes)).getPages().map(value=>value.getWidth()),[400,710,600])
 const texts=execFileSync('pdftotext',['-','-'],{input:bytes,encoding:'utf8'}).split('\f').map(text=>text.trim()).filter(Boolean)
 assert.deepEqual(texts,['Source 400','Replacement marker','Source 600'])
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
 await page.reload({waitUntil:'commit'})
 await send('每两页另存为副本')
 await expect(assistant.getByText('已保存两个副本',{exact:true})).toBeAttached({timeout:30000})
 const files=(await f.files.listFiles(f.alice.token)).files
 assert.equal(files.length,3)
 for(const [part,widths] of [[1,[400,710]],[2,[600]]]){
  const copy=files.find(entry=>entry.name===`replace-source-part-${part}.pdf`)
  assert.ok(copy)
  const saved=(await f.files.openFile(f.alice.token,copy.id)).file
  const document=await PDFDocument.load(await f.files.readFile(f.alice.token,copy.id,saved.revision))
  assert.deepEqual(document.getPages().map(value=>value.getWidth()),widths)
 }
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,replaced.revision)
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,replaced.revision),bytes)
 recordVerifiedOfficeEffect('pdf','replace_pages')
 recordVerifiedOfficeEffect('pdf','split_pdf')
})
