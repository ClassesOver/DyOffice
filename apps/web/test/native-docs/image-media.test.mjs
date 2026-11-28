import test from 'node:test'
import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {randomFillSync} from 'node:crypto'
import {createServer} from 'node:http'
import {fileURLToPath} from 'node:url'
import {expect} from '@playwright/test'
import JSZip from 'jszip'
import {PNG} from 'pngjs'
import {launchTestBrowser,recordVerifiedOfficeEffect} from '../helpers/browser.mjs'
import {fileFixture,docxBytes,importFile} from '../helpers/files.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {password} from '../helpers/identity.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'

const webp='UklGRhwAAABXRUJQVlA4TA8AAAAvA8AAAAcQ/Y/+ByKi/wEA'
const remoteUrl='https://images.example/icon.webp'
const frame=(delta,finish_reason)=>Buffer.from('data: '+JSON.stringify({choices:[{delta,finish_reason}]})+'\n\n')

async function testLocalPictures(t,method){
 let app
 const server=createServer((req,res)=>app.routing(req,res))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
 const origin='http://localhost:'+server.address().port
 const f=await fileFixture(t,{origin,buildApp:false})
 await f.preferences.update(f.alice.token,{language:'en',autoSave:false,showAssistant:false})
 const original=await docxBytes(),opened=(await importFile(f,f.alice.token,original)).file
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,codingHarnesses:false,nativeDocsDirectory:process.env.DYOFFICE_TEST_DOCS_DIST??fileURLToPath(new URL('../../dist-docs',import.meta.url))})
 f.cleanup.unshift(()=>app.close())
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1450,height:900}})
 const {csrfToken}=await(await page.request.get(origin+'/api/v1/auth/csrf')).json()
 assert.equal((await page.request.post(origin+'/api/v1/auth/login',{headers:{origin,'x-csrf-token':csrfToken},data:{username:'alice',password}})).status(),200)
 await page.goto(origin+'/native-docx/?fileId='+opened.fileId)
 const editor=page.locator('.tiptap.doc-page[contenteditable="true"]').first()
 await expect(editor).toBeVisible({timeout:18000})
 await editor.click()
 await page.getByRole('button',{name:'Insert',exact:true}).click()
 const picture=page.getByRole('button',{name:'Picture',exact:true})
 const images=page.locator('.tiptap.doc-page img')
 const png=new PNG({width:3,height:2});png.data.fill(255)
 const jpeg=Buffer.from(await page.evaluate(()=>{
  const canvas=document.createElement('canvas');canvas.width=4;canvas.height=3
  return canvas.toDataURL('image/jpeg').split(',')[1]
 }),'base64')
 const fixtures=[
  {name:'photo.PNG',mimeType:'application/octet-stream',buffer:PNG.sync.write(png),extension:/\.png$/},
  {name:'camera.JPG',mimeType:'',buffer:jpeg,extension:/\.jpe?g$/},
  {name:'animation.gif',mimeType:'application/octet-stream',buffer:Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64'),extension:/\.gif$/},
 ]
 async function choose(file){
  const [picker]=await Promise.all([page.waitForEvent('filechooser'),picture.click()])
  const {name,mimeType,buffer}=file
  await picker.setFiles({name,mimeType,buffer})
 }
 if(method==='paste'||method==='mixed-paste'){
  const mixed=method==='mixed-paste'
  const urls=fixtures.map(({name})=>'https://clipboard-images.example/'+name)
  const missing='https://clipboard-images.example/missing.png'
  if(mixed)urls.splice(1,0,missing)
  let resume
  const paused=new Promise(resolve=>{resume=resolve})
  const fetched=[]
  await page.route('https://clipboard-images.example/**',route=>route.fulfill({status:403}))
  await page.route('**/api/v1/ai/media',async route=>{
   const body=route.request().postDataJSON()
   assert.equal(body.action,'fetch_image')
   assert.ok(route.request().headers()['x-csrf-token'])
   assert.ok(urls.includes(body.url))
   fetched.push(body.url)
   if(mixed&&body.url===urls[0])await paused
   if(body.url===missing)return route.fulfill({status:404})
   const index=fixtures.findIndex(fixture=>body.url.endsWith('/'+fixture.name))
   assert.ok(index>=0)
   await route.fulfill({json:{mime:['image/png','image/jpeg','image/gif'][index],base64:fixtures[index].buffer.toString('base64')}})
  })
  await editor.click()
  if(mixed)await page.keyboard.press('ControlOrMeta+End')
  await editor.evaluate((node,{urls,mixed})=>{
   const clipboardData=new DataTransfer()
   const pictures=urls.map(src=>'<img src="'+src+'">').join('')
   clipboardData.setData('text/html',mixed
    ? '<p><strong>Before the pictures</strong></p>'+pictures+'<p>After the pictures</p>'
    : pictures)
   clipboardData.setData('text/plain',mixed?'Before the pictures\nAfter the pictures':urls.join('\n'))
   node.dispatchEvent(new ClipboardEvent('paste',{clipboardData,bubbles:true,cancelable:true}))
  },{urls,mixed})
  try{
   if(mixed){
    await expect.poll(()=>fetched.length).toBe(1)
    await page.keyboard.press('ControlOrMeta+Home')
    await page.keyboard.insertText('Typed while the pictures loaded. ')
   }
  }finally{resume()}
  await expect(images).toHaveCount(3,{timeout:7000})
  if(mixed)await page.keyboard.insertText('Continued here. ')
  assert.deepEqual(fetched,urls)
 }else if(method==='drop'){
  const unsupported={name:'masquerading.png',mimeType:'application/octet-stream',buffer:Buffer.from(webp,'base64')}
  const malformed={name:'invalid.png',mimeType:'application/octet-stream',buffer:Buffer.from('not a picture')}
  const transfer=await page.evaluateHandle(files=>{
   const dt=new DataTransfer()
   for(const {name,mimeType,data} of files)dt.items.add(new File([Uint8Array.from(atob(data),c=>c.charCodeAt(0))],name,{type:mimeType}))
   return dt
  },[unsupported,malformed,...fixtures].map(({name,mimeType,buffer})=>({name,mimeType,data:buffer.toString('base64')})))
  const target=await editor.locator('p').first().boundingBox()
  assert.ok(target)
  const event={dataTransfer:transfer,clientX:target.x+4,clientY:target.y+target.height/2}
  await editor.dispatchEvent('dragover',event)
  await expect(page.locator('.editor-scroll')).toHaveClass(/image-drop-target/,{timeout:3000})
  await editor.dispatchEvent('drop',event)
  await expect(page.locator('.editor-scroll')).not.toHaveClass(/image-drop-target/)
  await transfer.dispose()
 }else{
  for(const [index,file] of fixtures.entries()){
   await choose(file)
   await expect(images).toHaveCount(index+1,{timeout:7000})
  }
  await choose({name:'invalid.png',mimeType:'image/png',buffer:Buffer.from('not a picture')})
  await expect(page.getByText('Failed to load image',{exact:true})).toBeVisible()
 }
 await expect(images).toHaveCount(3,{timeout:7000})
 const saved=page.waitForResponse(response=>response.url().endsWith('/commits')&&response.ok(),{timeout:18000})
 await page.keyboard.press('ControlOrMeta+s');await saved
 const {file}=await f.files.openFile(f.alice.token,opened.fileId)
 assert.notEqual(file.revision,opened.revision)
 const doc=await JSZip.loadAsync(await f.files.readFile(f.alice.token,opened.fileId,file.revision))
 const parts=await Promise.all(doc.file(/^word\/media\//).map(async part=>({name:part.name,bytes:await part.async('nodebuffer')})))
 assert.equal(parts.length,3)
 for(const fixture of fixtures)assert.ok(parts.some(part=>fixture.extension.test(part.name)&&part.bytes.equals(fixture.buffer)),fixture.name)
 if(method==='mixed-paste'){
  const xml=await doc.file('word/document.xml').async('string')
  const before=xml.indexOf('Before the pictures')
  assert.match(xml.slice(xml.lastIndexOf('<w:p',before),before),/<w:b\b[^>]*\/>/)
  assert.match(xml.slice(before),/Before the pictures[^]*<w:drawing>[^]*After the pictures/)
  assert.match(xml.replace(/<[^>]+>/g,''),/Typed while the pictures loaded\. Continued here\. [^]*Before the pictures/)
  assert.doesNotMatch(xml,/clipboard-images\.example/)
 }
 await page.reload()
 await expect(images).toHaveCount(3,{timeout:18000})
 assert.deepEqual(await f.files.readFile(f.alice.token,opened.fileId,opened.revision),original)
}

test('Word inserts local PNG JPEG and GIF when the browser reports an unknown MIME type',{timeout:65000},t=>testLocalPictures(t,'picker'))
test('Word drops local PNG JPEG and GIF when the browser reports an unknown MIME type',{timeout:65000},t=>testLocalPictures(t,'drop'))
test('Word pastes remote pictures with their original bytes when cross-origin access is denied',{timeout:65000},t=>testLocalPictures(t,'paste'))
test('Word pastes webpage text and embeds remote pictures in their original order',{timeout:65000},t=>testLocalPictures(t,'mixed-paste'))

test('Word AI inserts generated, linked and attached images into DOCX without reusing expired attachments',{timeout:120_000},async t=>{
 const origin='http://localhost:4254',f=await fileFixture(t,{origin,buildApp:false})
 const keyring={activeKeyId:'test',keys:{test:new Uint8Array(32).fill(25)}}
 const chat={id:'shared-chat',kind:'chat',providerId:'deepseek',label:'Test chat',model:'synthetic',baseUrl:'https://provider.example/v1/chat/completions',enabled:true,apiKey:'synthetic-key'}
 const images={id:'image-gen',kind:'image_generation',providerId:'openai',label:'Test images',model:'gpt-image-1',baseUrl:'https://images.example/v1',enabled:true,apiKey:'synthetic-image-key'}
 const searches=['web_search','image_search'].map(kind=>({id:kind,kind,label:kind,providerId:'serper',model:'',baseUrl:'https://google.serper.dev',enabled:true,apiKey:'test-search-key'}))
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[chat,images,...searches],defaults:{chat:chat.id,image_generation:images.id,web_search:'web_search',image_search:'image_search'}})
 await f.preferences.update(f.alice.token,{language:'en',autoSave:false,showAssistant:true})
 const original=await docxBytes(),opened=(await importFile(f,f.alice.token,original)).file
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false,nativeDocsDirectory:process.env.DYOFFICE_TEST_DOCS_DIST??fileURLToPath(new URL('../../dist-docs',import.meta.url))})
 f.cleanup.push(async()=>{app.server.closeAllConnections();await app.close()});await app.listen({host:'127.0.0.1',port:4254})
 const browser=await launchTestBrowser();t.after(()=>browser.close())
 const page=await browser.newPage(),errors=[],mediaCalls=[],results=[],collaborationResponses=[]
 page.on('pageerror',error=>errors.push(error.message))
 page.on('response',response=>{if(response.url().endsWith('/word-collab'))collaborationResponses.push(response.status())})
 await page.route('**/api/v1/ai/media',route=>{
  const body=route.request().postDataJSON()
  mediaCalls.push(body.action)
  if(body.action==='generate_image')return route.fulfill({json:{url:'data:image/webp;base64,'+webp}})
  assert.equal(body.url,remoteUrl)
  return route.fulfill({json:{base64:webp,mime:'image/webp'}})
 })
 await page.route('**/api/v1/ai/search',route=>{
  const request=route.request().postDataJSON()
  assert.equal(request.query,'Word reference 719')
  assert.equal(request.maxResults,1)
  if(request.kind==='web_search')return route.fulfill({json:{method:'serper',results:[{title:'Word search citation',url:'https://results.example/word',snippet:'Reference 719'}]}})
  assert.equal(request.kind,'image_search')
  return route.fulfill({json:{method:'serper',images:[{title:'Reference image',imageUrl:remoteUrl,sourceUrl:'https://images.example',source:'Fixture'}]}})
 })
 const {csrfToken}=await(await page.request.get(origin+'/api/v1/auth/csrf')).json()
 assert.equal((await page.request.post(origin+'/api/v1/auth/login',{headers:{origin,'x-csrf-token':csrfToken},data:{username:'alice',password}})).status(),200)
 let turns=0
 const calls=[['generate_image',{prompt:'Draw a red square'}],['insert_image',{url:remoteUrl}],
  ['insert_image',{}],['insert_picture',{afterBlockIndex:-1,width:'32px',altText:'Attached blue picture',float:{x:'20px',y:'12px',wrap:'square'}}],
  ['insert_image',{}],['read_attachment',{index:0}],['web_search',{query:'Word reference 719',maxResults:1}],
  ['image_search',{query:'Word reference 719',maxResults:1}]]
 const references=[]
 const network=mockProviderNetwork(t,()=>{
  const current=turns++,index=Math.floor(current/2)
  const [name,input]=calls[index]
  const request=JSON.parse(network.wire.toString())
  assert.ok(request.tools.some(tool=>tool.function.name===name),`Missing ${name}; tools: ${request.tools.map(tool=>tool.function.name).join(', ')}`)
  if(current%2){
   results.push(JSON.parse(request.messages.filter(message=>message.role==='tool').at(-1).content))
   return Readable.from([frame({content:'Image action '+index+' complete'},'stop'),Buffer.from('data: [DONE]\n\n')])
  }
  if(index>=2&&index<=4){
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
  if(name==='read_attachment'){
   const user=request.messages.findLast(message=>message.role==='user')
   const text=typeof user.content==='string'?user.content:user.content.map(part=>part.text??'').join(' ')
   const indexOfFile=text.match(/(?:^|\n)(\d+) \| word-reference\.txt \|/m)?.[1]
   assert.notEqual(indexOfFile,undefined,'The numbered attachment list contains the uploaded reference')
   input.index=Number(indexOfFile)
  }
  return Readable.from([frame({tool_calls:[{index:0,id:'word-media-'+index,type:'function',function:{name,arguments:JSON.stringify(input)}}]},'tool_calls'),Buffer.from('data: [DONE]\n\n')])
 })
 await page.goto(origin+'/native-docx/?fileId='+opened.fileId)
 try{await expect(page.locator('.tiptap.doc-page[contenteditable="true"]').first()).toBeVisible({timeout:15_000})}
 catch(error){t.diagnostic(JSON.stringify({errors,collaborationResponses,status:await page.locator('.native-docs-status').allTextContents()}));throw error}
 assert.ok(collaborationResponses.length&&collaborationResponses.every(status=>status===404))
 if(await page.locator('.ai-rail').isVisible())await page.locator('.ai-rail').click()
 const composer=page.locator('.ai-panel textarea')
 for(let index=0;index<calls.length;index++){
  if(index===2||index===3){
   const size=index===2?200:4,image=new PNG({width:size,height:size})
   if(index===2){randomFillSync(image.data);image.data.set([0,255,0,255])}
   else for(let i=0;i<16;i++)image.data.set([0,0,255,255],i*4)
   const bytes=PNG.sync.write(image)
   if(index===2)assert.ok(bytes.length>128*1024)
   const panel=page.locator('.ai-panel')
   await panel.locator('.ai-plus-btn').click()
   const chooser=page.waitForEvent('filechooser')
   await panel.getByRole('menuitem',{name:'Add file',exact:true}).click()
   await (await chooser).setFiles({name:'local.png',mimeType:'image/png',buffer:bytes})
   await expect(panel.getByRole('img',{name:'local.png',exact:true}).first()).toBeVisible()
  }else if(index===5){
   const panel=page.locator('.ai-panel')
   await panel.locator('.ai-plus-btn').click()
   const chooser=page.waitForEvent('filechooser')
   await panel.getByRole('menuitem',{name:'Add file',exact:true}).click()
   const parsed=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/v1/ai/attachments/parse')
   await (await chooser).setFiles({name:'word-reference.txt',mimeType:'text/plain',buffer:Buffer.from('Word attachment marker 719')})
   assert.ok((await parsed).ok())
   await expect(panel.getByText('word-reference.txt',{exact:true})).toBeVisible()
  }
  await composer.fill('Insert image '+index);await composer.press('Enter')
  try{await expect(page.getByText('Image action '+index+' complete',{exact:true})).toBeVisible({timeout:15_000})}
  catch(error){t.diagnostic(JSON.stringify({turns,mediaCalls,errors,assistant:await page.locator('.ai-panel').innerText()}));throw error}
  assert.equal(!!results[index].isError,index===4,results[index].output)
 }
 assert.match(results[5].output,/Word attachment marker 719/)
 assert.match(results[6].output,/Word search citation[\s\S]*https:\/\/results\.example\/word/)
 assert.ok(results[7].output.includes(remoteUrl))
 assert.match(results[7].output,/Reference image/)
 assert.match(results[6].output,/Reference 719/)
 assert.deepEqual(mediaCalls,['generate_image','fetch_image'])
 await expect(page.locator('.tiptap.doc-page img')).toHaveCount(4)
 assert.equal((await f.files.openFile(f.alice.token,opened.fileId)).file.revision,opened.revision)
 const committed=page.waitForResponse(response=>response.url().endsWith('/commits')&&response.status()===200,{timeout:15_000})
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
  const large=image.data[1]===255
  assert.deepEqual([image.width,image.height],large?[200,200]:[4,4])
  colors.add([...image.data.subarray(0,4)].join(','))
 }
 assert.deepEqual(colors,new Set(['255,0,0,255','0,255,0,255','0,0,255,255']))
 assert.deepEqual(await f.files.readFile(f.alice.token,opened.fileId,opened.revision),original)
 await page.reload();await expect(page.locator('.tiptap.doc-page img')).toHaveCount(4,{timeout:30_000})
 assert.deepEqual(errors,[])
 recordVerifiedOfficeEffect('docx','generate_image')
 recordVerifiedOfficeEffect('docx','insert_image')
 recordVerifiedOfficeEffect('docx','insert_picture')
 recordVerifiedOfficeEffect('docx','image_search')
 recordVerifiedOfficeEffect('docx','read_attachment')
 recordVerifiedOfficeEffect('docx','web_search')
})
