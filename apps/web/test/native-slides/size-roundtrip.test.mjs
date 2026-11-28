import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createServer} from 'node:https'
import {fileURLToPath} from 'node:url'
import {expect} from '@playwright/test'
import JSZip from 'jszip'
import {PNG} from 'pngjs'
import UTIF from 'utif2'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {createWorkspaceService} from '../../server/src/modules/workspace/service.ts'
import {password} from '../helpers/identity.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {openIsolatedPptxSession} from '../../worker/src/native/pptx-session-host.ts'

test('actual Ribbon size plus mounted link, run link, animation and chart APIs survive download and reopen',{timeout:120_000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'dyoffice-slides-size-'))
 let app,server,browser
 t.after(async()=>{await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}await app?.close();await rm(directory,{recursive:true,force:true})})
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(directory,'key.pem'),'-out',join(directory,'cert.pem'),'-days','1','-subj','/CN=localhost'],{stdio:'pipe'})
 server=createServer({key:await readFile(join(directory,'key.pem')),cert:await readFile(join(directory,'cert.pem'))},(req,res)=>app.routing(req,res))
 await new Promise(resolve=>server.listen(Number(process.env.DYOFFICE_TEST_SLIDES_PORT??4252),'127.0.0.1',resolve))
 const origin=`https://127.0.0.1:${server.address().port}`
 const f=await fileFixture(t,{origin,buildApp:false})
 await f.preferences.update(f.alice.token,{language:'en',autoSave:false,showAssistant:true})
 const original=await readFile(new URL('../fixtures/slides/acceptance.pptx',import.meta.url)),file=await importFile(f,f.alice.token,original,'size-roundtrip.pptx'),id=file.file.fileId
 // Real native parser in a child process; unsafeTestOnly does not certify OS sandboxing.
 const slidesHost={openSession(input){return openIsolatedPptxSession({fileId:input.fileId,revision:input.revision,bytes:input.bytes},{timeoutMs:60000,unsafeTestOnly:true})}}
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,slidesHost,nativeSlidesDirectory:process.env.DYOFFICE_TEST_SLIDES_DIST??fileURLToPath(new URL('../../dist-slides/',import.meta.url))})
 browser=await launchTestBrowser()
 const context=await browser.newContext({ignoreHTTPSErrors:true,acceptDownloads:true,viewport:{width:1440,height:1100}}),page=await context.newPage(),errors=[]
 const responses=[]
 page.on('response',response=>{if(response.url().includes('/api/v1/files/'))responses.push([response.status(),response.url()])})
 page.on('pageerror',error=>errors.push(error.message))
 const challenge=await(await context.request.get(origin+'/api/v1/auth/csrf')).json()
 assert.equal((await context.request.post(origin+'/api/v1/auth/login',{headers:{origin,'x-csrf-token':challenge.csrfToken},data:{username:'alice',password}})).status(),200)
 await page.route('**/api/v1/ai/catalog',route=>route.fulfill({json:{entries:[]}}))
 await page.goto(`${origin}/native-pptx/?fileId=${id}`)
 await expect(page.locator('.app-main')).toBeVisible({timeout:45_000})
 await page.getByRole('button',{name:'File',exact:true}).click()
 await page.getByRole('group',{name:'File',exact:true}).getByRole('button',{name:/^Print/}).click()
 const printDialog=page.getByRole('dialog',{name:'Print',exact:true})
 await expect(printDialog).toBeVisible()
 await expect(printDialog.getByRole('group',{name:'Printer',exact:true})).toHaveCount(0)
 await printDialog.getByRole('button',{name:'Cancel',exact:true}).click()
 await page.keyboard.press('ControlOrMeta+p')
 await expect(printDialog).toBeVisible()
 await printDialog.getByRole('radio',{name:'Current slide',exact:true}).check()
 const printPreview=printDialog.frameLocator('iframe[title="Print"]')
 await expect(printPreview.locator('.page img')).toBeVisible()
 await page.evaluate(()=>{
  const append=document.body.append
  document.body.append=function(...children){
   for(const frame of children){
    if(!(frame instanceof HTMLIFrameElement)||!frame.sandbox.contains('allow-modals'))continue
    frame.addEventListener('load',()=>{
     const target=frame.contentWindow
     const browserPrint=target.print.bind(target)
     target.print=()=>{
      const images=[...target.document.querySelectorAll('.page img')]
      window.printedSlides={title:target.document.title,widths:images.map(image=>image.naturalWidth)}
      browserPrint()
     }
    },{capture:true,once:true})
   }
   return append.apply(this,children)
  }
 })
 await printDialog.getByRole('button',{name:'Print',exact:true}).click()
 await expect(printDialog).toBeHidden()
 const printed=await page.evaluate(()=>window.printedSlides)
 assert.equal(printed?.title,'size-roundtrip')
 assert.equal(printed.widths.length,1)
 assert.ok(printed.widths[0]>0)
 assert.equal((await f.files.openFile(f.alice.token,id)).file.revision,file.file.revision)
 const draftNotes='Manual Save As speaker notes'
 const workspace=createWorkspaceService(f.transactions)
 const presentationFolder=await workspace.createFolder(f.alice.token,{name:'Presentations',parentId:null})
 assert.equal(await page.evaluate(text=>window.slidesApi.setNotes({slideIndex:0,text}),draftNotes),true)
 await page.getByRole('button',{name:'File',exact:true}).click()
 const saveAs=page.getByRole('group',{name:'File',exact:true}).getByRole('button',{name:/^Save As/})
 await expect(saveAs).toBeEnabled()
 await saveAs.click()
 const confirmation=page.getByRole('dialog',{name:'Save a copy to your workspace'})
 const copyName=confirmation.getByRole('textbox',{name:'File name'})
 await expect(copyName).toHaveValue('size-roundtrip.pptx')
 await confirmation.getByRole('button',{name:'Cancel',exact:true}).click()
 await expect(confirmation).toHaveCount(0)
 assert.equal((await f.files.listFiles(f.alice.token)).files.length,1)
 await page.keyboard.press('ControlOrMeta+Shift+s')
 await copyName.fill('Manual presentation copy')
 await confirmation.getByRole('combobox',{name:'Folder',exact:true}).selectOption(presentationFolder.id)
 await confirmation.getByRole('button',{name:'Save copy',exact:true}).click()
 await expect(page.getByText('Saved copy: Manual presentation copy.pptx',{exact:true})).toBeVisible({timeout:30000})
 const manualCopy=(await workspace.listFiles(f.alice.token,{folderId:presentationFolder.id})).files.find(item=>item.name==='Manual presentation copy.pptx')
 assert.ok(manualCopy)
 const manualZip=await JSZip.loadAsync(await f.files.readFile(f.alice.token,manualCopy.id,manualCopy.revision))
 const notesXml=await Promise.all(manualZip.file(/^ppt\/notesSlides\/notesSlide\d+\.xml$/).map(part=>part.async('string')))
 assert.ok(notesXml.some(xml=>xml.includes(draftNotes)))
 assert.equal((await f.files.openFile(f.alice.token,id)).file.revision,file.file.revision)
 assert.deepEqual(await f.files.readFile(f.alice.token,id,file.file.revision),original)
 const assistantNotice=page.getByRole('complementary',{name:'Document notifications'}).getByRole('status')
 await expect(assistantNotice.filter({hasText:'No model is available for AI assistant.'})).toBeVisible()
 for(const name of ['AI 助手','AI Beautify','AI Fact Check','AI Image']){
  await expect(page.getByRole('button',{name,exact:true})).toBeDisabled()
 }
 await page.getByRole('button',{name:'Design',exact:true}).click()
 await page.getByRole('button',{name:'Slide Size',exact:true}).click()
 const resizeView=page.waitForResponse(response=>response.url().endsWith('/slides/slides')&&response.status()===200)
 await page.getByRole('button',{name:'Standard (4:3)',exact:true}).click()
 await (await resizeView).finished()
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
 await expect.poll(()=>page.evaluate(()=>window.slidesApi.getSlideSize())).toEqual({cx:9144000,cy:6858000})
 const link={kind:'url',url:'https://example.com/slides-roundtrip'}
 const animation={sourceId:'e_904989a1',effect:'fade',trigger:'onClick',durationMs:650,delayMs:100}
 // Exercise the actual mounted Web API and HTTP/native chain; this is not a model/Harness run.
 const applied=await page.evaluate(async({link,animation})=>{
  if(!await window.slidesApi.addBlankSlide({sourceIndex:1,fitWidthPx:960}))throw Error('third slide insert failed')
  const text=await window.slidesApi.editText({slideIndex:0,sourceId:animation.sourceId,paragraphs:[{runs:[
   {text:'Overview ',link:null,redact:null},
   {text:'Jump to slide three',link:{kind:'slide',slideIndex:2},redact:null},
  ]}]})
  const linked=await window.slidesApi.setLink({slideIndex:0,sourceId:animation.sourceId,target:link})
  const animated=await window.slidesApi.setAnimations({slideIndex:0,items:[animation]})
  const [savedLink,animations,runLinks]=await Promise.all([window.slidesApi.getLink(0,animation.sourceId),window.slidesApi.getAnimations(0),window.slidesApi.getRunLinks(0)])
  return {text:!!text,linked:!!linked,animated,link:savedLink,animations,runLinks}
 },{link,animation})
 const withoutSourceIds=links=>links.map(({sourceId,...rest})=>rest)
 const expectedRuns=[{paraIndex:0,runIndex:1,target:{kind:'slide',slideIndex:2}}]
 assert.equal(applied.text,true);assert.equal(applied.linked,true);assert.equal(applied.animated,true);assert.deepEqual(applied.link,link)
 assert.deepEqual(withoutSourceIds(applied.runLinks),expectedRuns)
 assert.equal(applied.animations[0].durationMs,650)
 const chartRead=await page.evaluate(async()=>{
  const added=await window.slidesApi.addChart({slideIndex:0,kind:'bar',title:'Before',categories:['Q1','Q2'],series:[{name:'Sales',values:[8,12]}],xPx:20,yPx:20,wPx:300,hPx:180,fitWidthPx:960})
  if(!added)throw Error('chart insert failed')
  const before=await window.slidesApi.getChartData(0,added.sourceId)
  const schemes=await window.slidesApi.getChartColorSchemes()
  const edited=await window.slidesApi.editChart({slideIndex:0,sourceId:added.sourceId,title:'Revenue',series:[{name:'Sales',values:[42,64]}],colorScheme:'mono-accent1'})
  if(!edited)throw Error('chart edit failed')
  return {before,schemes,after:await window.slidesApi.getChartData(0,edited.sourceId)}
 })
 assert.equal(chartRead.before.title,'Before');assert.equal(chartRead.schemes.length,9)
 assert.equal(chartRead.after.title,'Revenue');assert.deepEqual(chartRead.after.series,[{name:'Sales',values:[42,64]}])
 const picture = PNG.sync.write(new PNG({width:160,height:90}))
 await page.getByRole('button',{name:'Insert',exact:true}).click()
 const picker = page.waitForEvent('filechooser',{timeout:5000})
 await page.getByRole('button',{name:'Pictures',exact:true}).click()
 const pictureResponse = page.waitForResponse(response=>response.url().endsWith('/slides/media')&&response.status()===200)
 await (await picker).setFiles({name:'local-picture.png',mimeType:'image/png',buffer:picture})
 const insertedPicture = await (await pictureResponse).json()
 const pictureId = insertedPicture.created[0].id
 const pictureNode = insertedPicture.slide.nodes.find(node=>node.type==='picture'&&node.sourceId===pictureId)
 assert.ok(pictureNode)
 await expect.poll(()=>page.evaluate(async sourceId=>(await window.slidesApi.getRenderSlides())[0].nodes.some(node=>node.sourceId===sourceId),pictureId)).toBe(true)
 const replacement = PNG.sync.write(new PNG({width:90,height:160}))
 const replacedPicture = await page.evaluate(async ({sourceId,base64}) => {
  const slide = await window.slidesApi.replacePictureBytes({slideIndex:0,sourceId,base64,ext:'png'})
  return slide?.nodes.find(node=>node.type==='picture'&&node.sourceId===sourceId)
 },{sourceId:pictureId,base64:replacement.toString('base64')})
 assert.ok(replacedPicture)
 assert.deepEqual(replacedPicture.box,pictureNode.box)
 assert.match(replacedPicture.dataUrl,/^data:image\/png;base64,/)
 const tiffPixels = new Uint8Array(20*12*4)
 for(let i=0;i<tiffPixels.length;i+=4)tiffPixels.set([200,100,50,255],i)
 const tiff = Buffer.from(UTIF.encodeImage(tiffPixels,20,12))
 await expect(page.locator('.ribbon-tab-context.active')).toBeVisible()
 await page.getByRole('button',{name:'Insert',exact:true}).click()
 const [tiffPicker] = await Promise.all([
  page.waitForEvent('filechooser',{timeout:5000}),
  page.getByRole('button',{name:'Pictures',exact:true}).click(),
 ])
 const [tiffUpload] = await Promise.all([
  page.waitForResponse(response=>response.url().endsWith('/slides/media')),
  tiffPicker.setFiles({name:'local-picture.tiff',mimeType:'image/tiff',buffer:tiff}),
 ])
 assert.equal(tiffUpload.status(),200,'native picture upload must accept the selected TIFF')
 const tiffResult = await tiffUpload.json()
 const tiffPicture = tiffResult.slide.nodes.find(node=>node.type==='picture'&&node.sourceId===tiffResult.created[0].id)
 assert.match(tiffPicture.dataUrl,/^data:image\/png;base64,/)
 const preview = PNG.sync.read(Buffer.from(tiffPicture.dataUrl.split(',')[1],'base64'))
 assert.deepEqual([preview.width,preview.height,...preview.data.subarray(0,4)],[20,12,200,100,50,255])
 const bmp = Buffer.alloc(70)
 bmp.write('BM')
 bmp.writeUInt32LE(bmp.length,2)
 bmp.writeUInt32LE(54,10)
 bmp.writeUInt32LE(40,14)
 bmp.writeInt32LE(2,18)
 bmp.writeInt32LE(2,22)
 bmp.writeUInt16LE(1,26)
 bmp.writeUInt16LE(24,28)
 for(const offset of [56,59,64,67])bmp[offset]=255
 const insertTab = page.getByRole('button',{name:'Insert',exact:true})
 if (!(await insertTab.evaluate(tab=>tab.classList.contains('active')))) await insertTab.click()
 const [bmpPicker] = await Promise.all([
  page.waitForEvent('filechooser',{timeout:5000}),
  page.getByRole('button',{name:'Pictures',exact:true}).click(),
 ])
 assert.match(await bmpPicker.element().getAttribute('accept'),/\.bmp/)
 const [bmpUpload] = await Promise.all([
  page.waitForResponse(response=>response.url().endsWith('/slides/media')),
  bmpPicker.setFiles({name:'local-picture.bmp',mimeType:'image/bmp',buffer:bmp}),
 ])
 assert.equal(bmpUpload.status(),200)
 const bmpResult = await bmpUpload.json()
 const bmpPicture = bmpResult.slide.nodes.find(node=>node.type==='picture'&&node.sourceId===bmpResult.created[0].id)
 assert.equal(bmpPicture.dataUrl,`data:image/bmp;base64,${bmp.toString('base64')}`)
 assert.deepEqual(await page.evaluate(async url=>{
  const image=new Image()
  image.src=url
  await image.decode()
  const canvas=document.createElement('canvas')
  canvas.width=image.naturalWidth;canvas.height=image.naturalHeight
  const context=canvas.getContext('2d')
  context.drawImage(image,0,0)
  return [canvas.width,canvas.height,...context.getImageData(0,0,1,1).data]
 },bmpPicture.dataUrl),[2,2,255,0,0,255])
 const openMaster = async () => {
  await page.getByRole('button',{name:'View',exact:true}).click()
  await page.getByRole('button',{name:'Slide Master',exact:true}).click()
  await expect(page.locator('.master-view')).toBeVisible()
 }
 await openMaster()
 await page.locator('.master-view').getByRole('button',{name:'Text Box',exact:true}).click()
 const stage = await page.locator('.master-stage .stage-rel').boundingBox()
 assert.ok(stage)
 await page.mouse.move(stage.x+35,stage.y+48)
 await page.mouse.down()
 await page.mouse.move(stage.x+410,stage.y+105,{steps:6})
 await page.mouse.up()
 const editor = page.locator('.master-view .slide-text-editor')
 await expect(editor).toBeVisible()
 await editor.fill('CanvasMasterText')
 const masterEdit = page.waitForResponse(response=>response.url().endsWith('/slides/master-edit')&&response.status()===200)
 await editor.press('Control+Enter')
 assert.match(await (await masterEdit).text(),/CanvasMasterText/)
 await page.getByRole('button',{name:'Close Master View',exact:true}).click()
 await expect(page.locator('.master-view')).toHaveCount(0)
 const downloadPromise=page.waitForEvent('download',{timeout:15000}).catch(async error=>{throw Error(`${error.message}; body=${(await page.locator('body').innerText()).slice(0,1800)}; requests=${JSON.stringify(responses)}; bridgeDirty=${await page.evaluate(()=>window.slidesApi.isDirty())}; head=${(await f.files.openFile(f.alice.token,id)).file.revision}`)})
 await page.locator('.ribbon-tab-file').click()
 await page.locator('.dyoffice-slides-download').click()
 const download=await downloadPromise,downloaded=await readFile(await download.path())
 const current=await f.files.openFile(f.alice.token,id)
 assert.notEqual(current.file.revision,file.file.revision)
 assert.deepEqual(downloaded,await f.files.readFile(f.alice.token,id,current.file.revision))
 const archive=await JSZip.loadAsync(downloaded)
 const masters = await Promise.all(archive.file(/^ppt\/slideMasters\/slideMaster\d+\.xml$/).map(entry=>entry.async('string')))
 assert.ok(masters.some(xml=>xml.includes('CanvasMasterText')))
 const media = await Promise.all(archive.file(/^ppt\/media\/[^/]+\.png$/).map(entry=>entry.async('nodebuffer')))
 assert.ok(media.some(bytes=>bytes.equals(replacement)))
 const tiffMedia = await Promise.all(archive.file(/^ppt\/media\/[^/]+\.tiff?$/).map(entry=>entry.async('nodebuffer')))
 assert.ok(tiffMedia.some(bytes=>bytes.equals(tiff)))
 const bmpMedia = await Promise.all(archive.file(/^ppt\/media\/[^/]+\.bmp$/).map(entry=>entry.async('nodebuffer')))
 assert.ok(bmpMedia.some(bytes=>bytes.equals(bmp)))
 assert.match(await archive.file('ppt/presentation.xml').async('string'),/<p:sldSz[^>]*cx="9144000"[^>]*cy="6858000"/)
 assert.deepEqual(await f.files.readFile(f.alice.token,id,file.file.revision),original)
 await page.unroute('**/api/v1/ai/catalog')
 await page.route('**/api/v1/ai/catalog',route=>route.fulfill({status:503,json:{message:'provider diagnostic must stay private'}}))
 await page.reload()
 await expect(page.locator('.app-main')).toBeVisible({timeout:45_000})
 await expect(assistantNotice.filter({hasText:'AI assistant failed to load.'})).toBeVisible()
 await expect(assistantNotice.filter({hasText:'provider diagnostic must stay private'})).toHaveCount(0)
 await expect.poll(()=>page.evaluate(()=>window.slidesApi.getSlideSize())).toEqual({cx:9144000,cy:6858000})
 const reloaded=await page.evaluate(async pictureData=>{
  const slides=await window.slidesApi.getRenderSlides(),chart=slides[0].nodes.find(node=>node.type==='chart')
  return {links:await window.slidesApi.getSlideLinks(0),runLinks:await window.slidesApi.getRunLinks(0),animations:await window.slidesApi.getAnimations(0),chart:await window.slidesApi.getChartData(0,chart.sourceId),schemes:await window.slidesApi.getChartColorSchemes(),pictures:pictureData.every(data=>slides[0].nodes.some(node=>node.type==='picture'&&node.dataUrl===data))}
 },[replacedPicture.dataUrl,tiffPicture.dataUrl,bmpPicture.dataUrl])
 assert.deepEqual(reloaded.chart,chartRead.after);assert.deepEqual(reloaded.schemes,chartRead.schemes)
 assert.ok(reloaded.pictures)
 assert.ok(reloaded.links.some(item=>item.target.url===link.url))
 assert.deepEqual(withoutSourceIds(reloaded.runLinks),expectedRuns)
 assert.deepEqual(reloaded.animations.map(({sourceId,targetName,...item})=>item),[{effect:'fade',trigger:'onClick',durationMs:650,delayMs:100}])
 const glyph=await page.evaluate(async sourceId=>{
  const [slide]=await window.slidesApi.getRenderSlides()
  const node=slide.nodes.find(node=>node.sourceId===sourceId)
  if(!node?.text)throw Error('linked text node is missing')
  for(const line of node.text.lines){
   const run=line.runs.find(run=>run.link==='slide:2'&&run.widthPx>0)
   if(run)return {
    x:(node.box.x+node.text.insets.l+run.x+run.widthPx/2)/slide.widthPx,
    y:(node.box.y+node.text.insets.t+line.top+line.height/2)/slide.widthPx,
   }
  }
  throw Error('linked glyph is missing')
 },reloaded.runLinks[0].sourceId)
 const runLinksRead=page.waitForResponse(response=>response.ok()&&response.url().endsWith('/slides/run-links')&&response.request().postDataJSON().index===0)
 const animationsRead=page.waitForResponse(response=>response.ok()&&response.url().endsWith('/slides/animations')&&response.request().postDataJSON().index===0)
 await page.clock.install()
 await page.keyboard.press('F5')
 const show=page.locator('.slideshow')
 await expect(show.locator('.ss-counter')).toHaveText('1 / 3')
 await Promise.all([runLinksRead,animationsRead].map(async response=>(await response).finished()))
 // The linked text is the same shape as the click-triggered entrance animation.
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
 await page.keyboard.press('ArrowRight')
 await page.clock.runFor(800)
 await expect(show.locator('.ss-counter')).toHaveText('1 / 3')
 const slideSurface=show.locator('.ss-frame > div').first()
 await expect.poll(async()=>{
  const box=await slideSurface.boundingBox()
  await page.mouse.move(box.x+glyph.x*box.width,box.y+glyph.y*box.width)
  return slideSurface.evaluate(node=>node.style.cursor)
 }).toBe('pointer')
 await page.mouse.down()
 await page.mouse.up()
 await expect(show.locator('.ss-counter')).toHaveText('3 / 3')
 await page.keyboard.press('Escape')
 await expect(show).toHaveCount(0)
 await page.unroute('**/api/v1/ai/catalog')
 await page.route('**/api/v1/ai/catalog',route=>route.fulfill({json:{entries:[{id:'mock',label:'Naming model'}],defaultId:'mock'}}))
 const namingRequests=[]
 await page.route('**/api/v1/ai/turns',route=>{
  namingRequests.push(route.request().postDataJSON())
  return route.fulfill({contentType:'text/event-stream',body:'event: delta\ndata: {"text":"Draft Revenue.pptx"}\n\nevent: done\ndata: {}\n\n'})
 })
 await page.reload()
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready')
 await expect(page.locator('button.rb-big.ai-entry').filter({hasText:'AI 助手'})).toBeEnabled()
 const copyNote='Unsaved notes belong to the copy'
 assert.equal(await page.evaluate(text=>window.slidesApi.setNotes({slideIndex:0,text}),copyNote),true)
 async function chooseCopyName(name){
  await page.locator('.ribbon-tab-file').click()
  await page.getByRole('button',{name:'Name with AI…',exact:true}).click()
  const confirmation=page.getByRole('dialog',{name:'Save a copy to your workspace'})
  const input=confirmation.getByRole('textbox',{name:'File name'})
  await expect(input).toHaveValue('Draft Revenue.pptx')
  if(name!==null)await input.fill(name)
  await confirmation.getByRole('button',{name:name===null?'Cancel':'Save copy'}).click()
  await expect(confirmation).toHaveCount(0)
 }
 await chooseCopyName(null)
 assert.equal((await f.files.listFiles(f.alice.token)).files.length,2)
 await chooseCopyName('Reviewed Revenue')
 await expect.poll(async()=>(await f.files.listFiles(f.alice.token)).files.length).toBe(3)
 const copy=(await f.files.listFiles(f.alice.token)).files.find(item=>item.name==='Reviewed Revenue.pptx')
 assert.ok(copy)
 const copyArchive=await JSZip.loadAsync(await f.files.readFile(f.alice.token,copy.id,copy.revision))
 assert.ok((await Promise.all(copyArchive.file(/^ppt\/notesSlides\/notesSlide\d+\.xml$/).map(item=>item.async('string')))).some(xml=>xml.includes(copyNote)))
 assert.equal((await f.files.openFile(f.alice.token,id)).file.revision,current.file.revision)
 assert.equal(await page.evaluate(()=>window.slidesApi.isDirty()),true)
 assert.equal(namingRequests.length,2)
 for(const {modelId,request} of namingRequests){
  assert.equal(modelId,'mock');assert.equal(request.format,'pptx');assert.deepEqual(request.tools,[])
  assert.ok(request.messages[0].text.includes('Overview'))
 }
 assert.deepEqual(errors,[],JSON.stringify(responses.filter(([status])=>status>=400)))
})
