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

for(const operation of ['extract','split','grid','merge'])test(`browser PDF ${operation} tool recovers a lost creation response without preparing twice`,{timeout:120000},async t=>{
 let app,browser
 t.after(async()=>{await browser?.close();app?.server.closeAllConnections();await app?.close()})
 const origin='http://127.0.0.1:4228',f=await fileFixture(t,{origin,buildApp:false})
 const keyring={activeKeyId:'pdf-browser',keys:{'pdf-browser':new Uint8Array(32).fill(43)}}
 const endpoint=operation==='extract'?'/pdf/extract-pages/uploads':operation==='split'?'/pdf/split/uploads':'/pdf/page-layout/uploads'
 const tool={extract:['extract_pages',{pages:'2'}],split:['split_pdf',{pages_per_file:1}],grid:['split_pages',{per_page:2}],merge:['merge_pages',{per_sheet:2}]}[operation]
 let turns=0
 mockProviderNetwork(t,()=>{
  const delta=turns++===0?{tool_calls:[{index:0,id:'extract-one',type:'function',function:{name:tool[0],arguments:JSON.stringify(tool[1])}}]}:{content:'请核对页面中的保存结果。'}
  return Readable.from([Buffer.from(`data: ${JSON.stringify({choices:[{delta}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:turns===1?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`)])
 })
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[{id:'shared-chat',kind:'chat',providerId:'deepseek',label:'Test model',model:'synthetic-model',baseUrl:'https://provider.example/v1',enabled:true,apiKey:'synthetic-key'}],defaults:{chat:'shared-chat'}})
 const doc=await PDFDocument.create()
 for(const text of ['Source first page','Selected second page'])doc.addPage([300,200]).drawText(text,{x:20,y:100,size:12})
 const original=Buffer.from(await doc.save()),source=(await importFile(f,f.alice.token,original,'browser-source.pdf')).file
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false,localShellDirectory:fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 await app.listen({host:'127.0.0.1',port:4228})
 browser=await launchTestBrowser()
 const page=await browser.newPage({viewport:{width:1440,height:1000}})
 await stubHomeHero(page)
 await page.goto(origin)
 await page.getByLabel('用户名',{exact:true}).fill('alice');await page.getByLabel('密码',{exact:true}).fill(password)
 await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('.home')).toBeVisible()
 await page.goto(origin+'/#/file/'+source.fileId)
 const assistant=page.locator('.shared-editor-assistant')
 await expect(assistant.getByRole('textbox',{name:'消息',exact:true})).toBeVisible({timeout:30000})
 await expect(page.getByRole('region',{name:'PDF 页面',exact:true}).locator('figure')).toHaveCount(2)
 let preparations=0,finishes=0,created
 page.on('response',response=>{if(/\/(lease|uploads|finish)$/.test(response.url()))t.diagnostic(new URL(response.url()).pathname+': '+response.status())})
 page.on('request',request=>{if(request.url().endsWith(endpoint))preparations++;if(request.url().endsWith('/finish'))finishes++})
 await page.route('**/api/v1/uploads/*/finish',async route=>{
  const response=await route.fetch({timeout:10000});assert.equal(response.status(),200);created=(await response.json()).file
  await route.abort('failed')
 },{times:1})
 const stagedResponse=page.waitForResponse(response=>response.url().endsWith(endpoint))
 void stagedResponse.catch(()=>{})
 await assistant.getByRole('textbox',{name:'消息',exact:true}).fill(operation==='extract'?'提取第二页到新 PDF':'每页拆成一个 PDF')
 await assistant.getByRole('button',{name:'发送',exact:true}).click()
 try{await expect(page.getByRole('button',{name:'确认保存结果',exact:true})).toBeVisible({timeout:30000})}catch(error){t.diagnostic(JSON.stringify({turns,preparations,finishes,assistant:await assistant.innerText()}));throw error}
 const stage=await (await stagedResponse).json()
 const lastId=operation==='split'?stage.files.at(-1).fileId:stage.fileId
 assert.ok(created)
 assert.equal((await f.files.listFiles(f.alice.token)).files.length,2)
 await page.getByRole('button',{name:'确认保存结果',exact:true}).click()
 await expect(page).toHaveURL(origin+'/#/file/'+lastId,{timeout:30000})
 assert.equal(preparations,1);assert.equal(finishes,operation==='split'?3:2)
 assert.equal((await f.files.listFiles(f.alice.token)).files.length,operation==='split'?3:2)
 const last=(await f.files.openFile(f.alice.token,lastId)).file
 const task=getDocument({data:Uint8Array.from(await f.files.readFile(f.alice.token,last.fileId,last.revision)),disableFontFace:true,useSystemFonts:true})
 try{
  const pdf=await task.promise;assert.equal(pdf.numPages,operation==='grid'?4:1)
  const text=(await (await pdf.getPage(1)).getTextContent()).items.map(item=>item.str??'').join(' ')
  if(operation==='grid')assert.match(text,/Source first page/)
  else if(operation==='merge'){assert.match(text,/Source first page/);assert.match(text,/Selected second page/)}
  else assert.equal(text,'Selected second page')
 }finally{await task.destroy()}
 assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,source.revision)
 assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),original)
})
