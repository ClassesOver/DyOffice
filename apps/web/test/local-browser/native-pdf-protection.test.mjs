import test from 'node:test'
import assert from 'node:assert/strict'
import {PDFDocument,PDFName} from 'pdf-lib'
import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {expect} from '@playwright/test'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {password} from '../helpers/identity.mjs'
import {isHomeHeroRequest,stubHomeHero} from '../helpers/home-hero.mjs'
import {buildLocalApp} from '../../server/src/app.ts'

const directory=process.env.DYOFFICE_TEST_NATIVE_PDF_DIST
test('native PDF protected structures stay readable without offering edit drafts',{skip:!directory,timeout:60000},async t=>{
 const origin='http://localhost:4276',f=await fileFixture(t,{origin,buildApp:false})
 const records=[]
 for(const [kind,label] of [['signature','包含签名结构'],['xfa','包含 XFA 表单'],['encrypted','加密 PDF'],['plain','']]){
  const pdf=await PDFDocument.create()
  pdf.addPage([320,240]).drawText('Readable original '+kind,{x:24,y:180})
  if(kind==='signature')pdf.catalog.set(PDFName.of('Perms'),pdf.context.obj({}))
  if(kind==='xfa')pdf.getForm().acroForm.dict.set(PDFName.of('XFA'),pdf.context.register(pdf.context.stream('<xdp/>')))
  const bytes=kind==='encrypted'?await readFile(new URL('../../../pdf/tests/fixtures/enc256.pdf',import.meta.url))
   :Buffer.from(await pdf.save({updateFieldAppearances:false}))
  if(kind==='encrypted'){
   await assert.rejects(importFile(f,f.alice.token,bytes,kind+'.pdf'),{statusCode:400})
   // Exercise an existing encrypted revision without changing upload policy.
   const fileId=randomUUID(),revision=randomUUID(),owner=f.alice.user.id
   const ref=await f.objects.putImmutable(`${f.deploymentId}/${owner}/objects/${revision}`,bytes)
   await f.ownerDb.transaction(async c=>{
    await c.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true)",[f.deploymentId,owner])
    const {rows:[workspace]}=await c.query('SELECT id FROM workspaces WHERE deployment_id=$1 AND owner_id=$2',[f.deploymentId,owner])
    await c.query("INSERT INTO files(id,deployment_id,owner_id,workspace_id,name,format,current_revision) VALUES($1,$2,$3,$4,'encrypted.pdf','pdf',$5)",[fileId,f.deploymentId,owner,workspace.id,revision])
    await c.query('INSERT INTO file_revisions(id,deployment_id,owner_id,file_id,object_key,sha256,size) VALUES($1,$2,$3,$4,$5,$6,$7)',[revision,f.deploymentId,owner,fileId,ref.key,ref.sha256,ref.size])
   })
   records.push({kind,label,bytes,file:{fileId,revision}})
  }else{
   const {file}=await importFile(f,f.alice.token,bytes,kind+'.pdf')
   records.push({kind,label,bytes,file})
  }
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
 for(const {kind,label,bytes,file} of records){
  turns.length=0
  await page.goto(origin+'/native-pdf/?fileId='+file.fileId)
  if(kind==='encrypted'){
   const prompt=page.getByRole('dialog')
   const input=prompt.locator('input[type=password]')
   await expect(prompt).toBeVisible()
   await input.fill('wrong-password')
   await input.press('Enter')
   await expect(prompt.getByRole('alert')).toContainText('密码错误')
   await input.fill('user123')
   await input.press('Enter')
  }
  await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready')
  await page.getByRole('button',{name:'AI 助手',exact:true}).click()
  const assistant=page.locator('.shared-editor-assistant')
  await assistant.getByRole('textbox',{name:'消息'}).fill('Read the first page.')
  await assistant.getByRole('button',{name:'发送',exact:true}).click()
  await expect(assistant.getByText('Read finished',{exact:true})).toBeVisible({timeout:15000})
  assert.match(turns.at(-1).messages.at(-1).results[0].output,kind==='encrypted'?/confidential/:new RegExp('Readable original '+kind))
  const tools=turns[0].tools.map(tool=>tool.name)
  await page.getByRole('button',{name:'页面',exact:true}).click()
  const rotate=page.getByRole('button',{name:'向右旋转',exact:true})
  const save=page.getByRole('button',{name:'保存',exact:true})
  if(label){
   await expect(page.locator('.tb-readonly')).toContainText(label)
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
})
