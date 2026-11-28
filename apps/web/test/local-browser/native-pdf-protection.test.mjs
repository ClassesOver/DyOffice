import test from 'node:test'
import assert from 'node:assert/strict'
import {PDFDocument,PDFName} from 'pdf-lib'
import {readFile} from 'node:fs/promises'
import {expect} from '@playwright/test'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {password} from '../helpers/identity.mjs'
import {isHomeHeroRequest,stubHomeHero} from '../helpers/home-hero.mjs'
import {buildLocalApp} from '../../server/src/app.ts'

const directory=process.env.DYOFFICE_TEST_NATIVE_PDF_DIST
test('native PDF imports encrypted files and reads protected structures without offering edit drafts',{skip:!directory,timeout:90000},async t=>{
 const origin='http://localhost:4276',f=await fileFixture(t,{origin,buildApp:false})
 const records=[]
 for(const [kind,label] of [['signature','包含签名结构'],['signed','包含签名结构'],['xfa','包含 XFA 表单'],['plain',''],['encrypted','加密 PDF']]){
  const pdf=await PDFDocument.create()
  pdf.addPage([320,240]).drawText('Readable original '+kind,{x:24,y:180})
  if(kind==='signature')pdf.catalog.set(PDFName.of('Perms'),pdf.context.obj({}))
  if(kind==='xfa')pdf.getForm().acroForm.dict.set(PDFName.of('XFA'),pdf.context.register(pdf.context.stream('<xdp/>')))
  const bytes=kind==='encrypted'?await readFile(new URL('../../../pdf/tests/fixtures/enc256.pdf',import.meta.url))
   :kind==='signed'?await readFile(new URL('../fixtures/signed-approval.pdf',import.meta.url))
   :Buffer.from(await pdf.save({updateFieldAppearances:false}))
  const file=kind==='encrypted'?undefined:(await importFile(f,f.alice.token,bytes,kind+'.pdf')).file
  records.push({kind,label,bytes,file})
 }
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,
  nativePdfDirectory:directory,localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY})
 f.cleanup.unshift(()=>app.close())
 await app.listen({port:4276,host:'127.0.0.1'})
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage()
 await stubHomeHero(page)
 await page.route('**/api/v1/ai/catalog',route=>route.fulfill({json:{entries:[{id:'mock',label:'Office test model'}],defaultId:'mock'}}))
 const turns=[]
 await page.route('**/api/v1/ai/turns',route=>{
  if(isHomeHeroRequest(route.request()))return route.fallback()
  const request=route.request().postDataJSON().request
  turns.push(request)
  const result=request.messages.at(-1).results?.[0]
  const event=result?['delta',{text:'Read finished'}]:['tool_call',{id:'read',name:'read_pages',input:{start:1}}]
  return route.fulfill({contentType:'text/event-stream',body:'event: '+event[0]+'\ndata: '+JSON.stringify(event[1])+'\n\nevent: done\ndata: {}\n\n'})
 })
 await page.goto(origin)
 await page.getByLabel('用户名',{exact:true}).fill('alice')
 await page.getByLabel('密码',{exact:true}).fill(password)
 await page.getByRole('button',{name:'登录',exact:true}).click()
 await expect(page.locator('.home')).toBeVisible()
 const secretRequests=[]
 page.on('request',request=>{
  if(request.url().includes('user123')||request.postDataBuffer()?.includes('user123'))secretRequests.push(request.method())
 })
 for(const record of records){
  const {kind,label,bytes}=record
  let {file}=record
  let editor=page
  if(kind==='encrypted'){
   await page.goto(origin)
   await page.getByRole('button',{name:/^(打开本地文件|Open local files?)/i}).click()
   const upload=page.getByRole('dialog',{name:'上传文件',exact:true})
   await upload.locator('input[type=file]').setInputFiles({name:'encrypted.pdf',mimeType:'application/pdf',buffer:bytes})
   const finished=page.waitForResponse(response=>/\/api\/v1\/uploads\/[^/]+\/finish$/.test(response.url())&&response.ok())
   await upload.getByRole('button',{name:'开始上传（1）',exact:true}).click()
   await expect(upload).toContainText('已完成 1',{timeout:25000})
   file=(await(await finished).json()).file
   await upload.getByRole('button',{name:'完成',exact:true}).click()
   editor=page.frameLocator(`iframe[data-document-id="${file.fileId}"]`)
   const prompt=editor.getByRole('dialog')
   const input=prompt.locator('input[type=password]')
   await expect(prompt).toBeVisible()
   await input.fill('wrong-password')
   await input.press('Enter')
   await expect(prompt.getByRole('alert')).toContainText('密码错误')
   await input.fill('user123')
   await input.press('Enter')
  }else{
   await page.goto(origin+'/native-pdf/?fileId='+file.fileId)
  }
  turns.length=0
  await expect(editor.locator('html')).toHaveAttribute('data-document-loading','ready')
  if(kind==='signed'){
   const banner=page.locator('.pdf-sig-banner')
   await expect(banner).toContainText('签名完整，但签名人不受信任')
   await banner.getByRole('button',{name:'查看签名'}).click()
   const signatures=page.getByRole('dialog',{name:'数字签名'})
   await expect(signatures).toContainText('DyOffice QA fixture')
   await expect(signatures).toContainText('自签名证书')
   await expect(signatures).toContainText('工作区服务器')
   await expect(signatures).toContainText('未检查证书吊销状态')
   await page.keyboard.press('Escape')
   await expect(signatures).toHaveCount(0)
   await page.getByRole('button',{name:'文件',exact:true}).click()
   const savedVersion=page.getByRole('link',{name:'下载已保存版本',exact:true})
   await expect(savedVersion).toHaveAttribute('href',`/api/v1/files/${file.fileId}/content?revision=${file.revision}&download=1`)
   const [download]=await Promise.all([page.waitForEvent('download'),savedVersion.click()])
   assert.equal(await download.failure(),null)
   assert.deepEqual(await readFile(await download.path()),bytes)
  }
  await editor.getByRole('button',{name:'AI 助手',exact:true}).click()
  const assistant=editor.locator('.shared-editor-assistant')
  const composer=assistant.getByRole('textbox',{name:'消息'})
  try{
   await composer.fill('Read the first page.')
   await assistant.getByRole('button',{name:'发送',exact:true}).click()
   await expect(assistant.getByText('Read finished',{exact:true}),`${kind}: assistant read reply`).toBeVisible({timeout:15000})
   assert.equal(turns.length,2,`${kind}: one model request and one tool-result request`)
   assert.match(turns[1].messages.at(-1).results[0].output,kind==='encrypted'?/confidential/:new RegExp('Readable original '+kind))
  }catch(error){
   t.diagnostic(JSON.stringify({
    kind,
    requests:turns.map(turn=>({lastRole:turn.messages.at(-1)?.role,hasToolResult:!!turn.messages.at(-1)?.results?.length})),
    draft:await composer.inputValue({timeout:1000}).catch(()=>null),
    assistant:await assistant.innerText({timeout:1000}).catch(()=>null),
   }))
   throw error
  }
  const tools=turns[0].tools.map(tool=>tool.name)
  await editor.getByRole('button',{name:'页面',exact:true}).click()
  const rotate=editor.getByRole('button',{name:'向右旋转',exact:true})
  const save=editor.getByRole('button',{name:'保存',exact:true})
  if(label){
   await expect(editor.locator('.tb-readonly')).toContainText(label)
   await expect(rotate).toBeDisabled()
   assert.ok(!tools.includes('edit_text')&&!tools.includes('add_note')&&!tools.includes('apply_ops'))
   await expect(save).toBeDisabled()
   assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
   const content=await page.request.get(origin+'/api/v1/files/'+file.fileId+'/content?revision='+file.revision)
   assert.ok(content.ok())
   assert.deepEqual(await content.body(),bytes)
  }else{
   assert.ok(tools.includes('edit_text')&&tools.includes('add_note'))
   await rotate.click()
   await expect(save).toBeEnabled()
  }
 }
 assert.deepEqual(secretRequests,[])
})
