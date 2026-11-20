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

test('PDF replacement requires user file choice and confirmation, recovers one commit and reopens the saved page order',{timeout:120000},async t=>{
 let app,browser
 t.after(async()=>{await browser?.close();app?.server.closeAllConnections();await app?.close()})
 const origin='http://127.0.0.1:4287',f=await fileFixture(t,{origin,buildApp:false})
 const keyring={activeKeyId:'pdf-form',keys:{'pdf-form':new Uint8Array(32).fill(49)}}
 const nativePdfDirectory=process.env.DYOFFICE_TEST_NATIVE_PDF_DIST
 const pageInput=nativePdfDirectory?'1,3':[1,3]
 const calls=[['replace_pages',{pages:pageInput}],['replace_pages',{pages:pageInput}],['read_document',{}]]
 let turn=0
 const network=mockProviderNetwork(t,()=>{
  const index=Math.floor(turn/2),isTool=turn++%2===0
  const delta=isTool?{tool_calls:[{index:0,id:'form-'+index,type:'function',function:{name:calls[index][0],arguments:JSON.stringify(calls[index][1])}}]}:{content:'Form result '+index}
  return Readable.from([Buffer.from(`data: ${JSON.stringify({choices:[{delta}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:isTool?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`)])
 })
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[{id:'shared-chat',kind:'chat',providerId:'deepseek',label:'Test model',model:'synthetic-model',baseUrl:'https://provider.example/v1',enabled:true,apiKey:'synthetic-key'}],defaults:{chat:'shared-chat'}})
 const doc=await PDFDocument.create()
 for(let i=1;i<=4;i++)doc.addPage([400,400]).drawText('Target '+i,{x:30,y:200,size:14})
 const other=await PDFDocument.create();for(let i=1;i<=2;i++)other.addPage([450,500]).drawText('Source '+i,{x:40,y:250,size:14})
 const selected=Buffer.from(await other.save()),bytes=Buffer.from(await doc.save()),source=(await importFile(f,f.alice.token,bytes,'target.pdf')).file
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false,nativePdfDirectory,localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 await app.listen({host:'127.0.0.1',port:4287});browser=await launchTestBrowser()
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),tab=await context.newPage()
 await stubHomeHero(tab)
 await tab.goto(origin);await tab.getByLabel('用户名',{exact:true}).fill('alice');await tab.getByLabel('密码',{exact:true}).fill(password)
 await tab.getByRole('button',{name:'登录',exact:true}).click();await expect(tab.locator('.home')).toBeVisible()
 await tab.goto(origin+'/#/file/'+source.fileId)
 const surface=nativePdfDirectory?tab.frameLocator(`iframe[data-document-id="${source.fileId}"]`):tab
 const pages=nativePdfDirectory?surface.locator('.pdf-thumb'):tab.getByRole('region',{name:'PDF 页面',exact:true}).locator('figure')
 await expect(pages).toHaveCount(4)
 if(nativePdfDirectory)await surface.getByRole('button',{name:'AI 助手',exact:true}).click()
 else await expect(tab.locator('.workspace-document:not([hidden]) .ant-spin-spinning')).toHaveCount(0)
 const assistant=surface.locator('.shared-editor-assistant')
 let stages=0,saved
 const commits=[]
 tab.on('request',request=>{if(request.url().includes('/pdf/replace-pages/uploads?'))stages++;if(request.url().endsWith('/commits'))commits.push(request.postDataJSON())})
 const send=async text=>{await assistant.getByRole('textbox',{name:'消息',exact:true}).fill(text);await assistant.getByRole('button',{name:'发送',exact:true}).click()}
 const offered=tab.waitForRequest(req=>req.method()==='POST'&&new URL(req.url()).pathname==='/api/v1/ai/turns')
 await send('用另一个 PDF 替换第1和第3页')
 assert.ok((await offered).postDataJSON().request.tools.some(tool=>tool.name==='replace_pages'),'replace_pages must be offered')
 const selection=nativePdfDirectory?surface.getByRole('dialog',{name:'替换第 1、3 页',exact:true}):surface.getByRole('region',{name:'替换 PDF 页面',exact:true})
 const confirm=selection.getByRole('button',{name:'确认替换并保存',exact:true})
 await expect(selection).toBeVisible({timeout:30000});await expect(confirm).toBeDisabled()
 assert.equal(stages,0);assert.equal(commits.length,0)
 await selection.getByRole('button',{name:nativePdfDirectory?'取消':'取消替换',exact:true}).click();await expect(assistant.getByText('Form result 0',{exact:true})).toBeVisible({timeout:30000})
 assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,source.revision)
 await send('重试替换第1和第3页')
 await expect(selection).toBeVisible({timeout:30000})
 await selection.getByLabel(nativePdfDirectory?'选择来源 PDF':'选择替换来源 PDF',{exact:true}).setInputFiles({name:'replacement.pdf',mimeType:'application/pdf',buffer:selected})
 await expect(confirm).toBeEnabled()
 if(!nativePdfDirectory)await expect(selection.getByText('replacement.pdf',{exact:false})).toBeVisible()
 assert.equal(stages,0);assert.equal(commits.length,0)
 assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,source.revision)
 await tab.route('**/api/v1/files/*/commits',async route=>{
  const request=route.request()
  try{
   const response=await app.inject({method:'POST',url:new URL(request.url()).pathname,headers:await request.allHeaders(),payload:request.postData()})
   assert.equal(response.statusCode,200);saved=response.json()
  }finally{await route.abort('failed')}
 },{times:1})
 await confirm.click()
 if(nativePdfDirectory)await expect(assistant.getByText('Form result 1',{exact:true})).toBeVisible({timeout:30000})
 else{
  await expect(tab.getByRole('button',{name:'确认保存结果',exact:true})).toBeVisible({timeout:30000})
  await tab.getByRole('button',{name:'确认保存结果',exact:true}).click()
  await expect(tab.getByRole('button',{name:'确认保存结果',exact:true})).toHaveCount(0,{timeout:30000})
 }
 assert.ok(saved)
 assert.equal(stages,1);assert.equal(commits.length,2);assert.deepEqual(commits[1],commits[0])
 assert.notEqual(saved.revision,source.revision)
 assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,saved.revision)
 const output=await f.files.readFile(f.alice.token,source.fileId,saved.revision),items=await readPdfLeafObjects(output)
 for(const [index,expected]of ['Source 1','Source 2','Target 2','Target 4'].entries())assert.ok(items.some(item=>item.page===index&&item.text?.includes(expected)))
 assert.ok(!items.some(item=>/Target [13]/.test(item.text??'')))
 assert.equal((await PDFDocument.load(output)).getPageCount(),4)
 await tab.reload();await expect(pages).toHaveCount(4,{timeout:30000})
 if(nativePdfDirectory)await expect(surface.getByText('Source 1',{exact:true}).first()).toBeAttached()
 else await expect(tab.getByRole('region',{name:'PDF 页面',exact:true})).toContainText('Source 1')
 const wire=JSON.parse(network.wire.toString());assert.ok(wire.tools.some(tool=>tool.function.name==='replace_pages'))
 assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),bytes)
})
