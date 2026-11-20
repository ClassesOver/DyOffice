import {stubHomeHero} from '../helpers/home-hero.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {mkdir} from 'node:fs/promises'
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

test('PDF assistant reads real form fields and sensitive matches without changing its saved document',{timeout:120000},async t=>{
 let app,browser
 t.after(async()=>{await browser?.close();app?.server.closeAllConnections();await app?.close()})
 const origin='http://127.0.0.1:4229',f=await fileFixture(t,{origin,buildApp:false})
 const keyring={activeKeyId:'pdf-read',keys:{'pdf-read':new Uint8Array(32).fill(47)}}
 const calls=[['list_form_fields',{}],['find_sensitive_info',{patterns:['email'],mark:false}],['find_sensitive_info',{patterns:['email'],mark:true}],['create_document',{type:'pdf',title:'Created report',content:'<h1>Report</h1><p>Created from PDF fields.</p>'}]]
 let turn=0
 const network=mockProviderNetwork(t,()=>{
  const index=Math.floor(turn/2),isTool=turn++%2===0
  const delta=isTool?{tool_calls:[{index:0,id:'read-'+index,type:'function',function:{name:calls[index][0],arguments:JSON.stringify(calls[index][1])}}]}:{content:'Read result '+index}
  return Readable.from([Buffer.from(`data: ${JSON.stringify({choices:[{delta}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:isTool?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`)])
 })
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[{id:'shared-chat',kind:'chat',providerId:'deepseek',label:'Test model',model:'synthetic-model',baseUrl:'https://provider.example/v1',enabled:true,apiKey:'synthetic-key'}],defaults:{chat:'shared-chat'}})
 const doc=await PDFDocument.create(),first=doc.addPage([400,300]),second=doc.addPage([400,300]),form=doc.getForm()
 first.drawText('Form page',{x:30,y:260,size:12});second.drawText('Contact review@example.org',{x:30,y:260,size:12})
 const name=form.createTextField('Reviewer');name.setText('Alice');name.addToPage(first,{x:30,y:180,width:180,height:25})
 const checked=form.createCheckBox('Approved');checked.addToPage(first,{x:30,y:140,width:15,height:15});checked.check()
 const state=form.createDropdown('Status');state.addOptions(['Review','Done']);state.select('Done');state.addToPage(second,{x:30,y:180,width:150,height:25})
 const bytes=Buffer.from(await doc.save()),source=(await importFile(f,f.alice.token,bytes,'read-fields.pdf')).file
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false,localShellDirectory:fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 await app.listen({host:'127.0.0.1',port:4229});browser=await launchTestBrowser()
 const page=await browser.newPage({viewport:{width:1440,height:1000}})
 await stubHomeHero(page)
 await page.goto(origin);await page.getByLabel('用户名',{exact:true}).fill('alice');await page.getByLabel('密码',{exact:true}).fill(password)
 await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('.home')).toBeVisible()
 await page.goto(origin+'/#/file/'+source.fileId)
 await expect(page.getByRole('region',{name:'PDF 页面',exact:true}).locator('figure')).toHaveCount(2)
 const assistant=page.locator('.shared-editor-assistant').first(),writes=[],markQueries=[]
 page.on('request',request=>{if(request.method()==='POST'&&/\/(lease|uploads|commits|finish)$/.test(request.url()))writes.push(request.url())})
 page.on('response',response=>{if(new URL(response.url()).pathname===`/api/v1/files/${source.fileId}/pdf/redactions/query`)markQueries.push({status:response.status(),body:response.request().postDataJSON()})})
 for(let index=0;index<3;index++){
  await assistant.getByRole('textbox',{name:'消息',exact:true}).fill(['列出表单字段','查找邮箱','尝试标记邮箱'][index])
  await assistant.getByRole('button',{name:'发送',exact:true}).click()
  await expect(assistant.getByText('Read result '+index,{exact:true})).toBeVisible({timeout:30000})
  const request=JSON.parse(network.wire.toString()),result=request.messages.filter(message=>message.role==='tool').at(-1)
  assert.ok(result,'The actual tool result must be returned to the model')
  if(index===0){assert.match(result.content,/Reviewer/);assert.match(result.content,/Alice/);assert.match(result.content,/Approved/);assert.match(result.content,/true/);assert.match(result.content,/Status/);assert.match(result.content,/Done/);assert.match(result.content,/page 2/i)}
  else if(index===1){assert.match(result.content,/review@example\.org/);assert.match(result.content,/Page 2/)}
  else assert.equal(JSON.parse(result.content).isError,true)
 }
 // Web can queue redaction reviews, but rejects PDFs with interactive form fields.
 assert.deepEqual(markQueries,[{status:400,body:{revision:source.revision,patterns:['email']}}])
 await expect(page.getByRole('region',{name:'涂黑候选审查',exact:true})).toHaveCount(0)
 assert.deepEqual(writes,[])
 const feed=assistant.locator('.ai-chat')
 assert.ok(await feed.evaluate(node=>node.scrollWidth<=node.clientWidth+1),'tool replies stay within the assistant width')
 const messages=await feed.locator('.ai-msg').evaluateAll(nodes=>nodes.map(node=>{const box=node.getBoundingClientRect();return {top:box.top,bottom:box.bottom}}))
 assert.ok(messages.length>=6,'the conversation contains user instructions and tool-backed replies')
 assert.ok(messages.every((box,index)=>index===0||box.top>=messages[index-1].bottom),'conversation messages do not overlap')
 await mkdir('test-results/office-dock-unified',{recursive:true})
 await assistant.screenshot({path:'test-results/office-dock-unified/pdf-conversation.png',animations:'disabled'})
 await assistant.getByRole('textbox',{name:'消息',exact:true}).fill('创建新的 PDF 报告')
 await assistant.getByRole('button',{name:'发送',exact:true}).click()
 await expect(assistant.getByText('Read result 3',{exact:true})).toBeAttached({timeout:30000})
 const result=JSON.parse(network.wire.toString()).messages.filter(message=>message.role==='tool').at(-1)
 assert.match(result.content,/Saved file ID:/)
 const files=(await f.files.listFiles(f.alice.token)).files
 assert.equal(files.length,2)
 const created=files.find(file=>file.id!==source.fileId)
 assert.ok(created)
 await expect(page).toHaveURL(origin+'/#/file/'+created.id)
 const saved=(await f.files.openFile(f.alice.token,created.id)).file
 assert.ok(result.content.includes(saved.fileId));assert.ok(result.content.includes(saved.revision))
 const task=getDocument({data:Uint8Array.from(await f.files.readFile(f.alice.token,saved.fileId,saved.revision)),disableFontFace:true,useSystemFonts:true})
 try{
  const document=await task.promise,text=(await (await document.getPage(1)).getTextContent()).items.map(item=>item.str??'').join(' ')
  assert.match(text,/Created from PDF fields/)
 }finally{await task.destroy()}
 assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,source.revision)
 assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),bytes)
})
