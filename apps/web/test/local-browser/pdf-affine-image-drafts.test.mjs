import test from 'node:test'
import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {mkdir,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {PDFDocument,degrees,pushGraphicsState,popGraphicsState,rectangle,clip,endPath} from 'pdf-lib'
import {PNG} from 'pngjs'
import {expect} from '@playwright/test'
import {stubHomeHero} from '../helpers/home-hero.mjs'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {catalog} from '../../server/src/pdf/image-edits-job.mjs'
import {readPdfLeafObjects} from '../../../pdf/src/main/text-edit.ts'

const nativePdfDirectory=process.env.DYOFFICE_TEST_NATIVE_PDF_DIST
for(const native of [false,...(nativePdfDirectory?[true]:[])])test(`${native?'Native PDF':'PDF preview'} assistant flips and crops affine images, then saves and reopens`,{timeout:180000},async t=>{
 let app,browser,tab,turn=0
 const review='/tmp/dyoffice-pdf-affine-drafts-review/'+(native?'native':'preview');await mkdir(review,{recursive:true})
 t.after(async()=>{if(tab)await tab.screenshot({path:review+'/latest.png',fullPage:true}).catch(()=>{});await browser?.close();app?.server.closeAllConnections();await app?.close()})
 const port=43789,origin='http://127.0.0.1:'+port,f=await fileFixture(t,{origin,buildApp:false}),keyring={activeKeyId:'affine',keys:{affine:new Uint8Array(32).fill(63)}}
 const calls=[['list_page_images',{}],['flip_image',{page:1,image_number:1,axis:'horizontal'}],['list_page_images',{}],['crop_image',{page:1,image_number:1,left:.25}],['list_page_images',{}],['crop_image',{page:1,image_number:2,left:.25}],['insert_text',{page:1,text:'Affine browser saved',x:80,y:100,font_size:16}]]
 const network=mockProviderNetwork(t,()=>{const index=Math.floor(turn/2),tool=turn++%2===0,[name,input]=calls[index],delta=tool?{tool_calls:[{index:0,id:'affine-'+index,type:'function',function:{name,arguments:JSON.stringify(input)}}]}:{content:'Affine result '+index};return Readable.from([Buffer.from(`data: ${JSON.stringify({choices:[{delta}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:tool?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`)])})
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[{id:'shared-chat',kind:'chat',providerId:'deepseek',label:'Test model',model:'synthetic-model',baseUrl:'https://provider.example/v1',enabled:true,apiKey:'synthetic-key'}],defaults:{chat:'shared-chat'}})
 const pixels=new PNG({width:4,height:3});for(let i=0;i<pixels.data.length;i+=4)pixels.data.set([20+i*3,210-i*2,40+i,255],i)
 const inner=await PDFDocument.create(),p=inner.addPage([500,500]),image=await inner.embedPng(PNG.sync.write(pixels))
 p.drawImage(image,{x:200,y:200,width:100,height:75,rotate:degrees(30),xSkew:degrees(20),opacity:.4})
 p.pushOperators(pushGraphicsState(),rectangle(270,55,82,65),clip(),endPath())
 p.drawImage(image,{x:300,y:40,width:100,height:80,rotate:degrees(30)})
 p.pushOperators(popGraphicsState());p.drawText('Affine original',{x:30,y:30})
 const outer=await PDFDocument.create(),page=outer.addPage([600,600]);page.drawPage(await outer.embedPage((await PDFDocument.load(await inner.save())).getPage(0)),{x:40,y:50,xScale:.8,yScale:.9})
 const original=Buffer.from(await outer.save()),source=(await importFile(f,f.alice.token,original,'affine-drafts.pdf')).file
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false,nativePdfDirectory:native?nativePdfDirectory:undefined,localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 await app.listen({host:'127.0.0.1',port});browser=await launchTestBrowser();tab=await browser.newPage({viewport:{width:1600,height:1100}});await stubHomeHero(tab)
 const errors=[];tab.on('pageerror',error=>errors.push(error.message))
 await tab.goto(origin);await tab.getByLabel('用户名',{exact:true}).fill('alice');await tab.getByLabel('密码',{exact:true}).fill(password);await tab.getByRole('button',{name:'登录',exact:true}).click();await expect(tab.locator('.home')).toBeVisible();await tab.goto(origin+'/#/file/'+source.fileId)
 const surface=native?tab.frameLocator(`iframe[data-document-id="${source.fileId}"]`):tab
 const pages=surface.getByRole('region',{name:'PDF 页面',exact:true})
 if(native){
  await expect(surface.locator('html')).toHaveAttribute('data-document-loading','ready')
  await surface.getByRole('button',{name:'AI 助手',exact:true}).click()
 }else{
  await expect(pages.locator('figure')).toHaveCount(1);await expect(tab.locator('.workspace-document:not([hidden]) .ant-spin-spinning')).toHaveCount(0)
 }
 const canvas=native?surface.locator('.pdf-page-content canvas').first():pages.locator('canvas.pdf-page')
 const preview=()=>canvas.evaluate(element=>{
  const context=element.getContext('2d'),pixels=[]
  for(const [left,top]of [[172,250],[250,412]])for(let dy=0;dy<96;dy+=8)for(let dx=0;dx<80;dx+=8)
   pixels.push(...context.getImageData(Math.floor((left+dx)/600*element.width),Math.floor((top+dy)/600*element.height),1,1).data)
  return pixels
 })
 const difference=async baseline=>(await preview()).reduce((total,value,i)=>total+Math.abs(value-baseline[i]),0)/baseline.length
 await expect.poll(async()=>(await preview()).some((value,i)=>i%4===1&&value>=170&&value<=248)).toBe(true)
 const initialPreview=await preview()
 let stages=0,commits=0
 tab.on('request',request=>{const path=new URL(request.url()).pathname;if(path.endsWith('/uploads')&&path.includes('/pdf/'))stages++;if(path.endsWith('/commits'))commits++})
 const failedPreviews=[]
 tab.on('response',response=>{const path=new URL(response.url()).pathname;if(path.includes('/pdf/')&&path.endsWith('/query')&&!response.ok())failedPreviews.push(response.text().catch(()=>''))})
 const assistant=surface.locator('.shared-editor-assistant'),region=surface.getByRole('region',{name:'已有图片待保存编辑',exact:true}),save=surface.getByRole('button',{name:native?'保存':'保存新版本',exact:true})
 const expectDrafts=async count=>{if(!native)await expect(region.locator('li')).toHaveCount(count)}
 const send=async(index,editing=true)=>{await assistant.getByRole('textbox',{name:'消息',exact:true}).fill('Run affine step '+index);await assistant.getByRole('button',{name:'发送',exact:true}).click();await expect(assistant.getByText('Affine result '+index,{exact:true})).toBeVisible({timeout:30000});if(!native)await expect(tab.getByRole('status').filter({hasText:'正在生成图片与文字的页面预览'})).toHaveCount(0);const result=JSON.parse(JSON.parse(network.wire.toString()).messages.filter(message=>message.role==='tool').at(-1).content);if(result.isError)assert.fail(`Step ${index}: ${result.output} ${(await Promise.all(failedPreviews)).join(' ')}`);if(editing)await expect(save).toBeEnabled()}
 const unchanged=async()=>{assert.equal(stages,0);assert.equal(commits,0);assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,source.revision)}
 await send(0,false);await send(1);await expectDrafts(1);await expect.poll(()=>difference(initialPreview)).toBeGreaterThan(1.5);await unchanged()
 await surface.getByRole('button',{name:/^撤销/}).click();await expectDrafts(0);await expect.poll(()=>difference(initialPreview)).toBeLessThan(1.5)
 await send(2,false);await send(3);await expectDrafts(1);await expect.poll(()=>difference(initialPreview)).toBeGreaterThan(1.5)
 const firstCropPreview=await preview()
 await send(4,false);await send(5);await expectDrafts(2);await expect.poll(()=>difference(firstCropPreview)).toBeGreaterThan(1.5)
 await send(6);await unchanged();await tab.screenshot({path:review+'/pending.png',fullPage:true})
 await save.click();await expect.poll(async()=>(await f.files.openFile(f.alice.token,source.fileId)).file.revision,{timeout:30000}).not.toBe(source.revision);await expectDrafts(0);assert.equal(stages,1);assert.equal(commits,1)
 const saved=(await f.files.openFile(f.alice.token,source.fileId)).file;assert.notEqual(saved.revision,source.revision)
 const output=await f.files.readFile(f.alice.token,source.fileId,saved.revision),before=(await catalog(original)).entries.map(entry=>entry.image),after=(await catalog(output)).entries.map(entry=>entry.image),objects=await readPdfLeafObjects(output)
 assert.equal(after.length,before.length);assert.equal(after.length,2)
 for(let i=0;i<before.length;i++){
  const w=Math.ceil(before[i].width*3),cut=Math.round(w*.25)/w
  assert.ok(Math.abs(after[i].width-before[i].width*(1-cut))<.02);assert.ok(Math.abs(after[i].x-before[i].x-before[i].width*cut)<.02)
 }
 assert.ok(objects.some(o=>o.text==='Affine original'));assert.ok(objects.some(o=>o.text==='Affine browser saved'));assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),original)
 await writeFile(review+'/saved.pdf',output);await writeFile(review+'/geometry.json',JSON.stringify({before,after,stages,commits},null,2));await tab.reload()
 if(native){
  await expect(surface.locator('html')).toHaveAttribute('data-document-loading','ready')
  await expect(surface.getByText('Affine browser saved',{exact:true}).first()).toBeAttached({timeout:30000})
  await expect(save).toBeDisabled()
 }else{
  await expect(pages).toContainText('Affine browser saved',{timeout:30000});await expectDrafts(0)
 }
 await tab.screenshot({path:review+'/saved.png',fullPage:true});assert.deepEqual(errors,[])
})
