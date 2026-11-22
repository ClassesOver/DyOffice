import test from 'node:test'
import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {mkdir,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {PDFDocument,rgb} from 'pdf-lib'
import {PNG} from 'pngjs'
import {expect} from '@playwright/test'
import {isHomeHeroRequest,stubHomeHero} from '../helpers/home-hero.mjs'
import {launchTestBrowser,recordVerifiedOfficeEffect} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {catalog} from '../../server/src/pdf/image-edits-job.mjs'

const generatedFixtures={"gif":{"mime":"image/gif","base64":"R0lGODdhBAAEAIEAAP8AAAAAAAAAAAAAACwAAAAABAAEAAAICQABCBxIsCCAgAA7"},"webp":{"mime":"image/webp","base64":"UklGRhwAAABXRUJQVlA4TA8AAAAvA8AAAAcQ/Y/+ByKi/wEA"},"animated-gif":{"mime":"image/gif","base64":"R0lGODlhBAAEAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAABAAEAAAICQABCBxIsCCAgAAh+QQBCgABACwAAAAABAAEAIEA/wAAAAAAAAAAAAAICQABCBxIsCCAgAA7"},"animated-webp":{"mime":"image/webp","base64":"UklGRoQAAABXRUJQVlA4WAoAAAACAAAAAwAAAwAAQU5JTQYAAAAAAAAAAABBTk1GKAAAAAAAAAAAAAMAAAMAAGQAAAJWUDhMDwAAAC8DwAAABxD9j/4HIqL/AQBBTk1GKAAAAAAAAAAAAAMAAAMAAGQAAABWUDhMDwAAAC8DwAAAB9D/iP4HIqL/AQA="}}
const nativeDirectory=process.env.DYOFFICE_TEST_NATIVE_PDF_DIST
for(const generatedFormat of ['png','gif','webp','animated-gif','animated-webp'])test('Native PDF searches and generates '+generatedFormat+' images through chat and saves a local generated image draft',{skip:!nativeDirectory,timeout:180000},async t=>{
 let app,browser,turn=0,generatedUrl
 const searchUrls=[]
 t.after(async()=>{await browser?.close();app?.server.closeAllConnections();await app?.close()})
 const origin='http://127.0.0.1:4288',f=await fileFixture(t,{origin,buildApp:false}),keyring={activeKeyId:'media',keys:{media:new Uint8Array(32).fill(64)}}
 const network=mockProviderNetwork(t,()=>{
  const index=Math.floor(turn/2),tool=turn++%2===0
  const request=JSON.parse(network.wire.toString())
  assert.ok(request.tools.some(tool=>tool.function.name==='image_search'),'tools: '+request.tools.map(tool=>tool.function.name).join(','));assert.ok(request.tools.some(tool=>tool.function.name==='generate_image'),'generation tools missing')
  assert.doesNotMatch(network.wire.toString(),/data:image|iVBORw/)
  if(index===2&&tool){const result=JSON.parse(request.messages.filter(message=>message.role==='tool').at(-1).content);assert.ok(!result.isError,result.output);generatedUrl=result.output.match(/https:\/\/generated-image\.invalid\/[A-Za-z0-9-]+/)?.[0];assert.ok(generatedUrl,result.output)}
  const calls=[['image_search',{query:'office icon',max_results:2}],['generate_image',{prompt:'Draw a red square',aspect_ratio:'1:1'}],['insert_image',{page:1,url:generatedUrl,x:80,y:90,width:40}]]
  calls.push(['insert_image',{page:1,url:searchUrls[0],x:180,y:90,width:40}],['insert_image',{page:1,url:searchUrls[1],x:280,y:90,width:40}])
  calls.push(['list_page_images',{page:1}],['transform_image',{page:1,image_number:1,x:40,y:180}],['replace_image',{page:1,image_number:2,url:generatedUrl}],['delete_image',{page:1,image_number:3}],['rotate_image',{page:1,image_number:4,direction:'cw'}],['flip_image',{page:1,image_number:5,axis:'horizontal'}],['crop_image',{page:1,image_number:6,left:.5}],['set_image_opacity',{page:1,image_number:7,opacity:.5}],['remove_image_background',{page:1,image_number:8}])
  const [name,input]=calls[index],delta=tool?{tool_calls:[{index:0,id:'media-'+index,type:'function',function:{name,arguments:JSON.stringify(input)}}]}:{content:'Media result '+index}
  return Readable.from([Buffer.from(`data: ${JSON.stringify({choices:[{delta}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:tool?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`)])
 })
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[{id:'shared-chat',kind:'chat',providerId:'openai',label:'Test model',model:'synthetic-model',baseUrl:'https://provider.example/v1',enabled:true,apiKey:'synthetic-key'},{id:'image-gen',kind:'image_generation',providerId:'openai',label:'Test images',model:'gpt-image-1',baseUrl:'https://images.example/v1',enabled:true,apiKey:'synthetic-image-key'},{id:'image-search',kind:'image_search',providerId:'serper',label:'Test search',model:'',baseUrl:'https://google.serper.dev',enabled:true,apiKey:'synthetic-search-key'}],defaults:{chat:'shared-chat',image_generation:'image-gen',image_search:'image-search'}})
 const d=await PDFDocument.create(),sheet=d.addPage([500,600])
 sheet.drawText('Original PDF',{x:30,y:500})
 const sourceBlue=new PNG({width:4,height:4})
 for(let i=0;i<sourceBlue.data.length;i+=4){sourceBlue.data[i+2]=255;sourceBlue.data[i+3]=255}
 const image=await d.embedPng(PNG.sync.write(sourceBlue))
 for(const x of [100,200,300])sheet.drawImage(image,{x,y:300,width:40,height:40})
 sheet.drawImage(image,{x:400,y:300,width:60,height:40})
 const pattern=new PNG({width:4,height:4})
 for(let i=0;i<16;i++)pattern.data.set(i%4<2?[255,255,255,255]:[0,0,255,255],i*4)
 const split=await d.embedPng(PNG.sync.write(pattern))
 sheet.drawRectangle({x:90,y:155,width:365,height:50,color:rgb(1,0,0)})
 for(const x of [100,200,300])sheet.drawImage(split,{x,y:160,width:40,height:40})
 const cutout=new PNG({width:4,height:4})
 cutout.data.fill(255)
 for(const i of [5,6,9,10])cutout.data.set([0,0,255,255],i*4)
 sheet.drawImage(await d.embedPng(PNG.sync.write(cutout)),{x:400,y:160,width:40,height:40})
 const original=Buffer.from(await d.save()),source=(await importFile(f,f.alice.token,original,'media.pdf')).file
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false,nativePdfDirectory:nativeDirectory,localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 await app.listen({host:'127.0.0.1',port:4288});browser=await launchTestBrowser();const tab=await browser.newPage({viewport:{width:1600,height:1100}});await stubHomeHero(tab)
 const png=new PNG({width:4,height:4});for(let i=0;i<png.data.length;i+=4){png.data[i]=255;png.data[i+3]=255}const base64=PNG.sync.write(png).toString('base64'),apiCalls=[]
 // Deterministic media/search responses: this test verifies renderer wiring and actual PDF storage, not provider inference.
 await tab.route('**/api/v1/ai/media',route=>{const body=route.request().postDataJSON();apiCalls.push(body);if(body.action==='fetch_image'){assert.ok(['https://images.example/icon.gif','https://images.example/icon.webp'].includes(body.url));const fixture=body.url.endsWith('.gif')?generatedFixtures.gif:generatedFixtures.webp;return route.fulfill({json:fixture})}assert.equal(body.action,'generate_image');assert.equal(body.prompt,'Draw a red square');return route.fulfill({json:{url:generatedFormat==='png'?'data:image/png;base64,'+base64:'data:'+generatedFixtures[generatedFormat].mime+';base64,'+generatedFixtures[generatedFormat].base64}})})
 await tab.route('**/api/v1/ai/search',route=>{const body=route.request().postDataJSON();apiCalls.push(body);assert.equal(body.kind,'image_search');return route.fulfill({json:{images:[{title:'Office icon',imageUrl:'https://images.example/icon.gif',sourceUrl:'https://images.example/',source:'synthetic'},{title:'Office WebP',imageUrl:'https://images.example/icon.webp',sourceUrl:'https://images.example/',source:'synthetic'}],method:'serper'}})})
 const publicSettings=[];tab.on('response',async response=>{if(response.url().endsWith('/api/v1/settings/public')&&response.ok())publicSettings.push(await response.json())})
 const errors=[];tab.on('pageerror',error=>errors.push(error.message))
 await tab.goto(origin);await tab.getByLabel('用户名',{exact:true}).fill('alice');await tab.getByLabel('密码',{exact:true}).fill(password);await tab.getByRole('button',{name:'登录',exact:true}).click();await expect(tab.locator('.home')).toBeVisible()
 await tab.goto(origin+'/native-pdf/?fileId='+source.fileId)
 await expect(tab.locator('html')).toHaveAttribute('data-document-loading','ready')
 await tab.getByRole('button',{name:'AI 助手',exact:true}).click()
 await expect.poll(()=>publicSettings.some(settings=>settings.catalog.some(entry=>entry.id==='image-gen'&&entry.ready)&&settings.catalog.some(entry=>entry.id==='image-search'&&entry.ready))).toBe(true)
 const assistant=tab.locator('.shared-editor-assistant')
 for(let index=0;index<14;index++){
  await assistant.getByRole('textbox',{name:'消息',exact:true}).fill('Run media step '+index);await assistant.getByRole('button',{name:'发送',exact:true}).click();await expect(assistant.getByText('Media result '+index,{exact:true})).toBeVisible({timeout:30000})
  const result=JSON.parse(JSON.parse(network.wire.toString()).messages.filter(message=>message.role==='tool').at(-1).content);assert.ok(!result.isError,result.output)
  if(index===0){
   assert.match(result.output,/Office icon[^\n]*\n\s+https:\/\/images\.example\/icon\.gif/)
   assert.match(result.output,/Office WebP[^\n]*\n\s+https:\/\/images\.example\/icon\.webp/)
   searchUrls.push(...result.output.match(/https:\/\/images\.example\/icon\.(?:gif|webp)/g))
  }
  assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,source.revision)
 }
 assert.equal(apiCalls.length,4)
 const bitmap=tab.locator('.pdf-page-content canvas').first()
 const pixels=()=>bitmap.evaluate(canvas=>{
  const ctx=canvas.getContext('2d')
  return [[107,420],[132,420],[207,420],[232,420],[332,420],[405,435],[420,420]].map(([x,y])=>
   [...ctx.getImageData(Math.floor(x/500*canvas.width),Math.floor(y/600*canvas.height),1,1).data].slice(0,3))
 })
 const red=[255,0,0],white=[255,255,255],blue=[0,0,255],purple=[127,0,128]
 const expected=[blue,white,red,blue,purple,red,blue]
 await expect.poll(pixels,{timeout:15000}).toEqual(expected)
 const thumbnail=()=>tab.locator('.pdf-thumb canvas').first().evaluate(canvas=>
  [...canvas.getContext('2d').getImageData(Math.floor(107/500*canvas.width),Math.floor(420/600*canvas.height),1,1).data].slice(0,3))
 await expect.poll(thumbnail).toEqual(blue)
 await tab.getByRole('button',{name:/^撤销/}).click()
 await expect.poll(pixels,{timeout:15000}).toEqual([...expected.slice(0,5),white,blue])
 await tab.getByRole('button',{name:/^重做/}).click()
 await expect.poll(pixels,{timeout:15000}).toEqual(expected)
 assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,source.revision)
 const save=tab.getByRole('button',{name:'保存',exact:true});await expect(save).toBeEnabled();await save.click();await expect.poll(async()=>(await f.files.openFile(f.alice.token,source.fileId)).file.revision,{timeout:30000}).not.toBe(source.revision)
 const saved=(await f.files.openFile(f.alice.token,source.fileId)).file,bytes=await f.files.readFile(f.alice.token,source.fileId,saved.revision),images=(await catalog(bytes)).entries
 assert.equal(images.length,10);assert.equal(images[0].image.x,80);assert.equal(images[0].image.y,90);assert.equal(images[0].image.width,40);assert.equal(images[0].image.height,40)
 const {readImageBitmap}=await import('../../../pdf/src/main/image-edit.ts'),expectedBgra=Buffer.from(png.data)
 for(let i=0;i<expectedBgra.length;i+=4){expectedBgra[i]=png.data[i+2];expectedBgra[i+2]=png.data[i]}
 assert.deepEqual(await readImageBitmap(bytes,0,[80,470,120,510],4,4),expectedBgra)
 assert.deepEqual(await readImageBitmap(bytes,0,[180,470,220,510],4,4),expectedBgra);assert.deepEqual(await readImageBitmap(bytes,0,[280,470,320,510],4,4),expectedBgra)
 assert.ok(images.some(({image})=>image.x===40&&image.y===180&&image.width===40))
 assert.ok(images.some(({image})=>image.x===200&&image.y===260&&image.width===40))
 assert.ok(images.some(({image})=>[image.x,image.y,image.width,image.height].every((value,i)=>Math.abs(value-[410,250,40,60][i])<.01)))
 assert.ok(!images.some(({image})=>image.y===260&&[100,300].includes(image.x)))
 assert.deepEqual(await readImageBitmap(bytes,0,[200,300,240,340],4,4),expectedBgra)
 const expectedBlueBgra=Buffer.from(expectedBgra)
 for(let i=0;i<expectedBlueBgra.length;i+=4){expectedBlueBgra[i]=255;expectedBlueBgra[i+2]=0}
 assert.deepEqual(await readImageBitmap(bytes,0,[40,380,80,420],4,4),expectedBlueBgra)
 const pixel=(image,x)=>[...image.subarray(x*4,x*4+4)]
 const flipped=await readImageBitmap(bytes,0,[100,160,140,200],4,4)
 assert.deepEqual(pixel(flipped,0),[255,0,0,255])
 assert.deepEqual(pixel(flipped,3),[255,255,255,255])
 assert.deepEqual(pixel(await readImageBitmap(bytes,0,[220,160,240,200],2,4),0),[255,0,0,255])
 assert.equal((await readImageBitmap(bytes,0,[300,160,340,200],4,4))[3],128)
 const cut=await readImageBitmap(bytes,0,[400,160,440,200],4,4)
 assert.equal(cut[3],0)
 assert.deepEqual(pixel(cut,5),[255,0,0,255])
 assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),original)
 await tab.reload()
 await expect(tab.locator('html')).toHaveAttribute('data-document-loading','ready')
 await expect(tab.getByText('Original PDF',{exact:true}).first()).toBeAttached()
 await expect.poll(pixels,{timeout:15000}).toEqual(expected)
 await expect(save).toBeDisabled()
 assert.deepEqual(errors,[])
 const review='/tmp/dyoffice-pdf-media-review/native-'+generatedFormat;await mkdir(review,{recursive:true});await writeFile(review+'/saved.pdf',bytes);await tab.screenshot({path:review+'/saved.png',fullPage:true})
 for(const effect of [
  'image_search','generate_image','insert_image','transform_image','replace_image','delete_image',
  'rotate_image','flip_image','crop_image','set_image_opacity','remove_image_background',
 ]) recordVerifiedOfficeEffect('pdf',effect)
})

