import {stubHomeHero} from '../helpers/home-hero.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {Readable} from 'node:stream'
import {fileURLToPath} from 'node:url'
import {mkdir,writeFile} from 'node:fs/promises'
import {PDFDocument,degrees,rgb} from 'pdf-lib'
import {PNG} from 'pngjs'
import {readPdfLeafObjects} from '../../../pdf/src/main/text-edit.ts'
import {readImageSource} from '../../../pdf/src/main/image-edit.ts'
import {pdfRectToCss} from '../../../pdf/src/renderer/annotations.ts'
import {expect} from '@playwright/test'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'

test('PDF pending raster images edit real pixels with text and recover one combined saved revision',{timeout:180000},async t=>{
 let app,browser,tab,turn=0,saved
 t.after(async()=>{if(tab)await tab.screenshot({path:'/tmp/dyoffice-pdf-image-drafts-review/latest.png',fullPage:true}).catch(()=>{});await browser?.close();app?.server.closeAllConnections();await app?.close()})
 const review='/tmp/dyoffice-pdf-image-drafts-review'
 await mkdir(review,{recursive:true})
 const png=new PNG({width:8,height:4});png.data.fill(255)
 for(let y=2;y<3;y++)for(let x=1;x<7;x++){
  const p=(y*8+x)*4;const red=(x<4)===(y===1);png.data[p]=red?255:0;png.data[p+1]=0;png.data[p+2]=red?0:255
 }
 const image=PNG.sync.write(png),url='data:image/png;base64,'+image.toString('base64')
 const replacement=new PNG({width:2,height:2});for(let p=0;p<replacement.data.length;p+=4)replacement.data.set([0,255,0,255],p)
 const replacementBytes=PNG.sync.write(replacement)
 const calls=[['insert_image',{page:1,url,width:160,x:40,y:80,layer:'below_text'}],['list_page_images',{page:1}],['insert_text',{page:2,text:'Combined pending text',x:50,y:80,font_size:16}]]
 const network=mockProviderNetwork(t,()=>{
  const index=Math.floor(turn/2),tool=turn++%2===0,[name,input]=calls[index]
  const delta=tool?{tool_calls:[{index:0,id:'image-draft-'+index,type:'function',function:{name,arguments:JSON.stringify(input)}}]}:{content:'Image draft result '+index}
  return Readable.from([Buffer.from(`data: ${JSON.stringify({choices:[{delta}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:tool?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`)])
 })
 const origin='http://127.0.0.1:4242',f=await fileFixture(t,{origin,buildApp:false}),keyring={activeKeyId:'image-drafts',keys:{'image-drafts':new Uint8Array(32).fill(56)}}
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[{id:'shared-chat',kind:'chat',providerId:'deepseek',label:'Test model',model:'synthetic-model',baseUrl:'https://provider.example/v1',enabled:true,apiKey:'synthetic-key'}],defaults:{chat:'shared-chat'}})
 const doc=await PDFDocument.create(),originalImage=await doc.embedPng(replacementBytes)
 for(let i=0;i<2;i++){
  const page=doc.addPage([500,600]);page.drawRectangle({x:0,y:0,width:500,height:600,color:rgb(1,1,1)});page.drawText('Original page '+(i+1),{x:40,y:500,size:12})
  if(i===0)page.drawImage(originalImage,{x:400,y:500,width:15,height:15});else page.setRotation(degrees(90))
 }
 const bytes=Buffer.from(await doc.save()),source=(await importFile(f,f.alice.token,bytes,'pending-images.pdf')).file
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false,localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 await app.listen({host:'127.0.0.1',port:4242});browser=await launchTestBrowser()
 tab=await browser.newPage({viewport:{width:1600,height:1200}})
 await tab.addInitScript(()=>{
  const Native=window.FileReader
  window.__holdImageRead=false;window.__releaseImageReads=[]
  window.FileReader=class extends Native{readAsDataURL(file){if(window.__holdImageRead)window.__releaseImageReads.push(()=>super.readAsDataURL(file));else super.readAsDataURL(file)}}
 })
 await stubHomeHero(tab);await tab.goto(origin)
 await tab.getByLabel('用户名',{exact:true}).fill('alice');await tab.getByLabel('密码',{exact:true}).fill(password);await tab.getByRole('button',{name:'登录',exact:true}).click();await expect(tab.locator('.home')).toBeVisible()
 await tab.goto(origin+'/#/file/'+source.fileId);await expect(tab.getByRole('region',{name:'PDF 页面',exact:true}).locator('figure')).toHaveCount(2);await expect(tab.locator('.workspace-document:not([hidden]) .ant-spin-spinning')).toHaveCount(0)
 let queries=0,stages=0,commits=0,leases=0;const pixelTrace=[]
 tab.on('request',request=>{const path=new URL(request.url()).pathname;if(path.endsWith('/apply-ops/query')){queries++;const body=request.postDataJSON();for(const {input} of body.snapshot?.imageEdits??[]){if(input.kind!=='insertImage')continue;const p=PNG.sync.read(Buffer.from(input.image,'base64')),alpha=[...new Set(Array.from({length:p.width*p.height},(_,i)=>p.data[i*4+3]))];pixelTrace.push({query:queries,width:p.width,height:p.height,alpha,pixels:[...p.data]})}}if(path.endsWith('/apply-ops/uploads'))stages++;if(path.endsWith('/commits'))commits++;if(path.includes('lease'))leases++})
 const assistant=tab.locator('.shared-editor-assistant'),overlay=tab.getByLabel('待保存图片覆盖层',{exact:true}),status=tab.getByRole('status').filter({hasText:'正在生成图片与文字的页面预览'})
 const canvas=page=>tab.locator(`figure[data-pdf-page="${page}"] canvas.pdf-page`)
 const previewPixels=async page=>createHash('sha256').update(await canvas(page).evaluate(node=>node.toDataURL())).digest('hex')
 const initial=[await previewPixels(1),await previewPixels(2)]
 const stable=async()=>{await expect(status).toHaveCount(0);await expect(tab.getByRole('button',{name:'保存新版本',exact:true})).toBeEnabled()}
 const unchanged=async()=>{assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,source.revision);assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),bytes);assert.equal(stages,0);assert.equal(commits,0);assert.equal(leases,0)}
 const action=async fn=>{await Promise.all([tab.waitForResponse(response=>response.url().endsWith('/apply-ops/query')&&response.status()===200,{timeout:15000}),fn()]);await stable();await unchanged()}
 const send=async(index)=>{await assistant.getByRole('textbox',{name:'消息',exact:true}).fill('Execute image draft step '+index);await assistant.getByRole('button',{name:'发送',exact:true}).click();await expect(assistant.getByText('Image draft result '+index,{exact:true})).toBeVisible({timeout:30000})}
 const values=async()=>Object.fromEntries(await Promise.all(['横坐标','纵坐标','宽度','高度'].map(async(label)=>[label,Number(await tab.getByLabel('待保存图片'+label,{exact:true}).inputValue())])))
 await action(()=>send(0));await expect(overlay).toHaveCount(1);assert.notEqual(await previewPixels(1),initial[0]);assert.equal(await previewPixels(2),initial[1])
 await send(1)
 const wire=JSON.parse(network.wire.toString()),imageResult=wire.messages.findLast(message=>message.role==='tool')
 const listed=JSON.parse(JSON.parse(imageResult.content).output);assert.equal(listed.length,1,JSON.stringify(imageResult));assert.equal(listed[0].image_number,1);assert.equal(listed[0].width,15)
 await action(()=>send(2));await expect(tab.getByLabel('待保存文字覆盖层',{exact:true})).toHaveCount(1);assert.notEqual(await previewPixels(2),initial[1])
 const block=overlay.getByRole('button'),rect=block.locator('rect').first(),handle=block.locator('[data-resize="true"]')
 // Actual pointer events include canvas/SVG display scaling and capture.
 const drag=async(locator,dx,dy)=>{await locator.scrollIntoViewIfNeeded();const box=await locator.boundingBox();await tab.mouse.move(box.x+box.width/2,box.y+box.height/2);await tab.mouse.down();await tab.mouse.move(box.x+box.width/2+dx,box.y+box.height/2+dy,{steps:4});await tab.mouse.up()}
 await action(()=>drag(rect,20,10));await action(()=>drag(handle,40,20))
 await handle.scrollIntoViewIfNeeded();const beforeCancel=await values(),beforeQueries=queries,handleBox=await handle.boundingBox()
 await tab.mouse.move(handleBox.x+handleBox.width/2,handleBox.y+handleBox.height/2);await tab.mouse.down();await tab.mouse.move(handleBox.x+handleBox.width/2+30,handleBox.y+handleBox.height/2+15,{steps:3})
 await block.evaluate(node=>node.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerId:1})));await tab.mouse.up()
 assert.equal(Number(await rect.getAttribute('width')),beforeCancel['宽度']);assert.equal(Number(await rect.getAttribute('height')),beforeCancel['高度']);assert.deepEqual(await values(),beforeCancel);assert.equal(queries,beforeQueries)
 await action(()=>tab.getByRole('button',{name:'图片右转 90°',exact:true}).click());assert.equal(pixelTrace.at(-1).width,4);assert.equal(pixelTrace.at(-1).height,8)
 const rotatedPixels=pixelTrace.at(-1).pixels;await action(()=>tab.getByRole('button',{name:'水平翻转图片',exact:true}).click());assert.notDeepEqual(pixelTrace.at(-1).pixels,rotatedPixels,'Horizontal flip must actually change asymmetric pixels')
 for(const opacity of ['50','80']){await tab.getByLabel('待保存图片不透明度',{exact:true}).fill(opacity);await action(()=>tab.getByRole('button',{name:'应用不透明度',exact:true}).click());assert.deepEqual(pixelTrace.at(-1).alpha,[Math.round(Number(opacity)*255/100)],'Opacity must change image PNG bytes, not only redraw')}
 await tab.getByLabel('待保存图片左裁剪',{exact:true}).fill('25');await action(()=>tab.getByRole('button',{name:'裁剪待保存图片',exact:true}).click())
 await tab.getByLabel('待保存图片去背景容差',{exact:true}).fill('0');await action(()=>tab.getByRole('button',{name:'去除图片背景',exact:true}).click());assert.deepEqual([...pixelTrace.at(-1).alpha].sort((a,b)=>a-b),[0,204],'Cutout removes white edge pixels and retains 80% alpha')
 const geometry=await values(),beforeReplace=await previewPixels(1)
 await tab.evaluate(()=>{window.__holdImageRead=true})
 await tab.getByLabel('替换待保存图片',{exact:true}).setInputFiles({name:'replacement.png',mimeType:'image/png',buffer:replacementBytes})
 await expect(tab.getByRole('button',{name:'保存新版本',exact:true})).toBeDisabled();await expect(tab.getByLabel('待保存图片不透明度',{exact:true})).toBeDisabled()
 await action(()=>tab.evaluate(()=>{window.__holdImageRead=false;for(const release of window.__releaseImageReads.splice(0))release()}));assert.deepEqual(await values(),geometry);assert.notEqual(await previewPixels(1),beforeReplace)
 await action(()=>tab.getByRole('button',{name:'撤销修改',exact:true}).click());assert.deepEqual(await values(),geometry);assert.equal(await previewPixels(1),beforeReplace)
 await block.click();await expect(block).toBeFocused();await action(()=>tab.keyboard.press('Delete'));await expect(overlay).toHaveCount(0);assert.equal(await previewPixels(1),initial[0])
 await action(()=>tab.getByRole('button',{name:'撤销修改',exact:true}).click());await expect(overlay).toHaveCount(1);assert.deepEqual(await values(),geometry)
 // Native preview must show colored raster pixels above the white page background.
 const colors=await canvas(1).evaluate(node=>{const d=node.getContext('2d').getImageData(0,0,node.width,node.height).data;let red=0,blue=0;for(let p=0;p<d.length;p+=4){if(d[p]>d[p+1]+40&&d[p]>d[p+2]+40)red++;if(d[p+2]>d[p]+40&&d[p+2]>d[p+1]+40)blue++}return {red,blue}})
 assert.ok(colors.red>20&&colors.blue>20,JSON.stringify(colors));await tab.screenshot({path:review+'/pending.png',fullPage:true})
 await tab.route('**/api/v1/files/*/commits',async route=>{const response=await route.fetch({timeout:10000});assert.equal(response.status(),200);saved=await response.json();await route.abort('failed')},{times:1})
 await tab.getByRole('button',{name:'保存新版本',exact:true}).click();await expect(tab.getByRole('button',{name:'确认保存结果',exact:true})).toBeVisible({timeout:30000})
 assert.ok(saved);assert.equal(stages,1);assert.equal(commits,1);await expect(overlay).toHaveCount(1);await expect(block).toHaveAttribute('tabindex','-1');await expect(tab.getByLabel('待保存图片不透明度',{exact:true})).toBeDisabled()
 await tab.getByRole('button',{name:'确认保存结果',exact:true}).click();await expect(overlay).toHaveCount(0,{timeout:30000});await expect(tab.getByLabel('待保存文字覆盖层',{exact:true})).toHaveCount(0);assert.equal(stages,1);assert.equal(commits,2)
 const output=await f.files.readFile(f.alice.token,source.fileId,saved.revision),objects=await readPdfLeafObjects(output,true)
 await writeFile(review+'/saved.pdf',output);await writeFile(review+'/geometry.json',JSON.stringify({geometry,colors,queries,stages,commits,pixelTrace},null,2))
 const texts=objects.filter(object=>object.type===1).map(object=>object.text).join('|');assert.match(texts,/Original page 1/);assert.match(texts,/Original page 2/);assert.match(texts,/Combined pending text/)
 const images=objects.filter(object=>object.type===3);assert.equal(images.length,2)
 const added=images.find(object=>{if(object.page!==0)return false;const box=pdfRectToCss({pw:500,ph:600,rot:0},object.bounds,1);return Math.abs(box.left-geometry['横坐标'])<.1&&Math.abs(box.top-geometry['纵坐标'])<.1&&Math.abs(box.width-geometry['宽度'])<.1&&Math.abs(box.height-geometry['高度'])<.1})
 assert.ok(added,'Saved image bounds must match preview geometry: '+JSON.stringify(images))
 const pixels=await readImageSource(output,0,added.bounds);assert.equal(pixels.width,3);assert.equal(pixels.height,8)
 const alphas=new Set(),channels=[];for(let p=0;p<pixels.bgra.length;p+=4){alphas.add(pixels.bgra[p+3]);channels.push([...pixels.bgra.subarray(p,p+4)])}
 assert.ok(alphas.has(0));assert.ok(alphas.has(204));assert.equal(alphas.has(102),false);assert.ok(channels.some(([b,g,r,a])=>a===204&&r>200&&b<10&&g<10));assert.ok(channels.some(([b,g,r,a])=>a===204&&b>200&&r<10&&g<10))
 const old=images.find(object=>object!==added),oldPixels=await readImageSource(output,0,old.bounds);assert.equal(oldPixels.width,2);assert.equal(oldPixels.height,2);assert.deepEqual([...oldPixels.bgra.subarray(0,4)],[0,255,0,255])
 await tab.reload();await expect(tab.getByRole('region',{name:'PDF 页面',exact:true})).toContainText('Combined pending text',{timeout:30000});await expect(overlay).toHaveCount(0);await tab.screenshot({path:review+'/saved.png',fullPage:true})
 assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),bytes)
})
