import test from 'node:test'
import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {fileURLToPath} from 'node:url'
import {expect} from '@playwright/test'
import {PNG} from 'pngjs'
import {launchTestBrowser,recordVerifiedOfficeEffect} from '../helpers/browser.mjs'
import {fileFixture,docxBytes,importFile} from '../helpers/files.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {password} from '../helpers/identity.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'

const frame=(delta,finish_reason)=>Buffer.from('data: '+JSON.stringify({choices:[{delta,finish_reason}]})+'\n\n')
test('Word media analysis can use an image from the current send but not an earlier message',{timeout:120_000},async t=>{
 const origin='http://localhost:4264',f=await fileFixture(t,{origin,buildApp:false})
 const keyring={activeKeyId:'test',keys:{test:new Uint8Array(32).fill(25)}}
 const chat={id:'shared-chat',kind:'chat',providerId:'deepseek',label:'Test chat',model:'synthetic',baseUrl:'https://provider.example/v1/chat/completions',enabled:true,apiKey:'synthetic-key'}
 const analysis={id:'image-analysis',kind:'image_analysis',providerId:'openai',label:'Test vision',model:'gpt-4.1',baseUrl:'https://images.example/v1',enabled:true,apiKey:'synthetic-vision-key'}
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[chat,analysis],defaults:{chat:chat.id,image_analysis:analysis.id}})
 await f.preferences.update(f.alice.token,{language:'en',autoSave:false,showAssistant:true})
 const original=await docxBytes(),opened=(await importFile(f,f.alice.token,original)).file
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false,nativeDocsDirectory:process.env.DYOFFICE_TEST_DOCS_DIST??fileURLToPath(new URL('../../dist-docs',import.meta.url))})
 f.cleanup.push(async()=>{app.server.closeAllConnections();await app.close()});await app.listen({host:'127.0.0.1',port:4264})
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage(),mediaCalls=[],results=[]
 const image=new PNG({width:1,height:1});image.data.set([252,24,12,255])
 const buffer=PNG.sync.write(image),requirements='Identify the color'
 await page.route('**/api/v1/ai/media',route=>{
  mediaCalls.push(route.request().postDataJSON())
  return route.fulfill({json:{text:'The pixel is red.'}})
 })
 const {csrfToken}=await(await page.request.get(origin+'/api/v1/auth/csrf')).json()
 assert.equal((await page.request.post(origin+'/api/v1/auth/login',{headers:{origin,'x-csrf-token':csrfToken},data:{username:'alice',password}})).status(),200)
 let turns=0
 const network=mockProviderNetwork(t,()=>{
  const current=turns++,index=Math.floor(current/2),request=JSON.parse(network.wire.toString())
  if(current%2){
   results.push(JSON.parse(request.messages.filter(message=>message.role==='tool').at(-1).content))
   return Readable.from([frame({content:'Analysis round '+index+' complete'},'stop'),Buffer.from('data: [DONE]\n\n')])
  }
  assert.ok(request.tools.some(tool=>tool.function.name==='analyze_media'))
  const currentMessage=JSON.stringify(request.messages.filter(message=>message.role==='user').at(-1))
  const attachmentMarker='Current message image attachments'
  assert.equal(currentMessage.includes(attachmentMarker),index===0)
  if(index===0)assert.ok(currentMessage.includes('red.png'))
  const input={attachmentIndex:0,requirements}
  return Readable.from([frame({tool_calls:[{index:0,id:'attachment-media-'+index,type:'function',function:{name:'analyze_media',arguments:JSON.stringify(input)}}]},'tool_calls'),Buffer.from('data: [DONE]\n\n')])
 })
 await page.goto(origin+'/native-docx/?fileId='+opened.fileId)
 await expect(page.locator('.tiptap.doc-page').first()).toBeVisible({timeout:45_000})
 if(await page.locator('.ai-rail').isVisible())await page.locator('.ai-rail').click()
 const panel=page.locator('.ai-panel'),composer=panel.locator('textarea')
 await panel.locator('.ai-plus-btn').click()
 const chooser=page.waitForEvent('filechooser')
 await panel.getByRole('menuitem',{name:'Add file',exact:true}).click()
 await (await chooser).setFiles({name:'red.png',mimeType:'image/png',buffer})
 await expect(panel.getByRole('img',{name:'red.png',exact:true})).toBeVisible()
 for(let index=0;index<2;index++){
  await composer.fill('Analyze image for round '+index);await composer.press('Enter')
  await expect(page.getByText('Analysis round '+index+' complete',{exact:true})).toBeVisible({timeout:20_000})
  if(index===0)assert.equal(results[0].output,'The pixel is red.')
  else assert.equal(results[1].isError,true)
 }
 assert.deepEqual(mediaCalls,[{action:'analyze_media',mediaUrls:['data:image/png;base64,'+buffer.toString('base64')],requirements}])
 assert.equal((await f.files.openFile(f.alice.token,opened.fileId)).file.revision,opened.revision)
 await expect.poll(async()=>{
  const proof=(await(await page.request.get(origin+'/api/v1/auth/session-proof')).json()).csrfToken
  const response=await page.request.post(origin+'/api/v1/files/'+opened.fileId+'/assistant-chat',{headers:{origin,'x-csrf-token':proof},data:{}})
  return response.ok()&&(await response.json()).messages.some(m=>m.attachments?.some(a=>a.name==='red.png'))
 }).toBe(true)
 await page.reload()
 await expect(page.locator('.tiptap.doc-page').first()).toBeVisible()
 if(await page.locator('.ai-rail').isVisible())await page.locator('.ai-rail').click()
 const sent=panel.locator('.ai-msg-user').filter({hasText:'Analyze image for round 0'})
 await expect(sent.locator('.ai-attachment-thumb[title="red.png"]')).toBeVisible()
 recordVerifiedOfficeEffect('docx','analyze_media')
})
