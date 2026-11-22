import test from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {PDFDocument,PDFName,PDFString,rgb} from 'pdf-lib'
import {expect} from '@playwright/test'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {launchTestBrowser,recordVerifiedOfficeEffect} from '../helpers/browser.mjs'
import {password} from '../helpers/identity.mjs'
import {isHomeHeroRequest,stubHomeHero} from '../helpers/home-hero.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {fileURLToPath} from 'node:url'
import {readFile} from 'node:fs/promises'
import {Readable} from 'node:stream'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {readPdfLeafObjects} from '../../../pdf/src/main/text-edit.ts'
import {readImageSource} from '../../../pdf/src/main/image-edit.ts'
import {pdfInsertFormState} from '../../server/src/pdf/insert-form-integrity.mjs'
import {PNG} from 'pngjs'
import {renderPdfPages} from '../../server/src/pdf/raster.mjs'

const directory=process.env.DYOFFICE_TEST_NATIVE_PDF_DIST
const liveImageConfig=process.env.DYOFFICE_LIVE_PDF_IMAGE_CONFIG
test('native PDF assistant saves a rotation and reopens the new revision',{skip:!directory,timeout:60000},async t=>{
 const origin='http://localhost:4274',f=await fileFixture(t,{origin,buildApp:false})
 const fixture=await PDFDocument.create()
 for(let index=0;index<3;index++)fixture.addPage([240,300]).drawText('Page '+(index+1),{x:20,y:200})
 const original=Buffer.from(await fixture.save())
 const {file}=await importFile(f,f.alice.token,original,'rotation.pdf')
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,
  origin,csrfKey:f.csrfKey,objectStore:f.objects,nativePdfDirectory:directory,
  localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 f.cleanup.unshift(()=>app.close())
 await app.listen({port:4274,host:'127.0.0.1'})
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage()
 await stubHomeHero(page)
 await page.route('**/api/v1/ai/catalog',route=>route.fulfill({json:{entries:[{id:'mock',label:'Rotation fixture model'}],defaultId:'mock'}}))
 const calls=[]
 await page.route('**/api/v1/ai/turns',route=>{
  if(isHomeHeroRequest(route.request()))return route.fallback()
  calls.push(route.request().postDataJSON().request)
  const body=calls.length===1
   ? 'event: tool_call\ndata: '+JSON.stringify({id:'native-rotation',name:'apply_ops',input:{ops:[{op:'rotatePages',pages:[2],dir:90}]}})
   : 'event: delta\ndata: {"text":"Rotation queued"}'
  return route.fulfill({contentType:'text/event-stream',body:body+'\n\nevent: done\ndata: {}\n\n'})
 })
 await page.goto(origin)
 await page.getByLabel('用户名',{exact:true}).fill('alice')
 await page.getByLabel('密码',{exact:true}).fill(password)
 await page.getByRole('button',{name:'登录',exact:true}).click()
 await expect(page.locator('.home')).toBeVisible()
 await page.goto(origin+'/native-pdf/?fileId='+file.fileId)
 const ready=page.locator('html')
 await expect(ready).toHaveAttribute('data-document-loading','ready')
 await page.getByRole('button',{name:'AI 助手',exact:true}).click()
 const assistant=page.locator('.shared-editor-assistant')
 await assistant.getByRole('textbox',{name:'消息'}).fill('把第二页顺时针旋转九十度')
 await assistant.getByRole('button',{name:'发送',exact:true}).click()
 await expect(assistant.getByText('Rotation queued',{exact:true})).toBeVisible({timeout:20000})
 assert.ok(calls[0].tools.some(tool=>tool.name==='apply_ops'))
 assert.ok(!calls[0].tools.some(tool=>tool.name==='rotate_pages'))
 const results=calls[1].messages.filter(message=>message.role==='tool').flatMap(message=>message.results)
 assert.ok(results.some(result=>result.name==='apply_ops'&&!result.isError))
 const head=async()=>(await f.files.openFile(f.alice.token,file.fileId)).file.revision
 assert.equal(await head(),file.revision)
 await page.locator('.ribbon-tabs .qa-btn').first().click()
 await expect.poll(head,{timeout:15000}).not.toBe(file.revision)
 const revision=await head()
 const persisted=await PDFDocument.load(await f.files.readFile(f.alice.token,file.fileId,revision))
 assert.deepEqual(persisted.getPages().map(saved=>saved.getRotation().angle),[0,90,0])
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
 const reopened=page.waitForResponse(response=>response.ok()&&response.url().endsWith('/content?revision='+revision))
 await page.reload()
 await reopened
 await expect(ready).toHaveAttribute('data-document-loading','ready')
 recordVerifiedOfficeEffect('pdf','apply_ops.rotatePages')
})

test('native PDF OCR reads a real scan and saves a searchable layer without changing pixels',{skip:!directory||process.env.DYOFFICE_TEST_PDF_OCR!=='1',timeout:60000},async t=>{
 const origin='http://localhost:4269',f=await fileFixture(t,{origin,buildApp:false})
 const source=await PDFDocument.create()
 const raster=await source.embedPng(await readFile(new URL('../../../../packages/pdf2docx/ocr-helper/fixtures/smoke-en.png',import.meta.url)))
 source.addPage([raster.width,raster.height]).drawImage(raster,{x:0,y:0,width:raster.width,height:raster.height})
 source.addPage([300,200]).drawText('Digital second page',{x:20,y:100})
 const chinese=await source.embedPng(await readFile(new URL('../../../../packages/pdf2docx/ocr-helper/fixtures/smoke-zh.png',import.meta.url)))
 source.addPage([chinese.width,chinese.height]).drawImage(chinese,{x:0,y:0,width:chinese.width,height:chinese.height})
 const largeTitle=await source.embedPng(await readFile(new URL('../../../../packages/pdf2docx/ocr-helper/fixtures/smoke-zh-large.png',import.meta.url)))
 source.addPage([largeTitle.width,largeTitle.height]).drawImage(largeTitle,{x:0,y:0,width:largeTitle.width,height:largeTitle.height})
 const bytes=Buffer.from(await source.save()),{file}=await importFile(f,f.alice.token,bytes,'scan.pdf')
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,
  nativePdfDirectory:directory,localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 f.cleanup.unshift(()=>app.close())
 await app.listen({port:4269,host:'127.0.0.1'})
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage(),results=[]
 await stubHomeHero(page)
 await page.route('**/api/v1/ai/catalog',route=>route.fulfill({json:{entries:[{id:'mock',label:'OCR test model'}],defaultId:'mock'}}))
 const calls=[{name:'read_pages',input:{start:1,end:4}},{name:'search_text',input:{query:'OCR Smoke Fixture'}},{name:'search_text',input:{query:'文件识别测试'}}]
 let turn=0
 await page.route('**/api/v1/ai/turns',route=>{
  if(isHomeHeroRequest(route.request()))return route.fallback()
  if(turn>0)results.push(route.request().postDataJSON().request.messages.at(-1).results[0])
  const call=calls[turn++]
  const body=call?'event: tool_call\ndata: '+JSON.stringify({id:'scan-'+turn,...call}):'event: delta\ndata: {"text":"Scanned page read"}'
  return route.fulfill({contentType:'text/event-stream',body:body+'\n\nevent: done\ndata: {}\n\n'})
 })
 await page.goto(origin)
 await page.getByLabel('用户名',{exact:true}).fill('alice')
 await page.getByLabel('密码',{exact:true}).fill(password)
 await page.getByRole('button',{name:'登录',exact:true}).click()
 await expect(page.locator('.home')).toBeVisible()
 await page.goto(origin+'/native-pdf/?fileId='+file.fileId)
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready')
 await page.getByRole('button',{name:'AI 助手',exact:true}).click()
 const assistant=page.locator('.shared-editor-assistant')
 await assistant.getByRole('textbox',{name:'消息'}).fill('Read the four pages and find the scan headings.')
 await assistant.getByRole('button',{name:'发送',exact:true}).click()
 await expect(assistant.getByText('Scanned page read',{exact:true})).toBeVisible({timeout:25000})
 const recognizedPages=results[0].output.split(/\[Page \d+\]/).slice(1)
 assert.match(recognizedPages[0],/OCR.*OCR Smoke Fixture/s)
 assert.match(recognizedPages[1],/Digital second page/)
 assert.match(recognizedPages[2],/文件识别测试/)
 assert.match(recognizedPages[3],/扫描文件识别测试/)
 assert.match(results[1].output,/Page 1:.*OCR Smoke Fixture/)
 assert.match(results[2].output,/Page 3:.*文件识别测试/)
 assert.match(results[2].output,/Page 4:.*扫描文件识别测试/)
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),bytes)
 const head=async()=>(await f.files.openFile(f.alice.token,file.fileId)).file.revision
 const save=page.getByRole('button',{name:'保存',exact:true})
 await expect(save).toBeEnabled({timeout:3000})
 await save.click()
 await expect.poll(head,{timeout:15000}).not.toBe(file.revision)
 const savedRevision=await head()
 const saved=await f.files.readFile(f.alice.token,file.fileId,savedRevision)
 const [original,output]=await Promise.all([renderPdfPages(bytes),renderPdfPages(saved)])
 assert.equal(original.pages[0].text.trim(),'')
 assert.match(output.pages[0].text,/OCR\s+Smoke\s+Fixture/)
 assert.equal(output.pages[1].text,original.pages[1].text)
 assert.equal(original.pages[2].text.trim(),'')
 assert.match(output.pages[2].text,/文件识别测试/)
 assert.equal(original.pages[3].text.trim(),'')
 assert.match(output.pages[3].text,/扫描文件识别测试/)
 assert.deepEqual(output.pages.map(p=>p.pixels),original.pages.map(p=>p.pixels))
 await page.reload()
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready')
 await expect(save).toBeDisabled()
 await page.getByRole('button',{name:'搜索',exact:true}).click()
 await page.getByPlaceholder('搜索',{exact:true}).fill('文件识别测试')
 await expect(page.locator('.pdf-search-count')).toHaveText(/\/\s*2$/)
 assert.equal(await head(),savedRevision)
})

