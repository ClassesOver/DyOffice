import {stubHomeHero} from '../helpers/home-hero.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {fileURLToPath} from 'node:url'
import {PDFDocument} from 'pdf-lib'
import {pdfInsertFormState} from '../../server/src/pdf/insert-form-integrity.mjs'
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs'
import {expect} from '@playwright/test'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'

test('PDF image tools list the saved revision and recover one transformed image without duplicate edits',{timeout:120000},async t=>{
 let app,browser
 t.after(async()=>{await browser?.close();app?.server.closeAllConnections();await app?.close()})
 const origin='http://127.0.0.1:4234',f=await fileFixture(t,{origin,buildApp:false})
 const keyring={activeKeyId:'pdf-form',keys:{'pdf-form':new Uint8Array(32).fill(49)}}
 const insertion={page:1,image_number:1,x:80,y:60,width:120}
 const calls=[['list_page_images',{}],['transform_image',insertion],['list_page_images',{}]]
 let turn=0
 const network=mockProviderNetwork(t,()=>{
  const index=Math.floor(turn/2),isTool=turn++%2===0
  const delta=isTool?{tool_calls:[{index:0,id:'form-'+index,type:'function',function:{name:calls[index][0],arguments:JSON.stringify(calls[index][1])}}]}:{content:'Form result '+index}
  return Readable.from([Buffer.from(`data: ${JSON.stringify({choices:[{delta}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:isTool?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`)])
 })
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[{id:'shared-chat',kind:'chat',providerId:'deepseek',label:'Test model',model:'synthetic-model',baseUrl:'https://provider.example/v1',enabled:true,apiKey:'synthetic-key'}],defaults:{chat:'shared-chat'}})
 const doc=await PDFDocument.create(),page=doc.addPage([400,300])
 const picture=await doc.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOD8AAAAASUVORK5CYII=','base64'))
 page.drawImage(picture,{x:30,y:150,width:100,height:50})
 page.drawText('Footer unchanged',{x:30,y:50,size:12})
 const approved=doc.getForm().createCheckBox('Approved')
 approved.addToPage(page,{x:270,y:55,width:18,height:18});approved.check()
 const bytes=Buffer.from(await doc.save()),source=(await importFile(f,f.alice.token,bytes,'images.pdf')).file
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false,localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 await app.listen({host:'127.0.0.1',port:4234});browser=await launchTestBrowser()
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
 tab.on('request',request=>{if(request.url().endsWith('/pdf/apply-ops/uploads'))stages++;if(request.url().endsWith('/commits'))commits++})
 await tab.route('**/api/v1/files/*/commits',async route=>{
  const response=await route.fetch({timeout:10000});assert.equal(response.status(),200);saved=await response.json();await route.abort('failed')
 },{times:1})
 await assistant.getByRole('textbox',{name:'消息',exact:true}).fill('把图片1移到x80 y60，宽度120')
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
 const toolResult=JSON.parse(result.content);const listed=JSON.parse(toolResult.output);assert.equal(listed.length,1,JSON.stringify(listed));assert.ok(Math.abs(listed[0].x-80)<.1);assert.ok(Math.abs(listed[0].y-60)<.1);assert.ok(Math.abs(listed[0].width-120)<.1);assert.ok(Math.abs(listed[0].height-60)<.1)
 assert.equal(stages,1);assert.equal(commits,2)
 assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,saved.revision)
 const savedBytes=await f.files.readFile(f.alice.token,source.fileId,saved.revision)
 assert.equal(pdfInsertFormState(await PDFDocument.load(savedBytes)),pdfInsertFormState(await PDFDocument.load(bytes)))
 const task=getDocument({data:Uint8Array.from(savedBytes),disableFontFace:true,useSystemFonts:true})
 try{const content=await (await (await task.promise).getPage(1)).getTextContent();const text=content.items.map(item=>item.str??'').join(' ');assert.match(text,/Footer unchanged/)}finally{await task.destroy()}
 assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),bytes)
})
