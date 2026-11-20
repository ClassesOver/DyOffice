import {stubHomeHero} from '../helpers/home-hero.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {fileURLToPath} from 'node:url'
import {mkdir,writeFile} from 'node:fs/promises'
import {PDFDocument,degrees} from 'pdf-lib'
import {readPdfLeafObjects} from '../../../pdf/src/main/text-edit.ts'
import {expect} from '@playwright/test'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {tmpdir} from 'node:os'

test('PDF pending text edits, drags, deletes and undoes before one saved revision with commit recovery',{timeout:150000},async t=>{
 let app,browser,pendingId,secondId,turn=0
 t.after(async()=>{await browser?.close();app?.server.closeAllConnections();await app?.close()})
 const origin='http://127.0.0.1:4241',f=await fileFixture(t,{origin,buildApp:false})
 const keyring={activeKeyId:'pdf-drafts',keys:{'pdf-drafts':new Uint8Array(32).fill(51)}}
 const calls=()=>[
  ['insert_text',{page:1,text:'Draft candidate',x:40,y:70,font_size:16,max_width:130}],
  ['edit_inserted_text',{id:pendingId,text:'WWWW iiiii Hello',color:'#113355'}],
  ['move_inserted_text',{id:pendingId,dx:30,dy:25}],
  ['delete_inserted_text',{id:pendingId}],
  ['insert_text',{page:2,text:'第二个待保存文字',x:50,y:80,font_size:16}],
  ['apply_ops',{ops:[{op:'removeTextInsert',id:pendingId},{op:'removeTextInsert',id:secondId},{op:'removeTextInsert',id:pendingId},{op:'removeTextInsert',id:'Tmissing'}]}],
  ['list_inserted_text',{}],
 ]
 const network=mockProviderNetwork(t,()=>{
  const index=Math.floor(turn/2),tool=turn++%2===0,[name,input]=calls()[index]
  const delta=tool?{tool_calls:[{index:0,id:'draft-'+index,type:'function',function:{name,arguments:JSON.stringify(input)}}]}:{content:'Draft result '+index}
  return Readable.from([Buffer.from(`data: ${JSON.stringify({choices:[{delta}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:tool?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`)])
 })
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[{id:'shared-chat',kind:'chat',providerId:'deepseek',label:'Test model',model:'synthetic-model',baseUrl:'https://provider.example/v1',enabled:true,apiKey:'synthetic-key'}],defaults:{chat:'shared-chat'}})
 const doc=await PDFDocument.create()
 for(let i=0;i<2;i++){const page=doc.addPage([500,600]);page.drawText('Original page '+(i+1),{x:40,y:500,size:12});if(i===1)page.setRotation(degrees(90))}
 const bytes=Buffer.from(await doc.save()),source=(await importFile(f,f.alice.token,bytes,'pending-text.pdf')).file
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false,localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 await app.listen({host:'127.0.0.1',port:4241});browser=await launchTestBrowser()
 const tab=await browser.newPage({viewport:{width:1600,height:1100}})
 await stubHomeHero(tab)
 await tab.goto(origin);await tab.getByLabel('用户名',{exact:true}).fill('alice');await tab.getByLabel('密码',{exact:true}).fill(password)
 await tab.getByRole('button',{name:'登录',exact:true}).click();await expect(tab.locator('.home')).toBeVisible()
 await tab.goto(origin+'/#/file/'+source.fileId)
 await expect(tab.getByRole('region',{name:'PDF 页面',exact:true}).locator('figure')).toHaveCount(2)
 await expect(tab.locator('.workspace-document:not([hidden]) .ant-spin-spinning')).toHaveCount(0)
 const assistant=tab.locator('.shared-editor-assistant'),overlay=tab.getByLabel('待保存文字覆盖层',{exact:true})
 let queries=0,stages=0,commits=0,saved
 tab.on('request',request=>{if(request.url().endsWith('/text-inserts/query'))queries++;if(request.url().endsWith('/apply-ops/uploads'))stages++;if(request.url().endsWith('/commits'))commits++})
 const send=async(index,prompt)=>{await assistant.getByRole('textbox',{name:'消息',exact:true}).fill(prompt);await assistant.getByRole('button',{name:'发送',exact:true}).click();await expect(assistant.getByText('Draft result '+index,{exact:true})).toBeVisible({timeout:30000})}
 const original=async()=>{assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,source.revision);assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),bytes);assert.equal(stages,0);assert.equal(commits,0)}
 await send(0,'插入一个待保存文字块')
 await expect(overlay).toHaveCount(1);await expect(tab.getByRole('region',{name:'PDF 页面',exact:true})).toContainText('Draft candidate')
 pendingId=(await overlay.getByRole('button').getAttribute('aria-label')).replace('待保存文字 ','')
 assert.match(pendingId,/^T/);await original()
 await send(1,'改写刚才的待保存文字并换颜色');await expect(tab.getByRole('region',{name:'PDF 页面',exact:true})).toContainText('WWWW iiiii');await original()
 await send(2,'移动刚才的待保存文字');await original()
 await send(3,'删除刚才的待保存文字');await expect(overlay).toHaveCount(0);await original()
 await tab.getByRole('button',{name:'撤销修改',exact:true}).click();await expect(tab.getByRole('region',{name:'PDF 页面',exact:true})).toContainText('WWWW iiiii',{timeout:15000})
 // Exercise actual pointer capture and display-point scaling, rather than only the AI callback.
 const block=overlay.getByRole('button'),bounds=await block.boundingBox()
 const planned=tab.waitForResponse(response=>response.url().endsWith('/text-inserts/query'))
 await tab.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);await tab.mouse.down();await tab.mouse.move(bounds.x+bounds.width/2+20,bounds.y+bounds.height/2+15,{steps:4});await tab.mouse.up()
 assert.equal((await planned).status(),200)
 await expect(tab.getByLabel('待保存文字横坐标',{exact:true})).toHaveValue('90')
 await expect(tab.getByLabel('待保存文字纵坐标',{exact:true})).toHaveValue('110');await original()
 await tab.getByLabel('选择旋转页码').selectOption('2')
 await tab.getByRole('button',{name:'向右旋转 90°',exact:true}).click();await original()
 await send(4,'在待保存旋转后的第二页插入文字');await expect(overlay).toHaveCount(2);await original()
 await expect(overlay.last()).toHaveAttribute('viewBox','0 0 500 600')
 await expect(tab.getByRole('region',{name:'PDF 页面',exact:true})).toContainText('WWWW iiiii Hello')
 secondId=(await overlay.last().getByRole('button').getAttribute('aria-label')).replace('待保存文字 ','')
 await send(5,'把两个待保存文字作为一批删除，重复目标应幂等处理')
 await expect(overlay).toHaveCount(0);await original()
 await tab.getByRole('button',{name:'撤销修改',exact:true}).click()
 await expect(overlay).toHaveCount(2);await original()
 const review=tmpdir()+'/dyoffice-pdf-text-drafts-review'
 await mkdir(review,{recursive:true})
 await tab.screenshot({path:review+'/pending.png',fullPage:true})
 await tab.route('**/api/v1/files/*/commits',async route=>{const response=await route.fetch({timeout:10000});assert.equal(response.status(),200);saved=await response.json();await route.abort('failed')},{times:1})
 await tab.getByRole('button',{name:'保存新版本',exact:true}).click()
 await expect(tab.getByRole('button',{name:'确认保存结果',exact:true})).toBeVisible({timeout:30000})
 assert.ok(saved);assert.equal(stages,1);assert.equal(commits,1);assert.equal(queries,5)
 // Keep the local blocks while the commit receipt is unknown; confirm the original upload.
 await expect(overlay).toHaveCount(2)
 const savedContent=url=>url.pathname.endsWith('/content')&&url.searchParams.get('revision')===saved.revision
 let releaseRefresh
 const refreshGate=new Promise(resolve=>{releaseRefresh=resolve})
 await tab.route(savedContent,async route=>{await refreshGate;await route.continue()},{times:1})
 const refreshing=tab.waitForRequest(request=>savedContent(new URL(request.url())))
 try {
  await tab.getByRole('button',{name:'确认保存结果',exact:true}).click()
  await refreshing
  await send(6,'列出待保存文字');const wire=JSON.parse(network.wire.toString())
  assert.ok(wire.tools.some(tool=>tool.function.name==='edit_inserted_text'))
  const listing=wire.messages.findLast(message=>message.role==='tool'&&message.tool_call_id==='draft-6')
  assert.ok(listing,'Expected a list_inserted_text result after save')
  const result=JSON.parse(listing.content)
  assert.ok(!result.isError,result.output)
  assert.match(result.output,/^Unsaved inserted text: \[\]\./)
 } finally {releaseRefresh()}
 await expect(tab.getByRole('button',{name:'确认保存结果',exact:true})).toHaveCount(0,{timeout:30000})
 await expect(overlay).toHaveCount(0);assert.equal(stages,1);assert.equal(commits,2)
 const output=await f.files.readFile(f.alice.token,source.fileId,saved.revision),objects=await readPdfLeafObjects(output),text=objects.filter(object=>object.type===1).map(object=>object.text).join('|')
 await writeFile(review+'/saved.pdf',output)
 assert.match(text,/WWWW iiiii Hello/);assert.match(text,/第二个待保存文字/);assert.doesNotMatch(text,/Draft candidate/)
 assert.match(text,/Original page 1/);assert.match(text,/Original page 2/)
 const rotated=(await PDFDocument.load(output)).getPage(1)
 assert.equal(rotated.getRotation().angle,180)
 const second=objects.find(object=>object.type===1&&object.text==='第二个待保存文字')
 assert.ok(second)
 assert.deepEqual(second.matrix.slice(4).map(Math.round),[450,96])
 const final=objects.find(object=>object.type===1&&object.text==='WWWW iiiii Hello')
 assert.ok(final);assert.ok(Math.abs(final.matrix[4]-90)<.01,'saved text matrix origin must match dragged preview: '+JSON.stringify(final.matrix))
 assert.ok(Math.abs(final.matrix[5]-(600-110-16))<.01,'saved baseline must match dragged top edge and font size')
 await tab.reload();await expect(tab.getByRole('region',{name:'PDF 页面',exact:true})).toContainText('WWWW iiiii Hello',{timeout:30000})
 await expect(overlay).toHaveCount(0)
 assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),bytes)
})