test('native PDF form marks address visible pages after an unsaved reorder',{skip:!directory,timeout:60000},async t=>{
 const origin='http://localhost:4251',f=await fileFixture(t,{origin,buildApp:false})
 const seed=await PDFDocument.create(),form=seed.getForm()
 for(const name of ['OriginalFirst','OriginalSecond']){
  const original=seed.addPage([300,240])
  original.drawText(name,{x:24,y:160})
  form.createCheckBox(name).addToPage(original,{x:40,y:140,width:16,height:16})
 }
 const bytes=Buffer.from(await seed.save())
 const {file}=await importFile(f,f.alice.token,bytes,'reorder-form.pdf')
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,
  nativePdfDirectory:directory,localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 f.cleanup.unshift(()=>app.close())
 await app.listen({port:4251,host:'127.0.0.1'})
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage()
 await stubHomeHero(page)
 await page.route('**/api/v1/ai/catalog',route=>route.fulfill({json:{entries:[{id:'mock',label:'Office test model'}],defaultId:'mock'}}))
 const calls=[
  ['goto_page',{page:2}],
  ['apply_ops',{ops:[{op:'setPageOrder',order:[2,1]}]}],
  ['add_form_mark',{page:1,kind:'check',x:40,y:84}],
 ]
 let modelTurns=0
 const results=[]
 await page.route('**/api/v1/ai/turns',route=>{
  if(isHomeHeroRequest(route.request()))return route.fallback()
  const callIndex=Math.floor(modelTurns/2)
  const works=modelTurns++%2===0
  if(!works)results.push(route.request().postDataJSON().request.messages.at(-1).results[0])
  const body=works?'event: tool_call\ndata: '+JSON.stringify({id:'form-'+callIndex,name:calls[callIndex][0],input:calls[callIndex][1]})
   :'event: delta\ndata: '+JSON.stringify({text:'Form step '+callIndex})
  return route.fulfill({contentType:'text/event-stream',body:body+'\n\nevent: done\ndata: {}\n\n'})
 })
 await page.goto(origin)
 await page.getByLabel('用户名',{exact:true}).fill('alice')
 await page.getByLabel('密码',{exact:true}).fill(password)
 await page.getByRole('button',{name:'登录',exact:true}).click()
 await expect(page.locator('.home')).toBeVisible()
 await page.goto(origin+'/native-pdf/?fileId='+file.fileId)
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready')
 await page.getByRole('button',{name:'AI 助手',exact:true}).click()
 const assistant=page.locator('.shared-editor-assistant')
 for(const step of calls.keys()){
  await assistant.getByRole('textbox',{name:'消息'}).fill('Apply form step '+step)
  await assistant.getByRole('button',{name:'发送',exact:true}).click()
  await expect(assistant.getByText('Form step '+step,{exact:true})).toBeVisible({timeout:15000})
  if(step===0)await expect(page.locator('.pdf-thumb').nth(1)).toHaveClass(/pdf-thumb-active/)
 }
 for(const result of results)assert.ok(!result.isError,result.output)
 assert.match(results[0].output,/Navigated to page 2/)
 assert.match(results[2].output,/OriginalSecond/)
 const head=async()=>(await f.files.openFile(f.alice.token,file.fileId)).file.revision
 assert.equal(await head(),file.revision)
 await page.getByRole('button',{name:'保存',exact:true}).click()
 await expect.poll(head,{timeout:15000}).not.toBe(file.revision)
 const revision=await head()
 const saved=await f.files.readFile(f.alice.token,file.fileId,revision)
 const result=(await PDFDocument.load(saved)).getForm()
 assert.equal(result.getCheckBox('OriginalFirst').isChecked(),false)
 assert.equal(result.getCheckBox('OriginalSecond').isChecked(),true)
 const leaves=await readPdfLeafObjects(saved)
 assert.deepEqual(leaves.filter(item=>/^Original(First|Second)$/.test(item.text??'')).map(item=>[item.page,item.text]),[
  [0,'OriginalSecond'],[1,'OriginalFirst'],
 ])
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),bytes)
 const reopened=page.waitForResponse(response=>response.ok()&&response.url().endsWith('/content?revision='+revision))
 await page.reload()
 await reopened
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready')
 recordVerifiedOfficeEffect('pdf','apply_ops.setPageOrder')
 recordVerifiedOfficeEffect('pdf','add_form_mark')
})