test('native PDF inserts and replaces from current image attachments without fetching a URL',{skip:!nativeDirectory,timeout:90000},async t=>{
 const origin='http://localhost:43777',f=await fileFixture(t,{origin,buildApp:false})
 const d=await PDFDocument.create(),p=d.addPage([300,300])
 const sample=color=>{
  const image=new PNG({width:4,height:4})
  for(let i=0;i<16;i++)image.data.set(color,i*4)
  return PNG.sync.write(image)
 }
 const red=sample([255,0,0,255]),green=sample([0,255,0,255]),blue=sample([0,0,255,255])
 p.drawImage(await d.embedPng(red),{x:60,y:170,width:40,height:40})
 const original=Buffer.from(await d.save()),{file}=await importFile(f,f.alice.token,original,'attached-images.pdf')
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,
  nativePdfDirectory:nativeDirectory,localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY})
 f.cleanup.unshift(()=>app.close())
 await app.listen({host:'127.0.0.1',port:43777})
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage()
 await stubHomeHero(page)
 await page.route('**/api/v1/ai/catalog',route=>route.fulfill({json:{entries:[{id:'mock',label:'Office test model'}],defaultId:'mock'}}))
 let remoteFetches=0
 await page.route('**/api/v1/ai/media',route=>{remoteFetches++;return route.abort()})
 const steps=[
  ['insert_image',{page:1,x:160,y:90,width:40},green,false],
  ['insert_image',{page:1,x:220,y:90,width:40},null,true],
  ['replace_image',{page:1,image_number:1},blue,true],
  ['replace_image',{page:1,image_number:1},blue,false],
 ]
 let step=0
 const results=[],references=[],imageCounts=[]
 await page.route('**/api/v1/ai/turns',route=>{
  if(isHomeHeroRequest(route.request()))return route.fallback()
  const request=route.request().postDataJSON().request
  const last=request.messages.at(-1)
  const result=last.results?.find(item=>item.id==='attachment-'+step)
  if(result)results.push(result)
  else{
   references.push(last.text.match(/(attachment:\/\/[0-9a-f-]{36}) \| "sample\.png"/)?.[1])
   imageCounts.push(last.images?.length??0)
  }
  const [name,args,,stale]=steps[step]
  const input={...args,url:(stale?references[0]:references[step])??'attachment://unavailable'}
  const event=result?['delta',{text:'Attachment step '+step++}]:['tool_call',{id:'attachment-'+step,name,input}]
  return route.fulfill({contentType:'text/event-stream',body:'event: '+event[0]+'\ndata: '+JSON.stringify(event[1])+'\n\nevent: done\ndata: {}\n\n'})
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
 for(const [index,[,,image,stale]] of steps.entries()){
  if(image){
   await assistant.locator('.ai-plus-btn').click()
   const chooser=page.waitForEvent('filechooser')
   await assistant.getByRole('menuitem',{name:'添加文件',exact:true}).click()
   await (await chooser).setFiles({name:'sample.png',mimeType:'image/png',buffer:image})
   await expect(assistant.getByRole('button',{name:'移除附件 sample.png',exact:true})).toBeVisible()
  }
  await assistant.getByRole('textbox',{name:'消息',exact:true}).fill('Use image attachment '+index)
  await assistant.getByRole('button',{name:'发送',exact:true}).click()
  await expect(assistant.getByText('Attachment step '+index,{exact:true})).toBeVisible()
  assert.equal(!!results[index].isError,stale,results[index].output)
  assert.equal(imageCounts[index],image?1:0)
  if(stale)assert.match(results[index].output,/reference is unavailable/)
  if(image){
   assert.ok(references[index])
   assert.ok(!references.slice(0,index).includes(references[index]))
  }else assert.equal(references[index],undefined)
  assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
 }
 assert.equal(remoteFetches,0)
 await page.getByRole('button',{name:'保存',exact:true}).click()
 const head=async()=>(await f.files.openFile(f.alice.token,file.fileId)).file.revision
 await expect.poll(head,{timeout:15000}).not.toBe(file.revision)
 const saved=await head(),bytes=await f.files.readFile(f.alice.token,file.fileId,saved)
 const {readImageBitmap}=await import('../../../pdf/src/main/image-edit.ts')
 assert.equal((await catalog(bytes)).entries.length,2)
 assert.deepEqual([...(await readImageBitmap(bytes,0,[60,170,100,210],4,4)).subarray(0,4)],[255,0,0,255])
 assert.deepEqual([...(await readImageBitmap(bytes,0,[160,170,200,210],4,4)).subarray(0,4)],[0,255,0,255])
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
 await page.reload()
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready')
 await expect(page.getByRole('button',{name:'保存',exact:true})).toBeDisabled()
})
