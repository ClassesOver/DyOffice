import test from 'node:test'
import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {fileURLToPath} from 'node:url'
import {mkdir,writeFile} from 'node:fs/promises'
import {PDFDocument,PDFDict,PDFName} from 'pdf-lib'
import {expect} from '@playwright/test'
import {stubHomeHero} from '../helpers/home-hero.mjs'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {readPdfLeafObjects} from '../../../pdf/src/main/text-edit.ts'
import {createPdfStampsJob} from '../../server/src/pdf/stamps-job.mjs'
import {tmpdir} from 'node:os'
import {PNG} from 'pngjs'

test('PDF chat mixed canonical edits preview undo and save one revision with lost receipt recovery',{timeout:210000},async t=>{
 let app,browser,turn=0,markupId,noteId,removedTextId
 t.after(async()=>{await browser?.close();app?.server.closeAllConnections();await app?.close()})
 const origin='http://127.0.0.1:4251',f=await fileFixture(t,{origin,buildApp:false}),keyring={activeKeyId:'pending',keys:{pending:new Uint8Array(32).fill(75)}}
 const calls=()=>[
  ['markup_text',{page:1,text:'Original page 1',type:'highlight'}],
  ['add_note',{page:2,anchor_text:'Original page 2',contents:'Before pending note'}],
  ['insert_text',{page:1,text:'Remove this draft',x:30,y:200,font_size:12}],
  ['insert_text',{page:2,text:'Surviving draft',x:30,y:200,font_size:12}],
  ['apply_ops',{ops:[{op:'removeMarkup',id:markupId},{op:'setNoteContents',id:noteId,contents:'Updated pending note'},{op:'removeTextInsert',id:removedTextId},{op:'setFormValue',value:{name:'Name',value:'张三'}},{op:'addFormField',field:{name:'Status',kind:'choice',page:2,x:40,y:100,width:160,height:24,options:['待审','完成'],value:'完成'}},{op:'rotatePages',pages:[1],dir:90},{op:'deletePage',page:3},{op:'setPageOrder',order:[2,1]},{op:'setMetadata',metadata:{title:'Mixed browser title'}}]}],
  ['apply_ops',{ops:[{op:'setMetadata',metadata:{title:'Dry run only'}}],dry_run:true}],
  ['apply_ops',{ops:[{op:'setMetadata',metadata:{title:'Must not leak'}},{op:'setFormValue',value:{name:'Locked',value:'Overwrite'}}]}],
 ]
 const network=mockProviderNetwork(t,()=>{
  const index=Math.floor(turn/2),tool=turn++%2===0,[name,input]=calls()[index]
  const delta=tool?{tool_calls:[{index:0,id:'pending-'+index,type:'function',function:{name,arguments:JSON.stringify(input)}}]}:{content:'Pending result '+index}
  return Readable.from([Buffer.from(`data: ${JSON.stringify({choices:[{delta}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:tool?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`)])
 })
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[{id:'shared-chat',kind:'chat',providerId:'deepseek',label:'Test model',model:'synthetic-model',baseUrl:'https://provider.example/v1',enabled:true,apiKey:'synthetic-key'}],defaults:{chat:'shared-chat'}})
 const base=await PDFDocument.create()
 for(let i=1;i<=3;i++)base.addPage([500,650]).drawText('Original page '+i,{x:30,y:610,size:14})
 let stamped=Buffer.from(await base.save())
 for(const operation of [{op:'set_watermark',text:'Internal draft'},{op:'set_header_footer',page_number:true}]){
  stamped=(await createPdfStampsJob().execute(stamped,JSON.stringify({version:1,action:'stamps',operation}))).bytes
 }
 const doc=await PDFDocument.load(stamped),pages=doc.getPages(),form=doc.getForm()
 for(const name of ['Name','Locked']){const field=form.createTextField(name);field.setText(name==='Name'?'Before':'Keep');field.addToPage(pages[0],{x:30,y:name==='Name'?30:70,width:160,height:24});if(name==='Locked')field.enableReadOnly()}
 const original=Buffer.from(await doc.save()),source=(await importFile(f,f.alice.token,original,'pending-mixed.pdf')).file
 const n=PDFName.of,appearance=pdf=>Buffer.from(pdf.getForm().getTextField('Locked').acroField.getWidgets()[0].dict.lookup(n('AP'),PDFDict).lookup(n('N')).getContents()),oldAppearance=appearance(await PDFDocument.load(original))
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false,localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 await app.listen({host:'127.0.0.1',port:4251});browser=await launchTestBrowser();const tab=await browser.newPage({viewport:{width:1600,height:1100}});await stubHomeHero(tab)
 const errors=[];tab.on('pageerror',error=>errors.push(error.message))
 await tab.goto(origin);await tab.getByLabel('用户名',{exact:true}).fill('alice');await tab.getByLabel('密码',{exact:true}).fill(password);await tab.getByRole('button',{name:'登录',exact:true}).click();await expect(tab.locator('.home')).toBeVisible();await tab.goto(origin+'/#/file/'+source.fileId)
 const region=tab.getByRole('region',{name:'PDF 页面',exact:true}),assistant=tab.locator('.shared-editor-assistant')
 await expect(region.locator('figure')).toHaveCount(3);await expect(tab.locator('.workspace-document:not([hidden]) .ant-spin-spinning')).toHaveCount(0)
 let stages=0,commits=0,saved
 tab.on('request',request=>{const path=new URL(request.url()).pathname;if(path.endsWith('/uploads')&&path.includes('/pdf/'))stages++;if(path.endsWith('/commits'))commits++})
 const send=async(index,failed=false)=>{
  await assistant.getByRole('textbox',{name:'消息',exact:true}).fill('Run pending step '+index);await assistant.getByRole('button',{name:'发送',exact:true}).click();await expect(assistant.getByText('Pending result '+index,{exact:true})).toBeVisible({timeout:30000})
  const result=JSON.parse(JSON.parse(network.wire.toString()).messages.filter(message=>message.role==='tool').at(-1).content)
  assert.equal(!!result.isError,failed,result.output);return result
 }
 const unchanged=async()=>{assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,source.revision);assert.equal(stages,0);assert.equal(commits,0)}
 markupId=(await send(0)).output.match(/P[0-9a-f-]{36}/)?.[0];assert.ok(markupId);await unchanged()
 noteId=(await send(1)).output.match(/P[0-9a-f-]{36}/)?.[0];assert.ok(noteId);await unchanged()
 removedTextId=(await send(2)).output.match(/T[0-9a-f-]{36}/)?.[0];assert.ok(removedTextId);await send(3);await unchanged()
 await send(4);await expect(region.locator('figure')).toHaveCount(2,{timeout:30000});await unchanged()
 await expect(region.locator('figure').first()).toContainText('Original page 2')
 await expect(region.locator('figure').first()).toContainText('1 / 2')
 await tab.getByRole('button',{name:'撤销修改',exact:true}).click();await expect(region.locator('figure')).toHaveCount(3,{timeout:30000});await unchanged()
 await tab.getByRole('button',{name:'重做修改',exact:true}).click();await expect(region.locator('figure')).toHaveCount(2,{timeout:30000})
 await send(5);await send(6,true);await unchanged()
 const png=new PNG({width:2,height:1});png.data.set([255,0,0,255,0,0,255,255])
 await tab.getByLabel('选择旋转页码').selectOption('1')
 const layout=tab.waitForResponse(response=>response.url().endsWith('/image-inserts/query'))
 await tab.getByLabel('添加待保存图片').setInputFiles({name:'rotated.png',mimeType:'image/png',buffer:PNG.sync.write(png)})
 const layoutResponse=await layout;assert.equal(layoutResponse.status(),200)
 const {image,edit}=await layoutResponse.json();assert.equal(edit.rotate,90)
 const imageOverlay=tab.getByLabel('待保存图片覆盖层',{exact:true})
 await expect(imageOverlay).toHaveAttribute('viewBox','0 0 650 500')
 const imageBlock=imageOverlay.getByRole('button')
 await expect(imageBlock).toHaveAttribute('tabindex','0')
 await imageBlock.press('Shift+ArrowRight')
 await expect.poll(async()=>Number(await tab.getByLabel('待保存图片横坐标').inputValue())).toBe(image.x+10)
 await expect(tab.getByText('图片预览失败：',{exact:false})).toHaveCount(0)
 await expect(tab.getByRole('button',{name:'保存新版本',exact:true})).toBeEnabled({timeout:15000})
 await unchanged()
 const review=tmpdir()+'/dyoffice-pdf-pending-review';await mkdir(review,{recursive:true});await tab.screenshot({path:review+'/pending.png',fullPage:true})
 await tab.route('**/api/v1/files/*/commits',async route=>{const response=await route.fetch({timeout:15000});assert.equal(response.status(),200);saved=await response.json();await route.abort('failed')},{times:1})
 await tab.getByRole('button',{name:'保存新版本',exact:true}).click();await expect(tab.getByRole('button',{name:'确认保存结果',exact:true})).toBeVisible({timeout:30000})
 assert.ok(saved);assert.equal(stages,1);assert.equal(commits,1)
 await tab.getByRole('button',{name:'确认保存结果',exact:true}).click();await expect(tab.getByRole('button',{name:'确认保存结果',exact:true})).toHaveCount(0,{timeout:30000});assert.equal(stages,1);assert.equal(commits,2)
 const bytes=await f.files.readFile(f.alice.token,source.fileId,saved.revision),out=await PDFDocument.load(bytes)
 assert.equal(out.getPageCount(),2);assert.equal(out.getTitle(),'Mixed browser title');assert.equal(out.getPage(0).getRotation().angle,0);assert.equal(out.getPage(1).getRotation().angle,90)
 assert.equal(out.getForm().getTextField('Name').getText(),'张三');assert.deepEqual(out.getForm().getDropdown('Status').getSelected(),['完成']);assert.deepEqual(appearance(out),oldAppearance)
 const annotations=out.getPages().flatMap(page=>(page.node.Annots()?.asArray()??[]).map(ref=>out.context.lookup(ref)))
 assert.equal(annotations.filter(dict=>String(dict.get(n('Subtype')))==='/Highlight').length,0)
 assert.ok(annotations.some(dict=>String(dict.get(n('Subtype')))==='/Text'&&dict.lookup(n('Contents')).decodeText()==='Updated pending note'))
 const leaves=(await readPdfLeafObjects(bytes)).filter(item=>item.type===1),text=leaves.map(item=>item.text).join('|')
 const imageLeaves=(await readPdfLeafObjects(bytes)).filter(item=>item.type===3)
 assert.equal(imageLeaves.length,1);assert.equal(imageLeaves[0].page,1)
 assert.deepEqual(imageLeaves[0].bounds,[edit.rect[0],edit.rect[1]+10,edit.rect[2],edit.rect[3]+10])
 assert.match(text,/Original page 1/);assert.match(text,/Original page 2/);assert.match(text,/Surviving draft/);assert.doesNotMatch(text,/Original page 3|Remove this draft/)
 for(const [page,number]of [[0,'1 / 2'],[1,'2 / 2']]){
  assert.ok(leaves.some(item=>item.page===page&&item.text===number));assert.ok(leaves.some(item=>item.page===page&&item.text==='Internal draft'))
 }
 assert.doesNotMatch(text,/ \/ 3/)
 const count=await f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async connection=>Number((await connection.query('SELECT count(*) AS count FROM file_revisions WHERE file_id=$1',[source.fileId])).rows[0].count));assert.equal(count,2)
 assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),original)
 await writeFile(review+'/saved.pdf',bytes);await tab.reload();await expect(region.locator('figure')).toHaveCount(2,{timeout:30000});await expect(region).toContainText('Surviving draft');assert.deepEqual(errors,[]);await tab.screenshot({path:review+'/saved.png',fullPage:true})
})
