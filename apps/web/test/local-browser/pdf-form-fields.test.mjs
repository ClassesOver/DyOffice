import test from 'node:test'
import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {mkdir,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {PDFDocument} from 'pdf-lib'
import {expect} from '@playwright/test'
import {stubHomeHero} from '../helpers/home-hero.mjs'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'

const field=(name,kind,y,extra={})=>({op:'addFormField',field:{name,kind,page:1,x:40,y,width:180,height:24,...extra}})
test('PDF chat creates fillable fields and extends a radio group, fills saved values and reopens actual widgets',{timeout:180000},async t=>{
 let app,browser,turn=0
 t.after(async()=>{await browser?.close();app?.server.closeAllConnections();await app?.close()})
 const origin='http://127.0.0.1:4243',f=await fileFixture(t,{origin,buildApp:false}),keyring={activeKeyId:'fields',keys:{fields:new Uint8Array(32).fill(65)}}
 const calls=[['apply_ops',{ops:[field('Reviewer','text',100,{value:'张三',required:true,maxLen:20}),field('Consent','checkbox',145,{width:20,height:20,checked:true}),field('Status','choice',195,{options:['待审核','完成'],value:'待审核'}),field('Decision','radio',255,{width:20,height:20,exportValue:'Maybe',checked:true})]}],['list_form_fields',{}],['apply_ops',{ops:[{op:'setFormValue',value:{name:'Reviewer',value:'李四'}},{op:'setFormValue',value:{name:'Consent',checked:false}},{op:'setFormValue',value:{name:'Status',value:'完成'}},{op:'setFormValue',value:{name:'Decision',value:'No'}}]}],['apply_ops',{ops:[field('Locked','text',350,{value:'Overwrite'})]}]]
 const network=mockProviderNetwork(t,()=>{const index=Math.floor(turn/2),tool=turn++%2===0,[name,input]=calls[index],delta=tool?{tool_calls:[{index:0,id:'fields-'+index,type:'function',function:{name,arguments:JSON.stringify(input)}}]}:{content:'Fields result '+index};return Readable.from([Buffer.from(`data: ${JSON.stringify({choices:[{delta}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:tool?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`)])})
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[{id:'shared-chat',kind:'chat',providerId:'deepseek',label:'Test model',model:'synthetic-model',baseUrl:'https://provider.example/v1',enabled:true,apiKey:'synthetic-key'}],defaults:{chat:'shared-chat'}})
 const d=await PDFDocument.create(),p=d.addPage([500,650]);p.drawText('Original form',{x:30,y:610,size:14});const form=d.getForm(),locked=form.createTextField('Locked');locked.setText('Original');locked.enableReadOnly();locked.addToPage(p,{x:30,y:50,width:200,height:24});const radio=form.createRadioGroup('Decision');radio.addOptionToPage('No',p,{x:40,y:330,width:20,height:20});radio.select('No')
 const original=Buffer.from(await d.save()),source=(await importFile(f,f.alice.token,original,'fields.pdf')).file
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false,localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 await app.listen({host:'127.0.0.1',port:4243});browser=await launchTestBrowser();const tab=await browser.newPage({viewport:{width:1600,height:1100}});await stubHomeHero(tab);const errors=[];tab.on('pageerror',error=>errors.push(error.message))
 await tab.goto(origin);await tab.getByLabel('用户名',{exact:true}).fill('alice');await tab.getByLabel('密码',{exact:true}).fill(password);await tab.getByRole('button',{name:'登录',exact:true}).click();await expect(tab.locator('.home')).toBeVisible();await tab.goto(origin+'/#/file/'+source.fileId)
 await expect(tab.getByRole('region',{name:'PDF 页面',exact:true}).locator('figure')).toHaveCount(1);await expect(tab.locator('.workspace-document:not([hidden]) .ant-spin-spinning')).toHaveCount(0)
 let commits=0;tab.on('request',request=>{if(new URL(request.url()).pathname.endsWith('/commits'))commits++})
 const assistant=tab.locator('.shared-editor-assistant'),send=async(index,failed=false)=>{
  await assistant.getByRole('textbox',{name:'消息',exact:true}).fill('Run fields step '+index);await assistant.getByRole('button',{name:'发送',exact:true}).click();await expect(assistant.getByText('Fields result '+index,{exact:true})).toBeVisible({timeout:30000})
  const result=JSON.parse(JSON.parse(network.wire.toString()).messages.filter(message=>message.role==='tool').at(-1).content);assert.equal(!!result.isError,failed,result.output);await expect(tab.locator('.workspace-document:not([hidden]) .ant-spin-spinning')).toHaveCount(0);return result
 }
 const save=async()=>{const button=tab.getByRole('button',{name:'保存新版本',exact:true});await expect(button).toBeEnabled({timeout:30000});await button.click();await expect(tab.getByText('PDF 修改已保存为新版本。',{exact:true})).toBeVisible({timeout:30000})}
 await send(0);assert.equal(commits,0);await save();assert.equal(commits,1);const created=(await f.files.openFile(f.alice.token,source.fileId)).file,createdBytes=await f.files.readFile(f.alice.token,source.fileId,created.revision),createdForm=(await PDFDocument.load(createdBytes)).getForm()
 assert.equal(createdForm.getTextField('Reviewer').getText(),'张三');assert.equal(createdForm.getRadioGroup('Decision').getSelected(),'Maybe');assert.equal(createdForm.getTextField('Locked').getText(),'Original')
 const listed=await send(1);for(const name of ['Reviewer','Consent','Status','Decision','Locked'])assert.ok(listed.output.includes(name),listed.output)
 await send(2);assert.equal(commits,1);await save();assert.equal(commits,2);const saved=(await f.files.openFile(f.alice.token,source.fileId)).file,bytes=await f.files.readFile(f.alice.token,source.fileId,saved.revision),savedForm=(await PDFDocument.load(bytes)).getForm()
 assert.equal(savedForm.getTextField('Reviewer').getText(),'李四');assert.equal(savedForm.getCheckBox('Consent').isChecked(),false);assert.deepEqual(savedForm.getDropdown('Status').getSelected(),['完成']);assert.equal(savedForm.getRadioGroup('Decision').getSelected(),'No');assert.equal(savedForm.getTextField('Locked').isReadOnly(),true);assert.equal(savedForm.getTextField('Locked').getText(),'Original')
 await send(3,true);assert.equal(commits,2);assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,saved.revision)
 assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),original);assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,created.revision),createdBytes)
 await tab.reload();await expect(tab.getByRole('region',{name:'PDF 页面',exact:true})).toContainText('Original form',{timeout:30000});assert.deepEqual(errors,[])
 const review='/tmp/dyoffice-pdf-fields-review';await mkdir(review,{recursive:true});await writeFile(review+'/saved.pdf',bytes);await tab.screenshot({path:review+'/saved.png',fullPage:true})
})
