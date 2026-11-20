import {stubHomeHero} from '../helpers/home-hero.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {fileURLToPath} from 'node:url'
import {PDFDocument} from 'pdf-lib'
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs'
import {expect} from '@playwright/test'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'

test('PDF text insertion recovers the original commit and reads saved text without duplicate insertion',{timeout:120000},async t=>{
 let app,browser
 t.after(async()=>{await browser?.close();app?.server.closeAllConnections();await app?.close()})
 const origin='http://127.0.0.1:4231',f=await fileFixture(t,{origin,buildApp:false})
 const keyring={activeKeyId:'pdf-form',keys:{'pdf-form':new Uint8Array(32).fill(49)}}
 const insertion={page:1,text:'张三',anchor_text:'Name:',placement:'right',font_size:14}
 const calls=[['insert_text',insertion],['read_pages',{start:1,end:1}]]
 let turn=0
 const network=mockProviderNetwork(t,()=>{
  const index=Math.floor(turn/2),isTool=turn++%2===0
  const delta=isTool?{tool_calls:[{index:0,id:'form-'+index,type:'function',function:{name:calls[index][0],arguments:JSON.stringify(calls[index][1])}}]}:{content:'Form result '+index}
  return Readable.from([Buffer.from(`data: ${JSON.stringify({choices:[{delta}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:isTool?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`)])
 })
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[{id:'shared-chat',kind:'chat',providerId:'deepseek',label:'Test model',model:'synthetic-model',baseUrl:'https://provider.example/v1',enabled:true,apiKey:'synthetic-key'}],defaults:{chat:'shared-chat'}})
 const doc=await PDFDocument.create(),page=doc.addPage([400,300])
 page.drawText('Name:',{x:30,y:200,size:14})
 const bytes=Buffer.from(await doc.save()),source=(await importFile(f,f.alice.token,bytes,'insert-text.pdf')).file
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false,localShellDirectory:fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 await app.listen({host:'127.0.0.1',port:4231});browser=await launchTestBrowser()
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),tab=await context.newPage()
 await stubHomeHero(tab)
 await tab.goto(origin);await tab.getByLabel('用户名',{exact:true}).fill('alice');await tab.getByLabel('密码',{exact:true}).fill(password)
 await tab.getByRole('button',{name:'登录',exact:true}).click();await expect(tab.locator('.home')).toBeVisible()
 await tab.goto(origin+'/#/file/'+source.fileId)
 await expect(tab.getByRole('region',{name:'PDF 页面',exact:true}).locator('figure')).toHaveCount(1)
 await expect(tab.locator('.workspace-document:not([hidden]) .ant-spin-spinning')).toHaveCount(0)
 const assistant=tab.locator('.shared-editor-assistant')
 let stages=0,commits=0,saved
 tab.on('request',request=>{const path=new URL(request.url()).pathname;if(path.endsWith('/pdf/apply-ops/uploads'))stages++;if(path.endsWith('/commits'))commits++})
 await tab.route('**/api/v1/files/*/commits',async route=>{
  const response=await route.fetch({timeout:10000});assert.equal(response.status(),200);saved=await response.json();await route.abort('failed')
 },{times:1})
 await assistant.getByRole('textbox',{name:'消息',exact:true}).fill('在姓名旁填写张三')
 await assistant.getByRole('button',{name:'发送',exact:true}).click()
 await expect(assistant.getByText('Form result 0',{exact:true})).toBeVisible({timeout:30000})
 await expect(tab.getByLabel('待保存文字覆盖层',{exact:true})).toHaveCount(1)
 const save=tab.getByRole('button',{name:'保存新版本',exact:true})
 await expect(save).toBeEnabled()
 assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,source.revision)
 assert.equal(stages,0);assert.equal(commits,0)
 await save.click()
 await expect(tab.getByRole('button',{name:'确认保存结果',exact:true})).toBeVisible({timeout:30000})
 assert.ok(saved)
 await tab.getByRole('button',{name:'确认保存结果',exact:true}).click()
 await expect(tab.getByRole('button',{name:'确认保存结果',exact:true})).toHaveCount(0,{timeout:30000})
 await expect(assistant.getByRole('button',{name:'发送',exact:true})).toBeDisabled()
 await assistant.getByRole('textbox',{name:'消息',exact:true}).fill('重新读取第一页')
 await assistant.getByRole('button',{name:'发送',exact:true}).click()
 await expect(assistant.getByText('Form result 1',{exact:true})).toBeVisible({timeout:30000})
 const result=JSON.parse(network.wire.toString()).messages.filter(message=>message.role==='tool').at(-1)
 assert.match(result.content,/张三/)
 assert.equal(stages,1);assert.equal(commits,2)
 assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,saved.revision)
 const task=getDocument({data:Uint8Array.from(await f.files.readFile(f.alice.token,source.fileId,saved.revision)),disableFontFace:true,useSystemFonts:true})
 try{const content=await (await (await task.promise).getPage(1)).getTextContent();assert.equal(content.items.map(item=>item.str??'').join(' ').split('张三').length-1,1)}finally{await task.destroy()}
 assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),bytes)
})
