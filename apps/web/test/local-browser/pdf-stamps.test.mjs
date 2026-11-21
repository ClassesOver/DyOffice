import {stubHomeHero} from '../helpers/home-hero.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {fileURLToPath} from 'node:url'
import {readPdfLeafObjects} from '../../../pdf/src/main/text-edit.ts'
import {PDFDocument,PDFName} from 'pdf-lib'
import {expect} from '@playwright/test'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {renderPdfPages} from '../../server/src/pdf/raster.mjs'

test('PDF stamp tools save, recover the same commit, replace and remove through the actual assistant',{timeout:120000},async t=>{
 let app,browser
 t.after(async()=>{await browser?.close();app?.server.closeAllConnections();await app?.close()})
 const origin='http://127.0.0.1:4238',f=await fileFixture(t,{origin,buildApp:false})
 const keyring={activeKeyId:'pdf-form',keys:{'pdf-form':new Uint8Array(32).fill(49)}}
 const calls=[['set_watermark',{text:'First draft'}],['set_header_footer',{header_left:'Project',page_number:true}],['set_watermark',{text:'Final draft'}],['set_watermark',{text:''}],['set_header_footer',{}],['set_watermark',{text:'Editable draft'}],['insert_text',{page:1,text:'Added after watermark',x:40,y:100}],['set_watermark',{text:''}],['set_watermark',{text:'Page draft'}],['set_header_footer',{page_number:true}],['insert_blank_page',{after_page:1}],['apply_ops',{ops:[{op:'deletePage',page:1}]}],['set_watermark',{text:''}],['set_header_footer',{}]]
 let turn=0
 const toolResults=[]
 const network=mockProviderNetwork(t,()=>{
  const index=Math.floor(turn/2),isTool=turn++%2===0
  if(!isTool){
   const message=JSON.parse(network.wire.toString()).messages.find(item=>item.role==='tool'&&item.tool_call_id==='form-'+index)
   if(message)toolResults[index]=JSON.parse(message.content)
  }
  const delta=isTool?{tool_calls:[{index:0,id:'form-'+index,type:'function',function:{name:calls[index][0],arguments:JSON.stringify(calls[index][1])}}]}:{content:'Form result '+index}
  return Readable.from([Buffer.from(`data: ${JSON.stringify({choices:[{delta}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:isTool?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`)])
 })
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[{id:'shared-chat',kind:'chat',providerId:'deepseek',label:'Test model',model:'synthetic-model',baseUrl:'https://provider.example/v1',enabled:true,apiKey:'synthetic-key'}],defaults:{chat:'shared-chat'}})
 const doc=await PDFDocument.create(),page=doc.addPage([400,300])
 page.drawText('Footer unchanged',{x:30,y:50,size:12})
 const bytes=Buffer.from(await doc.save()),source=(await importFile(f,f.alice.token,bytes,'stamps.pdf')).file
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false,localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 await app.listen({host:'127.0.0.1',port:4238});browser=await launchTestBrowser()
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),tab=await context.newPage()
 await stubHomeHero(tab)
 await tab.goto(origin);await tab.getByLabel('用户名',{exact:true}).fill('alice');await tab.getByLabel('密码',{exact:true}).fill(password)
 await tab.getByRole('button',{name:'登录',exact:true}).click();await expect(tab.locator('.home')).toBeVisible()
 await tab.goto(origin+'/#/file/'+source.fileId)
 await expect(tab.getByRole('region',{name:'PDF 页面',exact:true}).locator('figure')).toHaveCount(1)
 await expect(tab.locator('.workspace-document:not([hidden]) .ant-spin-spinning')).toHaveCount(0)
 const assistant=tab.locator('.shared-editor-assistant'),save=tab.getByRole('button',{name:'保存新版本',exact:true})
 let stages=0,saved
 const commits=[]
 tab.on('request',request=>{if(request.url().endsWith('/pdf/stamps/uploads'))stages++;if(request.url().endsWith('/commits'))commits.push(request.postDataJSON())})
 await tab.route('**/api/v1/files/*/commits',async route=>{
  const response=await route.fetch({timeout:10000});assert.equal(response.status(),200);saved=await response.json();await route.abort('failed')
 },{times:1})
 await assistant.getByRole('textbox',{name:'消息',exact:true}).fill('添加 First draft 水印')
 await assistant.getByRole('button',{name:'发送',exact:true}).click()
 await expect(tab.getByRole('button',{name:'确认保存结果',exact:true})).toBeVisible({timeout:30000})
 assert.ok(saved)
 await tab.getByRole('button',{name:'确认保存结果',exact:true}).click()
 await expect(tab.getByRole('button',{name:'确认保存结果',exact:true})).toHaveCount(0,{timeout:30000})
 assert.equal(stages,1);assert.equal(commits.length,2);assert.deepEqual(commits[1],commits[0])
 assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,saved.revision)
 const contents=async()=>{
  const file=(await f.files.openFile(f.alice.token,source.fileId)).file
  const bytes=await f.files.readFile(f.alice.token,source.fileId,file.revision)
  return {bytes,text:(await readPdfLeafObjects(bytes)).filter(o=>o.type===1).map(o=>o.text).join('|')}
 }
 const [originalRaster,stamped]=await Promise.all([renderPdfPages(bytes),contents()])
 assert.match(stamped.text,/First draft/)
 assert.notEqual((await renderPdfPages(stamped.bytes)).pages[0].pixels,originalRaster.pages[0].pixels)
 for(let index=1;index<5;index++){
  await assistant.getByRole('textbox',{name:'消息',exact:true}).fill(['','添加页眉和页码','换成 Final draft 水印','移除水印','移除页眉页脚'][index])
  await assistant.getByRole('button',{name:'发送',exact:true}).click()
  await expect(assistant.getByText('Form result '+index,{exact:true})).toBeVisible({timeout:30000})
  const current=await contents();assert.match(current.text,/Footer unchanged/)
  if(index===1){assert.match(current.text,/Project/);assert.match(current.text,/1 \/ 1/)}
  if(index===2){assert.match(current.text,/Final draft/);assert.doesNotMatch(current.text,/First draft/)}
  if(index===3){assert.doesNotMatch(current.text,/draft/);assert.match(current.text,/Project/)}
  if(index===4){assert.doesNotMatch(current.text,/draft|Project|1 \/ 1/);const doc=await PDFDocument.load(current.bytes);assert.equal(doc.getPage(0).node.has(PDFName.of('DyOfficeStamps')),false);assert.equal((await renderPdfPages(current.bytes)).pages[0].pixels,originalRaster.pages[0].pixels)}
 }
 for(const [index,prompt] of [[5,'添加 Editable draft 水印'],[6,'在水印后插入文字'],[7,'删除水印并保留新增文字']]){
  await assistant.getByRole('textbox',{name:'消息',exact:true}).fill(prompt)
  await assistant.getByRole('button',{name:'发送',exact:true}).click()
  await expect(assistant.getByText('Form result '+index,{exact:true})).toBeVisible({timeout:30000})
  if(index===6){
   await expect(tab.getByLabel('待保存文字覆盖层',{exact:true})).toBeVisible()
   assert.doesNotMatch((await contents()).text,/Added after watermark/)
   await save.click()
   await expect(tab.getByLabel('待保存文字覆盖层',{exact:true})).toHaveCount(0,{timeout:30000})
   // The receipt clears the overlay before the newly saved preview finishes loading.
   await expect(tab.getByText('PDF 修改已保存为新版本。',{exact:true})).toBeVisible({timeout:30000})
  }
  const current=await contents()
  assert.match(current.text,/Footer unchanged/)
  if(index===5)assert.match(current.text,/Editable draft/)
  if(index>=6)assert.match(current.text,/Added after watermark/)
  if(index===7){
   assert.ok(toolResults[index],'The watermark tool returned a result to the model')
   assert.ok(!toolResults[index].isError,toolResults[index].output)
   assert.match(toolResults[index].output,/Saved a new PDF revision/)
   assert.doesNotMatch(current.text,/Editable draft/)
  }
 }
 for(const [index,prompt] of [[8,'添加 Page draft 水印'],[9,'添加页码'],[10,'在第一页后插入空白页'],[11,'删除第一页'],[12,'移除水印'],[13,'移除页码']]){
  const before=index===11?(await f.files.openFile(f.alice.token,source.fileId)).file.revision:undefined
  await assistant.getByRole('textbox',{name:'消息',exact:true}).fill(prompt)
  await assistant.getByRole('button',{name:'发送',exact:true}).click()
  await expect(assistant.getByText('Form result '+index,{exact:true})).toBeVisible({timeout:30000})
  if(index===11){
   await expect(save).toBeEnabled()
   await expect(tab.getByRole('region',{name:'PDF 页面',exact:true}).locator('figure')).toHaveCount(1)
   assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,before)
   await save.click()
   await expect(tab.getByText('PDF 修改已保存为新版本。',{exact:true})).toBeVisible({timeout:30000})
   assert.notEqual((await f.files.openFile(f.alice.token,source.fileId)).file.revision,before)
  }
  const current=await contents()
  if(index===10){assert.equal((await PDFDocument.load(current.bytes)).getPageCount(),2);assert.ok(current.text.includes('1 / 2'));assert.ok(current.text.includes('2 / 2'));assert.equal(current.text.match(/Page draft/g)?.length,2)}
  if(index===11){assert.equal((await PDFDocument.load(current.bytes)).getPageCount(),1);assert.ok(current.text.includes('1 / 1'));assert.doesNotMatch(current.text,/Footer unchanged|Added after watermark/)}
  if(index===12)assert.doesNotMatch(current.text,/Page draft/)
  if(index===13){assert.doesNotMatch(current.text,/Page draft|1 \/ 1/);assert.equal((await PDFDocument.load(current.bytes)).getPage(0).node.has(PDFName.of('DyOfficeStamps')),false)}
 }
 assert.equal(stages,11);assert.equal(commits.length,15)
 const wire=JSON.parse(network.wire.toString()),tools=wire.tools.map(tool=>tool.function.name)
 assert.ok(tools.includes('set_watermark'));assert.ok(tools.includes('set_header_footer'))
 assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),bytes)
})