test('native PDF model receives visible page and selection context, and cites navigable pages',{skip:!directory,timeout:60000},async t=>{
 const origin='http://localhost:4268',f=await fileFixture(t,{origin,buildApp:false})
 const source=await PDFDocument.create()
 source.addPage([300,400]).drawText('First unselected page',{x:40,y:320})
 source.addPage([300,400]).drawText('Selected source passage',{x:40,y:320})
 const {file}=await importFile(f,f.alice.token,Buffer.from(await source.save()),'selection.pdf')
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,
  nativePdfDirectory:directory,localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 f.cleanup.unshift(()=>app.close())
 await app.listen({port:4268,host:'127.0.0.1'})
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage()
 const fontPath='/native-pdf/assets/pdfjs/standard_fonts/LiberationSans-Regular.ttf'
 assert.equal((await page.request.get(origin+fontPath)).status(),401)
 await stubHomeHero(page)
 await page.route('**/api/v1/ai/catalog',route=>route.fulfill({json:{entries:[{id:'mock',label:'Office test model'}],defaultId:'mock'}}))
 const requests=[]
 await page.route('**/api/v1/ai/turns',route=>{
  if(isHomeHeroRequest(route.request()))return route.fallback()
  const request=route.request().postDataJSON().request
  requests.push(request)
  const body=requests.length===1?'event: tool_call\ndata: '+JSON.stringify({id:'page-order',name:'apply_ops',input:{ops:[{op:'setPageOrder',order:[2,1]}]}})
   :'event: delta\ndata: '+JSON.stringify({text:'Model reply '+requests.length+(requests.length===3?'\n\nSee [p.2](pdfnav://page/2), [out of range](pdfnav://page/3), [invalid](pdfnav://other/1).':'')})
  return route.fulfill({contentType:'text/event-stream',body:body+'\n\nevent: done\ndata: {}\n\n'})
 })
 await page.goto(origin)
 await page.getByLabel('用户名',{exact:true}).fill('alice')
 await page.getByLabel('密码',{exact:true}).fill(password)
 await page.getByRole('button',{name:'登录',exact:true}).click()
 await expect(page.locator('.home')).toBeVisible()
 assert.equal((await page.request.get(origin+'/pdfjs/standard_fonts/LiberationSans-Regular.ttf')).status(),404)
 const font=await page.request.get(origin+fontPath)
 assert.equal(font.status(),200)
 assert.match(font.headers()['content-type'],/font\/ttf/)
 assert.ok((await font.body()).length>1000)
 await page.goto(origin+'/native-pdf/?fileId='+file.fileId)
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready')
 await page.getByRole('button',{name:'AI 助手',exact:true}).click()
 const assistant=page.locator('.shared-editor-assistant'),composer=assistant.getByRole('textbox',{name:'消息'})
 const send=async(instruction,reply)=>{
  await composer.fill(instruction)
  await assistant.getByRole('button',{name:'发送',exact:true}).click()
  await expect(assistant.getByText('Model reply '+reply,{exact:true})).toBeVisible({timeout:15000})
  return requests.at(-1).messages.findLast(message=>message.role==='user').text
 }
 await send('Reverse the two pages',2)
 await expect(page.locator('.pdf-page').first()).toHaveAttribute('data-page','1')
 await page.locator('.pdf-thumb').first().click()
 const text=page.locator('.pdf-page').first().locator('.textLayer span').getByText('Selected source passage',{exact:true})
 await expect(text).toBeVisible()
 await text.evaluate(element=>{
  const selection=window.getSelection(),range=document.createRange()
  range.selectNodeContents(element)
  selection.removeAllRanges()
  selection.addRange(range)
  element.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}))
 })
 await expect(page.locator('.pdf-sel-popup')).toBeVisible()
 const scoped=await send('Explain this passage. [User link](pdfnav://page/2)',3)
 assert.match(scoped,/viewing visible page 1/)
 assert.match(scoped,/selected the following text on visible page 1:.*Selected source passage/s)
 assert.doesNotMatch(scoped,/First unselected page/)
 assert.match(requests[2].system,/\[p\.N\]\(pdfnav:\/\/page\/N\)/)
 await expect(assistant.getByRole('link',{name:'User link'})).toHaveCount(0)
 await expect(assistant.getByRole('link',{name:'out of range'})).toHaveCount(0)
 await expect(assistant.getByRole('link',{name:'invalid'})).toHaveCount(0)
 await assistant.getByRole('link',{name:'p.2',exact:true}).click()
 await expect(page.locator('.pdf-thumb').nth(1)).toHaveClass(/pdf-thumb-active/)
 await page.locator('.pdf-page').nth(1).click({position:{x:15,y:15}})
 await expect(page.locator('.pdf-sel-popup')).toHaveCount(0)
 const unscoped=await send('Which page am I viewing now?',4)
 assert.match(unscoped,/viewing visible page 2/)
 assert.doesNotMatch(unscoped,/Selected source passage/)
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
})

for (const theme of ['light','dark']) test(`native PDF saves and reopens an assistant mark without changing other page colors in the ${theme} UI theme`,{skip:!directory,timeout:90000},async t=>{
 const origin='http://localhost:4267',f=await fileFixture(t,{origin,buildApp:false})
 await f.preferences.update(f.alice.token,{theme})
 const source=await PDFDocument.create(),sheet=source.addPage([300,240])
 sheet.drawRectangle({x:40,y:140,width:16,height:16,borderWidth:1,borderColor:rgb(0,0,0)})
 sheet.drawText('Consent',{x:64,y:141,size:12})
 source.addPage([300,240]).drawRectangle({x:24,y:30,width:180,height:120,color:rgb(0.15,0.45,0.85)})
 const original=Buffer.from(await source.save()),{file}=await importFile(f,f.alice.token,original,'printed-check.pdf')
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,
  nativePdfDirectory:directory,localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 f.cleanup.unshift(()=>app.close())
 await app.listen({port:4267,host:'127.0.0.1'})
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage()
 await stubHomeHero(page)
 await page.route('**/api/v1/ai/catalog',route=>route.fulfill({json:{entries:[{id:'mock',label:'Office test model'}],defaultId:'mock'}}))
 let turn=0,result,commits=0
 page.on('request',request=>{
  if(request.method()==='POST'&&new URL(request.url()).pathname===`/api/v1/files/${file.fileId}/commits`)commits++
 })
 await page.route('**/api/v1/ai/turns',route=>{
  if(isHomeHeroRequest(route.request()))return route.fallback()
  const call=turn++===0
  if(!call)result=route.request().postDataJSON().request.messages.at(-1).results[0]
  const body=call?'event: tool_call\ndata: '+JSON.stringify({id:'printed-check',name:'add_form_mark',input:{page:1,kind:'check',x:40,y:84}})
   :'event: delta\ndata: '+JSON.stringify({text:'Printed mark queued'})
  return route.fulfill({contentType:'text/event-stream',body:body+'\n\nevent: done\ndata: {}\n\n'})
 })
 await page.goto(origin)
 await page.getByLabel('用户名',{exact:true}).fill('alice')
 await page.getByLabel('密码',{exact:true}).fill(password)
 await page.getByRole('button',{name:'登录',exact:true}).click()
 await expect(page.locator('.home')).toBeVisible()
 await page.goto(origin+'/native-pdf/?fileId='+file.fileId)
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready')
 await expect(page.locator('html')).toHaveAttribute('data-theme',theme)
 await page.getByRole('button',{name:'AI 助手',exact:true}).click()
 const assistant=page.locator('.shared-editor-assistant')
 await assistant.getByRole('textbox',{name:'消息'}).fill('Check the printed Consent box.')
 await assistant.getByRole('button',{name:'发送',exact:true}).click()
 try{
  await expect(assistant.getByText('Printed mark queued',{exact:true})).toBeVisible({timeout:15000})
 }catch(error){
  t.diagnostic(JSON.stringify({theme,turns:turn,toolResult:result?.summary??null,toolError:result?.isError??null,
   assistantText:(await assistant.innerText({timeout:2000}).catch(()=>'' )).slice(-800)}))
  throw error
 }
 assert.ok(!result.isError,result.output)
 const head=async()=>(await f.files.openFile(f.alice.token,file.fileId)).file.revision
 assert.equal(await head(),file.revision)
 assert.equal(commits,0)
 await page.getByRole('button',{name:'保存',exact:true}).click()
 await expect(page.locator('.dyoffice-pdf-persistence-state')).toHaveText('已保存',{timeout:15000})
 const revision=await head()
 assert.notEqual(revision,file.revision)
 assert.equal(commits,1)
 const bytes=await f.files.readFile(f.alice.token,file.fileId,revision)
 await page.getByRole('button',{name:'文件',exact:true}).click()
 const [download]=await Promise.all([
  page.waitForEvent('download'),
  page.getByRole('link',{name:'下载已保存版本',exact:true}).click(),
 ])
 const downloadedBytes=await readFile(await download.path())
 assert.deepEqual(downloadedBytes,bytes)
 const leaves=await readPdfLeafObjects(downloadedBytes)
 assert.deepEqual(leaves.filter(item=>item.type===3).map(item=>[item.page,...item.bounds]),[[0,40,140,56,156]])
 assert.ok(leaves.some(item=>item.text==='Consent'))
 const before=await renderPdfPages(original),after=await renderPdfPages(downloadedBytes)
 assert.notEqual(after.pages[0].pixels,before.pages[0].pixels)
 assert.equal(after.pages[1].pixels,before.pages[1].pixels)
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
 await page.reload()
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready')
 await page.getByRole('button',{name:'编辑',exact:true}).click()
 await page.getByRole('button',{name:'编辑图片',exact:true}).click()
 const mark=page.locator('.pdf-imgedit-hit')
 await expect(mark).toHaveCount(1)
 await mark.click()
 await expect(mark).toHaveClass(/pdf-imgedit-selected/)
 assert.equal(await head(),revision)
 assert.equal(commits,1)
})

