import test from 'node:test'
import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {fileURLToPath} from 'node:url'
import {expect} from '@playwright/test'
import JSZip from 'jszip'
import {PNG} from 'pngjs'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,docxBytes,importFile} from '../helpers/files.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {password} from '../helpers/identity.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'

const webp='UklGRhwAAABXRUJQVlA4TA8AAAAvA8AAAAcQ/Y/+ByKi/wEA'
const remoteUrl='https://images.example/icon.webp'
const frame=(delta,finish_reason)=>Buffer.from('data: '+JSON.stringify({choices:[{delta,finish_reason}]})+'\n\n')

test('Word AI inserts generated, linked and attached images into DOCX without reusing expired attachments',{timeout:120_000},async t=>{
 const origin='http://localhost:4254',f=await fileFixture(t,{origin,buildApp:false})
 const keyring={activeKeyId:'test',keys:{test:new Uint8Array(32).fill(25)}}
 const chat={id:'shared-chat',kind:'chat',providerId:'deepseek',label:'Test chat',model:'synthetic',baseUrl:'https://provider.example/v1',enabled:true,apiKey:'synthetic-key'}
 const images={id:'image-gen',kind:'image_generation',providerId:'openai',label:'Test images',model:'gpt-image-1',baseUrl:'https://images.example/v1',enabled:true,apiKey:'synthetic-image-key'}
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[chat,images],defaults:{chat:chat.id,image_generation:images.id}})
 await f.preferences.update(f.alice.token,{language:'en',autoSave:false,showAssistant:true})
 const original=await docxBytes(),opened=(await importFile(f,f.alice.token,original)).file
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false,nativeDocsDirectory:process.env.DYOFFICE_TEST_DOCS_DIST??fileURLToPath(new URL('../../dist-docs',import.meta.url))})
 f.cleanup.push(async()=>{app.server.closeAllConnections();await app.close()});await app.listen({host:'127.0.0.1',port:4254})
 const browser=await launchTestBrowser();t.after(()=>browser.close())
 const page=await browser.newPage(),errors=[],mediaCalls=[],results=[]
 page.on('pageerror',error=>errors.push(error.message))
 await page.route('**/api/v1/ai/media',route=>{
  const body=route.request().postDataJSON()
  mediaCalls.push(body.action)
  if(body.action==='generate_image')return route.fulfill({json:{url:'data:image/webp;base64,'+webp}})
  assert.equal(body.url,remoteUrl)
  return route.fulfill({json:{base64:webp,mime:'image/webp'}})
 })
 const {csrfToken}=await(await page.request.get(origin+'/api/v1/auth/csrf')).json()
 assert.equal((await page.request.post(origin+'/api/v1/auth/login',{headers:{origin,'x-csrf-token':csrfToken},data:{username:'alice',password}})).status(),200)
 let turns=0
 const calls=[['generate_image',{prompt:'Draw a red square'}],['insert_image',{url:remoteUrl}],
  ['insert_image',{}],['insert_picture',{afterBlockIndex:-1,width:'32px',altText:'Attached blue picture',float:{x:'20px',y:'12px',wrap:'square'}}],
  ['insert_image',{}]]
 const references=[]
 const network=mockProviderNetwork(t,()=>{
  const current=turns++,index=Math.floor(current/2)
  const [name,input]=calls[index]
  const request=JSON.parse(network.wire.toString())
  assert.ok(request.tools.some(tool=>tool.function.name===name))
  if(current%2){
   results.push(JSON.parse(request.messages.filter(message=>message.role==='tool').at(-1).content))
   return Readable.from([frame({content:'Image action '+index+' complete'},'stop'),Buffer.from('data: [DONE]\n\n')])
  }
  if(index>=2){
   const user=request.messages.findLast(message=>message.role==='user')
   const text=typeof user.content==='string'?user.content:user.content.map(part=>part.text??'').join(' ')
   if(index<4){
    const reference=text.match(/(https:\/\/attached-image\.invalid\/[0-9a-f-]{36}) \| "local\.png"/)?.[1]
    assert.ok(reference,'Current image must have an insertable reference')
    assert.ok(!references.includes(reference))
    references.push(reference)
    assert.ok(user.content.some(part=>part.type==='image_url'))
   }else assert.doesNotMatch(text,/attachments \(insert_image/)
   input.url=references[index===4?0:index-2]
  }
  return Readable.from([frame({tool_calls:[{index:0,id:'word-media-'+index,type:'function',function:{name,arguments:JSON.stringify(input)}}]},'tool_calls'),Buffer.from('data: [DONE]\n\n')])
 })
 await page.goto(origin+'/native-docx/?fileId='+opened.fileId)
 await expect(page.locator('.tiptap.doc-page').first()).toBeVisible({timeout:45_000})
 if(await page.locator('.ai-rail').isVisible())await page.locator('.ai-rail').click()
 const composer=page.locator('.ai-panel textarea')
 for(let index=0;index<calls.length;index++){
  if(index===2||index===3){
   const image=new PNG({width:4,height:4})
   for(let i=0;i<16;i++)image.data.set(index===2?[0,255,0,255]:[0,0,255,255],i*4)
   const panel=page.locator('.ai-panel')
   await panel.locator('.ai-plus-btn').click()
   const chooser=page.waitForEvent('filechooser')
   await panel.getByRole('menuitem',{name:'Add file',exact:true}).click()
   await (await chooser).setFiles({name:'local.png',mimeType:'image/png',buffer:PNG.sync.write(image)})
   await expect(panel.getByRole('img',{name:'local.png',exact:true}).first()).toBeVisible()
  }
  await composer.fill('Insert image '+index);await composer.press('Enter')
  try{await expect(page.getByText('Image action '+index+' complete',{exact:true})).toBeVisible({timeout:15_000})}
  catch(error){t.diagnostic(JSON.stringify({turns,mediaCalls,errors,assistant:await page.locator('.ai-panel').innerText()}));throw error}
  assert.equal(!!results[index].isError,index===4,results[index].output)
 }
 assert.deepEqual(mediaCalls,['generate_image','fetch_image'])
 await expect(page.locator('.tiptap.doc-page img')).toHaveCount(4)
 assert.equal((await f.files.openFile(f.alice.token,opened.fileId)).file.revision,opened.revision)
 const committed=page.waitForResponse(response=>response.url().endsWith('/commits')&&response.status()===200)
 await page.keyboard.press('Control+s');await committed
 const saved=(await f.files.openFile(f.alice.token,opened.fileId)).file
 assert.notEqual(saved.revision,opened.revision)
 const zip=await JSZip.loadAsync(await f.files.readFile(f.alice.token,saved.fileId,saved.revision))
 const xml=await zip.file('word/document.xml').async('string')
 assert.equal([...xml.matchAll(/<a:blip\s/g)].length,4)
 assert.match(xml,/<wp:anchor\b/)
 assert.match(xml,/Attached blue picture/)
 const media=zip.file(/^word\/media\/.*\.png$/)
 assert.ok(media.length>0)
 const colors=new Set()
 for(const file of media){
  const image=PNG.sync.read(await file.async('nodebuffer'))
  assert.deepEqual([image.width,image.height],[4,4])
  colors.add([...image.data.subarray(0,4)].join(','))
 }
 assert.deepEqual(colors,new Set(['255,0,0,255','0,255,0,255','0,0,255,255']))
 assert.deepEqual(await f.files.readFile(f.alice.token,opened.fileId,opened.revision),original)
 await page.reload();await expect(page.locator('.tiptap.doc-page img')).toHaveCount(4,{timeout:30_000})
 assert.deepEqual(errors,[])
})
