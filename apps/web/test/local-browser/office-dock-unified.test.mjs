import {stubHomeHero,isHomeHeroRequest} from '../helpers/home-hero.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm,mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {officeBrowserAsset as dist} from '../helpers/office-browser-assets.mjs'
import {execFileSync} from 'node:child_process'
import {createServer} from 'node:https'
import {PDFDocument} from 'pdf-lib'
import {expect} from '@playwright/test'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,docxBytes,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {createCrossPlatformProcess} from '../../worker/src/sandbox/cross-platform-process.ts'
import {sheetsGateway} from '../helpers/sheets-gateway.mjs'
import {createXlsxNativeWorker} from '../../worker/src/native/xlsx.ts'
import {openIsolatedPptxSession} from '../../worker/src/native/pptx-session-host.ts'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {createSkillService} from '../../server/src/modules/skills/service.ts'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'

test('four real Office editors share assistant chrome and retain drafts across collapse and an early stream failure',{timeout:180000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'dyoffice-dock-'))
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
 const keyring={activeKeyId:'dock',keys:{dock:new Uint8Array(32).fill(29)}}
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[{id:'chat',kind:'chat',providerId:'deepseek',label:'Office model',model:'synthetic',baseUrl:'https://provider.example/v1',enabled:true,apiKey:'test-key'}],defaults:{chat:'chat'}})
 await f.preferences.update(f.alice.token,{language:'zh',autoSave:false,showAssistant:true})
 await createSkillService(f.transactions).save(f.alice.token,'review-office',{description:'核对 Word、Excel、PowerPoint 和 PDF 内容与保存结果，保持修改可追溯。',body:'Review the current document and report the verified results.'})
 const gateway=await sheetsGateway(t),metadata=JSON.parse(await readFile(new URL('../../../../.dyoffice-native-build/host-manifest.json',import.meta.url),'utf8'))
 const sheetsNative=createXlsxNativeWorker(createCrossPlatformProcess({deploymentId:f.deploymentId,binary:metadata.nativeBinary,sha256:metadata.nativeSha256,allowedCommands:['open','read_range','read_formula_cells','read_row_outline','read_media','recalc_cells','save_archive','close']}))
 const slidesHost={openSession(input){return openIsolatedPptxSession({fileId:input.fileId,revision:input.revision,bytes:input.bytes},{timeoutMs:60000,unsafeTestOnly:true})}}
 const pdf=await PDFDocument.create();pdf.addPage([400,300]).drawText('Office assistant layout')
 const files={}
 for(const [format,bytes] of [['docx',await docxBytes()],['xlsx',await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url))],['pptx',await readFile(new URL('../fixtures/slides/acceptance.pptx',import.meta.url))],['pdf',Buffer.from(await pdf.save())]])files[format]=(await importFile(f,f.alice.token,bytes,'dock.'+format)).file
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false,nativeDocsDirectory:dist('docs'),nativeSheetsDirectory:dist('sheets'),nativeSlidesDirectory:dist('slides'),nativePdfDirectory:dist('pdf'),localShellDirectory:dist('local-shell'),sheetsNative,sheetsPlanner:gateway.planWorkbookSave,sheetsPackageReader:gateway.readWorkbookPackage,slidesHost})
 browser=await launchTestBrowser()
 const page=await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}}),errors=[],turns=[]
 await stubHomeHero(page)
 page.on('pageerror',error=>{errors.push(error.message);t.diagnostic(error.stack??error.message)})
 page.on('response',async response=>{
  if(response.status()===409&&new URL(response.url()).pathname.includes('/slides/')){
   const payload=response.request().postDataJSON()
   t.diagnostic(JSON.stringify({path:new URL(response.url()).pathname,generation:payload?.generation,index:payload?.index,response:await response.text()}))
  }
 })
 page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/v1/ai/turns'&&!isHomeHeroRequest(request))turns.push(true)})
 const {csrfToken}=await (await page.request.get(origin+'/api/v1/auth/csrf')).json()
 assert.equal((await page.request.post(origin+'/api/v1/auth/login',{headers:{origin,'x-csrf-token':csrfToken},data:{username:'alice',password}})).status(),200)
 await mkdir('test-results/office-dock-unified',{recursive:true})
 const metrics=[]
 const network=mockProviderNetwork(t,[Buffer.from('data: {"choices":[{"delta":{"content":"Office connection recovered"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')],{status:attempt=>attempt%2===1?429:200})
 let delayedFailure
 const requests=[]
 await page.route('**/api/v1/ai/turns',async route=>{
  if(isHomeHeroRequest(route.request()))return route.fallback()
  requests.push(route.request().postDataJSON().request)
  if(delayedFailure){
   const failure=delayedFailure
   delayedFailure=undefined
   await failure
   return route.fulfill({contentType:'text/event-stream',body:'event: delta\ndata: {"text":"Partial model reply"}\n\nevent: error\ndata: {"reason":"AI_TURN_TIMED_OUT","message":"The model response timed out."}\n\nevent: done\ndata: {}\n\n'})
  }
  return route.continue()
 })
 for(const format of ['docx','xlsx','pptx','pdf']){
  if(format==='pdf')await f.preferences.update(f.alice.token,{theme:'dark'})
  await page.goto(origin+'/native-'+format+'/?fileId='+files[format].fileId,{waitUntil:'commit'})
  if(format==='docx')await expect(page.locator('.tiptap.doc-page').first()).toBeVisible({timeout:45000})
  if(format==='xlsx')await expect(page.locator('#univer-container canvas').first()).toBeVisible({timeout:45000})
  if(format==='pptx')await expect(page.locator('.app-main')).toBeVisible({timeout:45000})
  if(format==='pdf'){
   await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready',{timeout:45000})
   await expect(page.locator('html')).toHaveAttribute('data-theme','dark')
  }
  const initialRail=page.locator(format==='xlsx'?'.expand-copilot':'.ai-rail').first()
  const panel=page.locator(format==='xlsx'?'.copilot:not(.collapsed)':'.ai-panel').first()
  try{
   await expect.poll(async()=>await initialRail.isVisible()||await panel.locator('textarea').isVisible(),{timeout:15000,message:format+' assistant becomes available'}).toBe(true)
  }catch(error){
   t.diagnostic(JSON.stringify({format,errors,ui:await page.evaluate(()=>({dock:document.querySelector('.ai-dock')?.className,rails:document.querySelectorAll('.ai-rail').length,panels:document.querySelectorAll('.ai-panel').length,desktop:!!window.desktop}))}))
   await page.screenshot({path:`test-results/office-dock-unified/${format}-failure.png`});throw error
  }
  if(await initialRail.isVisible())await initialRail.click()
  await expect(panel.locator('textarea')).toBeVisible({timeout:45000})
  const starter=panel.locator('.ai-starter').first()
  if(await starter.count()){
   const instruction=await starter.innerText()
   await starter.focus();await page.keyboard.press('Enter')
   await expect(panel.locator('textarea')).toHaveValue(instruction)
   await expect(panel.locator('textarea')).toBeFocused()
   await starter.hover()
   await page.screenshot({path:`test-results/office-dock-unified/${format}-suggestion.png`,animations:'disabled'})
  }
  const chatTab=panel.getByRole('tab',{name:'对话',exact:true})
  const tasksTab=panel.getByRole('tab',{name:/任务/})
  await chatTab.press('ArrowRight')
  await expect(tasksTab).toHaveAttribute('aria-selected','true')
  await expect(tasksTab).toBeFocused({timeout:15000})
  await expect(panel.locator('.ai-chat')).toBeHidden()
  await expect(panel.locator('.ai-composer')).toBeHidden()
  await page.keyboard.press('Home');await expect(chatTab).toBeFocused()
  await expect(panel.locator('.ai-chat')).toBeVisible()
  const draft='核对当前文档\n保留这份草稿'
  const textarea=panel.locator('textarea')
  const textareaHeight=()=>textarea.evaluate(node=>node.getBoundingClientRect().height)
  const compactHeight=44
  // Keyboard tab navigation leaves focus on the tab; focus the iframe composer before filling it.
  await textarea.click()
  await textarea.fill(draft)
  await expect(textarea,format+' short draft is entered').toHaveValue(draft)
  // The composer measures after the React update; the previous starter can still be at maximum height.
  await expect.poll(textareaHeight,{timeout:15000,message:format+' short draft settles before measuring growth'}).toBe(compactHeight)
  await textarea.fill(`${draft}\n检查第三行\n检查第四行`)
  await expect.poll(textareaHeight,{message:format+' composer grows for a longer draft'}).toBeGreaterThan(compactHeight)
  await textarea.fill(draft)
  await expect.poll(textareaHeight,{timeout:15000,message:format+' composer shrinks for the short draft'}).toBe(compactHeight)
  {
   const handle=panel.getByRole('separator',{name:'调整 AI 助手宽度'})
   await expect(handle).toBeVisible()
   const edge=await handle.boundingBox()
   const width=(await panel.boundingBox()).width
   await page.mouse.move(edge.x+edge.width/2,edge.y+48)
   await page.mouse.down()
   await page.mouse.move(edge.x+edge.width/2+90,edge.y+48,{steps:5})
   await expect.poll(async()=>(await panel.boundingBox()).width).toBe(width+90)
   await page.mouse.up()
   await handle.focus();await page.keyboard.press('ArrowRight')
   await expect(panel).toHaveCSS('width','466px')
   await page.keyboard.press('ArrowLeft')
   await expect(panel).toHaveCSS('width','450px')
   await expect(textarea).toHaveValue(draft)
  }
  const model=panel.getByRole('button',{name:'模型: synthetic',exact:true})
  await model.click()
  await expect(page.getByRole('option',{name:'synthetic',exact:true})).toHaveAttribute('aria-selected','true')
  await page.screenshot({path:`test-results/office-dock-unified/${format}-model-menu.png`,animations:'disabled'})
  await page.keyboard.press('Escape');await expect(model).toBeFocused()
  for(const theme of ['light','dark']){
   await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme)
   await panel.getByRole('tab',{name:/任务/}).click()
   const filters=panel.locator('.assistant-task-filters button')
   await expect(filters).toHaveCount(4)
   const boxes=await Promise.all((await filters.all()).map(button=>button.boundingBox()))
   assert.ok(Math.abs(boxes[0].width-boxes[1].width)<=1&&Math.abs(boxes[0].y-boxes[1].y)<=1,'task filters align in equal columns')
   assert.ok(boxes.every(box=>box.height>=34),format+' task filter click targets retain the shared minimum height')
   assert.equal(await filters.first().evaluate(node=>getComputedStyle(node).borderRadius),'8px',format+' task filter shape stays consistent after lazy styles load')
   for(const button of await filters.all()){
    await button.click();await expect(button).toHaveAttribute('aria-pressed','true')
    await expect(panel.locator('.assistant-team-empty')).toBeVisible()
   }
   await page.screenshot({path:`test-results/office-dock-unified/${format}-tasks-${theme}.png`,animations:'disabled'})
   await expect(panel.getByRole('tablist',{name:'Office 助手'}).getByRole('tab')).toHaveCount(2)
   await chatTab.click()
   const plus=panel.locator('.ai-plus-btn')
   {
    await expect(plus).toBeVisible()
    await plus.click()
    const menu=panel.locator('.ai-plus-pop')
    await expect(menu).toBeVisible()
    const menuBox=await menu.boundingBox(),viewport=page.viewportSize()
    assert.ok(menuBox.x>=0&&menuBox.x+menuBox.width<=viewport.width&&menuBox.y>=0&&menuBox.y+menuBox.height<=viewport.height,'composer menu stays within the viewport')
    await page.screenshot({path:`test-results/office-dock-unified/${format}-add-menu-${theme}.png`,animations:'disabled'})
    const skills=menu.getByRole('menuitem',{name:'技能',exact:true})
    if(await skills.count())await skills.click()
    const skillSearch=menu.locator('.ai-plus-search')
    await expect(skillSearch).toBeFocused()
    await skillSearch.fill('no-matching-skill-pixel-review')
    await expect(menu.locator('.ai-plus-empty')).toBeVisible()
    assert.ok(await menu.evaluate(node=>node.scrollWidth<=node.clientWidth+1),'skill picker has no horizontal overflow')
    await page.screenshot({path:`test-results/office-dock-unified/${format}-skill-search-${theme}.png`,animations:'disabled'})
    await skillSearch.fill('review-office')
    const skill=menu.locator('.ai-plus-skill').filter({hasText:'review-office'})
    await expect(skill).toBeVisible();await skill.click()
    await expect(panel.locator('.ai-skill-chip')).toContainText('review-office')
    await page.screenshot({path:`test-results/office-dock-unified/${format}-skill-selected-${theme}.png`,animations:'disabled'})
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0);await expect(plus).toBeFocused()
    await panel.getByRole('button',{name:'移除技能',exact:true}).click()
    await expect(panel.locator('.ai-skill-chip')).toHaveCount(0)
   }
   await panel.locator('textarea').focus()
   const send=panel.getByRole('button',{name:'发送',exact:true})
   await expect(send).toBeEnabled()
   const accent=await panel.evaluate(node=>{
    const sample=document.createElement('span')
    sample.style.color='var(--accent)'
    node.append(sample)
    const color=getComputedStyle(sample).color
    sample.remove()
    return color
   })
   await expect(panel.locator('.ai-panel-title > svg')).toHaveCSS('color',accent)
   await expect(panel.locator('.ai-input-box')).toHaveCSS('border-top-color',accent)
   await expect(chatTab).toHaveCSS('color',accent)
   await expect(send).toHaveCSS('background-color',accent)
   await expect(send.locator('.assistant-send-button-glyph')).toBeVisible()
   if(format==='xlsx'||format==='pptx'){
    const fileButton=page.getByRole('button',{name:'文件',exact:true})
    await expect(fileButton).toHaveCSS('background-color',accent)
    await fileButton.focus()
    await page.keyboard.press('Enter')
    await expect(fileButton).toHaveAttribute('aria-expanded','true')
    const menu=page.getByRole('group',{name:'文件',exact:true})
    await expect(menu).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(menu.getByRole('button').first()).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(fileButton).toBeFocused()
    await panel.locator('textarea').focus()
   }
   const chrome=await panel.evaluate(node=>{
    const read=selector=>{const element=node.querySelector(selector),style=getComputedStyle(element);return {height:element.getBoundingClientRect().height,fontSize:style.fontSize,borderRadius:style.borderRadius,padding:style.padding}}
    return {header:read('.ai-panel-header'),input:read('.ai-input-box'),textarea:read('textarea')}
   })
   metrics.push({format,theme,chrome})
   await page.screenshot({path:`test-results/office-dock-unified/${format}-${theme}.png`,animations:'disabled'})
   assert.equal(chrome.header.height,54,format+' header height')
   assert.equal(chrome.input.height,108,format+' model picker fits the compact composer')
   assert.equal(chrome.input.borderRadius,'12px',format+' input radius')
   assert.equal(chrome.textarea.fontSize,'14px',format+' input typography')
   assert.equal(chrome.textarea.height,compactHeight,format+' short draft keeps a compact input')
   assert.ok(await panel.locator('.ai-chat,.ai-composer').evaluateAll(nodes=>nodes.every(node=>node.scrollWidth<=node.clientWidth+1)),format+' chat and composer have no horizontal overflow')
  }
  await panel.locator('.ai-panel-collapse').click()
  const rail=page.locator(format==='xlsx'?'.expand-copilot':'.ai-rail').first()
  await expect(rail).toBeVisible()
  await page.screenshot({path:`test-results/office-dock-unified/${format}-collapsed.png`,animations:'disabled'})
  await rail.click();await expect(panel.locator('textarea')).toHaveValue(draft)
  await expect(panel).toHaveCSS('width','450px')
  await expect.poll(textareaHeight).toBe(compactHeight)
  await panel.locator('textarea').fill(Array(20).fill('这是一段较长的编辑指令').join('\n'))
  await expect.poll(textareaHeight).toBe(168)
  await panel.locator('textarea').fill(draft)
  await expect.poll(textareaHeight).toBe(compactHeight)
  await page.setViewportSize({width:768,height:900})
  await expect(panel.locator('textarea')).toBeVisible()
  if(format==='pdf'){
   assert.ok(await page.locator('.app-main').evaluate(node=>node.scrollWidth<=node.clientWidth+1),'native PDF and assistant fit the viewport')
  }
  await page.screenshot({path:`test-results/office-dock-unified/${format}-768.png`,animations:'disabled'})
  if(format==='pdf'){
   await page.setViewportSize({width:390,height:844})
   await expect(page.locator('.app-main')).toHaveCSS('flex-direction','column')
   await expect(panel.getByRole('separator',{name:'调整 AI 助手宽度'})).toBeHidden()
   await panel.getByRole('button',{name:'发送',exact:true}).scrollIntoViewIfNeeded()
   await expect(panel.locator('textarea')).toBeInViewport()
   await expect(panel.getByRole('button',{name:'发送',exact:true})).toBeInViewport()
   assert.ok(await panel.getByRole('button',{name:'发送',exact:true}).evaluate(node=>{const rect=node.getBoundingClientRect();return node.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2))}),'mobile send control is not covered by notifications')
   assert.ok(await page.locator('.app-main').evaluate(node=>node.scrollWidth<=node.clientWidth+1),'mobile native PDF and assistant fit the viewport')
   await page.screenshot({path:'test-results/office-dock-unified/pdf-390.png',animations:'disabled'})
  }
  assert.equal((await f.files.openFile(f.alice.token,files[format].fileId)).file.revision,files[format].revision,format+' assistant layout interactions do not save the document')
  await page.setViewportSize({width:1440,height:1000})
  const send=panel.getByRole('button',{name:'发送',exact:true})
  const composer=panel.locator('.ai-composer').filter({has:page.locator('textarea')})
  const draftExtras=composer.locator(format==='pdf'?'.shared-assistant-file-list':'.ai-attachments')
  const addDraftExtras=async()=>{
   const plus=panel.locator('.ai-plus-btn')
   await plus.click()
   const chooser=page.waitForEvent('filechooser')
   await panel.getByRole('menuitem',{name:'添加文件',exact:true}).click()
   await (await chooser).setFiles({name:'restore-note.txt',mimeType:'text/plain',buffer:Buffer.from('Recovery text attachment')})
   await expect(draftExtras).toContainText('restore-note.txt')
   await plus.click()
   const skillEntry=panel.getByRole('menuitem',{name:'技能',exact:true})
   if(await skillEntry.count())await skillEntry.click()
   await panel.locator('.ai-plus-skill').filter({hasText:'review-office'}).click()
   await page.keyboard.press('Escape')
   await expect(composer.locator('.ai-skill-chip')).toContainText('review-office')
  }
  await addDraftExtras()
  const before=network.writes
  await send.click()
  await expect(panel.locator('.ai-chat')).toContainText(/模型供应商限流或额度不足，请稍后重试或切换模型。|The model provider is rate limited or out of quota\. Try again later or choose another model\./)
  await expect(textarea).toHaveValue(draft,{timeout:5000})
  {
   await expect(draftExtras).toContainText('restore-note.txt')
   await expect(composer.locator('.ai-skill-chip')).toContainText('review-office')
  }
  assert.equal(network.writes,before+1,format+' does not automatically retry')
  await send.click()
  await expect(panel.locator('.ai-chat')).toContainText('Office connection recovered')
  {
   for(const request of requests.slice(-2)){
    assert.match(JSON.stringify(request.messages),/Review the current document and report the verified results/)
    assert.match(JSON.stringify(request),/restore-note\.txt/)
   }
   await expect(draftExtras).toHaveCount(0)
   await expect(composer.locator('.ai-skill-chip')).toHaveCount(0)
   await addDraftExtras()
  }
  if(format==='pdf')await composer.getByRole('button',{name:'移除技能',exact:true}).click()
  assert.equal(network.writes,before+2)
  let release
  const beforeTimeout=requests.length
  delayedFailure=new Promise(resolve=>{release=resolve})
  try{
   await textarea.fill('先前提交的请求')
   await send.click()
   await expect.poll(()=>delayedFailure===undefined).toBe(true)
   await textarea.fill('正在写的下一条消息')
  }finally{release()}
  await expect(panel.locator('.ai-chat')).toContainText(/等待模型回复超时。请重试、缩短请求，或切换模型。|The model response timed out\./)
  await expect(panel.locator('.ai-chat')).toContainText('Partial model reply')
  await expect(panel.locator('.ai-chat')).toContainText('先前提交的请求')
  await expect(textarea).toHaveValue('正在写的下一条消息')
  assert.equal(requests.length,beforeTimeout+1,format+' does not replay a timed out request')
  {
   assert.match(JSON.stringify(requests.at(-1)),/restore-note\.txt/)
   if(format==='pdf')assert.doesNotMatch(JSON.stringify(requests.at(-1).messages),/Review the current document and report the verified results/)
   await expect(draftExtras).toHaveCount(0)
   await expect(composer.locator('.ai-skill-chip')).toHaveCount(0)
  }
  assert.equal((await f.files.openFile(f.alice.token,files[format].fileId)).file.revision,files[format].revision)
  await page.reload()
  await expect.poll(async()=>await rail.isVisible()||await panel.locator('textarea').isVisible(),{timeout:45000}).toBe(true)
  if(await rail.isVisible())await rail.click()
  await expect(panel).toHaveCSS('width','450px',{timeout:15000})
  if(format==='pdf'){
   await panel.locator('.ai-plus-btn').click()
   await panel.getByRole('menuitem',{name:'技能',exact:true}).click()
   await expect(panel.getByRole('menuitemcheckbox',{name:/review-office/})).toHaveAttribute('aria-checked','false')
  }
 }
 await f.preferences.update(f.alice.token,{showAssistant:false})
 await page.reload()
 await expect(page.locator('.native-pdf-assistant-status')).toContainText('个人设置中关闭')
 await expect(page.locator('.shared-assistant-dock')).toHaveCount(0)
 assert.equal(turns.length,12,'only the three explicit sends in each editor reach the model')
 assert.deepEqual(errors,[])
 t.diagnostic(JSON.stringify(metrics))
})
