import {stubHomeHero} from '../helpers/home-hero.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {fileURLToPath} from 'node:url'
import {readPdfLeafObjects} from '../../../pdf/src/main/text-edit.ts'
import {PDFDocument} from 'pdf-lib'
import {expect} from '@playwright/test'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'

const nativePdfDirectory=process.env.DYOFFICE_TEST_NATIVE_PDF_DIST
for(const native of [false,...(nativePdfDirectory?[true]:[])])test((native?'Native PDF':'PDF preview')+' user-reviewed redaction saves one separate copy and recovers a lost finish response',{timeout:120000},async t=>{
 let app,browser
 t.after(async()=>{await browser?.close();app?.server.closeAllConnections();await app?.close()})
 const origin='http://127.0.0.1:4240',f=await fileFixture(t,{origin,buildApp:false})
 const keyring={activeKeyId:'pdf-form',keys:{'pdf-form':new Uint8Array(32).fill(49)}}
 const calls=[['find_sensitive_info',{patterns:['email'],mark:true}]]
 let turn=0
 const network=mockProviderNetwork(t,()=>{
  const index=Math.floor(turn/2),isTool=turn++%2===0
  const delta=isTool?{tool_calls:[{index:0,id:'form-'+index,type:'function',function:{name:calls[index][0],arguments:JSON.stringify(calls[index][1])}}]}:{content:'Form result '+index}
  return Readable.from([Buffer.from(`data: ${JSON.stringify({choices:[{delta}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:isTool?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`)])
 })
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[{id:'shared-chat',kind:'chat',providerId:'deepseek',label:'Test model',model:'synthetic-model',baseUrl:'https://provider.example/v1',enabled:true,apiKey:'synthetic-key'}],defaults:{chat:'shared-chat'}})
 const doc=await PDFDocument.create(),p=doc.addPage([500,600]);p.drawText('PUBLIC',{x:40,y:430,size:14});p.drawText('chosen@example.com',{x:40,y:350,size:14});p.drawText('keep@example.com',{x:40,y:270,size:14})
 const bytes=Buffer.from(await doc.save()),source=(await importFile(f,f.alice.token,bytes,'private.pdf')).file
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false,nativePdfDirectory:native?nativePdfDirectory:undefined,localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 await app.listen({host:'127.0.0.1',port:4240});browser=await launchTestBrowser()
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),tab=await context.newPage()
 await stubHomeHero(tab)
 await tab.goto(origin);await tab.getByLabel('用户名',{exact:true}).fill('alice');await tab.getByLabel('密码',{exact:true}).fill(password)
 await tab.getByRole('button',{name:'登录',exact:true}).click();await expect(tab.locator('.home')).toBeVisible()
 await tab.goto(origin+'/#/file/'+source.fileId)
 const editor=native?tab.frameLocator('.workspace-document:not([hidden]) iframe.workspace-document-frame'):tab
 const review=editor.getByRole('region',{name:'涂黑候选审查',exact:true})
 if(native){
  await expect(editor.locator('html')).toHaveAttribute('data-document-loading','ready',{timeout:30000})
  await editor.getByRole('button',{name:'注释',exact:true}).click()
  await editor.getByRole('button',{name:'查找敏感信息',exact:true}).click()
  await editor.getByRole('button',{name:'电子邮箱',exact:true}).click()
  await expect(review.getByRole('checkbox')).toHaveCount(2)
  await expect(editor.locator('svg[aria-label="待确认的涂黑标记"] rect')).toHaveCount(2)
  assert.equal((await f.files.listFiles(f.alice.token)).files.length,1)
  await review.getByRole('button',{name:'清除标记',exact:true}).click()
  await expect(review).toHaveCount(0)
  await editor.getByRole('button',{name:'开始',exact:true}).click()
  await editor.getByRole('button',{name:'AI 助手',exact:true}).click()
 }else await expect(tab.getByRole('region',{name:'PDF 页面',exact:true}).locator('figure')).toHaveCount(1)
 await expect(tab.locator('.workspace-document:not([hidden]) .ant-spin-spinning')).toHaveCount(0)
 const assistant=editor.locator('.shared-editor-assistant')
 let stages=0,finishes=0,created
 tab.on('request',request=>{if(request.url().endsWith('/pdf/redacted-copy/uploads'))stages++;if(request.url().endsWith('/finish'))finishes++})
 await assistant.getByRole('textbox',{name:'消息',exact:true}).fill('查找邮箱并标记，等我审查')
 await assistant.getByRole('button',{name:'发送',exact:true}).click()
 await expect(assistant.getByText('Form result 0',{exact:true})).toBeVisible({timeout:30000})
 await expect(review).toBeVisible();await expect(review.getByRole('checkbox')).toHaveCount(2)
 await expect(editor.locator('svg[aria-label="待确认的涂黑标记"] rect')).toHaveCount(2)
 assert.equal(stages,0);assert.equal(finishes,0);assert.equal((await f.files.listFiles(f.alice.token)).files.length,1)
 await review.getByRole('checkbox',{name:/keep@example.com/}).uncheck()
 await expect(editor.locator('svg[aria-label="待确认的涂黑标记"] rect')).toHaveCount(1)
 await review.getByRole('button',{name:'生成涂黑副本',exact:true}).click()
 assert.equal(stages,0)
 await tab.route('**/api/v1/uploads/*/finish',async route=>{
  const response=await route.fetch({timeout:10000});assert.equal(response.status(),200);created=(await response.json()).file;await route.abort('failed')
 },{times:1})
 await review.getByRole('button',{name:'确认永久涂黑并另存',exact:true}).click()
 await expect(editor.getByRole('button',{name:'确认保存结果',exact:true})).toBeVisible({timeout:30000});assert.ok(created)
 assert.notEqual(created.fileId,source.fileId);assert.equal((await f.files.listFiles(f.alice.token)).files.length,2)
 await editor.getByRole('button',{name:'确认保存结果',exact:true}).click()
 await expect(tab).toHaveURL(origin+'/#/file/'+created.fileId,{timeout:30000})
 assert.equal(stages,1);assert.equal(finishes,2)
 assert.equal((await f.files.listFiles(f.alice.token)).files.length,2)
 const output=await f.files.readFile(f.alice.token,created.fileId,created.revision),items=await readPdfLeafObjects(output),text=items.filter(o=>o.type===1).map(o=>o.text).join('|')
 assert.doesNotMatch(text,/chosen@example.com/);assert.match(text,/keep@example.com/);assert.match(text,/PUBLIC/)
 const pages=native?editor.locator('.pdf-page'):tab.locator('.workspace-document:not([hidden]) [aria-label="PDF 页面"]')
 await expect(pages).toContainText('keep@example.com',{timeout:30000})
 await expect(pages).not.toContainText('chosen@example.com')
 const wire=JSON.parse(network.wire.toString());assert.ok(!wire.tools.some(tool=>/apply.*redact|redact.*apply/.test(tool.function.name)))
 assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,source.revision)
 assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),bytes)
 if(native){
  await tab.goto(origin+'/#/file/'+source.fileId)
  await expect(editor.locator('html')).toHaveAttribute('data-document-loading','ready')
  await editor.getByRole('button',{name:'注释',exact:true}).click()
  await editor.getByRole('button',{name:'涂黑区域',exact:true}).click()
  const layer=editor.locator('.pdf-page .pdf-redaction-layer')
  await expect(layer).toBeVisible()
  const box=await layer.boundingBox()
  assert.ok(box)
  await tab.mouse.move(box.x+box.width*30/500,box.y+box.height*220/600)
  await tab.mouse.down()
  await tab.mouse.move(box.x+box.width*220/500,box.y+box.height*265/600,{steps:4})
  await tab.mouse.up()
  await expect(editor.locator('.pdf-redaction-mark')).toHaveCount(1)
  const apply=editor.getByRole('button',{name:'应用涂黑',exact:true})
  tab.once('dialog',dialog=>dialog.dismiss())
  await apply.click()
  assert.equal(stages,1);assert.equal((await f.files.listFiles(f.alice.token)).files.length,2)
  created=undefined
  await tab.route('**/api/v1/uploads/*/finish',async route=>{
   const response=await route.fetch({timeout:10000});assert.equal(response.status(),200);created=(await response.json()).file;await route.abort('failed')
  },{times:1})
  tab.once('dialog',dialog=>dialog.accept())
  await apply.click()
  const recover=editor.getByRole('button',{name:'确认保存结果',exact:true})
  await expect(recover).toBeVisible({timeout:30000})
  assert.ok(created)
  await recover.click()
  await expect(tab).toHaveURL(origin+'/#/file/'+created.fileId,{timeout:30000})
  const manualItems=await readPdfLeafObjects(await f.files.readFile(f.alice.token,created.fileId,created.revision))
  const manualText=manualItems.filter(o=>o.type===1).map(o=>o.text).join('|')
  assert.doesNotMatch(manualText,/chosen@example.com/);assert.match(manualText,/keep@example.com/);assert.match(manualText,/PUBLIC/)
  assert.equal(stages,2);assert.equal(finishes,4)
  assert.equal((await f.files.listFiles(f.alice.token)).files.length,3)
  assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),bytes)
 }
})
