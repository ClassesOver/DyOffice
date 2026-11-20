import {stubHomeHero} from '../helpers/home-hero.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {fileURLToPath} from 'node:url'
import {PDFDocument} from 'pdf-lib'
import {expect} from '@playwright/test'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'

test('PDF form tools recover the original committed revision and read its refreshed field values',{timeout:120000},async t=>{
 let app,browser
 t.after(async()=>{await browser?.close();app?.server.closeAllConnections();await app?.close()})
 const origin='http://127.0.0.1:4230',f=await fileFixture(t,{origin,buildApp:false})
 const keyring={activeKeyId:'pdf-form',keys:{'pdf-form':new Uint8Array(32).fill(49)}}
 const operations=[{op:'setFormValue',value:{name:'Reviewer',value:'张三'}},{op:'setFormValue',value:{name:'Approved',checked:true}},{op:'setFormValue',value:{name:'Status',value:'Done'}}]
 const calls=[['apply_ops',{ops:operations}],['list_form_fields',{}]]
 let turn=0
 const network=mockProviderNetwork(t,()=>{
  const index=Math.floor(turn/2),isTool=turn++%2===0
  const delta=isTool?{tool_calls:[{index:0,id:'form-'+index,type:'function',function:{name:calls[index][0],arguments:JSON.stringify(calls[index][1])}}]}:{content:'Form result '+index}
  return Readable.from([Buffer.from(`data: ${JSON.stringify({choices:[{delta}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:isTool?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`)])
 })
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[{id:'shared-chat',kind:'chat',providerId:'deepseek',label:'Test model',model:'synthetic-model',baseUrl:'https://provider.example/v1',enabled:true,apiKey:'synthetic-key'}],defaults:{chat:'shared-chat'}})
 const doc=await PDFDocument.create(),page=doc.addPage([400,300]),form=doc.getForm()
 page.drawText('Form body',{x:30,y:260,size:12})
 const name=form.createTextField('Reviewer');name.setText('Before');name.addToPage(page,{x:30,y:200,width:180,height:25})
 const checked=form.createCheckBox('Approved');checked.addToPage(page,{x:30,y:150,width:15,height:15})
 const state=form.createDropdown('Status');state.addOptions(['Review','Done']);state.select('Review');state.addToPage(page,{x:30,y:90,width:150,height:25})
 const bytes=Buffer.from(await doc.save()),source=(await importFile(f,f.alice.token,bytes,'fill-form.pdf')).file
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false,localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 await app.listen({host:'127.0.0.1',port:4230});browser=await launchTestBrowser()
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),tab=await context.newPage()
 await stubHomeHero(tab)
 await tab.goto(origin);await tab.getByLabel('用户名',{exact:true}).fill('alice');await tab.getByLabel('密码',{exact:true}).fill(password)
 await tab.getByRole('button',{name:'登录',exact:true}).click();await expect(tab.locator('.home')).toBeVisible()
 await tab.goto(origin+'/#/file/'+source.fileId)
 await expect(tab.getByRole('region',{name:'PDF 页面',exact:true}).locator('figure')).toHaveCount(1)
 await expect(tab.locator('.workspace-document:not([hidden]) .ant-spin-spinning')).toHaveCount(0)
 const assistant=tab.locator('.shared-editor-assistant'),save=tab.getByRole('button',{name:'保存新版本',exact:true}),confirm=tab.getByRole('button',{name:'确认保存结果',exact:true})
 let stages=0,saved
 const commits=[]
 tab.on('request',request=>{if(request.url().endsWith('/pdf/apply-ops/uploads'))stages++;if(request.url().endsWith('/commits'))commits.push(request.postDataJSON())})
 await tab.route('**/api/v1/files/*/commits',async route=>{
  const response=await route.fetch({timeout:10000});assert.equal(response.status(),200);saved=await response.json();await route.abort('failed')
 },{times:1})
 await assistant.getByRole('textbox',{name:'消息',exact:true}).fill('将姓名填为张三，勾选批准，状态改为Done')
 await assistant.getByRole('button',{name:'发送',exact:true}).click()
 await expect(assistant.getByText('Form result 0',{exact:true})).toBeVisible({timeout:30000})
 await expect(save).toBeEnabled({timeout:30000})
 assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,source.revision)
 assert.equal(stages,0);assert.equal(commits.length,0)
 await save.click()
 await expect(confirm).toBeVisible({timeout:30000})
 assert.ok(saved)
 assert.notEqual(saved.revision,source.revision)
 assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,saved.revision)
 await confirm.click()
 await expect(confirm).toHaveCount(0,{timeout:30000})
 await expect(tab.getByText('PDF 保存结果已确认。',{exact:true})).toBeVisible({timeout:30000})
 await expect(assistant.getByRole('button',{name:'发送',exact:true})).toBeDisabled()
 await assistant.getByRole('textbox',{name:'消息',exact:true}).fill('再次读取表单字段')
 await assistant.getByRole('button',{name:'发送',exact:true}).click()
 await expect(assistant.getByText('Form result 1',{exact:true})).toBeVisible({timeout:30000})
 const result=JSON.parse(JSON.parse(network.wire.toString()).messages.filter(message=>message.role==='tool').at(-1).content)
 assert.ok(!result.isError,result.output)
 assert.match(result.output,/Reviewer \(text, page 1\) current value: 张三/)
 assert.match(result.output,/Approved \(checkbox, page 1\) current value: true/)
 assert.match(result.output,/Status \(\w+, page 1\).*current value: Done/)
 assert.equal(stages,1);assert.equal(commits.length,2);assert.deepEqual(commits[1],commits[0])
 assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,saved.revision)
 const actual=(await PDFDocument.load(await f.files.readFile(f.alice.token,source.fileId,saved.revision))).getForm()
 assert.equal(actual.getTextField('Reviewer').getText(),'张三');assert.equal(actual.getCheckBox('Approved').isChecked(),true)
 assert.deepEqual(actual.getDropdown('Status').getSelected(),['Done'])
 assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),bytes)
})
