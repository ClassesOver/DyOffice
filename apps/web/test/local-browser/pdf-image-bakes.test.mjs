import {stubHomeHero} from '../helpers/home-hero.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {fileURLToPath} from 'node:url'
import {PNG} from 'pngjs'
import {PDFDocument} from 'pdf-lib'
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs'
import {expect} from '@playwright/test'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'

test('PDF pixel tools crop the selected image through chat and recover a lost commit without duplicate cropping',{timeout:120000},async t=>{
 let app,browser
 t.after(async()=>{await browser?.close();app?.server.closeAllConnections();await app?.close()})
 const origin='http://127.0.0.1:4236',f=await fileFixture(t,{origin,buildApp:false})
 const keyring={activeKeyId:'pdf-form',keys:{'pdf-form':new Uint8Array(32).fill(49)}}
 const insertion={page:1,image_number:1,left:.2,top:.2}
 const calls=[['list_page_images',{}],['crop_image',insertion],['list_page_images',{}]]
 let turn=0
 const network=mockProviderNetwork(t,()=>{
  const index=Math.floor(turn/2),isTool=turn++%2===0
  const delta=isTool?{tool_calls:[{index:0,id:'form-'+index,type:'function',function:{name:calls[index][0],arguments:JSON.stringify(calls[index][1])}}]}:{content:'Form result '+index}
  return Readable.from([Buffer.from(`data: ${JSON.stringify({choices:[{delta}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:isTool?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`)])
 })
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[{id:'shared-chat',kind:'chat',providerId:'deepseek',label:'Test model',model:'synthetic-model',baseUrl:'https://provider.example/v1',enabled:true,apiKey:'synthetic-key'}],defaults:{chat:'shared-chat'}})
 const doc=await PDFDocument.create(),page=doc.addPage([400,300])
 const pixels=new PNG({width:10,height:10});for(let y=0;y<10;y++)for(let x=0;x<10;x++)pixels.data.set([20*x,20*y,50,255],(y*10+x)*4)
 const picture=await doc.embedPng(PNG.sync.write(pixels))
 page.drawImage(picture,{x:30,y:150,width:100,height:50})
 page.drawText('Footer unchanged',{x:30,y:50,size:12})
 const bytes=Buffer.from(await doc.save()),source=(await importFile(f,f.alice.token,bytes,'images.pdf')).file
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false,localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 await app.listen({host:'127.0.0.1',port:4236});browser=await launchTestBrowser()
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),tab=await context.newPage()
 await stubHomeHero(tab)
 await tab.goto(origin);await tab.getByLabel('用户名',{exact:true}).fill('alice');await tab.getByLabel('密码',{exact:true}).fill(password)
 await tab.getByRole('button',{name:'登录',exact:true}).click();await expect(tab.locator('.home')).toBeVisible()
 await tab.goto(origin+'/#/file/'+source.fileId)
 await expect(tab.getByRole('region',{name:'PDF 页面',exact:true}).locator('figure')).toHaveCount(1)
 await expect(tab.locator('.workspace-document:not([hidden]) .ant-spin-spinning')).toHaveCount(0)
 const assistant=tab.locator('.shared-editor-assistant')
 await assistant.getByRole('textbox',{name:'消息',exact:true}).fill('列出当前PDF图片')
 await assistant.getByRole('button',{name:'发送',exact:true}).click()
 await expect(assistant.getByText('Form result 0',{exact:true})).toBeVisible({timeout:30000})
 let stages=0,commits=0,saved
 tab.on('request',request=>{const path=new URL(request.url()).pathname;if(path.endsWith('/pdf/apply-ops/uploads'))stages++;if(path.endsWith('/commits'))commits++})
 await tab.route('**/api/v1/files/*/commits',async route=>{
  const response=await route.fetch({timeout:10000});assert.equal(response.status(),200);saved=await response.json();await route.abort('failed')
 },{times:1})
 await assistant.getByRole('textbox',{name:'消息',exact:true}).fill('裁掉图片1左侧和顶部各20%')
 await assistant.getByRole('button',{name:'发送',exact:true}).click()
 await expect(assistant.getByText('Form result 1',{exact:true})).toBeVisible({timeout:30000})
 await expect(tab.getByRole('status').filter({hasText:'正在生成图片与文字的页面预览'})).toHaveCount(0)
 await expect(tab.getByRole('button',{name:'保存新版本',exact:true})).toBeEnabled()
 assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,source.revision);assert.equal(stages,0);assert.equal(commits,0)
 await tab.getByRole('button',{name:'保存新版本',exact:true}).click()
 await expect(tab.getByRole('button',{name:'确认保存结果',exact:true})).toBeVisible({timeout:30000})
 assert.ok(saved)
 await tab.getByRole('button',{name:'确认保存结果',exact:true}).click()
 await expect(tab.getByRole('button',{name:'确认保存结果',exact:true})).toHaveCount(0,{timeout:30000})
 await expect(assistant.getByRole('button',{name:'发送',exact:true})).toBeDisabled()
 await assistant.getByRole('textbox',{name:'消息',exact:true}).fill('重新列出图片')
 await assistant.getByRole('button',{name:'发送',exact:true}).click()
 await expect(assistant.getByText('Form result 2',{exact:true})).toBeVisible({timeout:30000})
 const result=JSON.parse(network.wire.toString()).messages.filter(message=>message.role==='tool').at(-1)
 const toolResult=JSON.parse(result.content);const listed=JSON.parse(toolResult.output);assert.equal(listed.length,1,JSON.stringify(listed));assert.ok(Math.abs(listed[0].x-50)<.1);assert.ok(Math.abs(listed[0].y-110)<.1);assert.ok(Math.abs(listed[0].width-80)<.1);assert.ok(Math.abs(listed[0].height-40)<.1)
 const {readImageBitmap}=await import('../../../pdf/src/main/image-edit.ts')
 const cropped=await readImageBitmap(await f.files.readFile(f.alice.token,source.fileId,saved.revision),0,[50,150,130,190],8,8)
 assert.deepEqual([...cropped.subarray(0,4)],[50,40,40,255]);assert.deepEqual([...cropped.subarray(-4)],[50,180,180,255])
 assert.equal(stages,1);assert.equal(commits,2)
 assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,saved.revision)
 const task=getDocument({data:Uint8Array.from(await f.files.readFile(f.alice.token,source.fileId,saved.revision)),disableFontFace:true,useSystemFonts:true})
 try{const content=await (await (await task.promise).getPage(1)).getTextContent();const text=content.items.map(item=>item.str??'').join(' ');assert.match(text,/Footer unchanged/)}finally{await task.destroy()}
 assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),bytes)
})
