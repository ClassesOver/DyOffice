import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {expect} from '@playwright/test'
import JSZip from 'jszip'
import {JSDOM} from 'jsdom'
import {PNG} from 'pngjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {openIsolatedPptxSession} from '../../worker/src/native/pptx-session-host.ts'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'

const nativeSlidesDirectory=process.env.DYOFFICE_TEST_SLIDES_DIST
test('PPTX image replacement uses the current attachment, with queued images available only after send',{skip:!nativeSlidesDirectory,timeout:90000},async t=>{
 const server=createServer()
 t.after(async()=>{
  server.closeAllConnections()
  if(server.listening)await new Promise(resolve=>server.close(resolve))
 })
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
 const origin='http://localhost:'+server.address().port,f=await fileFixture(t,{origin,buildApp:false})
 const original=await readFile(new URL('../fixtures/slides/acceptance.pptx',import.meta.url))
 const {file}=await importFile(f,f.alice.token,original,'image-attachment.pptx')
 await f.preferences.update(f.alice.token,{language:'en',showAssistant:true,autoSave:false})
 const app=await buildLocalApp({
  db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,
  codingHarnesses:false,nativeSlidesDirectory,
  slidesHost:{openSession(input){return openIsolatedPptxSession(input,{timeoutMs:60000,unsafeTestOnly:true})}},
 })
 f.cleanup.unshift(()=>app.close())
 await app.ready()
 server.on('request',app.routing)
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1360,height:900}})
 const {csrfToken}=await (await page.request.get(origin+'/api/v1/auth/csrf')).json()
 assert.equal((await page.request.post(origin+'/api/v1/auth/login',{headers:{origin,'x-csrf-token':csrfToken},data:{username:'alice',password}})).status(),200)
 await page.route('**/api/v1/ai/catalog',route=>route.fulfill({json:{entries:[{id:'mock',label:'Office test model'}],defaultId:'mock'}}))
 let remoteFetches=0,sourceId
 await page.route('**/api/v1/ai/media',route=>{remoteFetches++;return route.abort()})
 let release
 const queued=new Promise(resolve=>{release=resolve})
 const results=[],attachments=[]
 await page.route('**/api/v1/ai/turns',async route=>{
  const last=route.request().postDataJSON().request.messages.at(-1)
  const result=last.results?.[0]
  let event
  if(result){
   results.push(result)
   if(results.length===1)sourceId=result.output.match(/element id=([^.]*)\./)?.[1]
   event=['delta',{text:'Attachment step '+results.length}]
  }else{
   attachments.push({text:last.text,images:last.images})
   if(attachments.length===3)await queued
   const slideIndex=0,url=attachments.length<=2?'attachment://logo.png':'attachment://pending.png'
   event=['tool_call',sourceId
    ?{id:'replace-image-'+attachments.length,name:'replace_image',input:{slideIndex,sourceId,url}}
    :{id:'insert-logo',name:'insert_web_image',input:{slideIndex,url,x:350,y:180,w:100,h:100}}]
  }
  return route.fulfill({contentType:'text/event-stream',body:'event: '+event[0]+'\ndata: '+JSON.stringify(event[1])+'\n\nevent: done\ndata: {}\n\n'})
 })
 await page.goto(origin+'/native-pptx/?fileId='+file.fileId)
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready')
 const panel=page.locator('.ai-panel'),composer=panel.locator('textarea')
 const rail=page.getByRole('button',{name:'Expand AI assistant',exact:true})
 await expect(composer.or(rail)).toBeVisible()
 if(await rail.isVisible())await rail.click()
 const head=async()=>(await f.files.openFile(f.alice.token,file.fileId)).file.revision
 async function attach(name,color){
  const image=new PNG({width:4,height:4})
  for(let i=0;i<16;i++)image.data.set(color,i*4)
  const buffer=PNG.sync.write(image)
  await panel.locator('.ai-plus-btn').click()
  const chooser=page.waitForEvent('filechooser')
  await panel.getByRole('menuitem',{name:'Add file',exact:true}).click()
  await (await chooser).setFiles({name,mimeType:'image/png',buffer})
  await expect(panel.locator('.ai-attachments').getByRole('img',{name,exact:true})).toBeVisible()
  return buffer
 }
 async function save(base){
  await page.keyboard.press('Control+s')
  await expect.poll(head,{timeout:15000}).not.toBe(base)
  return head()
 }
 async function picture(revision){
  const bytes=await f.files.readFile(f.alice.token,file.fileId,revision),zip=await JSZip.loadAsync(bytes),{window}=new JSDOM()
  try{
   const parser=new window.DOMParser()
   const xml=async path=>parser.parseFromString(await zip.file(path).async('string'),'application/xml')
   const slide='ppt/slides/slide1.xml',doc=await xml(slide)
   const pictures=doc.getElementsByTagNameNS('*','pic')
   assert.equal(pictures.length,1)
   const embed=pictures[0].getElementsByTagNameNS('*','blip')[0].getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships','embed')
   const rels=await xml('ppt/slides/_rels/slide1.xml.rels')
   const target=[...rels.getElementsByTagNameNS('*','Relationship')].find(rel=>rel.getAttribute('Id')===embed).getAttribute('Target')
   const frame=pictures[0].getElementsByTagNameNS('*','xfrm')[0].outerHTML
   return {bytes:await zip.file(new URL(target,'https://package.invalid/'+slide).pathname.slice(1)).async('nodebuffer'),frame}
  }finally{window.close()}
 }
 let prior=file.revision,frame
 for(const [index,color] of [[255,0,0,255],[0,0,255,255]].entries()){
  const buffer=await attach('logo.png',color)
  await composer.fill(index?'Replace with the newly attached logo.':'Insert my logo.')
  await panel.getByRole('button',{name:'Send',exact:true}).click()
  await expect(panel.getByText('Attachment step '+(index+1),{exact:true})).toBeVisible()
  assert.ok(!results[index].isError,results[index].output)
  assert.match(attachments[index].text,/logo\.png/)
  assert.deepEqual(attachments[index].images.map(item=>item.base64),[buffer.toString('base64')])
  assert.equal(await head(),prior)
  prior=await save(prior)
  const saved=await picture(prior)
  assert.deepEqual([...PNG.sync.read(saved.bytes).data.subarray(0,4)],color)
  if(index)assert.equal(saved.frame,frame)
  else frame=saved.frame
 }
 await composer.fill('Check an attachment before it is sent.')
 await panel.getByRole('button',{name:'Send',exact:true}).click()
 await expect.poll(()=>attachments.length).toBe(3)
 const green=[0,255,0,255]
 try{
  const pending=await attach('pending.png',green)
  await composer.fill('Replace with the queued image.')
  await composer.press('Enter')
  const queue=panel.locator('.ai-queue-toggle')
  await expect(queue).toBeVisible()
  if(await queue.getAttribute('aria-expanded')==='false')await queue.click()
  await expect(panel.locator('.ai-queue-item')).toContainText('Replace with the queued image.')
  release()
  await expect(panel.getByText('Attachment step 4',{exact:true})).toBeVisible()
  assert.equal(results[2].isError,true)
  assert.match(results[2].output,/No image attachment named "pending\.png"/)
  assert.ok(!results[3].isError,results[3].output)
  assert.deepEqual(attachments[3].images.map(item=>item.base64),[pending.toString('base64')])
  assert.equal(await head(),prior)
  const saved=await picture(await save(prior))
  assert.deepEqual([...PNG.sync.read(saved.bytes).data.subarray(0,4)],green)
  assert.equal(saved.frame,frame)
 }finally{release()}
 assert.equal(remoteFetches,0)
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
})
