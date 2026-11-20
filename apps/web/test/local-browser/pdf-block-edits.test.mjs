import {stubHomeHero} from '../helpers/home-hero.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {fileURLToPath} from 'node:url'
import {readFile} from 'node:fs/promises'
import {PDFDocument} from 'pdf-lib'
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs'
import {expect} from '@playwright/test'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'

const liveConfig=process.env.DYOFFICE_LIVE_PDF_BLOCK_CONFIG
test('PDF paragraph rewrite recovers a lost commit and reads replacement content'+(liveConfig?' with a real model':''),{timeout:180000},async t=>{
 let app,browser
 t.after(async()=>{await browser?.close();app?.server.closeAllConnections();await app?.close()})
 const origin='http://127.0.0.1:4232',f=await fileFixture(t,{origin,buildApp:false})
 const keyring={activeKeyId:'pdf-form',keys:{'pdf-form':new Uint8Array(32).fill(49)}}
 const insertion={page:1,paragraph_text:'Original project',new_text:'项目进展顺利，下一步准备验收。',font_size:14,align:'left'}
 const calls=[['edit_block',insertion],['read_pages',{start:1,end:1}]]
 let turn=0
 const network=liveConfig?undefined:mockProviderNetwork(t,()=>{
  const index=Math.floor(turn/2),isTool=turn++%2===0
  const delta=isTool?{tool_calls:[{index:0,id:'form-'+index,type:'function',function:{name:calls[index][0],arguments:JSON.stringify(calls[index][1])}}]}:{content:'Form result '+index}
  return Readable.from([Buffer.from(`data: ${JSON.stringify({choices:[{delta}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:isTool?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`)])
 })
 const entry=liveConfig?JSON.parse(await readFile(liveConfig,'utf8')).entry:{id:'shared-chat',kind:'chat',providerId:'deepseek',label:'Test model',model:'synthetic-model',baseUrl:'https://provider.example/v1',enabled:true,apiKey:'synthetic-key'}
 assert.ok(entry?.enabled&&entry?.apiKey&&entry?.kind==='chat','Enabled test model configuration required')
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[entry],defaults:{chat:entry.id}})
 const doc=await PDFDocument.create(),page=doc.addPage([400,300])
 page.drawText('Original project summary to replace.',{x:30,y:200,size:14})
 page.drawText('Footer unchanged',{x:30,y:50,size:12})
 const bytes=Buffer.from(await doc.save()),source=(await importFile(f,f.alice.token,bytes,'edit-block.pdf')).file
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false,localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 await app.listen({host:'127.0.0.1',port:4232});browser=await launchTestBrowser()
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),tab=await context.newPage()
 await stubHomeHero(tab)
 await tab.goto(origin);await tab.getByLabel('用户名',{exact:true}).fill('alice');await tab.getByLabel('密码',{exact:true}).fill(password)
 await tab.getByRole('button',{name:'登录',exact:true}).click();await expect(tab.locator('.home')).toBeVisible()
 await tab.goto(origin+'/#/file/'+source.fileId)
 await expect(tab.getByRole('region',{name:'PDF 页面',exact:true}).locator('figure')).toHaveCount(1)
 await expect(tab.locator('.workspace-document:not([hidden]) .ant-spin-spinning')).toHaveCount(0)
 const assistant=tab.locator('.shared-editor-assistant')
 let stages=0,commits=0,saved
 tab.on('request',request=>{if(request.url().endsWith('/pdf/block-edits/uploads'))stages++;if(request.url().endsWith('/commits'))commits++})
 await tab.route('**/api/v1/files/*/commits',async route=>{
  const response=await route.fetch({timeout:10000});assert.equal(response.status(),200);saved=await response.json();await route.abort('failed')
 },{times:1})
 await assistant.getByRole('textbox',{name:'消息',exact:true}).fill('先读取 PDF 第 1 页，再用 edit_block 改写以 Original project 开头的整段原文，新文本逐字写为「项目进展顺利，下一步准备验收。」，只执行一次改写，保留 Footer unchanged。')
 await assistant.getByRole('button',{name:'发送',exact:true}).click()
 await expect(tab.getByRole('button',{name:'确认保存结果',exact:true})).toBeVisible({timeout:liveConfig?90000:30000})
 assert.ok(saved)
 await tab.getByRole('button',{name:'确认保存结果',exact:true}).click()
 await expect(tab.getByRole('button',{name:'确认保存结果',exact:true})).toHaveCount(0,{timeout:30000})
 await expect(assistant.getByRole('button',{name:'发送',exact:true})).toBeDisabled({timeout:30000})
 await assistant.getByRole('textbox',{name:'消息',exact:true}).fill('调用 read_pages 重新读取第一页，仅在回复中逐字引用新段落和页脚。')
 await assistant.getByRole('button',{name:'发送',exact:true}).click()
 if(network){
  await expect(assistant.getByText('Form result 1',{exact:true})).toBeVisible({timeout:30000})
  const result=JSON.parse(network.wire.toString()).messages.filter(message=>message.role==='tool').at(-1)
  assert.match(result.content,/项目进展顺利/);assert.doesNotMatch(result.content,/Original project/);assert.match(result.content,/Footer unchanged/)
 }else{
  await expect(assistant.getByRole('button',{name:'发送',exact:true})).toBeDisabled({timeout:60000})
  await expect(assistant.getByText('Footer unchanged',{exact:false}).last()).toContainText('Footer unchanged')
  const reply=await assistant.getByText('项目进展顺利，下一步准备验收。',{exact:false}).last().innerText()
  assert.doesNotMatch(reply,/Original project/)
 }
 assert.equal(stages,1);assert.equal(commits,2)
 assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,saved.revision)
 const task=getDocument({data:Uint8Array.from(await f.files.readFile(f.alice.token,source.fileId,saved.revision)),disableFontFace:true,useSystemFonts:true})
 try{const content=await (await (await task.promise).getPage(1)).getTextContent();const text=content.items.map(item=>item.str??'').join(' ');assert.match(text,/项目进展顺利/);assert.doesNotMatch(text,/Original project/);assert.match(text,/Footer unchanged/)}finally{await task.destroy()}
 assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),bytes)
 await tab.reload()
 const region=tab.getByRole('region',{name:'PDF 页面',exact:true})
 await expect(region).toContainText('项目进展顺利',{timeout:30000})
 await expect(region).toContainText('Footer unchanged')
 await expect(region).not.toContainText('Original project')
})
