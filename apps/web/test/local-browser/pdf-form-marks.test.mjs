import test from 'node:test'
import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {mkdir,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {PDFDocument,rgb} from 'pdf-lib'
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

test('assistant checks interactive fields and queues fitted printed form marks, then saves and reopens',{timeout:180000},async t=>{
 let app,browser,tab,turn=0
 const review=join(tmpdir(),'dyoffice-pdf-form-marks-review');await mkdir(review,{recursive:true})
 t.after(async()=>{if(tab)await tab.screenshot({path:review+'/latest.png',fullPage:true}).catch(()=>{});await browser?.close();app?.server.closeAllConnections();await app?.close()})
 const port=4284,origin=`http://127.0.0.1:${port}`,f=await fileFixture(t,{origin,buildApp:false}),keyring={activeKeyId:'affine',keys:{affine:new Uint8Array(32).fill(63)}}
 const calls=[['add_form_mark',{page:1,kind:'check',x:106,y:206}],['add_form_mark',{page:1,kind:'cross',anchor_text:'Consent',placement:'left'}],['add_form_mark',{page:1,kind:'check',anchor_text:'Consent',placement:'left'}],['add_form_mark',{page:1,kind:'cross',x:10,y:50}],['insert_text',{page:1,text:'Form browser saved',x:180,y:300,font_size:16}],['add_form_mark',{page:1,kind:'check',x:352,y:186}]]
 const network=mockProviderNetwork(t,()=>{const index=Math.floor(turn/2),tool=turn++%2===0,[name,input]=calls[index],delta=tool?{tool_calls:[{index:0,id:'form-'+index,type:'function',function:{name,arguments:JSON.stringify(input)}}]}:{content:'Form result '+index};return Readable.from([Buffer.from(`data: ${JSON.stringify({choices:[{delta}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:tool?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`)])})
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[{id:'shared-chat',kind:'chat',providerId:'deepseek',label:'Test model',model:'synthetic-model',baseUrl:'https://provider.example/v1',enabled:true,apiKey:'synthetic-key'}],defaults:{chat:'shared-chat'}})
 const d=await PDFDocument.create(),page=d.addPage([500,600]);page.drawRectangle({x:98,y:398,width:16,height:16,borderWidth:1,borderColor:rgb(0,0,0)});page.drawText('Consent',{x:118,y:400,size:12})
 const field=d.getForm().createCheckBox('Approved');field.addToPage(page,{x:300,y:400,width:16,height:16});const locked=d.getForm().createCheckBox('Locked');locked.addToPage(page,{x:350,y:400,width:16,height:16});locked.enableReadOnly()
 // First mark targets an interactive checkbox; static mark coordinates remain separate.
 calls[0][1]={page:1,kind:'cross',x:302,y:186}
 const original=Buffer.from(await d.save()),source=(await importFile(f,f.alice.token,original,'form-marks.pdf')).file
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false,localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 await app.listen({host:'127.0.0.1',port});browser=await launchTestBrowser();tab=await browser.newPage({viewport:{width:1600,height:1100}});await stubHomeHero(tab)
 const errors=[];tab.on('pageerror',error=>errors.push(error.message))
 await tab.goto(origin);await tab.getByLabel('用户名',{exact:true}).fill('alice');await tab.getByLabel('密码',{exact:true}).fill(password);await tab.getByRole('button',{name:'登录',exact:true}).click();await expect(tab.locator('.home')).toBeVisible();await tab.goto(origin+'/#/file/'+source.fileId)
 await expect(tab.getByRole('region',{name:'PDF 页面',exact:true}).locator('figure')).toHaveCount(1);await expect(tab.locator('.workspace-document:not([hidden]) .ant-spin-spinning')).toHaveCount(0)
 let stages=0,commits=0
 tab.on('request',request=>{const path=new URL(request.url()).pathname;if(path.endsWith('/apply-ops/uploads'))stages++;if(path.endsWith('/commits'))commits++})
 const assistant=tab.locator('.shared-editor-assistant'),region=tab.getByRole('region',{name:'待保存图片编辑',exact:true}),save=tab.getByRole('button',{name:'保存新版本',exact:true})
 const overlay=tab.getByLabel('待保存图片覆盖层',{exact:true})
 const send=async(index,editing=true,expectedError=false)=>{await assistant.getByRole('textbox',{name:'消息',exact:true}).fill('Run form step '+index);await assistant.getByRole('button',{name:'发送',exact:true}).click();await expect(assistant.getByText('Form result '+index,{exact:true})).toBeVisible({timeout:30000});await expect(tab.getByRole('status').filter({hasText:'正在生成图片与文字的页面预览'})).toHaveCount(0);const result=JSON.parse(JSON.parse(network.wire.toString()).messages.filter(message=>message.role==='tool').at(-1).content);if(expectedError){assert.equal(result.isError,true);assert.match(result.output,/read-only/i)}else assert.ok(!result.isError,result.output);if(editing)await expect(save).toBeEnabled();return result}
 const unchanged=async revision=>{assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,revision)}
 assert.match((await send(0)).output,/unsaved check.*Approved/);await expect(region).toHaveCount(0);await unchanged(source.revision);assert.equal(stages,0);assert.equal(commits,0)
 await send(1);await expect(region).toBeVisible();await expect(overlay).toHaveCount(1);await unchanged(source.revision)
 await tab.getByRole('button',{name:'撤销修改',exact:true}).click();await expect(region).toHaveCount(0);await expect(overlay).toHaveCount(0);await expect(save).toBeEnabled()
 await send(2);await send(3);await send(4);await unchanged(source.revision);assert.equal(stages,0);assert.equal(commits,0);await tab.screenshot({path:review+'/pending.png',fullPage:true})
 const receipt=tab.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/commits')&&response.request().method()==='POST')
 await save.click();const response=await receipt;assert.equal(response.status(),200);const committed=await response.json()
 await expect(tab.getByText('PDF 修改已保存为新版本。',{exact:true})).toBeVisible({timeout:30000});await expect(region).toHaveCount(0);assert.equal(stages,1);assert.equal(commits,1)
 const saved=(await f.files.openFile(f.alice.token,source.fileId)).file,output=await f.files.readFile(f.alice.token,source.fileId,saved.revision),entries=(await catalog(output)).entries,objects=await readPdfLeafObjects(output)
 assert.notEqual(saved.revision,source.revision);assert.equal(saved.revision,committed.revision)
 assert.equal(entries.length,2);assert.ok(entries.some(e=>Math.abs(e.image.x-98)<.1&&Math.abs(e.image.y-186)<.1&&Math.abs(e.image.width-16)<.1&&Math.abs(e.image.height-16)<.1),JSON.stringify(entries))
 assert.ok(entries.some(e=>Math.abs(e.image.x-10)<.1&&Math.abs(e.image.y-50)<.1));assert.ok(objects.some(o=>o.text==='Consent'));assert.ok(objects.some(o=>o.text==='Form browser saved'))
 const finalDoc=await PDFDocument.load(output);assert.equal(finalDoc.getForm().getCheckBox('Approved').isChecked(),true);assert.equal(finalDoc.getForm().getCheckBox('Locked').isChecked(),false)
 assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),original)
 await expect(tab.locator('.workspace-document:not([hidden]) .ant-spin-spinning')).toHaveCount(0);await send(5,false,true);await expect(save).toBeDisabled();await unchanged(saved.revision);assert.equal(stages,1);assert.equal(commits,1)
 await writeFile(review+'/saved.pdf',output);await writeFile(review+'/geometry.json',JSON.stringify({images:entries.map(e=>e.image),stages,commits},null,2));await tab.reload();await expect(tab.getByRole('region',{name:'PDF 页面',exact:true})).toContainText('Form browser saved',{timeout:30000});await expect(region).toHaveCount(0);await tab.screenshot({path:review+'/saved.png',fullPage:true});assert.deepEqual(errors,[])
})
