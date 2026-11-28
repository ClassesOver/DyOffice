import test from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createServer} from 'node:http'
import {Readable} from 'node:stream'
import {fileURLToPath} from 'node:url'
import {PDFDocument,PDFHexString,PDFName} from 'pdf-lib'
import {PNG} from 'pngjs'
import {expect} from '@playwright/test'
import {buildLocalApp} from '../../server/src/app.ts'
import {createWorkspaceService} from '../../server/src/modules/workspace/service.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {launchTestBrowser,recordVerifiedOfficeEffect} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {stubHomeHero} from '../helpers/home-hero.mjs'
import {password} from '../helpers/identity.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'

const nativePdfDirectory=process.env.DYOFFICE_TEST_NATIVE_PDF_DIST
const fillKey=PDFName.of('GenOfficeStaticFormFills')
async function addStaticFills(doc,fills){
 const png=new PNG({width:3,height:3});png.data.fill(255)
 const picture=await doc.embedPng(PNG.sync.write(png))
 for(const {pageIndex,rect:[x,y,x2,y2]} of fills)doc.getPage(pageIndex).drawImage(picture,{x,y,width:x2-x,height:y2-y})
 doc.catalog.set(fillKey,PDFHexString.fromText(JSON.stringify(fills)))
}
const staticFills=doc=>JSON.parse(doc.catalog.lookup(fillKey)?.decodeText()??'[]')
test('native PDF ribbon names extracted pages and saves numbered PDF parts to a selected folder',{skip:!nativePdfDirectory,timeout:90000},async t=>{
 let app
 const server=createServer((req,res)=>app.routing(req,res))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
 const origin='http://localhost:'+server.address().port,f=await fileFixture(t,{origin,buildApp:false})
 await f.preferences.update(f.alice.token,{language:'zh',autoSave:false,showAssistant:false})
 const doc=await PDFDocument.create(),first=doc.addPage([400,300]),second=doc.addPage([400,300]),form=doc.getForm()
 const shared=form.createTextField('customer'),excluded=form.createTextField('firstPageOnly')
 for(const page of [first,second])shared.addToPage(page,{x:30,y:230,width:160,height:22})
 shared.setText('Ada Lovelace')
 excluded.addToPage(first,{x:30,y:190,width:160,height:22});excluded.setText('Original only')
 const delivery=form.createRadioGroup('delivery')
 delivery.addOptionToPage('Pickup',first,{x:30,y:140,width:20,height:20})
 delivery.addOptionToPage('Courier',second,{x:30,y:140,width:20,height:20})
 delivery.select('Pickup')
 const entry={id:'second-text',kind:'text',pageIndex:1,rect:[45,75,145,99],text:'Second page entry',fontSize:14,color:'#111111',align:'left'}
 await addStaticFills(doc,[{...entry,id:'first-text',pageIndex:0,text:'Omitted page entry'},entry])
 const original=Buffer.from(await doc.save()),{file}=await importFile(f,f.alice.token,original,'fillable.pdf')
 const workspace=createWorkspaceService(f.transactions)
 const sourceFolder=await workspace.createFolder(f.alice.token,{name:'PDF originals',parentId:null})
 const extractFolder=await workspace.createFolder(f.alice.token,{name:'Extracted pages',parentId:null})
 await workspace.moveFile(f.alice.token,file.fileId,{folderId:sourceFolder.id})
 app=await buildLocalApp({
  db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,nativePdfDirectory,
  localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url)),
 })
 f.cleanup.unshift(()=>app.close())
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:1000}})
 await stubHomeHero(page)
 const csrf=await(await page.request.get(origin+'/api/v1/auth/csrf')).json()
 assert.equal((await page.request.post(origin+'/api/v1/auth/login',{headers:{origin,'x-csrf-token':csrf.csrfToken},data:{username:'alice',password}})).status(),200)
 await page.goto(origin+'/#/file/'+file.fileId)
 const frame=id=>page.frameLocator(`iframe[data-document-id="${id}"]`)
 const source=frame(file.fileId)
 await expect(source.locator('html')).toHaveAttribute('data-document-loading','ready')
 await source.getByRole('button',{name:'页面',exact:true}).click()
 const extractButton=source.getByRole('button',{name:'抽取本页',exact:true})
 const range=source.getByPlaceholder(/页码或范围/)
 const extract=async()=>{
  await extractButton.click()
  await range.fill('2');await range.press('Enter')
 }
 const singleDestination=source.getByRole('dialog',{name:'保存副本到工作区'})
 await extract()
 await expect(singleDestination.getByRole('textbox',{name:'文件名'})).toHaveValue('fillable-p2.pdf',{timeout:5000})
 await expect(singleDestination.getByRole('combobox',{name:'保存位置'})).toHaveValue(sourceFolder.id)
 await singleDestination.getByRole('button',{name:'取消',exact:true}).click()
 assert.equal((await f.files.listFiles(f.alice.token)).files.length,1)
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
 await extract()
 await singleDestination.getByRole('textbox',{name:'文件名'}).fill('Customer copy')
 await singleDestination.getByRole('combobox',{name:'保存位置'}).selectOption(extractFolder.id)
 const prepared=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/v1/files/${file.fileId}/pdf/extract-pages/uploads`)
 await singleDestination.getByRole('button',{name:'保存副本',exact:true}).click()
 const response=await prepared
 assert.ok(response.ok(),await response.text())
 const {fileId:copyId}=await response.json()
 await expect(page).toHaveURL(origin+'/#/file/'+copyId)
 assert.ok((await workspace.listFiles(f.alice.token,{folderId:extractFolder.id})).files.some(file=>file.id===copyId&&file.name==='Customer copy.pdf'))
 const copy=frame(copyId)
 await expect(copy.locator('html')).toHaveAttribute('data-document-loading','ready')
 const field=copy.locator('.pdf-form-layer input[title="customer"]')
 const option=copy.locator('.pdf-form-layer input[type="radio"][title="delivery"]')
 await expect(field).toHaveValue('Ada Lovelace')
 await expect(option).toBeVisible()
 await expect(option).not.toBeChecked()
 const head=async id=>(await f.files.openFile(f.alice.token,id)).file.revision
 const copiedRevision=await head(copyId)
 await field.fill('Grace Hopper')
 await option.check()
 await copy.getByRole('button',{name:'填写表单',exact:true}).click()
 await copy.locator('.pdf-page[data-page="0"] .pdf-imgedit-hit').click({timeout:10000})
 await copy.locator('.pdf-del-popup').getByRole('button',{name:'编辑文字',exact:true}).click()
 const fillText=copy.getByPlaceholder('输入要放置的文字',{exact:true})
 await expect(fillText).toHaveValue('Second page entry')
 await fillText.fill('Edited in the extracted copy')
 await copy.locator('.pdf-modal').getByRole('button',{name:'确定',exact:true}).click()
 await expect(copy.locator('.dyoffice-pdf-persistence-state')).toHaveAttribute('data-dirty','true')
 const saveResponse=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/v1/files/${copyId}/pdf/apply-ops/uploads`,{timeout:15000})
 await copy.getByRole('button',{name:'保存',exact:true}).click()
 const staged=await saveResponse
 assert.ok(staged.ok(),await staged.text())
 await expect.poll(()=>head(copyId),{timeout:18000}).not.toBe(copiedRevision)
 const saved=await PDFDocument.load(await f.files.readFile(f.alice.token,copyId,await head(copyId)))
 assert.equal(saved.getPageCount(),1)
 assert.deepEqual(saved.getForm().getFields().map(value=>value.getName()),['customer','delivery'])
 assert.equal(saved.getForm().getTextField('customer').getText(),'Grace Hopper')
 assert.deepEqual(staticFills(saved),[{...entry,pageIndex:0,text:'Edited in the extracted copy'}])
 const savedDelivery=saved.getForm().getRadioGroup('delivery')
 assert.deepEqual(savedDelivery.getOptions(),['Courier'])
 assert.equal(savedDelivery.getSelected(),'Courier')
 const folder=await workspace.createFolder(f.alice.token,{name:'PDF batches',parentId:null})
 await page.getByRole('tab',{name:'fillable.pdf',exact:true}).click()
 const splitButton=source.getByRole('button',{name:'拆分 PDF',exact:true})
 if(!await splitButton.isVisible())await source.getByRole('button',{name:'页面',exact:true}).click()
 const split=async()=>{
  await splitButton.click()
  await source.getByPlaceholder(/每 N 页拆分/).press('Enter')
 }
 await split()
 const destination=source.getByRole('dialog',{name:'保存拆分后的 PDF'})
 await destination.getByRole('button',{name:'取消',exact:true}).click()
 assert.equal((await f.files.listFiles(f.alice.token)).files.length,2)
 await split()
 await destination.getByRole('textbox',{name:'文件名前缀'}).fill('Packet')
 await destination.getByRole('combobox',{name:'保存位置'}).selectOption(folder.id)
 let finishes=0
 await page.route('**/api/v1/uploads/*/finish',async route=>{
  if(++finishes!==2)return route.continue()
  const response=await route.fetch()
  assert.equal(response.status(),200)
  await route.abort()
 })
 await destination.getByRole('button',{name:'保存拆分文件',exact:true}).click()
 const confirm=source.getByRole('button',{name:'确认副本保存结果'})
 await expect(confirm).toBeVisible({timeout:20000})
 await expect(page.getByRole('tab',{name:'fillable.pdf',exact:true})).toHaveAttribute('aria-selected','true')
 await expect(page.getByRole('tab',{name:/^Packet-[12]\.pdf$/})).toHaveCount(0)
 await confirm.click()
 await expect(page.getByRole('tab',{name:'首页',exact:true})).toHaveAttribute('aria-selected','true')
 await expect(page.locator('.home')).toContainText('PDF batches')
 const row=name=>page.locator('.recent-row').filter({has:page.getByText(name,{exact:true})})
 await expect(row('Packet-1.pdf').getByRole('checkbox')).toBeChecked()
 await expect(row('Packet-2.pdf')).toBeVisible()
 await expect(page.getByRole('tab',{name:/^Packet-[12]\.pdf$/})).toHaveCount(0)
 assert.equal(finishes,3)
 const parts=(await workspace.listFiles(f.alice.token,{folderId:folder.id})).files
 assert.deepEqual(parts.map(file=>file.name).sort(),['Packet-1.pdf','Packet-2.pdf'])
 assert.equal(await head(file.fileId),file.revision)
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
})

