import {stubHomeHero} from '../helpers/home-hero.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {mkdir,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {PDFDocument,degrees,rgb} from 'pdf-lib'
import {PNG} from 'pngjs'
import {expect} from '@playwright/test'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {catalog} from '../../server/src/pdf/image-edits-job.mjs'
import {readImageSource} from '../../../pdf/src/main/image-edit.ts'
import {readPdfLeafObjects} from '../../../pdf/src/main/text-edit.ts'
const png=color=>{const image=new PNG({width:2,height:2});for(let i=0;i<image.data.length;i+=4)image.data.set(color,i);return PNG.sync.write(image)}

test('saved PDF image edits remain pending across undo/discard and one mixed save with original-target identity',{timeout:240000},async t=>{
 let app,browser,tab,saved,turn=0
 const review='/tmp/dyoffice-pdf-saved-image-drafts-review';await mkdir(review,{recursive:true})
 t.after(async()=>{if(tab)await tab.screenshot({path:review+'/latest.png',fullPage:true}).catch(()=>{});await browser?.close();app?.server.closeAllConnections();await app?.close()})
 const origin='http://127.0.0.1:4289',f=await fileFixture(t,{origin,buildApp:false}),keyring={activeKeyId:'saved-images',keys:{'saved-images':new Uint8Array(32).fill(62)}}
 const replacement='data:image/png;base64,'+png([0,255,255,255]).toString('base64'),inserted='data:image/png;base64,'+png([255,0,255,255]).toString('base64'),list=['list_page_images',{}],remove=['delete_image',{page:1,image_number:1}]
 const calls=[list,remove,list,['transform_image',{page:1,image_number:1,x:200}],remove,list,remove,list,['transform_image',{page:1,image_number:2,x:180,y:420}],list,['set_image_opacity',{page:1,image_number:3,opacity:.8}],list,['replace_image',{page:1,image_number:4,url:replacement}],list,['insert_text',{page:2,text:'Pending mixed text',x:50,y:80,font_size:16}],['insert_image',{page:2,url:inserted,x:200,y:150,width:40,layer:'below_text'}],list]
 const network=mockProviderNetwork(t,()=>{const index=Math.floor(turn/2),tool=turn++%2===0,[name,input]=calls[index],delta=tool?{tool_calls:[{index:0,id:'saved-image-'+index,type:'function',function:{name,arguments:JSON.stringify(input)}}]}:{content:'Saved image result '+index};return Readable.from([Buffer.from(`data: ${JSON.stringify({choices:[{delta}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:tool?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`)])})
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[{id:'shared-chat',kind:'chat',providerId:'deepseek',label:'Test model',model:'synthetic-model',baseUrl:'https://provider.example/v1',enabled:true,apiKey:'synthetic-key'}],defaults:{chat:'shared-chat'}})
 const d=await PDFDocument.create(),p=d.addPage([500,600]);p.drawRectangle({x:0,y:0,width:500,height:600,color:rgb(1,1,1)});p.drawText('Original page 1',{x:250,y:560,size:14})
 for(const [i,color]of [[255,0,0,255],[0,255,0,255],[0,0,255,255],[255,255,0,255]].entries())p.drawImage(await d.embedPng(png(color)),{x:40,y:500-i*100,width:40,height:40})
 const second=d.addPage([500,600]);second.setRotation(degrees(90));second.drawText('Original page 2',{x:40,y:500,size:14})
 const original=Buffer.from(await d.save()),source=(await importFile(f,f.alice.token,original,'saved-image-drafts.pdf')).file
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false,localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 await app.listen({host:'127.0.0.1',port:4289});browser=await launchTestBrowser();tab=await browser.newPage({viewport:{width:1600,height:1200}});await stubHomeHero(tab)
 await tab.goto(origin);await tab.getByLabel('用户名',{exact:true}).fill('alice');await tab.getByLabel('密码',{exact:true}).fill(password);await tab.getByRole('button',{name:'登录',exact:true}).click();await expect(tab.locator('.home')).toBeVisible();await tab.goto(origin+'/#/file/'+source.fileId)
 await expect(tab.getByRole('region',{name:'PDF 页面',exact:true}).locator('figure')).toHaveCount(2);await expect(tab.locator('.workspace-document:not([hidden]) .ant-spin-spinning')).toHaveCount(0)
 let stages=0,commits=0,leases=0,queries=0
 tab.on('request',request=>{const path=new URL(request.url()).pathname;if(path.endsWith('/apply-ops/uploads'))stages++;if(path.endsWith('/commits'))commits++;if(path.includes('lease'))leases++;if(path.endsWith('/apply-ops/query'))queries++})
 const assistant=tab.locator('.shared-editor-assistant'),region=tab.getByRole('region',{name:'已有图片待保存编辑',exact:true}),raster=tab.locator('.pdf-page-surface canvas'),save=tab.getByRole('button',{name:'保存新版本',exact:true})
 const unchanged=async()=>{assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,source.revision);assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),original);assert.equal(stages,0);assert.equal(commits,0);assert.equal(leases,0)}
 const tool=()=>JSON.parse(JSON.parse(network.wire.toString()).messages.filter(message=>message.role==='tool').at(-1).content)
 const send=async(index)=>{await assistant.getByRole('textbox',{name:'消息',exact:true}).fill('Run saved image step '+index);await assistant.getByRole('button',{name:'发送',exact:true}).click();await expect(assistant.getByText('Saved image result '+index,{exact:true})).toBeVisible({timeout:30000});return tool()}
 const stable=async()=>{await expect(tab.getByRole('status').filter({hasText:'正在生成图片与文字的页面预览'})).toHaveCount(0);await expect(save).toBeEnabled()}
 const edit=async(index,count)=>{await send(index);await expect(region.locator('li')).toHaveCount(count);await stable();await unchanged()}
 const listed=async(index,pending)=>{const result=JSON.parse((await send(index)).output);assert.equal(result.length,4);assert.deepEqual(result.map(i=>i.image_number),[1,2,3,4]);assert.deepEqual(result.filter(i=>i.pending).map(i=>i.image_number),pending);assert.deepEqual(result.map(i=>[i.x,i.y]),[[40,60],[40,160],[40,260],[40,360]]);await unchanged()}
 await listed(0,[]);await edit(1,1);await listed(2,[1]);const beforeDuplicate=queries,duplicate=await send(3);assert.match(duplicate.output,/could not|pending|待保存|failed/i);assert.equal(queries,beforeDuplicate);await expect(region.locator('li')).toHaveCount(1);await unchanged()
 await tab.getByRole('button',{name:'撤销修改',exact:true}).click();await expect(region).toHaveCount(0);await expect(raster).toHaveCount(2);await unchanged()
 await edit(4,1);await tab.getByRole('button',{name:'放弃修改',exact:true}).click();await expect(region).toHaveCount(0);await expect(raster).toHaveCount(2);await unchanged()
 await listed(5,[]);await edit(6,1);await listed(7,[1]);await edit(8,2);await listed(9,[1,2]);await edit(10,3);await listed(11,[1,2,3]);await edit(12,4);await listed(13,[1,2,3,4])
 await send(14);await stable();await send(15);await stable();await expect(raster).toHaveCount(2);await unchanged()
 const preview=await raster.first().evaluate(c=>{const ctx=c.getContext('2d');return [[60,80],[200,440],[60,280],[60,380]].map(([x,y])=>[...ctx.getImageData(x,y,1,1).data])})
 assert.deepEqual(preview[0],[255,255,255,255]);assert.deepEqual(preview[1],[0,255,0,255]);assert.deepEqual(preview[2],[51,51,255,255]);assert.deepEqual(preview[3],[0,255,255,255]);await tab.screenshot({path:review+'/pending.png',fullPage:true})
 await tab.route('**/api/v1/files/*/commits',async route=>{const response=await route.fetch({timeout:10000});assert.equal(response.status(),200);saved=await response.json();await route.abort('failed')},{times:1})
 await save.click();await expect(tab.getByRole('button',{name:'确认保存结果',exact:true})).toBeVisible({timeout:30000});assert.ok(saved);assert.equal(stages,1);assert.equal(commits,1);await expect(region.locator('li')).toHaveCount(4);await expect(tab.getByRole('button',{name:'撤销修改',exact:true})).toBeDisabled()
 await tab.getByRole('button',{name:'确认保存结果',exact:true}).click();await expect(region).toHaveCount(0,{timeout:30000});await expect(raster).toHaveCount(2);assert.equal(stages,1);assert.equal(commits,2)
 await expect(tab.getByText('PDF 保存结果已确认。',{exact:true})).toBeVisible({timeout:30000});await expect(save).not.toHaveClass(/ant-btn-loading/);await expect(tab.locator('.workspace-document:not([hidden]) .ant-spin-spinning')).toHaveCount(0)
 const finalList=JSON.parse((await send(16)).output);assert.equal(finalList.length,4);assert.ok(finalList.every(image=>!image.pending))
 const output=await f.files.readFile(f.alice.token,source.fileId,saved.revision),entries=(await catalog(output)).entries,objects=await readPdfLeafObjects(output)
 assert.equal(entries.length,4);const read=async(page,x,y)=>{const e=entries.find(e=>e.image.page===page&&Math.abs(e.image.x-x)<.1&&Math.abs(e.image.y-y)<.1);assert.ok(e,JSON.stringify(entries.map(e=>e.image)));return readImageSource(output,page-1,e.ref.rect)}
 assert.deepEqual([...(await read(1,180,420)).bgra.subarray(0,4)],[0,255,0,255]);assert.deepEqual([...(await read(1,40,260)).bgra.subarray(0,4)],[255,0,0,204]);assert.deepEqual([...(await read(1,40,360)).bgra.subarray(0,4)],[255,255,0,255]);assert.deepEqual([...(await read(2,200,150)).bgra.subarray(0,4)],[255,0,255,255]);assert.ok(!entries.some(e=>e.image.page===1&&e.image.y===60))
 const texts=objects.filter(o=>o.type===1).map(o=>o.text).join('|');assert.match(texts,/Original page 1/);assert.match(texts,/Original page 2/);assert.match(texts,/Pending mixed text/)
 await writeFile(review+'/saved.pdf',output);await writeFile(review+'/receipts.json',JSON.stringify({queries,stages,commits,revision:saved.revision,preview,images:entries.map(e=>e.image)},null,2));await tab.reload();await expect(tab.getByRole('region',{name:'PDF 页面',exact:true})).toContainText('Pending mixed text',{timeout:30000});await expect(region).toHaveCount(0);await tab.screenshot({path:review+'/saved.png',fullPage:true});assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),original)
})