test('GenOffice PDF assistant and ribbon edits preview and save, including recovery from lost receipts'+(liveImageConfig?' with real model image editing':''),{skip:!directory,timeout:liveImageConfig?210000:120000},async t=>{
 const origin='http://localhost:4239',f=await fileFixture(t,{origin,buildApp:false})
 const doc=await PDFDocument.create()
 doc.addPage([300,240]).drawText('Native first page',{x:24,y:144,color:rgb(0,.2,.6)})
 const pattern=new PNG({width:16,height:16})
 for(let i=0;i<256;i++)pattern.data.set(i%16<8?[255,0,0,255]:[0,0,255,255],i*4)
 const stripes=await doc.embedPng(PNG.sync.write(pattern))
 doc.getPage(0).drawImage(stripes,{x:180,y:148,width:48,height:48})
 const cutoutPattern=new PNG({width:16,height:16})
 for(let y=0;y<16;y++)for(let x=0;x<16;x++){
  cutoutPattern.data.set(x>=4&&x<12&&y>=4&&y<12?[0,128,0,255]:[255,255,255,255],(y*16+x)*4)
 }
 doc.getPage(0).drawRectangle({x:244,y:148,width:40,height:40,color:rgb(1,0,0)})
 doc.getPage(0).drawImage(await doc.embedPng(PNG.sync.write(cutoutPattern)),{x:244,y:148,width:40,height:40})
 doc.addPage([300,240]).drawText('Native second page',{x:24,y:144})
 doc.getPage(0).drawText('Original paragraph starts here.',{x:24,y:72,size:12})
 doc.getPage(0).drawText('Original paragraph ends here.',{x:24,y:58,size:12})
 doc.getPage(1).drawText('Native second page',{x:24,y:76})
 doc.getPage(1).drawText('fixture@example.com',{x:24,y:110,size:12})
 const notePage=doc.getPage(1)
 const outlines=doc.context.register(doc.context.obj({Type:'Outlines',Count:1}))
 const bookmark=doc.context.register(doc.context.obj({Title:PDFString.of('Review bookmark'),Parent:outlines,Dest:[notePage.ref,'Fit']}))
 const outlineRoot=doc.context.lookup(outlines)
 outlineRoot.set(PDFName.of('First'),bookmark)
 outlineRoot.set(PDFName.of('Last'),bookmark)
 doc.catalog.set(PDFName.of('Outlines'),outlines)
 const field=doc.getForm().createTextField('ReviewStatus')
 field.setText('Pending')
 field.addToPage(notePage,{x:24,y:22,width:120,height:18})
 const savedNote=doc.context.register(doc.context.obj({Type:'Annot',Subtype:'Text',Rect:[230,184,248,202],P:notePage.ref,Contents:PDFString.of('Saved browser note'),T:PDFString.of('Reviewer'),F:4}))
 notePage.node.addAnnot(savedNote)
 const noteId='S'+savedNote.objectNumber
 const original=Buffer.from(await doc.save())
 const {file}=await importFile(f,f.alice.token,original,'native-ribbon.pdf')
 const keyring={activeKeyId:'pdf-test',keys:{'pdf-test':new Uint8Array(32).fill(29)}}
 const modelSettings=createGlobalConfigService({transactions:f.transactions,keyring})
 const configured=await modelSettings.saveGlobalConfig(f.adminSigned.token,0,{upserts:[{id:'fixture',kind:'chat',providerId:'openai',label:'Fixture',model:'synthetic',baseUrl:'https://provider.example/v1',apiKey:'fixture-key',enabled:true}],defaults:{chat:'fixture'}})
 const shell=process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,nativePdfDirectory:directory,localShellDirectory:shell??fileURLToPath(new URL('../../dist-local-shell',import.meta.url)),globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false})
 f.cleanup.unshift(()=>app.close())
 await app.listen({port:4239,host:'127.0.0.1'})
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1360,height:900}}),errors=[]
 page.on('pageerror',error=>errors.push(error.stack??error.message))
 const url=origin+'/native-pdf/?fileId='+file.fileId
 assert.equal((await page.request.get(url)).status(),401)
 await stubHomeHero(page)
 await page.goto(origin)
 await page.getByLabel('用户名',{exact:true}).fill('alice')
 await page.getByLabel('密码',{exact:true}).fill(password)
 await page.getByRole('button',{name:'登录',exact:true}).click()
 await expect(page.locator('.home')).toBeVisible()
 if(shell){
  assert.equal((await page.request.get(origin+'/pdf.html')).status(),404)
  await page.goto(origin+'/?entry=pdf-test#/file/'+file.fileId)
  const frame=page.locator('iframe.workspace-document-frame')
  await expect(frame).toHaveAttribute('src','/native-pdf/?fileId='+file.fileId)
  const pdf=frame.contentFrame()
  await expect(pdf.locator('html')).toHaveAttribute('data-document-loading','ready')
  await pdf.getByRole('button',{name:'页面',exact:true}).click()
  await pdf.getByRole('button',{name:'向右旋转',exact:true}).click()
  const dialog=page.waitForEvent('dialog').then(async dialog=>{assert.match(dialog.message(),/未保存修改/);await dialog.dismiss()})
  assert.equal(await pdf.locator('html').evaluate(()=>window.dyofficeEditorCanClose()),false)
  await dialog
  await expect(pdf.getByRole('button',{name:'保存',exact:true})).toBeEnabled()
  await pdf.getByRole('button',{name:/^撤销/}).click()
  assert.equal(await pdf.locator('html').evaluate(()=>window.dyofficeEditorCanClose()),true)
 }
 const response=await page.goto(url)
 assert.equal(response.status(),200)
 await expect(page.locator('.ribbon-tab').first()).toBeVisible({timeout:30000})
 const fileTab=page.getByRole('button',{name:'文件',exact:true})
 await expect(fileTab).toHaveClass(/ribbon-tab-file/)
 await expect(page.locator('.dyoffice-pdf-persistence-state')).toHaveAttribute('data-dirty','false')
 await fileTab.click()
 await expect(page.locator('.file-menu').getByRole('link',{name:'下载已保存版本'})).toHaveAttribute('href',/\/content\?revision=/)
 await page.keyboard.press('Escape')
 await expect(page.locator('.file-menu')).toHaveCount(0)
 await expect(fileTab).toBeFocused()
 await expect(page.locator('.pdf-thumb')).toHaveCount(2)
 await expect(page.getByText('Native first page',{exact:true}).first()).toBeAttached()
 await page.getByRole('button',{name:'编辑文字',exact:true}).click()
 const textCheck=page.waitForResponse(response=>response.url().endsWith('/text-edits/query'),{timeout:8000})
 await Promise.all([
  textCheck,
  page.locator('.textLayer span').filter({hasText:/^Native first page$/}).first().click({modifiers:['Alt']}),
 ])
 const checked=await textCheck
 assert.equal(checked.status(),200)
 const validation=await checked.json()
 assert.equal(validation.revision,file.revision)
 assert.equal(validation.edits[0].reason,null)
 assert.equal(validation.edits[0].bounds.length,4)
 assert.deepEqual(validation.edits[0].baseColor,[0,51,153])
 const manualDraft=page.locator('.pdf-textedit-input')
 await expect(manualDraft).toHaveCSS('color','rgb(0, 51, 153)')
 await manualDraft.fill('Manual updated page')
 const draftCheck=page.waitForResponse(response=>response.url().endsWith('/text-edits/query'))
 await Promise.all([draftCheck,manualDraft.press('Control+Enter')])
 assert.equal((await (await draftCheck).json()).edits[0].reason,null)
 await page.getByRole('button',{name:'编辑文字',exact:true}).click()
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
 await page.getByRole('button',{name:'编辑',exact:true}).click()
 const editImages=page.getByRole('button',{name:'编辑图片',exact:true})
 await editImages.click()
 await page.locator('.pdf-imgedit-hit').first().click({timeout:8000})
 await page.getByRole('button',{name:'水平翻转',exact:true}).click()
 const pixel=async(x=190,y=60,selector='.pdf-page')=>page.locator(selector).first().screenshot().then(buffer=>{
  const image=PNG.sync.read(buffer),i=(Math.floor(y/240*image.height)*image.width+Math.floor(x/300*image.width))*4
  return [...image.data.subarray(i,i+3)]
 })
 await expect.poll(pixel,{timeout:15000}).toEqual([0,0,255])
 // The text draft stays on this page, so undo must remove the already rendered image-erasure patch.
 await expect(page.locator('.pdf-page').first().locator('.pdf-page-livepreview')).toBeVisible()
 await page.getByRole('button',{name:/^撤销/}).click()
 await expect.poll(pixel).toEqual([255,0,0])
 await page.getByRole('button',{name:/^重做/}).click()
 await expect.poll(pixel).toEqual([0,0,255])
 const draftImage=page.locator('.pdf-page').first().locator('.pdf-imgedit-img').first()
 await draftImage.click()
 await page.getByRole('button',{name:'裁剪',exact:true}).click()
 const crop=page.getByRole('dialog',{name:'裁剪',exact:true})
 const applyCrop=crop.getByRole('button',{name:'应用',exact:true})
 await expect(applyCrop).toBeEnabled()
 const box=await crop.locator('[style*="cursor: move"]').boundingBox()
 const west=await crop.locator('[style*="cursor: ew-resize"]').last().boundingBox()
 await page.mouse.move(west.x+west.width/2,west.y+west.height/2)
 await page.mouse.down()
 await page.mouse.move(west.x+west.width/2+box.width/4,west.y+west.height/2,{steps:4})
 await page.mouse.up()
 await applyCrop.click()
 await expect.poll(pixel).toEqual([255,255,255])
 await expect.poll(()=>pixel(198,60)).toEqual([0,0,255])
 await draftImage.click()
 await page.getByRole('button',{name:'透明度',exact:true}).click()
 await page.getByRole('button',{name:'50%',exact:true}).click()
 await expect.poll(()=>pixel(198,60)).toEqual([127,127,255])
 await page.locator('.pdf-imgedit-hit').click()
 await page.getByRole('button',{name:'去除背景',exact:true}).click()
 await page.getByRole('dialog',{name:'去除背景',exact:true}).getByRole('button',{name:'应用',exact:true}).click()
 await expect.poll(()=>pixel(247,55)).toEqual([255,0,0])
 await expect.poll(()=>pixel(264,72)).toEqual([0,128,0])
 await editImages.click()
 await page.getByRole('button',{name:'开始',exact:true}).click()
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
 const assistant=page.locator('.shared-editor-assistant')
 const entry=page.getByRole('button',{name:'AI 助手',exact:true})
 await entry.click()
 await expect(assistant).toBeVisible({timeout:5000})
 const deltas=[
  {tool_calls:[{index:0,id:'sensitive',type:'function',function:{name:'find_sensitive_info',arguments:'{"patterns":["email"]}'}}]},
  {tool_calls:[{index:0,id:'search',type:'function',function:{name:'search_text',arguments:'{"query":"native SECOND page"}'}}]},
  {tool_calls:[{index:0,id:'read',type:'function',function:{name:'read_pages',arguments:'{"start":2}'}}]},
  {tool_calls:[{index:0,id:'highlight',type:'function',function:{name:'markup_text',arguments:'{"page":2,"text":"Native second page","type":"highlight"}'}}]},
  {tool_calls:[{index:0,id:'missing',type:'function',function:{name:'edit_text',arguments:'{"page":2,"old_text":"Native second page","new_text":"Wrong target","occurrence":3}'}}]},
  {tool_calls:[{index:0,id:'paragraph',type:'function',function:{name:'edit_block',arguments:JSON.stringify({page:1,paragraph_text:'starts here',new_text:'Revised paragraph begins.\nRevised paragraph ends.',align:'right'})}}]},
  {tool_calls:[{index:0,id:'move',type:'function',function:{name:'move_text_block',arguments:'{"page":1,"paragraph_text":"starts here","dx":0,"dy":10}'}}]},
  {tool_calls:[{index:0,id:'rewrite',type:'function',function:{name:'edit_text',arguments:'{"page":2,"old_text":"Native second page","new_text":"Native revised","occurrence":2}'}}]},
  {tool_calls:[{index:0,id:'insert',type:'function',function:{name:'insert_text',arguments:'{"page":2,"text":"Original insert","x":24,"y":185,"font_size":12}'}}]},
  {tool_calls:[{index:0,id:'list-inserts',type:'function',function:{name:'list_inserted_text',arguments:'{"page":2}'}}]},
  {tool_calls:[{index:0,id:'edit-insert',type:'function',function:{name:'edit_inserted_text',arguments:'{"text":"Final insert"}'}}]},
  {tool_calls:[{index:0,id:'move-insert',type:'function',function:{name:'move_inserted_text',arguments:'{"dx":10,"dy":5}'}}]},
  {tool_calls:[{index:0,id:'discardable',type:'function',function:{name:'insert_text',arguments:'{"page":2,"text":"Discard this draft","x":60,"y":180}'}}]},
  {tool_calls:[{index:0,id:'delete-insert',type:'function',function:{name:'delete_inserted_text',arguments:'{}'}}]},
  {tool_calls:[{index:0,id:'read-annots',type:'function',function:{name:'read_annotations',arguments:'{"start":2,"end":2}'}}]},
  {tool_calls:[{index:0,id:'edit-note',type:'function',function:{name:'edit_note',arguments:JSON.stringify({page:2,note_id:noteId,text:'Revised browser note'})}}]},
  {tool_calls:[{index:0,id:'reply-note',type:'function',function:{name:'reply_note',arguments:JSON.stringify({page:2,note_id:noteId,text:'Assistant reply'})}}]},
  {tool_calls:[{index:0,id:'add-note',type:'function',function:{name:'add_note',arguments:'{"page":2,"text":"Discardable note","x":100,"y":100}'}}]},
  {tool_calls:[{index:0,id:'delete-note',type:'function',function:{name:'delete_note',arguments:'{}'}}]},
  {tool_calls:[{index:0,id:'underline',type:'function',function:{name:'markup_text',arguments:'{"page":2,"text":"Native second page","type":"underline"}'}}]},
  {tool_calls:[{index:0,id:'delete-mark',type:'function',function:{name:'delete_markup',arguments:'{"page":2,"type":"underline"}'}}]},
  {tool_calls:[{index:0,id:'fields',type:'function',function:{name:'list_form_fields',arguments:'{}'}}]},
  {tool_calls:[{index:0,id:'preview-batch',type:'function',function:{name:'apply_ops',arguments:'{"dry_run":true,"ops":[{"op":"rotatePages","pages":[1],"dir":90}]}'}}]},
  {tool_calls:[{index:0,id:'invalid-batch',type:'function',function:{name:'apply_ops',arguments:'{"ops":[{"op":"rotatePages","pages":[1],"dir":90},{"op":"setFormValue","value":{"name":"Missing","value":"X"}}]}'}}]},
  {tool_calls:[{index:0,id:'batch',type:'function',function:{name:'apply_ops',arguments:'{"ops":[{"op":"rotatePages","pages":[2],"dir":90},{"op":"setFormValue","value":{"name":"ReviewStatus","value":"Approved"}},{"op":"setMetadata","metadata":{"title":"Reviewed PDF"}}]}'}}]},
  {tool_calls:[{index:0,id:'outline',type:'function',function:{name:'get_outline',arguments:'{}'}}]},
  {tool_calls:[{index:0,id:'blank',type:'function',function:{name:'insert_blank_page',arguments:'{"after_page":2}'}}]},
  {tool_calls:[{index:0,id:'read-blank',type:'function',function:{name:'read_pages',arguments:'{"start":3}'}}]},
  {tool_calls:[{index:0,id:'watermark',type:'function',function:{name:'set_watermark',arguments:'{"text":"Web review copy","angle":0}'}}]},
  {tool_calls:[{index:0,id:'footer',type:'function',function:{name:'set_header_footer',arguments:'{"page_number":true,"start_at":7}'}}]},
  {content:'Read native PDF successfully'},
 ]
 let insertedId
 const network=mockProviderNetwork(t,()=>{
  const delta=deltas.shift();assert.ok(delta)
  const tool=delta.tool_calls?.[0].function
  if(tool?.name==='edit_inserted_text'||tool?.name==='move_inserted_text'){
   insertedId??=network.wire.toString().match(/(Td[a-z0-9]+): page 2/)?.[1]
   assert.ok(insertedId,'list_inserted_text did not return a page 2 draft ID')
   tool.arguments=JSON.stringify({...JSON.parse(tool.arguments),id:insertedId})
  }
  if(tool?.name==='delete_inserted_text'){
   const id=[...network.wire.toString().matchAll(/pt as (Td[a-z0-9]+)/g)].at(-1)?.[1]
   assert.ok(id&&id!==insertedId)
   tool.arguments=JSON.stringify({id})
  }
  if(tool?.name==='delete_note'){
   const id=network.wire.toString().match(/Added note (Pd[a-z0-9]+) on page 2/)?.[1]
   assert.ok(id)
   tool.arguments=JSON.stringify({page:2,note_id:id})
  }
  return Readable.from([Buffer.from('data: '+JSON.stringify({choices:[{delta,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:delta.tool_calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n')])
 })
 const isTurn=req=>req.method()==='POST'&&new URL(req.url()).pathname==='/api/v1/ai/turns'
 const firstTurn=page.waitForRequest(isTurn)
 const readback=[]
 page.on('request',req=>{if(isTurn(req))readback.push(JSON.stringify(req.postDataJSON()))})
 await assistant.getByRole('textbox',{name:'消息'}).fill('请读取第二页')
 await assistant.getByRole('button',{name:'发送',exact:true}).click()
 const advertised=JSON.stringify((await firstTurn).postDataJSON())
 assert.match(advertised,/"search_text"/)
 assert.match(advertised,/"find_sensitive_info"/)
 assert.match(advertised,/"markup_text"/)
 assert.match(advertised,/"edit_text"/)
 assert.match(advertised,/"edit_block"/)
 assert.match(advertised,/"move_text_block"/)
 assert.match(advertised,/"apply_ops"/)
 assert.match(advertised,/"list_form_fields"/)
 assert.match(advertised,/"insert_blank_page"/)
 assert.match(advertised,/"get_outline"/)
 assert.match(advertised,/"set_watermark"/)
 assert.match(advertised,/"set_header_footer"/)
 for(const name of ['read_annotations','edit_note','reply_note','add_note','delete_note','delete_markup']){
  assert.ok(JSON.parse(advertised).request.tools.some(tool=>tool.name===name),name)
 }
 for(const name of ['insert_text','list_inserted_text','edit_inserted_text','move_inserted_text','delete_inserted_text']){
  assert.ok(JSON.parse(advertised).request.tools.some(tool=>tool.name===name),name)
 }
 await expect(assistant.getByText('Read native PDF successfully')).toBeVisible({timeout:20000})
 assert.ok(readback.some(wire=>wire.includes('Page 2 [email]: fixture@example.com')))
 assert.ok(readback.some(wire=>wire.includes('Page 2:')&&wire.includes('Native second page')))
 assert.ok(readback.some(wire=>wire.includes('[Page 2]')&&wire.includes('Native second page')))
 assert.ok(readback.some(wire=>wire.includes('Marked 1 occurrence(s) on page 2')))
 assert.ok(readback.some(wire=>wire.includes('Occurrence 3')&&wire.includes('not found')))
 assert.ok(readback.some(wire=>wire.includes('Replaced occurrence 2')&&wire.includes('unsaved')))
 assert.ok(readback.some(wire=>wire.includes('Replaced the paragraph')&&wire.includes('2 reflowed line(s)')))
 assert.ok(readback.some(wire=>wire.includes('Moved the paragraph')&&wire.includes('dy 10 pt')))
 assert.ok(readback.some(wire=>wire.includes('pending inserted text block(s) on page 2')))
 assert.ok(readback.some(wire=>wire.includes('Updated inserted text')&&wire.includes('Moved inserted text')))
 assert.ok(readback.some(wire=>wire.includes('Removed inserted text')))
 assert.ok(readback.some(wire=>wire.includes('Review bookmark')))
 assert.ok(readback.some(wire=>wire.includes('[Page 3]')&&wire.includes('(unsaved blank page)')))
 assert.ok(readback.some(wire=>wire.includes('Watermark \\"Web review copy\\" applied')))
 assert.ok(readback.some(wire=>wire.includes('Header/footer applied')))
 for(const result of ['ReviewStatus','the document was NOT modified','Nothing was applied (atomic)','Document properties (written on save)']){
  assert.ok(readback.some(wire=>wire.includes(result)),result)
 }
 for(const result of ['Note '+noteId,'Edited note '+noteId,'Replied to note '+noteId,'Deleted note Pd','Removed 1 underline']){
  assert.ok(readback.some(wire=>wire.includes(result)),result)
 }
 await entry.click()
 await expect(assistant).toBeHidden()
 await expect(page.locator('.pdf-thumb')).toHaveCount(3)
 await expect(page.getByText('Native second page',{exact:true}).first()).toBeAttached()
 const save=page.locator('.ribbon-tabs .qa-btn').first()
 const commits=[],fileRoute=`**/api/v1/files/${file.fileId}`
 let stages=0
 await page.route(fileRoute+'/pdf/apply-ops/uploads',async route=>{
  stages++
  const response=await route.fetch()
  if(!response.ok())t.diagnostic('PDF save preparation: '+response.status()+' '+await response.text())
  await route.fulfill({response})
 })
 await page.route(fileRoute+'/commits',async route=>{
  commits.push(route.request().postDataJSON())
  if(commits.length>2)return route.continue()
  const reply=await route.fetch()
  assert.ok(reply.ok(),await reply.text())
  await route.abort()
 })
 const head=async()=>(await (await page.request.get(origin+'/api/v1/files/'+file.fileId)).json()).file.revision
 assert.equal(await head(),file.revision)
 assert.deepEqual(errors,[])
 await expect(save).toBeEnabled({timeout:3000})
 await save.click()
 await expect(page.locator('.dyoffice-pdf-persistence-state')).toHaveAttribute('data-attention','true',{timeout:15000})
 assert.equal(commits.length,2)
 const revision=await head()
 assert.notEqual(revision,file.revision)
 const loadedAfterSave=page.waitForResponse(response=>response.ok()&&response.url().endsWith('/content?revision='+revision))
 await save.click()
 await loadedAfterSave
 await expect(page.locator('.dyoffice-pdf-persistence-state')).toHaveText('已保存',{timeout:15000})
 await expect(save).toBeDisabled()
 assert.equal(stages,1)
 assert.equal(commits.length,3)
 assert.deepEqual(commits,[commits[0],commits[0],commits[0]])
 const savedBytes=await f.files.readFile(f.alice.token,file.fileId,revision)
 const externalText=(bytes,page)=>execFileSync('pdftotext',['-f',String(page),'-l',String(page),'-','-'],{input:bytes,encoding:'utf8'})
 assert.match(externalText(original,1),/Native first page/)
 assert.match(externalText(original,1),/Original paragraph starts here/)
 const externalFirstPage=externalText(savedBytes,1)
 for(const text of ['Manual updated page','Revised paragraph begins.','Revised paragraph ends.']){
  assert.ok(externalFirstPage.includes(text),externalFirstPage)
 }
 assert.doesNotMatch(externalFirstPage,/Native first page|Original paragraph starts here|Original paragraph ends here/)
 const externalSecondPage=externalText(savedBytes,2)
 assert.match(externalSecondPage,/Native revised/)
 assert.match(externalSecondPage,/Final insert/)
 assert.doesNotMatch(externalSecondPage,/Original insert|Discard this draft/)
 const savedImage=await readImageSource(savedBytes,0,[192,148,228,196])
 assert.deepEqual([...savedImage.bgra.subarray(0,4)],[255,0,0,128])
 const savedCutout=await readImageSource(savedBytes,0,[244,148,284,188])
 assert.equal(savedCutout.bgra[3],0)
 const center=(Math.floor(savedCutout.height/2)*savedCutout.width+Math.floor(savedCutout.width/2))*4
 assert.deepEqual([...savedCutout.bgra.subarray(center,center+4)],[0,128,0,255])
 const persisted=await PDFDocument.load(savedBytes)
 const stampLeaves=await readPdfLeafObjects(savedBytes)
 for(const i of [0,1,2]){
  const text=stampLeaves.filter(leaf=>leaf.page===i).map(leaf=>leaf.text)
  assert.ok(text.includes('Web review copy')&&text.includes(`${7+i} / 3`),JSON.stringify(text))
 }
 assert.equal(persisted.getTitle(),'Reviewed PDF')
 assert.equal(persisted.getForm().getTextField('ReviewStatus').getText(),'Approved')
 const annotations=persisted.getPage(1).node.Annots().asArray().map(ref=>persisted.context.lookup(ref))
 const subtype=dict=>String(dict.get(PDFName.of('Subtype')))
 const notes=annotations.filter(dict=>subtype(dict)==='/Text')
 const root=notes.find(dict=>!dict.has(PDFName.of('IRT')))
 const reply=notes.find(dict=>dict.has(PDFName.of('IRT')))
 assert.equal(notes.length,2)
 assert.equal(root.lookup(PDFName.of('Contents')).decodeText(),'Revised browser note')
 assert.equal(root.lookup(PDFName.of('T')).decodeText(),'Reviewer')
 assert.equal(reply.lookup(PDFName.of('IRT')),root)
 assert.equal(reply.lookup(PDFName.of('Contents')).decodeText(),'Assistant reply')
 assert.equal(annotations.filter(dict=>subtype(dict)==='/Underline').length,0)
 assert.equal(annotations.filter(dict=>subtype(dict)==='/Highlight').length,1)
 const leaves=stampLeaves.filter(item=>item.type===1&&item.text!=='Web review copy'&&!/^[7-9] \/ 3$/.test(item.text??''))
 const firstPage=leaves.filter(item=>item.page===0)
 assert.deepEqual(firstPage.map(item=>item.text).sort(),['Manual updated page','Revised paragraph begins.','Revised paragraph ends.'])
 assert.deepEqual(firstPage.find(item=>item.text==='Manual updated page').fill.slice(0,3),[0,51,153])
 assert.ok(firstPage.filter(item=>item.text.startsWith('Revised')).every(item=>item.matrix[4]>24))
 assert.deepEqual(firstPage.filter(item=>item.text.startsWith('Revised')).map(item=>item.matrix[5]).sort((a,b)=>b-a),[62,48])
 const savedText=leaves.filter(item=>item.page===1)
 assert.deepEqual(savedText.map(item=>item.text).sort(),['Final insert','Native revised','Native second page','fixture@example.com'])
 assert.deepEqual(savedText.find(item=>item.text==='Final insert').matrix.slice(4),[34,38])
 assert.ok(savedText.find(item=>item.text==='Native revised').bounds[1]<savedText.find(item=>item.text==='Native second page').bounds[1])
 assert.deepEqual(persisted.getPages().map(page=>page.getRotation().angle),[0,90,0])
 assert.deepEqual(persisted.getPage(2).getSize(),{width:240,height:300})
 assert.deepEqual(stampLeaves.filter(item=>item.page===2).map(item=>item.text).sort(),['9 / 3','Web review copy'])
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
 const refreshed=page.waitForResponse(response=>response.ok()&&response.url().endsWith('/content?revision='+revision))
 await page.reload()
 await refreshed
 await expect(page.locator('.pdf-thumb')).toHaveCount(3)
 await page.locator('.pdf-thumb').nth(1).click()
 await expect(page.getByText('Native revised',{exact:true}).first()).toBeAttached()
 const count=await f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async connection=>(await connection.query('SELECT count(*)::int AS count FROM file_revisions WHERE file_id=$1',[file.fileId])).rows[0].count)
 assert.equal(count,2)
 deltas.push(
  {tool_calls:[{index:0,id:'clear-watermark',type:'function',function:{name:'set_watermark',arguments:'{"text":""}'}}]},
  {content:'Removal queued'},
 )
 await entry.click()
 await assistant.getByRole('textbox',{name:'消息'}).fill('请清除之前保存的水印，保留页脚')
 await assistant.getByRole('button',{name:'发送',exact:true}).click()
 await expect(assistant.getByText('Removal queued',{exact:true})).toBeVisible({timeout:20000})
 assert.ok(readback.some(wire=>wire.includes('Removal of the managed watermark is queued')))
 assert.equal(await head(),revision)
 await save.click()
 await expect(page.locator('.dyoffice-pdf-persistence-state')).toHaveText('已保存',{timeout:15000})
 const clearedRevision=await head()
 assert.notEqual(clearedRevision,revision)
 const cleared=await readPdfLeafObjects(await f.files.readFile(f.alice.token,file.fileId,clearedRevision))
 assert.ok(!cleared.some(leaf=>leaf.text==='Web review copy'))
 for(const index of [0,1,2])assert.ok(cleared.some(leaf=>leaf.page===index&&leaf.text===`${7+index} / 3`))
 for(const effect of [
  'apply_ops.setFormValue','apply_ops.setMetadata','edit_block','move_text_block',
  'edit_text','insert_text','edit_inserted_text','move_inserted_text','delete_inserted_text',
  'edit_note','reply_note','delete_note','markup_text','delete_markup','insert_blank_page',
  'set_watermark','set_header_footer',
 ]) recordVerifiedOfficeEffect('pdf',effect)

 if(liveImageConfig){
  const {entry:live}=JSON.parse(await readFile(liveImageConfig,'utf8'))
  assert.ok(live?.enabled&&live?.apiKey&&live?.kind==='chat','Enabled live chat model configuration required')
  await modelSettings.saveGlobalConfig(f.adminSigned.token,configured.revision,{upserts:[{...live,id:'fixture'}],defaults:{chat:'fixture'}})
  t.mock.restoreAll()
 }
 // The manual erase patch spans the middle image, which also has an assistant draft.
 const mixed=await PDFDocument.create(),mixedPage=mixed.addPage([300,240])
 const sharedImage=await mixed.embedPng(PNG.sync.write(pattern))
 const lefts=[60,130,200]
 for(const x of lefts)mixedPage.drawImage(sharedImage,{x,y:148,width:40,height:40})
 const approval=mixed.getForm().createCheckBox('Approved')
 approval.addToPage(mixedPage,{x:30,y:40,width:18,height:18})
 approval.check()
 const mixedOriginal=Buffer.from(await mixed.save())
 const mixedFile=(await importFile(f,f.alice.token,mixedOriginal,'native-ribbon-and-assistant.pdf')).file
 const mixedHead=async()=>(await f.files.openFile(f.alice.token,mixedFile.fileId)).file.revision
 await page.goto(origin+'/native-pdf/?fileId='+mixedFile.fileId)
 await page.getByRole('button',{name:'编辑',exact:true}).click()
 await editImages.click()
 const hits=page.locator('.pdf-imgedit-hit')
 await expect(hits).toHaveCount(3)
 for(const x of [60,200]){
  await (x===60?hits.first():hits.last()).click()
  const erasePreview=page.waitForResponse(response=>{
   if(!response.url().endsWith('/pdf/image-previews/query'))return false
   const {operation}=response.request().postDataJSON()
   return operation.kind==='erase'&&operation.excludeRects.some(rect=>rect[0]===x)
  },{timeout:20000})
  await page.getByRole('button',{name:'水平翻转',exact:true}).click()
  const preview=await erasePreview
  assert.ok(preview.ok(),await preview.text())
  await expect.poll(()=>pixel(x+8,65),{timeout:10000}).toEqual([0,0,255])
 }
 await editImages.click()
 await page.getByRole('button',{name:'开始',exact:true}).click()
 await expect.poll(()=>pixel(138,65)).toEqual([255,0,0])
 if(!liveImageConfig)deltas.push(
  {tool_calls:[{index:0,id:'assistant-list',type:'function',function:{name:'list_page_images',arguments:'{"page":1}'}}]},
  {tool_calls:[{index:0,id:'assistant-flip',type:'function',function:{name:'flip_image',arguments:'{"page":1,"image_number":2,"axis":"horizontal"}'}}]},
  {content:'Middle image flip queued'},
 )
 const imageReadbackStart=readback.length
 await entry.click()
 await assistant.getByRole('textbox',{name:'消息'}).fill('先用 list_page_images 列出第 1 页的内嵌图片。按位置找出横向居中的图片，只用 flip_image 水平翻转这张图片一次。保留两侧的待保存编辑与表单。我会手动保存。')
 await assistant.getByRole('button',{name:'发送',exact:true}).click()
 const readImageTurn=()=>readback.slice(imageReadbackStart)
 await expect.poll(()=>readImageTurn().some(wire=>wire.includes('Image 2 on page 1 has a pending flip_image edit.')),{timeout:liveImageConfig?90000:20000}).toBe(true)
 assert.ok(readImageTurn().some(wire=>wire.includes('image 2: 40 × 40 pt at x=130, y=52')))
 if(!liveImageConfig)await expect(assistant.getByText('Middle image flip queued',{exact:true})).toBeVisible({timeout:20000})
 await expect(assistant.getByRole('button',{name:'停止',exact:true})).toHaveCount(0,{timeout:liveImageConfig?60000:10000})
 await entry.click()
 for(const x of lefts)await expect.poll(()=>pixel(x+8,65),{timeout:10000}).toEqual([0,0,255])
 await expect.poll(()=>pixel(138,65,'.pdf-thumb-box')).toEqual([0,0,255])
 await page.getByRole('button',{name:/^撤销/}).click()
 await expect.poll(()=>pixel(138,65)).toEqual([255,0,0])
 await expect.poll(()=>pixel(68,65)).toEqual([0,0,255])
 await page.getByRole('button',{name:/^重做/}).click()
 await expect.poll(()=>pixel(138,65),{timeout:10000}).toEqual([0,0,255])
 assert.equal(await mixedHead(),mixedFile.revision)
 await save.click()
 await expect(page.locator('.dyoffice-pdf-persistence-state')).toHaveText('已保存',{timeout:15000})
 const mixedRevision=await mixedHead()
 assert.notEqual(mixedRevision,mixedFile.revision)
 const mixedBytes=await f.files.readFile(f.alice.token,mixedFile.fileId,mixedRevision)
 for(const x of lefts){
  const image=await readImageSource(mixedBytes,0,[x,148,x+40,188])
  assert.deepEqual([...image.bgra.subarray(0,4)],[255,0,0,255])
 }
 const renderFirstPage=bytes=>PNG.sync.read(execFileSync('pdftoppm',['-png','-r','72','-f','1','-l','1','-singlefile','-'],{input:bytes}))
 const originalRaster=renderFirstPage(mixedOriginal),savedRaster=renderFirstPage(mixedBytes)
 assert.deepEqual([originalRaster.width,originalRaster.height,savedRaster.width,savedRaster.height],[300,240,300,240])
 for(const x of lefts){
  const index=(65*savedRaster.width+x+8)*4
  assert.deepEqual([...originalRaster.data.subarray(index,index+4)],[255,0,0,255])
  const [red,green,blue,alpha]=savedRaster.data.subarray(index,index+4)
  assert.ok(red<=2&&green<=2&&blue>=253&&alpha===255,`Poppler pixel at ${x+8},65: ${[red,green,blue,alpha]}`)
 }
 assert.equal(pdfInsertFormState(await PDFDocument.load(mixedBytes)),pdfInsertFormState(await PDFDocument.load(mixedOriginal)))
 assert.deepEqual(await f.files.readFile(f.alice.token,mixedFile.fileId,mixedFile.revision),mixedOriginal)
 const mixedReload=page.waitForResponse(response=>response.ok()&&response.url().endsWith('/content?revision='+mixedRevision))
 await page.reload()
 await mixedReload
 await expect.poll(()=>pixel(138,65),{timeout:15000}).toEqual([0,0,255])
 assert.deepEqual(errors,[])
})