const cases=[
 ['extract_pages',{pages:'3,1'},[['source-提取.pdf',[400,600]]]],
 ['split_pdf',{pages_per_file:2},[]],
 ['confirm_pdf_copies',{},[['source-part-1.pdf',[400,500]],['source-part-2.pdf',[600]]]],
 ['split_pages',{per_page:2},[['source-split-pages.pdf',[200,200,250,250,300,300]]]],
 ['merge_pages',{per_sheet:2},[['source-merged-pages.pdf',2]]],
 ['crop_pages',{pages:'1',left:.1,top:.1,right:.9,bottom:.9},[]],
 ['crop_pages',{pages:'2',left:.1,top:.1,right:.9,bottom:.9},[]],
 ['set_page_size',{width:420,height:595},[]],
 ['insert_blank_page',{after_page:1},[]],
 ['extract_pages',{pages:'2'},[]],
]
test('native PDF assistant and ribbon save separate page copies',{skip:!nativePdfDirectory,timeout:150000},async t=>{
 const origin='http://localhost:4290',f=await fileFixture(t,{origin,buildApp:false})
 const keyring={activeKeyId:'copies',keys:{copies:new Uint8Array(32).fill(37)}}
 const source=await PDFDocument.create()
 for(const width of [400,500,600])source.addPage([width,300]).drawText('Source '+width,{x:30,y:250})
 const original=Buffer.from(await source.save()),{file}=await importFile(f,f.alice.token,original,'source.pdf')
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[{id:'fixture',kind:'chat',providerId:'openai',label:'Fixture',model:'synthetic',baseUrl:'https://provider.example/v1/chat/completions',apiKey:'fixture-key',enabled:true}],defaults:{chat:'fixture'}})
 const app=await buildLocalApp({
  db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,rateLimit:{max:5000,windowMs:60000},
  globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false,nativePdfDirectory,
  localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url)),
 })
 f.cleanup.unshift(()=>app.close())
 await app.listen({port:4290,host:'127.0.0.1'})
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:1000}})
 await stubHomeHero(page)
 await page.goto(origin)
 await page.getByLabel('用户名',{exact:true}).fill('alice')
 await page.getByLabel('密码',{exact:true}).fill(password)
 await page.getByRole('button',{name:'登录',exact:true}).click()
 await expect(page.locator('.home')).toBeVisible()
 await page.goto(origin+'/#/file/'+file.fileId)
 const frame=page.frameLocator(`iframe[data-document-id="${file.fileId}"]`)
 await expect(frame.locator('html')).toHaveAttribute('data-document-loading','ready')
 await frame.getByRole('button',{name:'AI 助手',exact:true}).click()
 const assistant=frame.locator('.shared-editor-assistant')
 let confirmationCount=0
 page.on('dialog',async dialog=>{
  if(dialog.type()!=='confirm'){await dialog.dismiss();return}
  confirmationCount++
  if(confirmationCount===1)await dialog.dismiss()
  else await dialog.accept()
 })
 let turn=0
 let dropped=false
 await page.route('**/api/v1/uploads/*/finish',async route=>{
  if(turn!==3||dropped){await route.continue();return}
  try{
   const request=route.request()
   const response=await app.inject({method:'POST',url:new URL(request.url()).pathname,headers:await request.allHeaders()})
   dropped=response.statusCode===200
   if(!dropped)t.diagnostic('finish response: '+response.statusCode)
  }finally{await route.abort('failed')}
 })
 const network=mockProviderNetwork(t,()=>{
  const index=Math.floor(turn/2),[name,input]=cases[index],isTool=turn++%2===0
  const delta=isTool?{tool_calls:[{index:0,id:'call-'+turn,type:'function',function:{name,arguments:JSON.stringify(input)}}]}:{content:'Finished case '+index}
  return Readable.from([Buffer.from('data: '+JSON.stringify({choices:[{delta,finish_reason:isTool?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n')])
 })
 for(const [index,[name,,outputs]] of cases.entries()){
  const request=page.waitForRequest(req=>req.method()==='POST'&&new URL(req.url()).pathname==='/api/v1/ai/turns')
  await assistant.getByRole('textbox',{name:'消息'}).fill(name+' '+index)
  await assistant.getByRole('button',{name:'发送',exact:true}).click()
  const {tools,system}=(await request).postDataJSON().request
  assert.ok(tools.some(tool=>tool.name===name),`Missing native PDF tool ${name}`)
  if(index===0){
   assert.match(system,/Ordinary edits create unsaved drafts/)
   assert.match(system,/crop_pages, set_page_size, replace_pages.*user confirmation.*new revision/)
   assert.match(system,/extract_pages, split_pdf, split_pages, merge_pages.*separate saved PDF/)
  }
  await expect(assistant.getByText('Finished case '+index,{exact:true})).toBeAttached({timeout:20000})
  const reply=JSON.parse(network.wire.toString()).messages.filter(message=>message.role==='tool').at(-1)
  if(name==='split_pdf'){
   assert.equal(dropped,true)
   assert.match(reply.content,/batch incomplete.*confirm_pdf_copies/)
   await expect(page).toHaveURL(origin+'/#/file/'+file.fileId)
   continue
  }
  if(name==='insert_blank_page'){
   assert.match(reply.content,/blank page/i)
   continue
  }
  if(name==='crop_pages'||name==='set_page_size'){
   if(name==='crop_pages'&&confirmationCount===1){
    assert.match(reply.content,/user canceled/)
    assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
    continue
   }
   assert.match(reply.content,/saved a new revision/i)
   const {file:saved}=await f.files.openFile(f.alice.token,file.fileId)
   assert.notEqual(saved.revision,file.revision)
   const pdf=await PDFDocument.load(await f.files.readFile(f.alice.token,file.fileId,saved.revision))
   if(name==='crop_pages'){
    assert.equal(pdf.getPage(0).getCropBox().width,400)
    assert.equal(pdf.getPage(1).getCropBox().width,400)
    assert.equal(pdf.getPage(1).getCropBox().height,240)
    assert.equal(pdf.getPage(1).getWidth(),500)
   }else assert.deepEqual(pdf.getPages().map(item=>item.getSize()),Array(3).fill({width:420,height:595}))
   continue
  }
  if(!outputs.length){
   assert.match(reply.content,/Save or discard PDF changes/)
   continue
  }
  const entries=(await f.files.listFiles(f.alice.token)).files
  let last
  for(const [output,geometry] of outputs){
   const entry=entries.find(item=>item.name===output)
   assert.ok(entry,reply?.content)
   last=entry.id
   const {file:saved}=await f.files.openFile(f.alice.token,entry.id)
   assert.ok(reply.content.includes(saved.fileId)&&reply.content.includes(saved.revision),reply.content)
   const bytes=await f.files.readFile(f.alice.token,entry.id,saved.revision)
   const pdf=await PDFDocument.load(bytes)
   assert.deepEqual(Array.isArray(geometry)?pdf.getPages().map(item=>item.getWidth()):pdf.getPageCount(),geometry)
   if(name==='merge_pages'){
    const text=execFileSync('pdftotext',['-','-'],{input:bytes,encoding:'utf8'})
    assert.deepEqual(text.match(/Source \d+/g),['Source 400','Source 500','Source 600'])
   }
  }
  await expect(page).toHaveURL(origin+'/#/file/'+last)
  await expect(page.frameLocator(`iframe[data-document-id="${last}"]`).locator('html')).toHaveAttribute('data-document-loading','ready')
  await page.getByText('source.pdf',{exact:true}).first().click()
 }
 assert.equal((await f.files.listFiles(f.alice.token)).files.length,6)
 assert.equal(confirmationCount,3)
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
 for(const effect of ['extract_pages','confirm_pdf_copies','split_pages','merge_pages','crop_pages','set_page_size']){
  recordVerifiedOfficeEffect('pdf',effect)
 }
 await frame.getByRole('button',{name:/^撤销/}).click()
 await frame.getByRole('button',{name:'页面',exact:true}).click()
 await frame.getByRole('button',{name:'抽取本页',exact:true}).click()
 await frame.getByPlaceholder(/页码或范围/).fill('2')
 let ribbonFile
 await page.route('**/api/v1/uploads/*/finish',async route=>{
  try{
   const request=route.request()
   const response=await app.inject({method:'POST',url:new URL(request.url()).pathname,headers:await request.allHeaders()})
   assert.equal(response.statusCode,200)
   ribbonFile=response.json().file
  }finally{await route.abort('failed')}
 },{times:1})
 await frame.getByPlaceholder(/页码或范围/).press('Enter')
 await frame.getByRole('dialog',{name:'保存副本到工作区'}).getByRole('button',{name:'保存副本',exact:true}).click()
 const confirm=frame.getByRole('button',{name:'确认副本保存结果'})
 await expect(confirm).toBeVisible({timeout:20000})
 assert.ok(ribbonFile)
 const last=ribbonFile.fileId
 await confirm.click()
 await expect(page).toHaveURL(origin+'/#/file/'+last)
 await expect(page.frameLocator(`iframe[data-document-id="${last}"]`).locator('html')).toHaveAttribute('data-document-loading','ready')
 assert.equal((await f.files.listFiles(f.alice.token)).files.length,7)
 assert.notEqual(last,file.fileId)
 const {file:actual}=await f.files.openFile(f.alice.token,last)
 assert.equal((await PDFDocument.load(await f.files.readFile(f.alice.token,last,actual.revision))).getPageCount(),1)

 const workspace=createWorkspaceService(f.transactions)
 const layoutFolder=await workspace.createFolder(f.alice.token,{name:'Printed layouts',parentId:null})
 const casesFromRibbon=[
  ['拆分 PDF',[1,2],async modal=>{
   await modal.getByPlaceholder(/每 N 页/).fill('2')
   await modal.getByPlaceholder(/每 N 页/).press('Enter')
   await frame.getByRole('dialog',{name:'保存拆分后的 PDF'}).getByRole('button',{name:'保存拆分文件',exact:true}).click()
  }],
  ['拆分页面',[6],modal=>modal.getByRole('button',{name:'1 分 2',exact:true}).click()],
  ['合并页面',[1],async modal=>{
   await modal.getByLabel('每张合并页数').fill('3')
   await modal.getByLabel('显示分隔线').check()
   await modal.getByLabel('每张合并页数').press('Enter')
  }],
 ]
 const sourceRevision=(await f.files.openFile(f.alice.token,file.fileId)).file.revision
 const sourceBytes=await f.files.readFile(f.alice.token,file.fileId,sourceRevision)
 const layoutResponses=[]
 page.on('response',response=>{
  if(/\/(lease|page-layout\/uploads)$/.test(response.url()))layoutResponses.push(response)
 })
 for(const [label,expected,submit] of casesFromRibbon){
  await page.getByRole('tab',{name:'source.pdf',exact:true}).click()
  await expect.poll(()=>frame.locator('html').evaluate(()=>window.dyofficeEditorCanClose())).toBe(true)
  const previous=new Set((await f.files.listFiles(f.alice.token)).files.map(item=>item.id))
  await frame.getByRole('button',{name:label,exact:true}).click()
  await submit(frame.locator('.pdf-modal'))
  if(label!=='拆分 PDF'){
   const destination=frame.getByRole('dialog',{name:'保存副本到工作区'})
   const expectedName=label==='拆分页面'?'source-split.pdf':'source-3in1.pdf'
   await expect(destination.getByRole('textbox',{name:'文件名'})).toHaveValue(expectedName)
   await destination.getByRole('textbox',{name:'文件名'}).fill(label+'.pdf')
   await destination.getByRole('combobox',{name:'保存位置'}).selectOption(layoutFolder.id)
   await destination.getByRole('button',{name:'保存副本',exact:true}).click()
  }
  const added=async()=>(await f.files.listFiles(f.alice.token)).files.filter(item=>!previous.has(item.id))
  try{
   await expect.poll(async()=>(await added()).length,{timeout:15000,message:label}).toBe(expected.length)
  }catch(error){
   for(const response of layoutResponses)t.diagnostic(`${response.request().method()} ${new URL(response.url()).pathname} ${response.status()} ${response.ok()?'':await response.text()}`)
   t.diagnostic(await frame.locator('.dyoffice-pdf-persistence-state').getAttribute('title')??'No persistence error')
   throw error
  }
  const newFiles=await added()
  if(label!=='拆分 PDF')assert.ok((await workspace.listFiles(f.alice.token,{folderId:layoutFolder.id})).files.some(file=>file.id===newFiles[0].id&&file.name===label+'.pdf'))
  const pageCounts=[]
  for(const item of newFiles){
   const {file:saved}=await f.files.openFile(f.alice.token,item.id)
   const output=await PDFDocument.load(await f.files.readFile(f.alice.token,item.id,saved.revision))
   pageCounts.push(output.getPageCount())
   const outputFrame=page.locator(`iframe[data-document-id="${item.id}"]`)
   if(label==='拆分 PDF')await expect(outputFrame).toHaveCount(0)
   else await expect(outputFrame).toBeAttached()
  }
  if(label==='拆分 PDF')await expect(page.getByRole('tab',{name:'首页',exact:true})).toHaveAttribute('aria-selected','true')
  assert.deepEqual(pageCounts.sort((a,b)=>a-b),expected,label)
  assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,sourceRevision)
 }
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,sourceRevision),sourceBytes)
 await page.getByRole('tab',{name:'source.pdf',exact:true}).click()
 const targetFrame=page.frameLocator(`iframe[data-document-id="${file.fileId}"]`)
 const imported=await PDFDocument.create()
 imported.addPage([700,300]).drawText('Imported marker',{x:25,y:260})
 const importedBytes=Buffer.from(await imported.save())
 const chooser=page.waitForEvent('filechooser')
 await targetFrame.getByRole('button',{name:'导入页面',exact:true}).click()
 await targetFrame.getByLabel('选择来源 PDF', {exact:true}).click()
 const fileChooser=await chooser
 await fileChooser.setFiles({name:'import.pdf',mimeType:'application/pdf',buffer:importedBytes})
 const route='/api/v1/files/'+file.fileId
 const saved=page.waitForResponse(response=>{
  if(response.request().method()!=='POST')return false
  const path=new URL(response.url()).pathname
  return path===route+'/commits'||path===route+'/pdf/insert-pages/uploads'&&!response.ok()
 },{timeout:25000})
 await targetFrame.getByRole('button',{name:'确认导入并保存'}).click()
 const saveResponse=await saved
 assert.ok(saveResponse.ok(),await saveResponse.text())
 const {revision}=await saveResponse.json()
 const {file:inserted}=await f.files.openFile(f.alice.token,file.fileId)
 assert.equal(inserted.revision,revision)
 assert.notEqual(inserted.revision,sourceRevision)
 const insertedBytes=await f.files.readFile(f.alice.token,file.fileId,inserted.revision)
 const insertedDoc=await PDFDocument.load(insertedBytes)
 assert.equal(insertedDoc.getPageCount(),4)
 const insertedText=await (await import('../../../pdf/src/main/text-edit.ts')).readPdfLeafObjects(insertedBytes)
 assert.ok(insertedText.some(item=>item.type===1&&item.text.includes('Imported marker')))
 const pageTexts=execFileSync('pdftotext',['-','-'],{input:insertedBytes,encoding:'utf8'}).split('\f').map(text=>text.trim())
 assert.equal(pageTexts.filter(text=>text.includes('Imported marker')).length,1)
 assert.equal(pageTexts.filter(text=>text.includes('Source 400')).length,1)
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,sourceRevision),sourceBytes)
})

test('native PDF assistant replaces only the confirmed page and splits the saved result',{skip:!nativePdfDirectory,timeout:120000},async t=>{
 const port=4290,origin='http://localhost:'+port,f=await fileFixture(t,{origin,buildApp:false})
 const keyring={activeKeyId:'replace',keys:{replace:new Uint8Array(32).fill(37)}}
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{
  upserts:[{id:'fixture',kind:'chat',providerId:'openai',label:'Fixture',model:'synthetic',baseUrl:'https://provider.example/v1/chat/completions',apiKey:'fixture-key',enabled:true}],
  defaults:{chat:'fixture'},
 })
 const originalDoc=await PDFDocument.create()
 for(const width of [400,500,600])originalDoc.addPage([width,300]).drawText('Source '+width,{x:30,y:250})
 const retained={id:'fixture-static-text',kind:'text',pageIndex:2,rect:[50,70,140,97],text:'Retained entry'}
 await addStaticFills(originalDoc,[{...retained,id:'old-static-text',pageIndex:1,text:'Old entry'},retained])
 const original=Buffer.from(await originalDoc.save()),{file}=await importFile(f,f.alice.token,original,'replace-source.pdf')
 const app=await buildLocalApp({
  db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,
  globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false,nativePdfDirectory,
  localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url)),
 })
 f.cleanup.unshift(()=>app.close())
 await app.listen({port,host:'127.0.0.1'})
 const network=mockProviderNetwork(t,()=>{
  const {messages}=JSON.parse(network.wire.toString()),last=messages.at(-1)
  const content=messages.findLast(message=>message.role==='user')?.content
  const prompt=typeof content==='string'?content:content?.map(part=>part.text??'').join(' ')
  const split=prompt?.includes('每两页另存为副本')
  const action=split?{name:'split_pdf',arguments:'{"pages_per_file":2}'}:{name:'replace_pages',arguments:'{"pages":"2"}'}
  const result=last.role==='tool'?JSON.parse(last.content):undefined
  if(result){
   assert.ok(!result.isError,result.output)
   assert.match(result.output,split?/Saved and opened 2 PDF file/:/Replaced the selected pages and saved a new revision/)
  }
  const delta=result?{content:split?'已保存两个副本':'已保存替换页'}:{tool_calls:[{index:0,id:action.name,type:'function',function:action}]}
  return Readable.from([Buffer.from('data: '+JSON.stringify({choices:[{delta,finish_reason:result?'stop':'tool_calls'}]})+'\n\ndata: [DONE]\n\n')])
 })
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage()
 await stubHomeHero(page)
 await page.goto(origin)
 await page.getByLabel('用户名',{exact:true}).fill('alice')
 await page.getByLabel('密码',{exact:true}).fill(password)
 await page.getByRole('button',{name:'登录',exact:true}).click()
 await expect(page.locator('.home')).toBeVisible()
 await page.goto(origin+'/#/file/'+file.fileId)
 const frame=page.frameLocator(`iframe[data-document-id="${file.fileId}"]`)
 const assistant=frame.locator('.shared-editor-assistant')
 async function send(prompt){
  await expect(frame.locator('html')).toHaveAttribute('data-document-loading','ready',{timeout:30000})
  await expect(frame.locator('.dyoffice-pdf-persistence-state')).toHaveText('已保存')
  const composer=assistant.getByRole('textbox',{name:'消息'})
  if(!await composer.isVisible())await frame.getByRole('button',{name:'AI 助手',exact:true}).click()
  await composer.fill(prompt)
  await assistant.getByRole('button',{name:'发送',exact:true}).click()
 }
 await send('替换第二页')
 const dialog=frame.getByRole('dialog',{name:'替换第 2 页',exact:true})
 await expect(dialog).toBeVisible({timeout:20000})
 const confirm=dialog.getByRole('button',{name:'确认替换并保存'})
 await expect(confirm).toBeDisabled()
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
 const replacement=await PDFDocument.create()
 replacement.addPage([710,300]).drawText('Replacement marker',{x:25,y:260})
 await addStaticFills(replacement,[{...retained,pageIndex:0,text:'New entry'}])
 const replacementBytes=Buffer.from(await replacement.save())
 const {file:workspaceReplacement}=await importFile(f,f.alice.token,replacementBytes,'replacement.pdf')
 await dialog.getByRole('button',{name:'从工作区选择…',exact:true}).click()
 const picker=frame.getByRole('dialog',{name:'选择来源 PDF',exact:true})
 await picker.getByRole('listbox',{name:'工作区文件',exact:true}).selectOption(workspaceReplacement.fileId)
 const [readSource]=await Promise.all([
  page.waitForResponse(response=>new URL(response.url()).pathname===`/api/v1/files/${workspaceReplacement.fileId}/content`),
  picker.getByRole('button',{name:'使用所选文件',exact:true}).click(),
 ])
 assert.ok(readSource.ok())
 assert.equal(new URL(readSource.url()).searchParams.get('revision'),workspaceReplacement.revision)
 await expect(confirm).toBeEnabled()
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
 const stage=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/v1/files/'+file.fileId+'/pdf/replace-pages/uploads')
 await confirm.click()
 const staged=await stage
 assert.ok(staged.ok(),await staged.text())
 await expect(assistant.getByText('已保存替换页',{exact:true})).toBeAttached({timeout:30000})
 const {file:replaced}=await f.files.openFile(f.alice.token,file.fileId)
 assert.notEqual(replaced.revision,file.revision)
 const bytes=await f.files.readFile(f.alice.token,file.fileId,replaced.revision)
 const replacedDoc=await PDFDocument.load(bytes)
 assert.deepEqual(replacedDoc.getPages().map(value=>value.getWidth()),[400,710,600])
 const [oldFill,newFill]=staticFills(replacedDoc)
 assert.deepEqual(oldFill,retained)
 assert.notEqual(newFill.id,retained.id)
 assert.deepEqual(newFill,{...retained,id:newFill.id,pageIndex:1,text:'New entry'})
 const texts=execFileSync('pdftotext',['-','-'],{input:bytes,encoding:'utf8'}).split('\f').map(text=>text.trim()).filter(Boolean)
 assert.deepEqual(texts,['Source 400','Replacement marker','Source 600'])
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
 await page.reload({waitUntil:'commit'})
 await send('每两页另存为副本')
 await expect(assistant.getByText('已保存两个副本',{exact:true})).toBeAttached({timeout:30000})
 const files=(await f.files.listFiles(f.alice.token)).files
 assert.equal(files.length,4)
 for(const [part,widths] of [[1,[400,710]],[2,[600]]]){
  const copy=files.find(entry=>entry.name===`replace-source-part-${part}.pdf`)
  assert.ok(copy)
  const saved=(await f.files.openFile(f.alice.token,copy.id)).file
  const document=await PDFDocument.load(await f.files.readFile(f.alice.token,copy.id,saved.revision))
  assert.deepEqual(document.getPages().map(value=>value.getWidth()),widths)
  assert.deepEqual(staticFills(document),part===1?[newFill]:[{...retained,pageIndex:0}])
 }
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,replaced.revision)
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,replaced.revision),bytes)
 assert.equal((await f.files.openFile(f.alice.token,workspaceReplacement.fileId)).file.revision,workspaceReplacement.revision)
 assert.deepEqual(await f.files.readFile(f.alice.token,workspaceReplacement.fileId,workspaceReplacement.revision),replacementBytes)
 recordVerifiedOfficeEffect('pdf','replace_pages')
 recordVerifiedOfficeEffect('pdf','split_pdf')
})
