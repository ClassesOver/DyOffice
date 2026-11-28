import test from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {createServer} from 'node:http'
import {deflateSync} from 'node:zlib'
import JSZip from 'jszip'
import {PDFArray,PDFDict,PDFDocument,PDFHexString,PDFName,PDFRawStream,PDFString,degrees,rgb} from 'pdf-lib'
import {expect} from '@playwright/test'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {launchTestBrowser,recordVerifiedOfficeEffect} from '../helpers/browser.mjs'
import {password} from '../helpers/identity.mjs'
import {isHomeHeroRequest,stubHomeHero} from '../helpers/home-hero.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {createAssistantChannelService} from '../../server/src/modules/assistant-channel/service.ts'
import {fileURLToPath} from 'node:url'
import {readFile} from 'node:fs/promises'
import {Readable} from 'node:stream'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {readPdfLeafObjects} from '../../../pdf/src/main/text-edit.ts'
import {encryptDocument} from '../../../pdf/src/main/pdf-crypt.ts'
import {readImageSource} from '../../../pdf/src/main/image-edit.ts'
import {pdfInsertFormState} from '../../server/src/pdf/insert-form-integrity.mjs'
import {PNG} from 'pngjs'
import {renderPdfPages} from '../../server/src/pdf/raster.mjs'

const directory=process.env.DYOFFICE_TEST_NATIVE_PDF_DIST
const liveImageConfig=process.env.DYOFFICE_LIVE_PDF_IMAGE_CONFIG
test('native Web PDF reduces a saved file into a smaller copy',{skip:!directory,timeout:65000},async t=>{
 let app
 const server=createServer((req,res)=>app.routing(req,res))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
 const origin='http://localhost:'+server.address().port
 const f=await fileFixture(t,{origin,buildApp:false})
 await f.preferences.update(f.alice.token,{language:'en',autoSave:false,showAssistant:false})
 const pdf=await PDFDocument.create(),sheet=pdf.addPage([400,300])
 sheet.drawText('Keep selectable source text',{x:30,y:260})
 const uncompressed=deflateSync(Buffer.from('q Q\n'.repeat(25000)),{level:0})
 sheet.node.addContentStream(pdf.context.register(PDFRawStream.of(pdf.context.obj({Filter:'FlateDecode',Length:uncompressed.length}),uncompressed)))
 const scan=new PNG({width:3000,height:100});scan.data.fill(180)
 const image=await pdf.embedPng(PNG.sync.write(scan));sheet.drawImage(image,{x:30,y:100,width:300,height:10})
 const original=Buffer.from(await pdf.save()),{file}=await importFile(f,f.alice.token,original,'Scan draft.pdf')
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,nativePdfDirectory:directory})
 f.cleanup.unshift(()=>app.close())
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const context=await browser.newContext({viewport:{width:1420,height:900},acceptDownloads:true})
 const page=await context.newPage()
 const csrf=await(await page.request.get(origin+'/api/v1/auth/csrf')).json()
 assert.equal((await page.request.post(origin+'/api/v1/auth/login',{headers:{origin,'x-csrf-token':csrf.csrfToken},data:{username:'alice',password}})).status(),200)
 await page.goto(origin+'/native-pdf/?fileId='+file.fileId)
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready')
 await page.getByRole('button',{name:'Pages',exact:true}).click()
 await page.getByRole('button',{name:'Rotate right',exact:true}).click()
 const dirty=page.locator('.dyoffice-pdf-persistence-state')
 await expect(dirty).toHaveAttribute('data-dirty','true')
 const reduce=page.getByRole('button',{name:'Reduce file size',exact:true})
 await expect(reduce).toBeEnabled({timeout:2500})
 const [download]=await Promise.all([page.waitForEvent('download',{timeout:22000}),reduce.click()])
 assert.equal(download.suggestedFilename(),'Scan draft-small.pdf')
 const bytes=await readFile(await download.path()),copy=await PDFDocument.load(bytes)
 assert.ok(bytes.length<original.length/3)
 assert.equal(copy.getPageCount(),1)
 assert.equal(copy.getPage(0).getRotation().angle,0)
 assert.ok((await readPdfLeafObjects(bytes)).some(item=>item.type===1&&item.text.includes('Keep selectable source text')))
 assert.ok(copy.context.enumerateIndirectObjects().some(([,obj])=>obj instanceof PDFRawStream&&String(obj.dict.get(PDFName.of('Subtype')))==='/Image'&&String(obj.dict.get(PDFName.of('Width')))==='2480'))
 await expect(page.getByText(/Reduced by about \d+%/)).toBeVisible()
 await expect(dirty).toHaveAttribute('data-dirty','true')
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)

 const compact=(await importFile(f,f.alice.token,bytes,'compact.pdf')).file
 const fresh=await context.newPage()
 await fresh.goto(origin+'/native-pdf/?fileId='+compact.fileId)
 await expect(fresh.locator('html')).toHaveAttribute('data-document-loading','ready')
 await fresh.getByRole('button',{name:'Pages',exact:true}).click()
 const downloads=[]
 fresh.on('download',value=>downloads.push(value))
 await fresh.getByRole('button',{name:'Reduce file size',exact:true}).click()
 await expect(fresh.getByText('This file is already small; nothing to squeeze')).toBeVisible({timeout:18000})
 assert.deepEqual(downloads,[])
 assert.equal((await f.files.openFile(f.alice.token,compact.fileId)).file.revision,compact.revision)

 const currentCsrf=await(await page.request.get(origin+'/api/v1/auth/csrf')).json()
 const postReduction=(fileId,revision)=>page.request.post(origin+'/api/v1/files/'+fileId+'/pdf/reduce-size',{
  headers:{origin,'x-csrf-token':currentCsrf.csrfToken},data:{revision},
 })
 assert.equal((await postReduction(file.fileId,compact.revision)).status(),409)
 const form=await PDFDocument.create()
 form.addPage([300,300])
 const fields=form.getForm()
 fields.acroForm.dict.set(PDFName.of('XFA'),form.context.register(form.context.flateStream('<xdp/>')))
 const unsupported=(await importFile(f,f.alice.token,Buffer.from(await form.save({updateFieldAppearances:false})),'xfa.pdf')).file
 assert.equal((await postReduction(unsupported.fileId,unsupported.revision)).status(),400)
})

test('native Web PDF ribbon imports fillable pages with duplicate field names',{skip:!directory,timeout:90000},async t=>{
 let app
 const server=createServer((req,res)=>app.routing(req,res))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
 const origin='http://localhost:'+server.address().port,f=await fileFixture(t,{origin,buildApp:false})
 await f.preferences.update(f.alice.token,{language:'en',autoSave:false,showAssistant:false})
 const target=await PDFDocument.create(),targetPage=target.addPage([400,300])
 targetPage.drawText('Target page')
 const existing=target.getForm().createTextField('contact')
 existing.addToPage(targetPage,{x:35,y:200,width:150,height:20});existing.setText('Existing name')
 const original=Buffer.from(await target.save()),{file}=await importFile(f,f.alice.token,original,'destination.pdf')
 const donor=await PDFDocument.create(),source=donor.addPage([400,300]),form=donor.getForm()
 const field=form.createTextField('contact')
 field.addToPage(source,{x:35,y:200,width:150,height:20});field.setText('Taylor Chen')
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,nativePdfDirectory:directory})
 f.cleanup.unshift(()=>app.close())
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1420,height:1000}})
 const csrf=await(await page.request.get(origin+'/api/v1/auth/csrf')).json()
 assert.equal((await page.request.post(origin+'/api/v1/auth/login',{headers:{origin,'x-csrf-token':csrf.csrfToken},data:{username:'alice',password}})).status(),200)
 await page.goto(origin+'/native-pdf/?fileId='+file.fileId)
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready')
 await page.getByRole('button',{name:'Pages',exact:true}).click()
 await page.getByRole('button',{name:'Import pages',exact:true}).click()
 const dialog=page.getByRole('dialog',{name:'Import PDF pages',exact:true})
 await dialog.getByLabel('Choose source PDF').setInputFiles({name:'form.pdf',mimeType:'application/pdf',buffer:Buffer.from(await donor.save())})
 const head=async()=>(await f.files.openFile(f.alice.token,file.fileId)).file.revision
 await dialog.getByRole('button',{name:'Import and save',exact:true}).click()
 await expect.poll(head,{timeout:20000}).not.toBe(file.revision)
 const importedRevision=await head(),contact=page.locator('.pdf-form-layer input[title="contact_2"]')
 await expect(contact).toHaveValue('Taylor Chen',{timeout:15000})
 await contact.fill('Grace Hopper')
 await expect(page.locator('.dyoffice-pdf-persistence-state')).toHaveAttribute('data-dirty','true')
 await page.keyboard.press('Control+s')
 await expect.poll(head,{timeout:18000}).not.toBe(importedRevision)
 const saved=await PDFDocument.load(await f.files.readFile(f.alice.token,file.fileId,await head()))
 const savedField=saved.getForm().getTextField('contact_2')
 assert.equal(saved.getPageCount(),2)
 assert.equal(savedField.getText(),'Grace Hopper')
 assert.equal(saved.getForm().getTextField('contact').getText(),'Existing name')
 assert.deepEqual(savedField.acroField.getWidgets().map(widget=>String(widget.P())),[String(saved.getPage(1).ref)])
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
})

test('native Web PDF ribbon replaces and imports local pages with revision undo',{skip:!directory,timeout:90000},async t=>{
 let app
 const server=createServer((req,res)=>app.routing(req,res))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
 const origin='http://localhost:'+server.address().port
 const f=await fileFixture(t,{origin,buildApp:false})
 await f.preferences.update(f.alice.token,{language:'en',autoSave:false,showAssistant:false})
 const pdf=await PDFDocument.create(),replacement=await PDFDocument.create()
 for(const width of [400,500,600,700,800])pdf.addPage([width,300]).drawText('Original '+width,{x:35,y:250})
 for(const width of [310,320])replacement.addPage([width,300]).drawText('Replacement '+width,{x:35,y:250})
 const originalForm=pdf.getForm(),customer=originalForm.createTextField('customer')
 for(const index of [2,3])customer.addToPage(pdf.getPage(index),{x:35,y:105,width:140,height:20})
 customer.setText('Ada Lovelace')
 const removedField=originalForm.createTextField('obsolete')
 removedField.addToPage(pdf.getPage(4),{x:35,y:105,width:140,height:20})
 removedField.setText('Removed with the page')
 const existingFrom=pdf.getPage(1)
 existingFrom.node.addAnnot(pdf.context.register(pdf.context.obj({
  Type:'Annot',Subtype:'Link',Rect:[30,236,160,275],Dest:[2,'Fit'],
 })))
 const [replacementFrom,replacementTo]=replacement.getPages()
 replacementFrom.node.addAnnot(replacement.context.register(replacement.context.obj({
  Type:'Annot',Subtype:'Link',Rect:[30,236,190,274],Dest:[replacementTo.ref,'Fit'],
 })))
 const original=Buffer.from(await pdf.save())
 const {file}=await importFile(f,f.alice.token,original,'replace-ribbon.pdf')
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,nativePdfDirectory:directory})
 f.cleanup.unshift(()=>app.close())
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1420,height:900}})
 const errors=[],saveResponses=[]
 page.on('pageerror',error=>errors.push(error.message))
 page.on('response',response=>{
  const path=new URL(response.url()).pathname
  if(path.endsWith('/pdf/apply-ops')||path.endsWith('/commits'))saveResponses.push([path.split('/').at(-1),response.status()])
 })
 const csrf=await(await page.request.get(origin+'/api/v1/auth/csrf')).json()
 assert.equal((await page.request.post(origin+'/api/v1/auth/login',{headers:{origin,'x-csrf-token':csrf.csrfToken},data:{username:'alice',password}})).status(),200)
 await page.goto(origin+'/native-pdf/?fileId='+file.fileId)
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready')
 await page.getByRole('button',{name:'Pages',exact:true}).click()
 const action=page.getByRole('button',{name:'Replace pages',exact:true})
 const head=async()=>(await f.files.openFile(f.alice.token,file.fileId)).file.revision
 const readSaved=async revision=>PDFDocument.load(await f.files.readFile(f.alice.token,file.fileId,revision))
 const widths=async revision=>(await readSaved(revision)).getPages().map(p=>p.getWidth())
 const verifyForm=async(revision,pageIndex)=>{
  const saved=await readSaved(revision),form=saved.getForm()
  assert.deepEqual(form.getFields().map(field=>field.getName()),['customer'])
  const field=form.getTextField('customer')
  assert.equal(field.getText(),'Ada Lovelace')
  assert.deepEqual(field.acroField.getWidgets().map(widget=>String(widget.P())),[String(saved.getPage(pageIndex).ref)])
 }
 async function verifySavedJump(revision,from,to){
  const stored=await PDFDocument.load(await f.files.readFile(f.alice.token,file.fileId,revision))
  const annotation=stored.getPage(from).node.Annots().lookup(0,PDFDict)
  assert.equal(String(annotation.lookup(PDFName.of('Dest'),PDFArray).get(0)),String(stored.getPage(to).ref))
 }
 async function chooseTargets(range){
  await action.click()
  const targets=page.getByPlaceholder(/Pages to replace/)
  await targets.fill(range)
  await targets.press('Enter')
  return page.getByRole('dialog',{name:`Replace pages ${range.replace(',', ', ')}`,exact:true})
 }
 const canceled=await chooseTargets('2')
 try{await expect(canceled).toBeVisible({timeout:10000})}
 catch(error){
  t.diagnostic(JSON.stringify({errors,dialogs:await page.locator('dialog,.pdf-modal,.pdf-toast').allTextContents(),status:await page.locator('.dyoffice-pdf-persistence-state').getAttribute('title')}))
  throw error
 }
 await canceled.getByRole('button',{name:'Cancel',exact:true}).click()
 assert.equal(await head(),file.revision)

 await page.getByRole('button',{name:'Delete page',exact:true}).click()
 await expect(page.locator('.dyoffice-pdf-persistence-state')).toHaveAttribute('data-dirty','true')
 const dialog=await chooseTargets('2,4')
 try{await expect(dialog).toBeVisible({timeout:12000})}
 catch(error){
  t.diagnostic(JSON.stringify({errors,saveResponses,dialogs:await page.locator('dialog,.pdf-modal,.pdf-toast').allTextContents()}))
  throw error
 }
 const flushed=await head()
 assert.notEqual(flushed,file.revision)
 assert.deepEqual(await widths(flushed),[500,600,700,800])
 await verifySavedJump(flushed,0,1)
 const confirm=dialog.getByRole('button',{name:'Replace and save',exact:true})
 await expect(confirm).toBeDisabled()
 await dialog.getByLabel('Choose source PDF').setInputFiles({name:'replacement.pdf',mimeType:'application/pdf',buffer:Buffer.from(await replacement.save())})
 await confirm.click()
 await expect.poll(head,{timeout:12000}).not.toBe(flushed)
 assert.deepEqual(await widths(await head()),[500,310,320,700])
 await verifySavedJump(await head(),0,1)
 await verifySavedJump(await head(),1,2)
 await expect(action).toBeEnabled()
 await expect(page.locator('.dyoffice-pdf-persistence-state')).toHaveAttribute('data-dirty','false')

 const importAction=page.getByRole('button',{name:'Import pages',exact:true})
 const importDialog=page.getByRole('dialog',{name:'Import PDF pages',exact:true})
 const replaced=await head()
 await verifyForm(replaced,3)
 await importAction.click()
 await expect(importDialog).toBeVisible({timeout:8000})
 await importDialog.getByRole('button',{name:'Cancel',exact:true}).click()
 assert.equal(await head(),replaced)

 await page.getByRole('button',{name:'Delete page',exact:true}).click()
 await expect(page.locator('.dyoffice-pdf-persistence-state')).toHaveAttribute('data-dirty','true')
 await importAction.click()
 await expect(importDialog.getByText(/after page 1/)).toBeVisible({timeout:12000})
 const importBase=await head()
 assert.notEqual(importBase,replaced)
 assert.deepEqual(await widths(importBase),[310,320,700])
 const source=await PDFDocument.create()
 for(const width of [210,220])source.addPage([width,300]).drawText('Imported '+width,{x:35,y:250})
 const [importFrom,importTo]=source.getPages()
 const importName=PDFString.of('Imported second page')
 source.catalog.set(PDFName.of('Names'),source.context.obj({
  Dests:{Names:[importName,[importTo.ref,'XYZ',0,280,null]]},
 }))
 importFrom.node.addAnnot(source.context.register(source.context.obj({
  Type:'Annot',Subtype:'Link',Rect:[30,236,190,274],Dest:importName,
 })))
 const sourceFile={name:'import.pdf',mimeType:'application/pdf',buffer:Buffer.from(await source.save())}
 await importDialog.getByLabel('Choose source PDF').setInputFiles(sourceFile)
 await importDialog.getByRole('button',{name:'Import and save',exact:true}).click()
 await expect.poll(head,{timeout:12000}).not.toBe(importBase)
 assert.deepEqual(await widths(await head()),[310,210,220,320,700])
 await expect(importAction).toBeEnabled()
 await expect(page.locator('.dyoffice-pdf-persistence-state')).toHaveAttribute('data-dirty','false')

 const imported=await head()
 await verifyForm(imported,4)
 await verifySavedJump(imported,1,2)
 const thumbnails=page.locator('.pdf-thumbs')
 await thumbnails.evaluate(list=>{list.scrollTop=0})
 await thumbnails.click({button:'right',position:{x:4,y:4}})
 await page.locator('.thumb-menu').getByRole('button',{name:'Import pages',exact:true}).click()
 await expect(importDialog.getByText(/before the first page/)).toBeVisible()
 await importDialog.getByLabel('Choose source PDF').setInputFiles(sourceFile)
 await importDialog.getByRole('button',{name:'Import and save',exact:true}).click()
 await expect.poll(head,{timeout:12000}).not.toBe(imported)
 assert.deepEqual(await widths(await head()),[210,220,310,210,220,320,700])
 await expect(importAction).toBeEnabled()
 const prepended=await head()
 await verifyForm(prepended,6)
 const undo=page.getByRole('button',{name:/^Undo \(/})
 const redo=page.getByRole('button',{name:/^Redo \(/})
 const csrfForHistory=await(await page.request.get(origin+'/api/v1/auth/csrf')).json()
 async function replay(button,target,parent){
  await expect(button).toBeEnabled({timeout:3500})
  await button.click()
  await expect.poll(head,{timeout:12000}).not.toBe(parent)
  const restored=await head()
  assert.notEqual(restored,target)
  assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,restored),await f.files.readFile(f.alice.token,file.fileId,target))
  const response=await page.request.get(origin+'/api/v1/files/'+file.fileId+'/revisions',{headers:{'x-csrf-token':csrfForHistory.csrfToken}})
  assert.ok(response.ok())
  const receipt=(await response.json()).revisions.find(row=>row.revision===restored)
  assert.ok(receipt)
  assert.equal(receipt.parentRevision,parent)
  assert.equal(receipt.restoredFrom,target)
  await expect(importAction).toBeEnabled()
  return restored
 }
 const undidPrepend=await replay(undo,imported,prepended)
 const undidImport=await replay(undo,importBase,undidPrepend)
 await expect(undo).toBeDisabled()
 const redidImport=await replay(redo,imported,undidImport)
 const redidPrepend=await replay(redo,prepended,redidImport)
 await expect(redo).toBeDisabled()
 await page.getByRole('button',{name:'Rotate right',exact:true}).click()
 const dirty=page.locator('.dyoffice-pdf-persistence-state')
 await expect(dirty).toHaveAttribute('data-dirty','true')
 await undo.click()
 await expect(dirty).toHaveAttribute('data-dirty','false')
 assert.equal(await head(),redidPrepend)
 await replay(undo,imported,redidPrepend)
 await page.getByRole('button',{name:'Home',exact:true}).click()
 await page.locator('.pdf-page[data-page="1"] .pdf-link').click()
 await expect(page.locator('.tb-page-input')).toHaveValue('3')
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
 assert.deepEqual(errors,[])
})

test('native Web PDF ribbon crops and resizes saved form pages',{skip:!directory,timeout:70000},async t=>{
 let app
 const server=createServer((req,res)=>app.routing(req,res))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
 const origin='http://localhost:'+server.address().port
 const f=await fileFixture(t,{origin,buildApp:false})
 await f.preferences.update(f.alice.token,{language:'en',autoSave:false,showAssistant:false})
 const pdf=await PDFDocument.create()
 for(const width of [400,500])pdf.addPage([width,300]).drawText('Original page '+width,{x:120,y:200})
 const customer=pdf.getForm().createTextField('customer')
 customer.setText('Ada Lovelace')
 customer.addToPage(pdf.getPage(0),{x:140,y:80,width:150,height:28})
 const original=Buffer.from(await pdf.save())
 const {file}=await importFile(f,f.alice.token,original,'geometry.pdf')
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,nativePdfDirectory:directory})
 f.cleanup.unshift(()=>app.close())
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1420,height:900}})
 const errors=[]
 page.on('pageerror',error=>errors.push(error.message))
 const csrf=await(await page.request.get(origin+'/api/v1/auth/csrf')).json()
 assert.equal((await page.request.post(origin+'/api/v1/auth/login',{headers:{origin,'x-csrf-token':csrf.csrfToken},data:{username:'alice',password}})).status(),200)
 await page.goto(origin+'/native-pdf/?fileId='+file.fileId)
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready')
 const ribbon=page.getByRole('button',{name:'Pages',exact:true})
 const cropButton=page.getByRole('button',{name:'Crop pages',exact:true})
 const dialog=page.getByRole('dialog')
 const selectCrop=async()=>{
  await cropButton.click()
  const preview=dialog.locator('img')
  await expect(preview).toBeVisible()
  const box=await preview.boundingBox()
  await page.mouse.move(box.x+1,box.y+1)
  await page.mouse.down()
  await page.mouse.move(box.x+box.width/4,box.y+box.height/5,{steps:5})
  await page.mouse.up()
 }
 const head=async()=>(await f.files.openFile(f.alice.token,file.fileId)).file.revision
 const saved=async revision=>PDFDocument.load(await f.files.readFile(f.alice.token,file.fileId,revision))
 await ribbon.click()
 await selectCrop()
 await dialog.getByRole('button',{name:'Apply',exact:true}).click()
 await expect.poll(head,{timeout:12000}).not.toBe(file.revision)
 const croppedRevision=await head(),cropped=await saved(croppedRevision)
 assert.equal(cropped.getForm().getTextField('customer').getText(),'Ada Lovelace')
 const kept=cropped.getPage(0).getCropBox()
 assert.ok(Math.abs(kept.x-100)<2&&Math.abs(kept.height-240)<2,JSON.stringify(kept))
 assert.deepEqual(cropped.getPage(1).getCropBox(),{x:0,y:0,width:500,height:300})
 await expect(cropButton).toBeEnabled()

 await page.getByRole('button',{name:'Rotate right',exact:true}).click()
 await expect(page.locator('.dyoffice-pdf-persistence-state')).toHaveAttribute('data-dirty','true')
 await page.getByRole('button',{name:'Page size',exact:true}).click()
 await page.locator('.pdf-modal').getByRole('button',{name:'A5',exact:true}).click()
 await expect.poll(async()=>{
  const current=await saved(await head())
  return current.getPages().map(p=>[p.getWidth(),p.getHeight(),p.getRotation().angle])
 },{timeout:18000}).toEqual([[595,420,90],[420,595,0]])
 assert.equal((await saved(await head())).getForm().getTextField('customer').getText(),'Ada Lovelace')
 await expect(cropButton).toBeEnabled()
 await expect(page.locator('.dyoffice-pdf-persistence-state')).toHaveAttribute('data-dirty','false')

 const resizedRevision=await head()
 await page.getByRole('button',{name:'Rotate right',exact:true}).click()
 await selectCrop()
 await page.keyboard.press('Control+s')
 await expect.poll(head,{timeout:12000}).not.toBe(resizedRevision)
 await expect(page.locator('.dyoffice-pdf-persistence-state')).toHaveAttribute('data-dirty','false')
 const rotatedRevision=await head()
 await dialog.getByRole('button',{name:'Apply',exact:true}).click()
 await expect(page.getByText('The page changed. Open the crop preview again.',{exact:true})).toBeVisible()
 assert.equal(await head(),rotatedRevision)
 const input=page.locator('.pdf-form-layer input[title="customer"]')
 await expect(input).toHaveValue('Ada Lovelace')
 await input.fill('Grace Hopper')
 await expect(page.locator('.dyoffice-pdf-persistence-state')).toHaveAttribute('data-dirty','true')
 await page.keyboard.press('Control+s')
 await expect.poll(head,{timeout:14000}).not.toBe(rotatedRevision)
 assert.equal((await saved(await head())).getForm().getTextField('customer').getText(),'Grace Hopper')
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
 assert.deepEqual(errors,[])
})

test('native Web PDF converts to editable Word Excel and PowerPoint downloads',{skip:!directory,timeout:90000},async t=>{
 let app
 const server=createServer((req,res)=>app.routing(req,res))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
 const origin='http://localhost:'+server.address().port
 const f=await fileFixture(t,{origin,buildApp:false})
 await f.preferences.update(f.alice.token,{language:'en',autoSave:false,showAssistant:false})
 const pdf=await PDFDocument.create()
 pdf.addPage([600,800]).drawText('Quarterly revenue example',{x:65,y:710,size:18})
 const original=Buffer.from(await pdf.save())
 const {file}=await importFile(f,f.alice.token,original,'Quarterly report.pdf')
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,nativePdfDirectory:directory,assistantChannels:true})
 f.cleanup.unshift(()=>app.close())
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1420,height:820},acceptDownloads:true})
 const csrf=await(await page.request.get(origin+'/api/v1/auth/csrf')).json()
 assert.equal((await page.request.post(origin+'/api/v1/auth/login',{headers:{origin,'x-csrf-token':csrf.csrfToken},data:{username:'alice',password}})).status(),200)
 await page.goto(origin+'/native-pdf/?fileId='+file.fileId)
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready')
 for(const [label,extension,part] of [
  ['Word','docx','word/document.xml'],
  ['Excel','xlsx','xl/worksheets/sheet1.xml'],
  ['PPT','pptx','ppt/slides/slide1.xml'],
 ]){
  await page.getByRole('button',{name:'PDF Converter',exact:true}).click()
  const action=page.getByRole('button',{name:'PDF to '+label,exact:true})
  await expect(action).toBeEnabled({timeout:2000})
  const [download]=await Promise.all([page.waitForEvent('download',{timeout:35000}),action.click()])
  assert.equal(download.suggestedFilename(),'Quarterly report.'+extension)
  const result=await JSZip.loadAsync(await readFile(await download.path()))
  assert.match(await result.file(part).async('string'),/Quarterly revenue example/)
 }
 for(const [label,extension] of [['Markdown','md'],['HTML','html']]){
  await page.getByRole('button',{name:'PDF Converter',exact:true}).click()
  const action=page.getByRole('button',{name:'PDF to '+label,exact:true})
  await expect(action).toBeEnabled({timeout:2000})
  const [download]=await Promise.all([page.waitForEvent('download',{timeout:35000}),action.click()])
  assert.equal(download.suggestedFilename(),'Quarterly report.'+extension)
  const result=await readFile(await download.path(),'utf8')
  assert.match(result,/Quarterly revenue example/)
  if(extension==='html')assert.match(result,/<title>Quarterly report<\/title>/)
 }
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)

 await page.getByRole('button',{name:'Pages',exact:true}).click()
 await page.getByRole('button',{name:'Rotate right',exact:true}).click()
 await expect(page.locator('.dyoffice-pdf-persistence-state')).toHaveAttribute('data-dirty','true')
 await page.getByRole('button',{name:'Home',exact:true}).click()
 await page.getByRole('button',{name:'PDF Converter',exact:true}).click()
 const converted=page.waitForRequest(request=>new URL(request.url()).pathname.endsWith('/pdf/convert-office'))
 const [draftDownload]=await Promise.all([
  page.waitForEvent('download',{timeout:35000}),page.getByRole('button',{name:'PDF to PPT',exact:true}).click(),
 ])
 assert.equal(draftDownload.suggestedFilename(),'Quarterly report.pptx')
 const request=(await converted).postDataJSON()
 assert.equal(request.revision,file.revision)
 assert.deepEqual(request.snapshot.rotations,{'0':90})
 const convertedDraft=await JSZip.loadAsync(await readFile(await draftDownload.path()))
 assert.match(await convertedDraft.file('ppt/presentation.xml').async('string'),/<p:sldSz\b[^>]*cx="10160000"[^>]*cy="7620000"/)
 await expect(page.locator('.dyoffice-pdf-persistence-state')).toHaveAttribute('data-dirty','true')
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)

 const other=await browser.newContext()
 try {
  const challenge=await(await other.request.get(origin+'/api/v1/auth/csrf')).json()
  assert.equal((await other.request.post(origin+'/api/v1/auth/login',{
   headers:{origin,'x-csrf-token':challenge.csrfToken},data:{username:'bob',password},
  })).status(),200)
  const proof=await(await other.request.get(origin+'/api/v1/auth/session-proof')).json()
  const denied=await other.request.post(origin+'/api/v1/files/'+file.fileId+'/pdf/convert-office',{
   headers:{origin,'x-csrf-token':proof.csrfToken},data:{revision:file.revision,format:'docx'},
  })
  assert.equal(denied.status(),404)
 } finally { await other.close() }

 const protectedPdf=await PDFDocument.create()
 protectedPdf.addPage().drawText('Owner-authorized conversion')
 encryptDocument(protectedPdf,{
  userPassword:'',ownerPassword:'export-owner',
  permissions:{printing:true,modifying:false,annotating:false,copying:false},
 })
 const protectedBytes=Buffer.from(await protectedPdf.save({useObjectStreams:false}))
 const protectedId=randomUUID(),protectedRevision=randomUUID(),owner=f.alice.user.id
 const stored=await f.objects.putImmutable(`${f.deploymentId}/${owner}/objects/${protectedRevision}`,protectedBytes)
 // Upload policy forbids encrypted PDFs. Exercise an already stored revision.
 await f.ownerDb.transaction(async db=>{
  await db.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true)",[f.deploymentId,owner])
  const {rows:[workspace]}=await db.query('SELECT id FROM workspaces WHERE deployment_id=$1 AND owner_id=$2',[f.deploymentId,owner])
  await db.query("INSERT INTO files(id,deployment_id,owner_id,workspace_id,name,format,current_revision) VALUES($1,$2,$3,$4,'Protected report.pdf','pdf',$5)",[protectedId,f.deploymentId,owner,workspace.id,protectedRevision])
  await db.query('INSERT INTO file_revisions(id,deployment_id,owner_id,file_id,object_key,sha256,size) VALUES($1,$2,$3,$4,$5,$6,$7)',[protectedRevision,f.deploymentId,owner,protectedId,stored.key,stored.sha256,stored.size])
 })
 await page.goto(origin+'/native-pdf/?fileId='+protectedId)
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready')
 await page.getByRole('button',{name:'PDF Converter',exact:true}).click()
 await page.getByRole('button',{name:'PDF to Word',exact:true}).click()
 const authorization=page.getByRole('dialog',{name:'Enter the PDF owner password'})
 await expect(authorization).toBeVisible()
 await authorization.locator('input').fill('incorrect')
 await authorization.getByRole('button',{name:'Convert',exact:true}).click()
 await expect(authorization.getByRole('alert')).toBeVisible()
 await authorization.locator('input').fill('export-owner')
 const [authorized]=await Promise.all([
  page.waitForEvent('download',{timeout:35000}),authorization.getByRole('button',{name:'Convert',exact:true}).click(),
 ])
 assert.equal(authorized.suggestedFilename(),'Protected report.docx')
 const authorizedDocx=await JSZip.loadAsync(await readFile(await authorized.path()))
 assert.match(await authorizedDocx.file('word/document.xml').async('string'),/Owner-authorized conversion/)
 assert.deepEqual(await f.files.readFile(f.alice.token,protectedId,protectedRevision),protectedBytes)

 const channels=createAssistantChannelService({transactions:f.transactions,credentialKey:f.csrfKey})
 const {conversationId}=await channels.createConversation(f.alice.token,{fileId:file.fileId})
 const {memberToken}=await channels.issueDshToken(f.alice.token,conversationId,60,false,true)
 const {ticket}=await channels.issueEditTicket(memberToken,file.fileId,undefined)
 const guest=await browser.newContext()
 try {
  const redeemed=await guest.request.post(origin+'/dsh-edit/redeem',{headers:{origin},data:{ticket}})
  assert.equal(redeemed.status(),200)
  const referer=origin+(await redeemed.json()).url
  const proof=await(await guest.request.get(origin+'/api/v1/auth/session-proof',{headers:{referer}})).json()
  const convert=(id,revision)=>guest.request.post(origin+'/api/v1/files/'+id+'/pdf/convert-office',{
   headers:{origin,referer,'x-csrf-token':proof.csrfToken},data:{revision,format:'docx'},
  })
  const result=await convert(file.fileId,file.revision)
  assert.equal(result.status(),200)
  const guestDocx=await JSZip.loadAsync(await result.body())
  assert.match(await guestDocx.file('word/document.xml').async('string'),/Quarterly revenue example/)
  assert.equal((await convert(protectedId,protectedRevision)).status(),404)
 } finally { await guest.close() }
})

test('native Web PDF opens an internal link at its explicit destination',{skip:!directory,timeout:60000},async t=>{
 let app
 const server=createServer((req,res)=>app.routing(req,res))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
 const origin='http://localhost:'+server.address().port
 const f=await fileFixture(t,{origin,buildApp:false})
 await f.preferences.update(f.alice.token,{language:'en',autoSave:false})
 const pdf=await PDFDocument.create()
 const source=pdf.addPage([600,800]),target=pdf.addPage([600,2400])
 pdf.addPage([600,800])
 source.drawText('Go to the marked location',{x:60,y:718,size:17})
 target.drawText('Marked location',{x:60,y:280,size:20})
 const link=pdf.context.register(pdf.context.obj({
  Type:'Annot',Subtype:'Link',Rect:[55,702,478,745],Border:[0,0,0],
  Dest:[target.ref,PDFName.of('XYZ'),0,300,null],
 }))
 source.node.set(PDFName.of('Annots'),pdf.context.obj([link]))
 const {file}=await importFile(f,f.alice.token,Buffer.from(await pdf.save()),'internal-link.pdf')
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,nativePdfDirectory:directory})
 f.cleanup.unshift(()=>app.close())
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1280,height:720}})
 const csrf=await(await page.request.get(origin+'/api/v1/auth/csrf')).json()
 assert.equal((await page.request.post(origin+'/api/v1/auth/login',{headers:{origin,'x-csrf-token':csrf.csrfToken},data:{username:'alice',password}})).status(),200)
 await page.goto(origin+'/native-pdf/?fileId='+file.fileId)
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready')
 await page.locator('.pdf-page[data-page="0"] .pdf-link').click()
 const markedLocation=page.locator('.pdf-page[data-page="1"] .textLayer').getByText('Marked location',{exact:true})
 await expect(markedLocation).toBeInViewport()
 await expect.poll(()=>markedLocation.evaluate(mark=>Math.abs(
  mark.getBoundingClientRect().top-document.querySelector('.pdf-scroll').getBoundingClientRect().top,
 ))).toBeLessThan(60)
})

test('native Web PDF Save As creates a workspace copy of unsaved page changes',{skip:!directory,timeout:60000},async t=>{
 let app
 const server=createServer((req,res)=>app.routing(req,res))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
 const origin='http://localhost:'+server.address().port
 const f=await fileFixture(t,{origin,buildApp:false})
 await f.preferences.update(f.alice.token,{language:'en',autoSave:false,showAssistant:false})
 const pdf=await PDFDocument.create()
 pdf.addPage([240,300]).drawText('Source page')
 const original=Buffer.from(await pdf.save())
 const {file}=await importFile(f,f.alice.token,original,'manual-save-as.pdf')
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,nativePdfDirectory:directory})
 f.cleanup.unshift(()=>app.close())
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1280,height:720}})
 const csrf=await(await page.request.get(origin+'/api/v1/auth/csrf')).json()
 assert.equal((await page.request.post(origin+'/api/v1/auth/login',{headers:{origin,'x-csrf-token':csrf.csrfToken},data:{username:'alice',password}})).status(),200)
 await page.goto(origin+'/native-pdf/?fileId='+file.fileId)
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready')
 const dialog=page.getByRole('dialog',{name:'Save a copy to your workspace'})
 const name=dialog.getByRole('textbox',{name:'File name'})
 const openSaveAs=async()=>{
  await page.getByRole('button',{name:'File',exact:true}).click()
  const saveAs=page.locator('#pdf-web-file-menu').getByRole('button',{name:/^Save As/})
  await expect(saveAs).toBeEnabled()
  await saveAs.click()
  await expect(name).toHaveValue('manual-save-as.pdf')
 }
 await openSaveAs()
 await name.fill('Unedited copy')
 await dialog.getByRole('button',{name:'Save copy',exact:true}).click()
 await expect(page.getByText('Saved copy: Unedited copy.pdf',{exact:true})).toBeVisible({timeout:15000})
 const unedited=(await f.files.listFiles(f.alice.token)).files.find(item=>item.name==='Unedited copy.pdf')
 assert.ok(unedited)
 assert.deepEqual(await f.files.readFile(f.alice.token,unedited.id,unedited.revision),original)
 await page.getByRole('button',{name:'Pages',exact:true}).click()
 await page.getByRole('button',{name:'Rotate right',exact:true}).click()
 const persistence=page.locator('.dyoffice-pdf-persistence-state')
 await expect(persistence).toHaveAttribute('data-dirty','true')
 await openSaveAs()
 await dialog.getByRole('button',{name:'Cancel',exact:true}).click()
 await expect(dialog).toHaveCount(0)
 assert.equal((await f.files.listFiles(f.alice.token)).files.length,2)
 await page.keyboard.press('ControlOrMeta+Shift+s')
 await name.fill('Rotated copy')
 await dialog.getByRole('button',{name:'Save copy',exact:true}).click()
 await expect.poll(async()=>(await f.files.listFiles(f.alice.token)).files.length).toBe(3)
 const copy=(await f.files.listFiles(f.alice.token)).files.find(item=>item.name==='Rotated copy.pdf')
 assert.ok(copy)
 const stored=await PDFDocument.load(await f.files.readFile(f.alice.token,copy.id,copy.revision))
 assert.equal(stored.getPage(0).getRotation().angle,90)
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
 await expect(persistence).toHaveAttribute('data-dirty','true')
})

test('native Web PDF exports A0 pages as PNG and JPG after saving rotations',{skip:!directory,timeout:65000},async t=>{
 let app
 const server=createServer((req,res)=>app.routing(req,res))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
 const origin='http://localhost:'+server.address().port
 const f=await fileFixture(t,{origin,buildApp:false})
 await f.preferences.update(f.alice.token,{language:'en',autoSave:false,showAssistant:false})
 const pdf=await PDFDocument.create()
 pdf.addPage([2384,3370]).drawRectangle({x:0,y:0,width:2384,height:3370,color:rgb(1,0,0)})
 pdf.addPage([240,300]).drawRectangle({x:0,y:0,width:240,height:300,color:rgb(0,0,1)})
 pdf.addPage([3600,4800]).drawRectangle({x:0,y:0,width:3600,height:4800,color:rgb(0,1,0)})
 const original=Buffer.from(await pdf.save())
 const {file}=await importFile(f,f.alice.token,original,'Large plan.pdf')
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,nativePdfDirectory:directory})
 f.cleanup.unshift(()=>app.close())
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:900},acceptDownloads:true})
 const csrf=await(await page.request.get(origin+'/api/v1/auth/csrf')).json()
 assert.equal((await page.request.post(origin+'/api/v1/auth/login',{headers:{origin,'x-csrf-token':csrf.csrfToken},data:{username:'alice',password}})).status(),200)
 await page.goto(origin+'/native-pdf/?fileId='+file.fileId)
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready')
 await page.getByRole('button',{name:'Pages',exact:true}).click()
 await page.getByRole('button',{name:'Rotate right',exact:true}).click()
 await expect(page.locator('.dyoffice-pdf-persistence-state')).toHaveAttribute('data-dirty','true')
 await page.getByRole('button',{name:'Home',exact:true}).click()
 for(const format of ['png','jpg']){
  await page.getByRole('button',{name:'PDF Converter',exact:true}).click()
  const action=page.getByRole('button',{name:`Export as ${format.toUpperCase()}`,exact:true})
  const [download]=await Promise.all([page.waitForEvent('download',{timeout:17000}),action.click()])
  assert.equal(download.suggestedFilename(),`Large plan-${format}.zip`)
  const zip=await JSZip.loadAsync(await readFile(await download.path()))
  assert.deepEqual(Object.keys(zip.files),[1,2,3].map(number=>`Large plan-0${number}.${format}`))
  const big=await zip.file(`Large plan-01.${format}`).async('nodebuffer')
  const small=await zip.file(`Large plan-02.${format}`).async('nodebuffer')
  const limited=await zip.file(`Large plan-03.${format}`).async('nodebuffer')
  if(format==='png'){
   assert.deepEqual([big.readUInt32BE(16),big.readUInt32BE(20)],[7020,4966])
   const blue=PNG.sync.read(small)
   assert.deepEqual([blue.width,blue.height],[500,625])
   assert.deepEqual([...blue.data.subarray(0,4)],[0,0,255,255])
   assert.deepEqual([limited.readUInt32BE(16),limited.readUInt32BE(20)],[6000,8000])
  }else{
   assert.deepEqual([...big.subarray(0,3)],[255,216,255])
   assert.deepEqual([...small.subarray(0,3)],[255,216,255])
   const sizes=await page.evaluate(async encoded=>{
    const results=[]
    for(const data of encoded){
     const image=await createImageBitmap(new Blob([Uint8Array.from(atob(data),char=>char.charCodeAt(0))],{type:'image/jpeg'}))
     results.push([image.width,image.height])
     image.close()
    }
    return results
   },[big,small,limited].map(image=>image.toString('base64')))
   assert.deepEqual(sizes,[[7020,4966],[500,625],[6000,8000]])
  }
 }
 const {file:saved}=await f.files.openFile(f.alice.token,file.fileId)
 assert.notEqual(saved.revision,file.revision)
 assert.equal((await PDFDocument.load(await f.files.readFile(f.alice.token,file.fileId,saved.revision))).getPage(0).getRotation().angle,90)
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
})

test('native Web PDF prints page ranges and parity through the browser dialog',{skip:!directory,timeout:60000},async t=>{
 let app
 const server=createServer((req,res)=>app.routing(req,res))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
 const origin='http://localhost:'+server.address().port
 const f=await fileFixture(t,{origin,buildApp:false})
 await f.preferences.update(f.alice.token,{language:'en',autoSave:false})
 const pdf=await PDFDocument.create()
 for(const [width,height,rotation,color] of [[240,300,0,rgb(1,0,0)],[240,300,0,rgb(0,0,1)],[240,360,90,rgb(0,1,0)]]){
  const sheet=pdf.addPage([width,height])
  sheet.setRotation(degrees(rotation))
  sheet.drawRectangle({x:0,y:0,width,height,color})
 }
 const {file}=await importFile(f,f.alice.token,Buffer.from(await pdf.save()),'print-range.pdf')
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,nativePdfDirectory:directory})
 f.cleanup.unshift(()=>app.close())
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1280,height:720}})
 const csrf=await(await page.request.get(origin+'/api/v1/auth/csrf')).json()
 assert.equal((await page.request.post(origin+'/api/v1/auth/login',{headers:{origin,'x-csrf-token':csrf.csrfToken},data:{username:'alice',password}})).status(),200)
 await page.goto(origin+'/native-pdf/?fileId='+file.fileId)
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready')
 await page.keyboard.press('ControlOrMeta+p')
 const dialog=page.getByRole('dialog',{name:'Print',exact:true})
 await expect(dialog).toBeVisible()
 await expect(dialog.getByText('Default printer',{exact:true})).toHaveCount(0)
 await dialog.getByRole('combobox',{name:'Print',exact:true}).selectOption('even')
 await page.evaluate(()=>{
  const append=document.body.append
  document.body.append=function(...children){
   for(const frame of children){
    if(!(frame instanceof HTMLIFrameElement)||!frame.sandbox.contains('allow-modals'))continue
    frame.addEventListener('load',()=>{
     const target=frame.contentWindow
     const browserPrint=target.print.bind(target)
     target.print=()=>{
      const canvas=document.createElement('canvas')
      canvas.width=canvas.height=1
      const ctx=canvas.getContext('2d')
      const pages=[...target.document.images].map(image=>{
       ctx.drawImage(image,0,0,1,1)
       return Array.from(ctx.getImageData(0,0,1,1).data)
      })
      window.printedPdf={title:target.document.title,pages,html:frame.srcdoc}
      browserPrint()
     }
    },{capture:true,once:true})
   }
   return append.apply(this,children)
  }
 })
 await dialog.getByRole('button',{name:'Print',exact:true}).click()
 await expect.poll(()=>page.evaluate(()=>window.printedPdf?.pages.length)).toBe(1)
 const {pages:[pixel]}=await page.evaluate(()=>window.printedPdf)
 assert.ok(pixel[0]<10&&pixel[1]<10&&pixel[2]>245,'only the blue second page should print')

 await page.keyboard.press('ControlOrMeta+p')
 await expect(dialog).toBeVisible()
 await dialog.getByRole('radio',{name:'Custom range',exact:true}).check()
 await dialog.getByPlaceholder('e.g. 1,3,5-8').fill('1-3')
 await dialog.getByRole('combobox',{name:'Print',exact:true}).selectOption('odd')
 await dialog.getByRole('button',{name:'Print',exact:true}).click()
 await expect.poll(()=>page.evaluate(()=>window.printedPdf?.pages.length)).toBe(2)
 const {title,html,pages:[first,last]}=await page.evaluate(()=>window.printedPdf)
 assert.equal(title,'print-range')
 assert.ok(first[0]>245&&first[1]<10&&first[2]<10,'first output page should be red')
 assert.ok(last[0]<10&&last[1]>245&&last[2]<10,'second output page should be green')
 const output=await browser.newPage()
 try {
  const printSizes=async(doc,expected)=>{
   await output.setContent(doc)
   const printed=await PDFDocument.load(await output.pdf({preferCSSPageSize:true}))
   assert.equal(printed.getPageCount(),expected.length)
   expected.forEach(([width,height],index)=>{
    const size=printed.getPage(index).getSize()
    assert.ok(Math.abs(size.width-width)<1&&Math.abs(size.height-height)<1,JSON.stringify(size))
   })
  }
  await printSizes(html,[[240,300],[360,240]])
  await page.keyboard.press('ControlOrMeta+p')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button',{name:'Print',exact:true}).click()
  await expect.poll(()=>page.evaluate(()=>window.printedPdf?.pages.length)).toBe(3)
  await printSizes((await page.evaluate(()=>window.printedPdf)).html,[[240,300],[240,300],[360,240]])
 } finally {
  await output.close()
 }
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
})

test('native Web PDF prevents a 101st draft page and saves the existing edits',{skip:!directory,timeout:90000},async t=>{
 let app
 const server=createServer((req,res)=>app.routing(req,res))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
 const origin='http://localhost:'+server.address().port
 const f=await fileFixture(t,{origin,buildApp:false})
 await f.preferences.update(f.alice.token,{language:'en',autoSave:false})
 const pdf=await PDFDocument.create()
 for(let i=0;i<99;i++)pdf.addPage([240,300]).drawText('Fixture page '+(i+1))
 const {file}=await importFile(f,f.alice.token,Buffer.from(await pdf.save()),'page-limit.pdf')
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,nativePdfDirectory:directory})
 f.cleanup.unshift(()=>app.close())
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage()
 const csrf=await(await page.request.get(origin+'/api/v1/auth/csrf')).json()
 assert.equal((await page.request.post(origin+'/api/v1/auth/login',{headers:{origin,'x-csrf-token':csrf.csrfToken},data:{username:'alice',password}})).status(),200)
 await page.goto(origin+'/native-pdf/?fileId='+file.fileId)
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready')
 await page.getByRole('button',{name:'Pages',exact:true}).click()
 await page.getByRole('button',{name:'Rotate right',exact:true}).click()
 const insertBlank=page.getByRole('button',{name:'Insert blank page',exact:true})
 await expect(insertBlank).toBeEnabled()
 await insertBlank.click()
 await expect(insertBlank).toBeDisabled({timeout:1500})
 await expect(insertBlank).toHaveAttribute('data-tip',/100 pages/)
 await page.locator('.pdf-thumb-box').first().click({button:'right'})
 await expect(page.locator('.thumb-menu').getByRole('button',{name:'Insert blank page',exact:true})).toBeDisabled()
 await page.keyboard.press('Escape')
 await page.keyboard.press('Control+s')
 const head=async()=>(await f.files.openFile(f.alice.token,file.fileId)).file.revision
 await expect.poll(head,{timeout:40000}).not.toBe(file.revision)
 const stored=await PDFDocument.load(await f.files.readFile(f.alice.token,file.fileId,await head()))
 assert.equal(stored.getPageCount(),100)
 assert.equal(stored.getPage(0).getRotation().angle,90)
})

test('native PDF assistant starts a new chat without losing the draft or pending page rotation',{skip:!directory,timeout:60000},async t=>{
 const origin='http://localhost:4274',f=await fileFixture(t,{origin,buildApp:false})
 const fixture=await PDFDocument.create()
 for(let index=0;index<3;index++)fixture.addPage([240,300]).drawText('Page '+(index+1),{x:20,y:200})
 const original=Buffer.from(await fixture.save())
 const {file}=await importFile(f,f.alice.token,original,'rotation.pdf')
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,
  origin,csrfKey:f.csrfKey,objectStore:f.objects,nativePdfDirectory:directory,
  localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 f.cleanup.unshift(()=>app.close())
 await app.listen({port:4274,host:'127.0.0.1'})
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage()
 await stubHomeHero(page)
 await page.route('**/api/v1/ai/catalog',route=>route.fulfill({json:{entries:[{id:'mock',label:'Rotation fixture model'}],defaultId:'mock'}}))
 const calls=[]
 await page.route('**/api/v1/ai/turns',route=>{
  if(isHomeHeroRequest(route.request()))return route.fallback()
  calls.push(route.request().postDataJSON().request)
  const body=calls.length===1
   ? 'event: tool_call\ndata: '+JSON.stringify({id:'native-rotation',name:'apply_ops',input:{ops:[{op:'rotatePages',pages:[2],dir:90}]}})
   : calls.length===2
   ? 'event: tool_call\ndata: '+JSON.stringify({id:'native-read',name:'read_pages',input:{start:2}})
   : 'event: delta\ndata: '+JSON.stringify({text:calls.length===3?'Rotation queued':'## Fresh PDF reply\n\n[第二页](pdfnav://page/2)'})
  return route.fulfill({contentType:'text/event-stream',body:body+'\n\nevent: done\ndata: {}\n\n'})
 })
 await page.goto(origin)
 await page.getByLabel('用户名',{exact:true}).fill('alice')
 await page.getByLabel('密码',{exact:true}).fill(password)
 await page.getByRole('button',{name:'登录',exact:true}).click()
 await expect(page.locator('.home')).toBeVisible()
 await page.goto(origin+'/native-pdf/?fileId='+file.fileId)
 const ready=page.locator('html')
 await expect(ready).toHaveAttribute('data-document-loading','ready')
 await page.getByRole('button',{name:'AI 助手',exact:true}).click()
 const assistant=page.locator('.shared-editor-assistant')
 const composer=assistant.getByRole('textbox',{name:'消息'}),newChat=assistant.getByRole('button',{name:'新对话',exact:true})
 await expect(newChat).toHaveCount(0)
 await composer.fill('把第二页顺时针旋转九十度')
 await assistant.getByRole('button',{name:'发送',exact:true}).click()
 await expect(assistant.getByText('Rotation queued',{exact:true})).toBeVisible({timeout:20000})
 await expect(newChat).toBeVisible()
 const reply=assistant.locator('.ai-msg-assistant')
 await expect(reply).toHaveCount(1)
 const steps=reply.locator('.ai-work-group-summary')
 const body=reply.locator('.ai-work-group-body')
 const details=body.locator('.ai-work-group-body-inner')
 await expect(steps).toHaveText(/2 个步骤/)
 await expect(steps).toHaveAttribute('aria-expanded','false')
 await steps.click()
 await expect(steps).toHaveAttribute('aria-expanded','true')
 const openDuration=await body.evaluate(el=>parseFloat(getComputedStyle(el).transitionDuration))
 await expect(details).toHaveCSS('opacity','1')
 await expect(reply.locator('.ai-step-row').last()).toBeVisible()
 await steps.click()
 await expect(steps).toHaveAttribute('aria-expanded','false')
 const closeDuration=await body.evaluate(el=>parseFloat(getComputedStyle(el).transitionDuration))
 assert.ok(closeDuration>0 && openDuration>closeDuration,'The details close faster than they open')
 await expect(details).toHaveCSS('opacity','0')
 await expect(body).toHaveCSS('height','0px')
 assert.ok(calls[0].tools.some(tool=>tool.name==='apply_ops'))
 assert.ok(!calls[0].tools.some(tool=>tool.name==='rotate_pages'))
 const results=calls[1].messages.filter(message=>message.role==='tool').flatMap(message=>message.results)
 assert.ok(results.some(result=>result.name==='apply_ops'&&!result.isError))
 await composer.fill('仅回复新的 PDF 问题')
 await newChat.click()
 await expect(newChat).toHaveCount(0)
 await expect(composer).toHaveValue('仅回复新的 PDF 问题')
 await expect(composer).toBeFocused()
 await expect(assistant.getByText('Rotation queued',{exact:true})).toHaveCount(0)
 await assistant.getByRole('button',{name:'发送',exact:true}).click()
 await expect(assistant.getByText('Fresh PDF reply',{exact:true})).toBeVisible()
 assert.doesNotMatch(JSON.stringify(calls.at(-1).messages),/把第二页顺时针旋转九十度|Rotation queued/)
 const head=async()=>(await f.files.openFile(f.alice.token,file.fileId)).file.revision
 assert.equal(await head(),file.revision)
 await page.locator('.ribbon-tabs .qa-btn').first().click()
 await expect.poll(head,{timeout:15000}).not.toBe(file.revision)
 const revision=await head()
 const persisted=await PDFDocument.load(await f.files.readFile(f.alice.token,file.fileId,revision))
 assert.deepEqual(persisted.getPages().map(saved=>saved.getRotation().angle),[0,90,0])
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
 const reopened=page.waitForResponse(response=>response.ok()&&response.url().endsWith('/content?revision='+revision))
 await page.reload()
 await reopened
 await expect(ready).toHaveAttribute('data-document-loading','ready')
 await page.getByRole('button',{name:'AI 助手',exact:true}).click()
 await expect(assistant.getByText('Fresh PDF reply',{exact:true})).toBeVisible()
 await assistant.getByRole('link',{name:'第二页',exact:true}).click()
 await expect(page.locator('.pdf-thumb').nth(1)).toHaveClass(/pdf-thumb-active/)
 await newChat.click()
 await expect(assistant.getByText('Fresh PDF reply',{exact:true})).toHaveCount(0)
 await expect(newChat).toHaveCount(0)
 recordVerifiedOfficeEffect('pdf','apply_ops.rotatePages')
})

test('native PDF OCR reads a real scan and saves a searchable layer without changing pixels',{skip:!directory||process.env.DYOFFICE_TEST_PDF_OCR!=='1',timeout:60000},async t=>{
 const origin='http://localhost:4269',f=await fileFixture(t,{origin,buildApp:false})
 const source=await PDFDocument.create()
 const raster=await source.embedPng(await readFile(new URL('../../../../packages/pdf2docx/ocr-helper/fixtures/smoke-en.png',import.meta.url)))
 source.addPage([raster.width,raster.height]).drawImage(raster,{x:0,y:0,width:raster.width,height:raster.height})
 source.addPage([300,200]).drawText('Digital second page',{x:20,y:100})
 const chinese=await source.embedPng(await readFile(new URL('../../../../packages/pdf2docx/ocr-helper/fixtures/smoke-zh.png',import.meta.url)))
 source.addPage([chinese.width,chinese.height]).drawImage(chinese,{x:0,y:0,width:chinese.width,height:chinese.height})
 const largeTitle=await source.embedPng(await readFile(new URL('../../../../packages/pdf2docx/ocr-helper/fixtures/smoke-zh-large.png',import.meta.url)))
 source.addPage([largeTitle.width,largeTitle.height]).drawImage(largeTitle,{x:0,y:0,width:largeTitle.width,height:largeTitle.height})
 const bytes=Buffer.from(await source.save()),{file}=await importFile(f,f.alice.token,bytes,'scan.pdf')
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,
  nativePdfDirectory:directory,localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 f.cleanup.unshift(()=>app.close())
 await app.listen({port:4269,host:'127.0.0.1'})
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage(),results=[]
 await stubHomeHero(page)
 await page.route('**/api/v1/ai/catalog',route=>route.fulfill({json:{entries:[{id:'mock',label:'OCR test model'}],defaultId:'mock'}}))
 const calls=[{name:'read_pages',input:{start:1,end:4}},{name:'search_text',input:{query:'OCR Smoke Fixture'}},{name:'search_text',input:{query:'文件识别测试'}}]
 const instruction='Read the four pages and find the scan headings.'
 const isScanTurn=request=>{
  if(request.method()!=='POST'||!request.url().endsWith('/api/v1/ai/turns'))return false
  const payload=request.postDataJSON()?.request
  return payload?.format==='pdf'&&payload.messages?.some(message=>message.role==='user'&&message.text?.startsWith(instruction))
 }
 let turn=0
 await page.route('**/api/v1/ai/turns',route=>{
  if(!isScanTurn(route.request()))return route.fallback()
  if(turn>0)results.push(route.request().postDataJSON().request.messages.at(-1).results?.[0])
  const call=calls[turn++]
  const body=call?'event: tool_call\ndata: '+JSON.stringify({id:'scan-'+turn,...call}):'event: delta\ndata: {"text":"Scanned page read"}'
  return route.fulfill({contentType:'text/event-stream',body:body+'\n\nevent: done\ndata: {}\n\n'})
 })
 await page.goto(origin)
 await page.getByLabel('用户名',{exact:true}).fill('alice')
 await page.getByLabel('密码',{exact:true}).fill(password)
 await page.getByRole('button',{name:'登录',exact:true}).click()
 await expect(page.locator('.home')).toBeVisible()
 await page.goto(origin+'/native-pdf/?fileId='+file.fileId)
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready')
 await page.getByRole('button',{name:'AI 助手',exact:true}).click()
 const assistant=page.locator('.shared-editor-assistant')
 const composer=assistant.getByRole('textbox',{name:'消息'})
 await composer.fill(instruction)
 await expect(composer).toHaveValue(instruction)
 await expect(assistant.getByRole('button',{name:'发送',exact:true})).toBeEnabled()
 // The dock and OCR progress can reflow after opening. Use the composer
 // shortcut, then require the PDF turn to reach the mock before waiting on OCR.
 await Promise.all([page.waitForRequest(isScanTurn,{timeout:8000}),composer.press('Enter')])
 await expect(assistant.getByText('Scanned page read',{exact:true})).toBeVisible({timeout:25000})
 assert.deepEqual(results.map(result=>result?.name),calls.map(call=>call.name))
 assert.ok(results.every(result=>result&&!result.isError))
 const recognizedPages=results[0].output.split(/\[Page \d+\]/).slice(1)
 assert.match(recognizedPages[0],/OCR.*OCR Smoke Fixture/s)
 assert.match(recognizedPages[1],/Digital second page/)
 assert.match(recognizedPages[2],/文件识别测试/)
 assert.match(recognizedPages[3],/扫描文件识别测试/)
 assert.match(results[1].output,/Page 1:.*OCR Smoke Fixture/)
 assert.match(results[2].output,/Page 3:.*文件识别测试/)
 assert.match(results[2].output,/Page 4:.*扫描文件识别测试/)
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),bytes)
 const head=async()=>(await f.files.openFile(f.alice.token,file.fileId)).file.revision
 const save=page.getByRole('button',{name:'保存',exact:true})
 await expect(save).toBeEnabled({timeout:3000})
 await save.click()
 await expect.poll(head,{timeout:15000}).not.toBe(file.revision)
 const savedRevision=await head()
 const saved=await f.files.readFile(f.alice.token,file.fileId,savedRevision)
 const [original,output]=await Promise.all([renderPdfPages(bytes),renderPdfPages(saved)])
 assert.equal(original.pages[0].text.trim(),'')
 assert.match(output.pages[0].text,/OCR\s+Smoke\s+Fixture/)
 assert.equal(output.pages[1].text,original.pages[1].text)
 assert.equal(original.pages[2].text.trim(),'')
 assert.match(output.pages[2].text,/文件识别测试/)
 assert.equal(original.pages[3].text.trim(),'')
 assert.match(output.pages[3].text,/扫描文件识别测试/)
 assert.deepEqual(output.pages.map(p=>p.pixels),original.pages.map(p=>p.pixels))
 await page.reload()
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready')
 await expect(save).toBeDisabled()
 await page.getByRole('button',{name:'搜索',exact:true}).click()
 await page.getByPlaceholder('搜索',{exact:true}).fill('文件识别测试')
 await expect(page.locator('.pdf-search-count')).toHaveText(/\/\s*2$/)
 assert.equal(await head(),savedRevision)
})

test('native PDF form marks and editable static fills follow an unsaved reorder',{skip:!directory,timeout:90000},async t=>{
 const origin='http://localhost:4251',f=await fileFixture(t,{origin,buildApp:false})
 const seed=await PDFDocument.create(),form=seed.getForm()
 for(const name of ['OriginalFirst','OriginalSecond']){
  const original=seed.addPage([300,240])
  original.drawText(name,{x:24,y:160})
  form.createCheckBox(name).addToPage(original,{x:40,y:140,width:16,height:16})
 }
 const bytes=Buffer.from(await seed.save())
 const {file}=await importFile(f,f.alice.token,bytes,'reorder-form.pdf')
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,
  nativePdfDirectory:directory,localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 f.cleanup.unshift(()=>app.close())
 await app.listen({port:4251,host:'127.0.0.1'})
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage({viewport:{width:960,height:2400}})
 await stubHomeHero(page)
 await page.route('**/api/v1/ai/catalog',route=>route.fulfill({json:{entries:[{id:'mock',label:'Office test model'}],defaultId:'mock'}}))
 const calls=[
  ['goto_page',{page:1}],
  ['goto_page',{page:2}],
  ['apply_ops',{ops:[{op:'setPageOrder',order:[2,1]}]}],
  ['add_form_mark',{page:1,kind:'check',x:40,y:84}],
  ['add_form_mark',{page:2,kind:'cross',x:205,y:155}],
 ]
 let modelTurns=0
 const results=[]
 await page.route('**/api/v1/ai/turns',route=>{
  if(isHomeHeroRequest(route.request()))return route.fallback()
  const callIndex=Math.floor(modelTurns/2)
  const works=modelTurns++%2===0
  if(!works)results.push(route.request().postDataJSON().request.messages.at(-1).results[0])
  const body=works?'event: tool_call\ndata: '+JSON.stringify({id:'form-'+callIndex,name:calls[callIndex][0],input:calls[callIndex][1]})
   :'event: delta\ndata: '+JSON.stringify({text:'Form step '+callIndex})
  return route.fulfill({contentType:'text/event-stream',body:body+'\n\nevent: done\ndata: {}\n\n'})
 })
 await page.goto(origin)
 await page.getByLabel('用户名',{exact:true}).fill('alice')
 await page.getByLabel('密码',{exact:true}).fill(password)
 await page.getByRole('button',{name:'登录',exact:true}).click()
 await expect(page.locator('.home')).toBeVisible()
 await page.goto(origin+'/native-pdf/?fileId='+file.fileId)
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready')
 const scroller=page.locator('.pdf-scroll')
 await expect.poll(()=>scroller.evaluate(el=>el.scrollHeight-el.clientHeight)).toBe(0)
 await page.getByRole('button',{name:'AI 助手',exact:true}).click()
 const assistant=page.locator('.shared-editor-assistant')
 for(const step of calls.keys()){
  await assistant.getByRole('textbox',{name:'消息'}).fill('Apply form step '+step)
  await assistant.getByRole('button',{name:'发送',exact:true}).click()
  await expect(assistant.getByText('Form step '+step,{exact:true})).toBeVisible({timeout:15000})
  if(step<2)await expect(page.locator('.pdf-thumb').nth(step)).toHaveClass(/pdf-thumb-active/)
 }
 for(const result of results)assert.ok(!result.isError,result.output)
 assert.equal(results[1].name,'goto_page')
 assert.match(results[1].output,/Navigated to page 2/)
 recordVerifiedOfficeEffect('pdf','goto_page')
 assert.match(results[3].output,/OriginalSecond/)
 assert.match(results[4].output,/Placed a cross/)
 const fillTab=page.getByRole('button',{name:'填写表单',exact:true})
 const fillText=page.getByPlaceholder('输入要放置的文字',{exact:true})
 const confirmFill=page.locator('.pdf-modal').getByRole('button',{name:'确定',exact:true})
 const targetPage=page.locator('.pdf-page[data-page="1"]')
 await fillTab.click()
 await page.getByRole('button',{name:'添加文字',exact:true}).click()
 await fillText.fill('Editable on reopen')
 await confirmFill.click()
 await targetPage.click({position:{x:150,y:140}})
 await expect(targetPage.locator('.pdf-imgedit-img')).toBeVisible()
 const head=async()=>(await f.files.openFile(f.alice.token,file.fileId)).file.revision
 assert.equal(await head(),file.revision)
 await page.getByRole('button',{name:'保存',exact:true}).click()
 await expect.poll(head,{timeout:15000}).not.toBe(file.revision)
 const revision=await head()
 const saved=await f.files.readFile(f.alice.token,file.fileId,revision)
 const output=await PDFDocument.load(saved),result=output.getForm()
 assert.equal(result.getCheckBox('OriginalFirst').isChecked(),false)
 assert.equal(result.getCheckBox('OriginalSecond').isChecked(),true)
 const fills=doc=>JSON.parse(doc.catalog.lookup(PDFName.of('GenOfficeStaticFormFills')).decodeText())
 const [cross,firstFill]=fills(output)
 assert.equal(cross.kind,'cross')
 assert.equal(cross.pageIndex,1)
 assert.equal(firstFill.pageIndex,0)
 assert.equal(firstFill.text,'Editable on reopen')
 const leaves=await readPdfLeafObjects(saved)
 assert.deepEqual(leaves.filter(item=>/^Original(First|Second)$/.test(item.text??'')).map(item=>[item.page,item.text]),[
  [0,'OriginalSecond'],[1,'OriginalFirst'],
 ])
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),bytes)
 const reopened=page.waitForResponse(response=>response.ok()&&response.url().endsWith('/content?revision='+revision))
 await page.reload()
 await reopened
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready')
 await fillTab.click()
 await page.locator('.pdf-page[data-page="0"] .pdf-imgedit-hit').click({timeout:10000})
 await page.locator('.pdf-del-popup').getByRole('button',{name:'编辑文字',exact:true}).click()
 await expect(fillText).toHaveValue('Editable on reopen')
 await fillText.fill('Edited after reopening')
 await confirmFill.click()
 await page.getByRole('button',{name:'保存',exact:true}).click()
 await expect.poll(head,{timeout:15000}).not.toBe(revision)
 const edited=await PDFDocument.load(await f.files.readFile(f.alice.token,file.fileId,await head()))
 assert.deepEqual(fills(edited),[cross,{...firstFill,text:'Edited after reopening'}])
 recordVerifiedOfficeEffect('pdf','apply_ops.setPageOrder')
 recordVerifiedOfficeEffect('pdf','add_form_mark')
})

test('native PDF model receives visible page and selection context, and cites navigable pages',{skip:!directory,timeout:60000},async t=>{
 const origin='http://localhost:4268',f=await fileFixture(t,{origin,buildApp:false})
 const source=await PDFDocument.create()
 source.addPage([300,400]).drawText('First unselected page',{x:40,y:320})
 source.addPage([300,400]).drawText('Selected source passage',{x:40,y:320})
 const {file}=await importFile(f,f.alice.token,Buffer.from(await source.save()),'selection.pdf')
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,
  nativePdfDirectory:directory,localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 f.cleanup.unshift(()=>app.close())
 await app.listen({port:4268,host:'127.0.0.1'})
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage()
 const fontPath='/native-pdf/assets/pdfjs/standard_fonts/LiberationSans-Regular.ttf'
 assert.equal((await page.request.get(origin+fontPath)).status(),401)
 await stubHomeHero(page)
 await page.route('**/api/v1/ai/catalog',route=>route.fulfill({json:{entries:[{id:'mock',label:'Office test model'}],defaultId:'mock'}}))
 const requests=[]
 await page.route('**/api/v1/ai/turns',route=>{
  if(isHomeHeroRequest(route.request()))return route.fallback()
  const request=route.request().postDataJSON().request
  requests.push(request)
  const body=requests.length===1?'event: tool_call\ndata: '+JSON.stringify({id:'page-order',name:'apply_ops',input:{ops:[{op:'setPageOrder',order:[2,1]}]}})
   :'event: delta\ndata: '+JSON.stringify({text:'Model reply '+requests.length+(requests.length===3?'\n\nSee [p.2](pdfnav://page/2), [out of range](pdfnav://page/3), [invalid](pdfnav://other/1).':'')})
  return route.fulfill({contentType:'text/event-stream',body:body+'\n\nevent: done\ndata: {}\n\n'})
 })
 await page.goto(origin)
 await page.getByLabel('用户名',{exact:true}).fill('alice')
 await page.getByLabel('密码',{exact:true}).fill(password)
 await page.getByRole('button',{name:'登录',exact:true}).click()
 await expect(page.locator('.home')).toBeVisible()
 assert.equal((await page.request.get(origin+'/pdfjs/standard_fonts/LiberationSans-Regular.ttf')).status(),404)
 const font=await page.request.get(origin+fontPath)
 assert.equal(font.status(),200)
 assert.match(font.headers()['content-type'],/font\/ttf/)
 assert.ok((await font.body()).length>1000)
 await page.goto(origin+'/native-pdf/?fileId='+file.fileId)
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready')
 await page.getByRole('button',{name:'AI 助手',exact:true}).click()
 const assistant=page.locator('.shared-editor-assistant'),composer=assistant.getByRole('textbox',{name:'消息'})
 const send=async(instruction,reply)=>{
  await composer.fill(instruction)
  await assistant.getByRole('button',{name:'发送',exact:true}).click()
  await expect(assistant.getByText('Model reply '+reply,{exact:true})).toBeVisible({timeout:15000})
  return requests.at(-1).messages.findLast(message=>message.role==='user').text
 }
 await send('Reverse the two pages',2)
 await expect(page.locator('.pdf-page').first()).toHaveAttribute('data-page','1')
 await page.locator('.pdf-thumb').first().click()
 const text=page.locator('.pdf-page').first().locator('.textLayer span').getByText('Selected source passage',{exact:true})
 await expect(text).toBeVisible()
 await text.evaluate(element=>{
  const selection=window.getSelection(),range=document.createRange()
  range.selectNodeContents(element)
  selection.removeAllRanges()
  selection.addRange(range)
  element.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}))
 })
 await expect(page.locator('.pdf-sel-popup')).toBeVisible()
 const scoped=await send('Explain this passage. [User link](pdfnav://page/2)',3)
 assert.match(scoped,/viewing visible page 1/)
 assert.match(scoped,/selected the following text on visible page 1:.*Selected source passage/s)
 assert.doesNotMatch(scoped,/First unselected page/)
 assert.match(requests[2].system,/\[p\.N\]\(pdfnav:\/\/page\/N\)/)
 await expect(assistant.getByRole('link',{name:'User link'})).toHaveCount(0)
 await expect(assistant.getByRole('link',{name:'out of range'})).toHaveCount(0)
 await expect(assistant.getByRole('link',{name:'invalid'})).toHaveCount(0)
 await assistant.getByRole('link',{name:'p.2',exact:true}).click()
 await expect(page.locator('.pdf-thumb').nth(1)).toHaveClass(/pdf-thumb-active/)
 await page.locator('.pdf-page').nth(1).click({position:{x:15,y:15}})
 await expect(page.locator('.pdf-sel-popup')).toHaveCount(0)
 const unscoped=await send('Which page am I viewing now?',4)
 assert.match(unscoped,/viewing visible page 2/)
 assert.doesNotMatch(unscoped,/Selected source passage/)
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
})

for (const theme of ['light','dark']) test(`native PDF saves and reopens an assistant mark without changing other page colors in the ${theme} UI theme`,{skip:!directory,timeout:90000},async t=>{
 const origin='http://localhost:4267',f=await fileFixture(t,{origin,buildApp:false})
 await f.preferences.update(f.alice.token,{theme})
 const source=await PDFDocument.create(),sheet=source.addPage([300,240])
 sheet.drawRectangle({x:40,y:140,width:16,height:16,borderWidth:1,borderColor:rgb(0,0,0)})
 sheet.drawText('Consent',{x:64,y:141,size:12})
 source.addPage([300,240]).drawRectangle({x:24,y:30,width:180,height:120,color:rgb(0.15,0.45,0.85)})
 const original=Buffer.from(await source.save()),{file}=await importFile(f,f.alice.token,original,'printed-check.pdf')
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,
  nativePdfDirectory:directory,localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 f.cleanup.unshift(()=>app.close())
 await app.listen({port:4267,host:'127.0.0.1'})
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage()
 await stubHomeHero(page)
 await page.route('**/api/v1/ai/catalog',route=>route.fulfill({json:{entries:[{id:'mock',label:'Office test model'}],defaultId:'mock'}}))
 let turn=0,result,commits=0
 page.on('request',request=>{
  if(request.method()==='POST'&&new URL(request.url()).pathname===`/api/v1/files/${file.fileId}/commits`)commits++
 })
 await page.route('**/api/v1/ai/turns',route=>{
  if(isHomeHeroRequest(route.request()))return route.fallback()
  const call=turn++===0
  if(!call)result=route.request().postDataJSON().request.messages.at(-1).results[0]
  const body=call?'event: tool_call\ndata: '+JSON.stringify({id:'printed-check',name:'add_form_mark',input:{page:1,kind:'check',x:40,y:84}})
   :'event: delta\ndata: '+JSON.stringify({text:'Printed mark queued'})
  return route.fulfill({contentType:'text/event-stream',body:body+'\n\nevent: done\ndata: {}\n\n'})
 })
 await page.goto(origin)
 await page.getByLabel('用户名',{exact:true}).fill('alice')
 await page.getByLabel('密码',{exact:true}).fill(password)
 await page.getByRole('button',{name:'登录',exact:true}).click()
 await expect(page.locator('.home')).toBeVisible()
 await page.goto(origin+'/native-pdf/?fileId='+file.fileId)
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready')
 await expect(page.locator('html')).toHaveAttribute('data-theme',theme)
 await page.getByRole('button',{name:'AI 助手',exact:true}).click()
 const assistant=page.locator('.shared-editor-assistant')
 await assistant.getByRole('textbox',{name:'消息'}).fill('Check the printed Consent box.')
 await assistant.getByRole('button',{name:'发送',exact:true}).click()
 try{
  await expect(assistant.getByText('Printed mark queued',{exact:true})).toBeVisible({timeout:15000})
 }catch(error){
  t.diagnostic(JSON.stringify({theme,turns:turn,toolResult:result?.summary??null,toolError:result?.isError??null,
   assistantText:(await assistant.innerText({timeout:2000}).catch(()=>'' )).slice(-800)}))
  throw error
 }
 assert.ok(!result.isError,result.output)
 const head=async()=>(await f.files.openFile(f.alice.token,file.fileId)).file.revision
 assert.equal(await head(),file.revision)
 assert.equal(commits,0)
 if(theme==='light')await page.keyboard.press('Control+s')
 else await page.getByRole('button',{name:'保存',exact:true}).click()
 await expect(page.locator('.dyoffice-pdf-persistence-state')).toHaveText('已保存',{timeout:15000})
 const revision=await head()
 assert.notEqual(revision,file.revision)
 assert.equal(commits,1)
 const bytes=await f.files.readFile(f.alice.token,file.fileId,revision)
 await page.getByRole('button',{name:'文件',exact:true}).click()
 const [download]=await Promise.all([
  page.waitForEvent('download'),
  page.getByRole('link',{name:'下载已保存版本',exact:true}).click(),
 ])
 const downloadedBytes=await readFile(await download.path())
 assert.deepEqual(downloadedBytes,bytes)
 const leaves=await readPdfLeafObjects(downloadedBytes)
 assert.deepEqual(leaves.filter(item=>item.type===3).map(item=>[item.page,...item.bounds]),[[0,40,140,56,156]])
 assert.ok(leaves.some(item=>item.text==='Consent'))
 const before=await renderPdfPages(original),after=await renderPdfPages(downloadedBytes)
 assert.notEqual(after.pages[0].pixels,before.pages[0].pixels)
 assert.equal(after.pages[1].pixels,before.pages[1].pixels)
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
 await page.reload()
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready')
 await page.getByRole('button',{name:'编辑',exact:true}).click()
 await page.getByRole('button',{name:'编辑图片',exact:true}).click()
 const mark=page.locator('.pdf-imgedit-hit')
 await expect(mark).toHaveCount(1)
 await mark.click()
 await expect(mark).toHaveClass(/pdf-imgedit-selected/)
 assert.equal(await head(),revision)
 assert.equal(commits,1)
})

test('GenOffice PDF assistant and ribbon edits preview and save, including recovery from lost receipts'+(liveImageConfig?' with real model image editing':''),{skip:!directory,timeout:liveImageConfig?210000:180000},async t=>{
 const origin='http://localhost:4239',f=await fileFixture(t,{origin,buildApp:false})
 const doc=await PDFDocument.create()
 doc.addPage([300,240]).drawText('Native first page',{x:24,y:144,color:rgb(0,.2,.6)})
 const pattern=new PNG({width:16,height:16})
 for(let i=0;i<256;i++)pattern.data.set(i%16<8?[255,0,0,255]:[0,0,255,255],i*4)
 const stripes=await doc.embedPng(PNG.sync.write(pattern))
 doc.getPage(0).drawImage(stripes,{x:180,y:148,width:48,height:48})
 const cutoutPattern=new PNG({width:16,height:16})
 for(let y=0;y<16;y++)for(let x=0;x<16;x++){
  cutoutPattern.data.set(x>=4&&x<12&&y>=4&&y<12?[0,128,0,255]:[255,255,255,255],(y*16+x)*4)
 }
 doc.getPage(0).drawRectangle({x:244,y:148,width:40,height:40,color:rgb(1,0,0)})
 doc.getPage(0).drawImage(await doc.embedPng(PNG.sync.write(cutoutPattern)),{x:244,y:148,width:40,height:40})
 doc.addPage([300,240]).drawText('Native second page',{x:24,y:144})
 doc.getPage(0).drawText('Original paragraph starts here.',{x:24,y:72,size:12})
 doc.getPage(0).drawText('Original paragraph ends here.',{x:24,y:58,size:12})
 doc.getPage(1).drawText('Native second page',{x:24,y:76})
 doc.getPage(1).drawText('fixture@example.com',{x:24,y:110,size:12})
 const notePage=doc.getPage(1)
 const outlines=doc.context.register(doc.context.obj({Type:'Outlines',Count:1}))
 const bookmark=doc.context.register(doc.context.obj({Title:PDFString.of('Review bookmark'),Parent:outlines,Dest:[notePage.ref,'Fit']}))
 const outlineRoot=doc.context.lookup(outlines)
 outlineRoot.set(PDFName.of('First'),bookmark)
 outlineRoot.set(PDFName.of('Last'),bookmark)
 doc.catalog.set(PDFName.of('Outlines'),outlines)
 const field=doc.getForm().createTextField('ReviewStatus')
 field.setText('Pending')
 field.addToPage(notePage,{x:24,y:22,width:120,height:18})
 const savedNote=doc.context.register(doc.context.obj({Type:'Annot',Subtype:'Text',Rect:[230,184,248,202],P:notePage.ref,Contents:PDFString.of('Saved browser note'),T:PDFString.of('Reviewer'),F:4}))
 notePage.node.addAnnot(savedNote)
 const noteId='S'+savedNote.objectNumber
 const original=Buffer.from(await doc.save())
 const {file}=await importFile(f,f.alice.token,original,'native-ribbon.pdf')
 const keyring={activeKeyId:'pdf-test',keys:{'pdf-test':new Uint8Array(32).fill(29)}}
 const modelSettings=createGlobalConfigService({transactions:f.transactions,keyring})
 const configured=await modelSettings.saveGlobalConfig(f.adminSigned.token,0,{upserts:[{id:'fixture',kind:'chat',providerId:'openai',label:'Fixture',model:'synthetic',baseUrl:'https://provider.example/v1/chat/completions',apiKey:'fixture-key',enabled:true}],defaults:{chat:'fixture'}})
 const shell=process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,nativePdfDirectory:directory,localShellDirectory:shell??fileURLToPath(new URL('../../dist-local-shell',import.meta.url)),globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false})
 f.cleanup.unshift(()=>app.close())
 await app.listen({port:4239,host:'127.0.0.1'})
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1360,height:900}}),errors=[]
 page.on('pageerror',error=>errors.push(error.stack??error.message))
 const url=origin+'/native-pdf/?fileId='+file.fileId
 assert.equal((await page.request.get(url)).status(),401)
 await stubHomeHero(page)
 await page.goto(origin)
 await page.getByLabel('用户名',{exact:true}).fill('alice')
 await page.getByLabel('密码',{exact:true}).fill(password)
 await page.getByRole('button',{name:'登录',exact:true}).click()
 await expect(page.locator('.home')).toBeVisible()
 if(shell){
  assert.equal((await page.request.get(origin+'/pdf.html')).status(),404)
  await page.goto(origin+'/?entry=pdf-test#/file/'+file.fileId)
  const frame=page.locator('iframe.workspace-document-frame')
  await expect(frame).toHaveAttribute('src','/native-pdf/?fileId='+file.fileId)
  const pdf=frame.contentFrame()
  await expect(pdf.locator('html')).toHaveAttribute('data-document-loading','ready')
  await pdf.getByRole('button',{name:'页面',exact:true}).click()
  await pdf.getByRole('button',{name:'向右旋转',exact:true}).click()
  const dialog=page.waitForEvent('dialog').then(async dialog=>{assert.match(dialog.message(),/未保存修改/);await dialog.dismiss()})
  assert.equal(await pdf.locator('html').evaluate(()=>window.dyofficeEditorCanClose()),false)
  await dialog
  await expect(pdf.getByRole('button',{name:'保存',exact:true})).toBeEnabled()
  await pdf.getByRole('button',{name:/^撤销/}).click()
  assert.equal(await pdf.locator('html').evaluate(()=>window.dyofficeEditorCanClose()),true)
 }
 const response=await page.goto(url)
 assert.equal(response.status(),200)
 await expect(page.locator('.ribbon-tab').first()).toBeVisible({timeout:30000})
 const fileTab=page.getByRole('button',{name:'文件',exact:true})
 await expect(fileTab).toHaveClass(/ribbon-tab-file/)
 await expect(page.locator('.dyoffice-pdf-persistence-state')).toHaveAttribute('data-dirty','false')
 await fileTab.click()
 await expect(page.locator('.file-menu').getByRole('link',{name:'下载已保存版本'})).toHaveAttribute('href',/\/content\?revision=/)
 await page.keyboard.press('Escape')
 await expect(page.locator('.file-menu')).toHaveCount(0)
 await expect(fileTab).toBeFocused()
 await expect(page.locator('.pdf-thumb')).toHaveCount(2)
 await expect(page.getByText('Native first page',{exact:true}).first()).toBeAttached()
 await page.getByRole('button',{name:'编辑文字',exact:true}).click()
 const textCheck=page.waitForResponse(response=>response.url().endsWith('/text-edits/query'),{timeout:8000})
 await Promise.all([
  textCheck,
  page.locator('.textLayer span').filter({hasText:/^Native first page$/}).first().click({modifiers:['Alt']}),
 ])
 const checked=await textCheck
 assert.equal(checked.status(),200)
 const validation=await checked.json()
 assert.equal(validation.revision,file.revision)
 assert.equal(validation.edits[0].reason,null)
 assert.equal(validation.edits[0].bounds.length,4)
 assert.deepEqual(validation.edits[0].baseColor,[0,51,153])
 const manualDraft=page.locator('.pdf-textedit-input')
 await expect(manualDraft).toHaveCSS('color','rgb(0, 51, 153)')
 await manualDraft.fill('Manual updated page')
 const draftCheck=page.waitForResponse(response=>response.url().endsWith('/text-edits/query'))
 await Promise.all([draftCheck,manualDraft.press('Control+Enter')])
 assert.equal((await (await draftCheck).json()).edits[0].reason,null)
 await page.getByRole('button',{name:'编辑文字',exact:true}).click()
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
 await page.getByRole('button',{name:'编辑',exact:true}).click()
 const editImages=page.getByRole('button',{name:'编辑图片',exact:true})
 await editImages.click()
 await page.locator('.pdf-imgedit-hit').first().click({timeout:8000})
 await page.getByRole('button',{name:'水平翻转',exact:true}).click()
 const pixel=async(x=190,y=60,selector='.pdf-page')=>page.locator(selector).first().screenshot().then(buffer=>{
  const image=PNG.sync.read(buffer),i=(Math.floor(y/240*image.height)*image.width+Math.floor(x/300*image.width))*4
  return [...image.data.subarray(i,i+3)]
 })
 await expect.poll(pixel,{timeout:15000}).toEqual([0,0,255])
 // The text draft stays on this page, so undo must remove the already rendered image-erasure patch.
 await expect(page.locator('.pdf-page').first().locator('.pdf-page-livepreview')).toBeVisible()
 await page.getByRole('button',{name:/^撤销/}).click()
 await expect.poll(pixel).toEqual([255,0,0])
 await page.getByRole('button',{name:/^重做/}).click()
 await expect.poll(pixel).toEqual([0,0,255])
 const draftImage=page.locator('.pdf-page').first().locator('.pdf-imgedit-img').first()
 await draftImage.click()
 await page.getByRole('button',{name:'裁剪',exact:true}).click()
 const crop=page.getByRole('dialog',{name:'裁剪',exact:true})
 const applyCrop=crop.getByRole('button',{name:'应用',exact:true})
 await expect(applyCrop).toBeEnabled()
 const box=await crop.locator('[style*="cursor: move"]').boundingBox()
 const west=await crop.locator('[style*="cursor: ew-resize"]').last().boundingBox()
 await page.mouse.move(west.x+west.width/2,west.y+west.height/2)
 await page.mouse.down()
 await page.mouse.move(west.x+west.width/2+box.width/4,west.y+west.height/2,{steps:4})
 await page.mouse.up()
 await applyCrop.click()
 await expect.poll(pixel).toEqual([255,255,255])
 await expect.poll(()=>pixel(198,60)).toEqual([0,0,255])
 await draftImage.click()
 await page.getByRole('button',{name:'透明度',exact:true}).click()
 await page.getByRole('button',{name:'50%',exact:true}).click()
 await expect.poll(()=>pixel(198,60)).toEqual([127,127,255])
 await page.locator('.pdf-imgedit-hit').click()
 await page.getByRole('button',{name:'去除背景',exact:true}).click()
 await page.getByRole('dialog',{name:'去除背景',exact:true}).getByRole('button',{name:'应用',exact:true}).click()
 await expect.poll(()=>pixel(247,55)).toEqual([255,0,0])
 await expect.poll(()=>pixel(264,72)).toEqual([0,128,0])
 await editImages.click()
 await page.getByRole('button',{name:'开始',exact:true}).click()
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
 const assistant=page.locator('.shared-editor-assistant')
 const entry=page.getByRole('button',{name:'AI 助手',exact:true})
 await entry.click()
 await expect(assistant).toBeVisible({timeout:5000})
 const deltas=[
  {tool_calls:[{index:0,id:'sensitive',type:'function',function:{name:'find_sensitive_info',arguments:'{"patterns":["email"]}'}}]},
  {tool_calls:[{index:0,id:'search',type:'function',function:{name:'search_text',arguments:'{"query":"native SECOND page"}'}}]},
  {tool_calls:[{index:0,id:'read',type:'function',function:{name:'read_pages',arguments:'{"start":2}'}}]},
  {tool_calls:[{index:0,id:'highlight',type:'function',function:{name:'markup_text',arguments:'{"page":2,"text":"Native second page","type":"highlight"}'}}]},
  {tool_calls:[{index:0,id:'missing',type:'function',function:{name:'edit_text',arguments:'{"page":2,"old_text":"Native second page","new_text":"Wrong target","occurrence":3}'}}]},
  {tool_calls:[{index:0,id:'paragraph',type:'function',function:{name:'edit_block',arguments:JSON.stringify({page:1,paragraph_text:'starts here',new_text:'Revised paragraph begins.\nRevised paragraph ends.',align:'right'})}}]},
  {tool_calls:[{index:0,id:'move',type:'function',function:{name:'move_text_block',arguments:'{"page":1,"paragraph_text":"starts here","dx":0,"dy":10}'}}]},
  {tool_calls:[{index:0,id:'rewrite',type:'function',function:{name:'edit_text',arguments:'{"page":2,"old_text":"Native second page","new_text":"Native revised","occurrence":2}'}}]},
  {tool_calls:[{index:0,id:'insert',type:'function',function:{name:'insert_text',arguments:'{"page":2,"text":"Original insert","x":24,"y":185,"font_size":12}'}}]},
  {tool_calls:[{index:0,id:'list-inserts',type:'function',function:{name:'list_inserted_text',arguments:'{"page":2}'}}]},
  {tool_calls:[{index:0,id:'edit-insert',type:'function',function:{name:'edit_inserted_text',arguments:'{"text":"Final insert"}'}}]},
  {tool_calls:[{index:0,id:'move-insert',type:'function',function:{name:'move_inserted_text',arguments:'{"dx":10,"dy":5}'}}]},
  {tool_calls:[{index:0,id:'discardable',type:'function',function:{name:'insert_text',arguments:'{"page":2,"text":"Discard this draft","x":60,"y":180}'}}]},
  {tool_calls:[{index:0,id:'delete-insert',type:'function',function:{name:'delete_inserted_text',arguments:'{}'}}]},
  {tool_calls:[{index:0,id:'read-annots',type:'function',function:{name:'read_annotations',arguments:'{"start":2,"end":2}'}}]},
  {tool_calls:[{index:0,id:'edit-note',type:'function',function:{name:'edit_note',arguments:JSON.stringify({page:2,note_id:noteId,text:'Revised browser note'})}}]},
  {tool_calls:[{index:0,id:'reply-note',type:'function',function:{name:'reply_note',arguments:JSON.stringify({page:2,note_id:noteId,text:'Assistant reply'})}}]},
  {tool_calls:[{index:0,id:'add-note',type:'function',function:{name:'add_note',arguments:'{"page":2,"text":"Discardable note","x":100,"y":100}'}}]},
  {tool_calls:[{index:0,id:'delete-note',type:'function',function:{name:'delete_note',arguments:'{}'}}]},
  {tool_calls:[{index:0,id:'keep-note',type:'function',function:{name:'add_note',arguments:'{"page":2,"text":"New review note retained","x":130,"y":100}'}}]},
  {tool_calls:[{index:0,id:'underline',type:'function',function:{name:'markup_text',arguments:'{"page":2,"text":"Native second page","type":"underline"}'}}]},
  {tool_calls:[{index:0,id:'delete-mark',type:'function',function:{name:'delete_markup',arguments:'{"page":2,"type":"underline"}'}}]},
  {tool_calls:[{index:0,id:'fields',type:'function',function:{name:'list_form_fields',arguments:'{}'}}]},
  {tool_calls:[{index:0,id:'preview-batch',type:'function',function:{name:'apply_ops',arguments:'{"dry_run":true,"ops":[{"op":"rotatePages","pages":[1],"dir":90}]}'}}]},
  {tool_calls:[{index:0,id:'invalid-batch',type:'function',function:{name:'apply_ops',arguments:'{"ops":[{"op":"rotatePages","pages":[1],"dir":90},{"op":"setFormValue","value":{"name":"Missing","value":"X"}}]}'}}]},
  {tool_calls:[{index:0,id:'batch',type:'function',function:{name:'apply_ops',arguments:'{"ops":[{"op":"rotatePages","pages":[2],"dir":90},{"op":"setFormValue","value":{"name":"ReviewStatus","value":"Approved"}},{"op":"setMetadata","metadata":{"title":"Reviewed PDF"}}]}'}}]},
  {tool_calls:[{index:0,id:'outline',type:'function',function:{name:'get_outline',arguments:'{}'}}]},
  {tool_calls:[{index:0,id:'blank',type:'function',function:{name:'insert_blank_page',arguments:'{"after_page":2}'}}]},
  {tool_calls:[{index:0,id:'read-blank',type:'function',function:{name:'read_pages',arguments:'{"start":3}'}}]},
  {tool_calls:[{index:0,id:'watermark',type:'function',function:{name:'set_watermark',arguments:'{"text":"Web review copy","angle":0}'}}]},
  {tool_calls:[{index:0,id:'footer',type:'function',function:{name:'set_header_footer',arguments:'{"page_number":true,"start_at":7}'}}]},
  {content:'Read native PDF successfully'},
 ]
 let insertedId
 const network=mockProviderNetwork(t,()=>{
  const delta=deltas.shift();assert.ok(delta)
  const tool=delta.tool_calls?.[0].function
  if(tool?.name==='edit_inserted_text'||tool?.name==='move_inserted_text'){
   insertedId??=network.wire.toString().match(/(Td[a-z0-9]+): page 2/)?.[1]
   assert.ok(insertedId,'list_inserted_text did not return a page 2 draft ID')
   tool.arguments=JSON.stringify({...JSON.parse(tool.arguments),id:insertedId})
  }
  if(tool?.name==='delete_inserted_text'){
   const id=[...network.wire.toString().matchAll(/pt as (Td[a-z0-9]+)/g)].at(-1)?.[1]
   assert.ok(id&&id!==insertedId)
   tool.arguments=JSON.stringify({id})
  }
  if(tool?.name==='delete_note'){
   const id=network.wire.toString().match(/Added note (Pd[a-z0-9]+) on page 2/)?.[1]
   assert.ok(id)
   tool.arguments=JSON.stringify({page:2,note_id:id})
  }
  return Readable.from([Buffer.from('data: '+JSON.stringify({choices:[{delta,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:delta.tool_calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n')])
 })
 const isTurn=req=>req.method()==='POST'&&new URL(req.url()).pathname==='/api/v1/ai/turns'
 const firstTurn=page.waitForRequest(isTurn)
 const readback=[]
 page.on('request',req=>{if(isTurn(req))readback.push(JSON.stringify(req.postDataJSON()))})
 await assistant.getByRole('textbox',{name:'消息'}).fill('请读取第二页')
 await assistant.getByRole('button',{name:'发送',exact:true}).click()
 const advertised=JSON.stringify((await firstTurn).postDataJSON())
 assert.match(advertised,/"search_text"/)
 assert.match(advertised,/"find_sensitive_info"/)
 assert.match(advertised,/"markup_text"/)
 assert.match(advertised,/"edit_text"/)
 assert.match(advertised,/"edit_block"/)
 assert.match(advertised,/"move_text_block"/)
 assert.match(advertised,/"apply_ops"/)
 assert.match(advertised,/"list_form_fields"/)
 assert.match(advertised,/"insert_blank_page"/)
 assert.match(advertised,/"get_outline"/)
 assert.match(advertised,/"set_watermark"/)
 assert.match(advertised,/"set_header_footer"/)
 for(const name of ['read_annotations','edit_note','reply_note','add_note','delete_note','delete_markup']){
  assert.ok(JSON.parse(advertised).request.tools.some(tool=>tool.name===name),name)
 }
 for(const name of ['insert_text','list_inserted_text','edit_inserted_text','move_inserted_text','delete_inserted_text']){
  assert.ok(JSON.parse(advertised).request.tools.some(tool=>tool.name===name),name)
 }
 await expect(assistant.getByText('Read native PDF successfully')).toBeVisible({timeout:20000})
 const toolResults=readback.flatMap(wire=>JSON.parse(wire).request.messages.flatMap(message=>message.results??[]))
 const output=(id,name)=>{
  const result=toolResults.find(item=>item.id===id)
  assert.equal(result?.name,name,id)
  assert.ok(!result.isError,result.output)
  return result.output
 }
 assert.equal(output('sensitive','find_sensitive_info').split('\n')[0],'Page 2 [email]: fixture@example.com')
 assert.match(output('search','search_text'),/^Page 2: .*Native second page/m)
 const secondPage=output('read','read_pages')
 assert.match(secondPage,/\[Page 2\][\s\S]*Native second page/)
 assert.match(secondPage,/fixture@example\.com/)
 assert.doesNotMatch(secondPage,/Original paragraph/)
 assert.match(output('read-blank','read_pages'),/\[Page 3\]\s*\(unsaved blank page\)/)
 const inserted=output('list-inserts','list_inserted_text')
 assert.ok(inserted.includes(`${insertedId}: page 2, x=24`),inserted)
 assert.match(inserted,/12 pt[^\n]*"Original insert"/)
 const annots=output('read-annots','read_annotations')
 assert.match(annots,/\[Page 2\]/)
 assert.ok(annots.includes('Note '+noteId),annots)
 assert.match(annots,/Reviewer[^\n]*"Saved browser note"/)
 assert.match(annots,/Markup .*highlight/)
 assert.match(output('fields','list_form_fields'),/^ReviewStatus \(text, page 2\) current value: Pending$/m)
 assert.equal(output('outline','get_outline'),'Review bookmark')
 for(const name of ['find_sensitive_info','search_text','read_pages','list_inserted_text','read_annotations','list_form_fields','get_outline']){
  recordVerifiedOfficeEffect('pdf',name)
 }
 assert.ok(readback.some(wire=>wire.includes('Marked 1 occurrence(s) on page 2')))
 assert.ok(readback.some(wire=>wire.includes('Occurrence 3')&&wire.includes('not found')))
 assert.ok(readback.some(wire=>wire.includes('Replaced occurrence 2')&&wire.includes('unsaved')))
 assert.ok(readback.some(wire=>wire.includes('Replaced the paragraph')&&wire.includes('2 reflowed line(s)')))
 assert.ok(readback.some(wire=>wire.includes('Moved the paragraph')&&wire.includes('dy 10 pt')))
 assert.ok(readback.some(wire=>wire.includes('Updated inserted text')&&wire.includes('Moved inserted text')))
 assert.ok(readback.some(wire=>wire.includes('Removed inserted text')))
 assert.ok(readback.some(wire=>wire.includes('Watermark \\"Web review copy\\" applied')))
 assert.ok(readback.some(wire=>wire.includes('Header/footer applied')))
 for(const result of ['ReviewStatus','the document was NOT modified','Nothing was applied (atomic)','Document properties (written on save)']){
  assert.ok(readback.some(wire=>wire.includes(result)),result)
 }
 for(const result of ['Note '+noteId,'Edited note '+noteId,'Replied to note '+noteId,'Deleted note Pd','Removed 1 underline']){
  assert.ok(readback.some(wire=>wire.includes(result)),result)
 }
 await entry.click()
 await expect(assistant).toBeHidden()
 await expect(page.locator('.pdf-thumb')).toHaveCount(3)
 await expect(page.getByText('Native second page',{exact:true}).first()).toBeAttached()
 const save=page.locator('.ribbon-tabs .qa-btn').first()
 const commits=[],fileRoute=`**/api/v1/files/${file.fileId}`
 let stages=0
 await page.route(fileRoute+'/pdf/apply-ops/uploads',async route=>{
  stages++
  const response=await route.fetch()
  if(!response.ok())t.diagnostic('PDF save preparation: '+response.status()+' '+await response.text())
  await route.fulfill({response})
 })
 await page.route(fileRoute+'/commits',async route=>{
  commits.push(route.request().postDataJSON())
  if(commits.length>2)return route.continue()
  const reply=await route.fetch()
  assert.ok(reply.ok(),await reply.text())
  await route.abort()
 })
 const head=async()=>(await (await page.request.get(origin+'/api/v1/files/'+file.fileId)).json()).file.revision
 assert.equal(await head(),file.revision)
 assert.deepEqual(errors,[])
 await expect(save).toBeEnabled({timeout:3000})
 await save.click()
 await expect(page.locator('.dyoffice-pdf-persistence-state')).toHaveAttribute('data-attention','true',{timeout:15000})
 assert.equal(commits.length,2)
 const revision=await head()
 assert.notEqual(revision,file.revision)
 const loadedAfterSave=page.waitForResponse(response=>response.ok()&&response.url().endsWith('/content?revision='+revision))
 await save.click()
 await loadedAfterSave
 await expect(page.locator('.dyoffice-pdf-persistence-state')).toHaveText('已保存',{timeout:15000})
 await expect(save).toBeDisabled()
 assert.equal(stages,1)
 assert.equal(commits.length,3)
 assert.deepEqual(commits,[commits[0],commits[0],commits[0]])
 const savedBytes=await f.files.readFile(f.alice.token,file.fileId,revision)
 const externalText=(bytes,page)=>execFileSync('pdftotext',['-f',String(page),'-l',String(page),'-','-'],{input:bytes,encoding:'utf8'})
 assert.match(externalText(original,1),/Native first page/)
 assert.match(externalText(original,1),/Original paragraph starts here/)
 const externalFirstPage=externalText(savedBytes,1)
 for(const text of ['Manual updated page','Revised paragraph begins.','Revised paragraph ends.']){
  assert.ok(externalFirstPage.includes(text),externalFirstPage)
 }
 assert.doesNotMatch(externalFirstPage,/Native first page|Original paragraph starts here|Original paragraph ends here/)
 const externalSecondPage=externalText(savedBytes,2)
 assert.match(externalSecondPage,/Native revised/)
 assert.match(externalSecondPage,/Final insert/)
 assert.doesNotMatch(externalSecondPage,/Original insert|Discard this draft/)
 const savedImage=await readImageSource(savedBytes,0,[192,148,228,196])
 assert.deepEqual([...savedImage.bgra.subarray(0,4)],[255,0,0,128])
 const savedCutout=await readImageSource(savedBytes,0,[244,148,284,188])
 assert.equal(savedCutout.bgra[3],0)
 const center=(Math.floor(savedCutout.height/2)*savedCutout.width+Math.floor(savedCutout.width/2))*4
 assert.deepEqual([...savedCutout.bgra.subarray(center,center+4)],[0,128,0,255])
 const persisted=await PDFDocument.load(savedBytes)
 const stampLeaves=await readPdfLeafObjects(savedBytes)
 for(const i of [0,1,2]){
  const text=stampLeaves.filter(leaf=>leaf.page===i).map(leaf=>leaf.text)
  assert.ok(text.includes('Web review copy')&&text.includes(`${7+i} / 3`),JSON.stringify(text))
 }
 assert.equal(persisted.getTitle(),'Reviewed PDF')
 assert.equal(persisted.getForm().getTextField('ReviewStatus').getText(),'Approved')
 const annotations=persisted.getPage(1).node.Annots().asArray().map(ref=>persisted.context.lookup(ref))
 const subtype=dict=>String(dict.get(PDFName.of('Subtype')))
 const notes=annotations.filter(dict=>subtype(dict)==='/Text')
 const contents=dict=>dict.lookup(PDFName.of('Contents')).decodeText()
 const root=notes.find(dict=>contents(dict)==='Revised browser note')
 const reply=notes.find(dict=>dict.has(PDFName.of('IRT')))
 assert.equal(notes.length,3)
 assert.ok(root&&!root.has(PDFName.of('IRT')))
 assert.ok(notes.some(dict=>!dict.has(PDFName.of('IRT'))&&contents(dict)==='New review note retained'))
 assert.ok(notes.every(dict=>contents(dict)!=='Discardable note'))
 assert.equal(root.lookup(PDFName.of('Contents')).decodeText(),'Revised browser note')
 assert.equal(root.lookup(PDFName.of('T')).decodeText(),'Reviewer')
 assert.equal(reply.lookup(PDFName.of('IRT')),root)
 assert.equal(reply.lookup(PDFName.of('Contents')).decodeText(),'Assistant reply')
 assert.equal(annotations.filter(dict=>subtype(dict)==='/Underline').length,0)
 assert.equal(annotations.filter(dict=>subtype(dict)==='/Highlight').length,1)
 const leaves=stampLeaves.filter(item=>item.type===1&&item.text!=='Web review copy'&&!/^[7-9] \/ 3$/.test(item.text??''))
 const firstPage=leaves.filter(item=>item.page===0)
 assert.deepEqual(firstPage.map(item=>item.text).sort(),['Manual updated page','Revised paragraph begins.','Revised paragraph ends.'])
 assert.deepEqual(firstPage.find(item=>item.text==='Manual updated page').fill.slice(0,3),[0,51,153])
 assert.ok(firstPage.filter(item=>item.text.startsWith('Revised')).every(item=>item.matrix[4]>24))
 assert.deepEqual(firstPage.filter(item=>item.text.startsWith('Revised')).map(item=>item.matrix[5]).sort((a,b)=>b-a),[62,48])
 const savedText=leaves.filter(item=>item.page===1)
 assert.deepEqual(savedText.map(item=>item.text).sort(),['Final insert','Native revised','Native second page','fixture@example.com'])
 assert.deepEqual(savedText.find(item=>item.text==='Final insert').matrix.slice(4),[34,38])
 assert.ok(savedText.find(item=>item.text==='Native revised').bounds[1]<savedText.find(item=>item.text==='Native second page').bounds[1])
 assert.deepEqual(persisted.getPages().map(page=>page.getRotation().angle),[0,90,0])
 assert.deepEqual(persisted.getPage(2).getSize(),{width:240,height:300})
 assert.deepEqual(stampLeaves.filter(item=>item.page===2).map(item=>item.text).sort(),['9 / 3','Web review copy'])
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
 const refreshed=page.waitForResponse(response=>response.ok()&&response.url().endsWith('/content?revision='+revision))
 await page.reload()
 await refreshed
 await expect(page.locator('.pdf-thumb')).toHaveCount(3)
 await page.locator('.pdf-thumb').nth(1).click()
 await expect(page.getByText('Native revised',{exact:true}).first()).toBeAttached()
 const count=await f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async connection=>(await connection.query('SELECT count(*)::int AS count FROM file_revisions WHERE file_id=$1',[file.fileId])).rows[0].count)
 assert.equal(count,2)
 deltas.push(
  {tool_calls:[{index:0,id:'clear-watermark',type:'function',function:{name:'set_watermark',arguments:'{"text":""}'}}]},
  {content:'Removal queued'},
 )
 await entry.click()
 await assistant.getByRole('textbox',{name:'消息'}).fill('请清除之前保存的水印，保留页脚')
 await assistant.getByRole('button',{name:'发送',exact:true}).click()
 await expect(assistant.getByText('Removal queued',{exact:true})).toBeVisible({timeout:20000})
 assert.ok(readback.some(wire=>wire.includes('Removal of the managed watermark is queued')))
 assert.equal(await head(),revision)
 await save.click()
 await expect(page.locator('.dyoffice-pdf-persistence-state')).toHaveText('已保存',{timeout:15000})
 const clearedRevision=await head()
 assert.notEqual(clearedRevision,revision)
 const cleared=await readPdfLeafObjects(await f.files.readFile(f.alice.token,file.fileId,clearedRevision))
 assert.ok(!cleared.some(leaf=>leaf.text==='Web review copy'))
 for(const index of [0,1,2])assert.ok(cleared.some(leaf=>leaf.page===index&&leaf.text===`${7+index} / 3`))
 for(const effect of [
  'apply_ops.setFormValue','apply_ops.setMetadata','edit_block','move_text_block',
  'edit_text','insert_text','edit_inserted_text','move_inserted_text','delete_inserted_text',
  'add_note','edit_note','reply_note','delete_note','markup_text','delete_markup','insert_blank_page',
  'set_watermark','set_header_footer',
 ]) recordVerifiedOfficeEffect('pdf',effect)

 if(liveImageConfig){
  const {entry:live}=JSON.parse(await readFile(liveImageConfig,'utf8'))
  assert.ok(live?.enabled&&live?.apiKey&&live?.kind==='chat','Enabled live chat model configuration required')
  await modelSettings.saveGlobalConfig(f.adminSigned.token,configured.revision,{upserts:[{...live,id:'fixture'}],defaults:{chat:'fixture'}})
  t.mock.restoreAll()
 }
 // The manual erase patch spans the middle image, which also has an assistant draft.
 const mixed=await PDFDocument.create(),mixedPage=mixed.addPage([300,240])
 const sharedImage=await mixed.embedPng(PNG.sync.write(pattern))
 const lefts=[60,130,200]
 for(const x of lefts)mixedPage.drawImage(sharedImage,{x,y:148,width:40,height:40})
 const approval=mixed.getForm().createCheckBox('Approved')
 approval.addToPage(mixedPage,{x:30,y:40,width:18,height:18})
 approval.check()
 const mixedOriginal=Buffer.from(await mixed.save())
 const mixedFile=(await importFile(f,f.alice.token,mixedOriginal,'native-ribbon-and-assistant.pdf')).file
 const mixedHead=async()=>(await f.files.openFile(f.alice.token,mixedFile.fileId)).file.revision
 await page.goto(origin+'/native-pdf/?fileId='+mixedFile.fileId)
 await page.getByRole('button',{name:'编辑',exact:true}).click()
 await editImages.click()
 const hits=page.locator('.pdf-imgedit-hit')
 await expect(hits).toHaveCount(3)
 for(const x of [60,200]){
  await (x===60?hits.first():hits.last()).click()
  const erasePreview=page.waitForResponse(response=>{
   if(!response.url().endsWith('/pdf/image-previews/query'))return false
   const {operation}=response.request().postDataJSON()
   return operation.kind==='erase'&&operation.excludeRects.some(rect=>rect[0]===x)
  },{timeout:20000})
  await page.getByRole('button',{name:'水平翻转',exact:true}).click()
  const preview=await erasePreview
  assert.ok(preview.ok(),await preview.text())
  await expect.poll(()=>pixel(x+8,65),{timeout:10000}).toEqual([0,0,255])
 }
 await editImages.click()
 await page.getByRole('button',{name:'开始',exact:true}).click()
 await expect.poll(()=>pixel(138,65)).toEqual([255,0,0])
 if(!liveImageConfig)deltas.push(
  {tool_calls:[{index:0,id:'assistant-list',type:'function',function:{name:'list_page_images',arguments:'{"page":1}'}}]},
  {tool_calls:[{index:0,id:'assistant-flip',type:'function',function:{name:'flip_image',arguments:'{"page":1,"image_number":2,"axis":"horizontal"}'}}]},
  {content:'Middle image flip queued'},
 )
 const imageReadbackStart=readback.length
 await entry.click()
 await assistant.getByRole('textbox',{name:'消息'}).fill('先用 list_page_images 列出第 1 页的内嵌图片。按位置找出横向居中的图片，只用 flip_image 水平翻转这张图片一次。保留两侧的待保存编辑与表单。我会手动保存。')
 await assistant.getByRole('button',{name:'发送',exact:true}).click()
 const readImageTurn=()=>readback.slice(imageReadbackStart)
 await expect.poll(()=>readImageTurn().some(wire=>wire.includes('Image 2 on page 1 has a pending flip_image edit.')),{timeout:liveImageConfig?90000:20000}).toBe(true)
 const imageList=readImageTurn().flatMap(wire=>JSON.parse(wire).request.messages.flatMap(message=>message.results??[]))
  .find(result=>result.name==='list_page_images'&&!result.isError)
 assert.match(imageList?.output??'',/image 2: 40 × 40 pt at x=130, y=52/)
 recordVerifiedOfficeEffect('pdf','list_page_images')
 if(!liveImageConfig)await expect(assistant.getByText('Middle image flip queued',{exact:true})).toBeVisible({timeout:20000})
 await expect(assistant.getByRole('button',{name:'停止',exact:true})).toHaveCount(0,{timeout:liveImageConfig?60000:10000})
 await entry.click()
 for(const x of lefts)await expect.poll(()=>pixel(x+8,65),{timeout:10000}).toEqual([0,0,255])
 await expect.poll(()=>pixel(138,65,'.pdf-thumb-box')).toEqual([0,0,255])
 await page.getByRole('button',{name:/^撤销/}).click()
 await expect.poll(()=>pixel(138,65)).toEqual([255,0,0])
 await expect.poll(()=>pixel(68,65)).toEqual([0,0,255])
 await page.getByRole('button',{name:/^重做/}).click()
 await expect.poll(()=>pixel(138,65),{timeout:10000}).toEqual([0,0,255])
 assert.equal(await mixedHead(),mixedFile.revision)
 await save.click()
 await expect(page.locator('.dyoffice-pdf-persistence-state')).toHaveText('已保存',{timeout:15000})
 const mixedRevision=await mixedHead()
 assert.notEqual(mixedRevision,mixedFile.revision)
 const mixedBytes=await f.files.readFile(f.alice.token,mixedFile.fileId,mixedRevision)
 for(const x of lefts){
  const image=await readImageSource(mixedBytes,0,[x,148,x+40,188])
  assert.deepEqual([...image.bgra.subarray(0,4)],[255,0,0,255])
 }
 const renderFirstPage=bytes=>PNG.sync.read(execFileSync('pdftoppm',['-png','-r','72','-f','1','-l','1','-singlefile','-'],{input:bytes}))
 const originalRaster=renderFirstPage(mixedOriginal),savedRaster=renderFirstPage(mixedBytes)
 assert.deepEqual([originalRaster.width,originalRaster.height,savedRaster.width,savedRaster.height],[300,240,300,240])
 for(const x of lefts){
  const index=(65*savedRaster.width+x+8)*4
  assert.deepEqual([...originalRaster.data.subarray(index,index+4)],[255,0,0,255])
  const [red,green,blue,alpha]=savedRaster.data.subarray(index,index+4)
  assert.ok(red<=2&&green<=2&&blue>=253&&alpha===255,`Poppler pixel at ${x+8},65: ${[red,green,blue,alpha]}`)
 }
 assert.equal(pdfInsertFormState(await PDFDocument.load(mixedBytes)),pdfInsertFormState(await PDFDocument.load(mixedOriginal)))
 assert.deepEqual(await f.files.readFile(f.alice.token,mixedFile.fileId,mixedFile.revision),mixedOriginal)
 const mixedReload=page.waitForResponse(response=>response.ok()&&response.url().endsWith('/content?revision='+mixedRevision))
 await page.reload()
 await mixedReload
 await expect.poll(()=>pixel(138,65),{timeout:15000}).toEqual([0,0,255])
 assert.deepEqual(errors,[])
})


test('native Web PDF saves and exports empty and 20 MiB attachments',{skip:!directory,timeout:90000},async t=>{
 let app
 const server=createServer((req,res)=>app.routing(req,res))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
 const origin='http://localhost:'+server.address().port
 const f=await fileFixture(t,{origin,buildApp:false})
 await f.preferences.update(f.alice.token,{language:'en',autoSave:false,showAssistant:false})
 const pdf=await PDFDocument.create();pdf.addPage([240,300]).drawText('Attachment boundary fixture',{x:20,y:240})
 const original=Buffer.from(await pdf.save()),{file}=await importFile(f,f.alice.token,original,'attachments.pdf')
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,nativePdfDirectory:directory})
 f.cleanup.unshift(()=>app.close())
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1420,height:900},acceptDownloads:true})
 const csrf=await(await page.request.get(origin+'/api/v1/auth/csrf')).json()
 assert.equal((await page.request.post(origin+'/api/v1/auth/login',{headers:{origin,'x-csrf-token':csrf.csrfToken},data:{username:'alice',password}})).status(),200)
 await page.goto(origin+'/native-pdf/?fileId='+file.fileId)
 const panel=async()=>{
  await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready')
  await page.getByRole('button',{name:'View',exact:true}).click()
  await page.getByRole('button',{name:'Attachments',exact:true}).click()
 }
 await panel()
 const large=Buffer.alloc(20*1024*1024,0xa5)
 large.set(Buffer.from('PDF attachment starts here'))
 large[large.length-1]=0x5a
 const attachments=[['empty.txt',Buffer.alloc(0)],['large.bin',large]]
 for(const [name,buffer] of attachments){
  const [picker]=await Promise.all([page.waitForEvent('filechooser'),page.getByRole('button',{name:'Add attachment',exact:true}).click()])
  await picker.setFiles({name,mimeType:'application/octet-stream',buffer})
  await expect(page.locator(`.pdf-attachment-name[title="${name}"]`)).toBeVisible({timeout:6000})
 }
 const [extra]=await Promise.all([page.waitForEvent('filechooser'),page.getByRole('button',{name:'Add attachment',exact:true}).click()])
 await extra.setFiles({name:'extra.txt',mimeType:'text/plain',buffer:Buffer.from('x')})
 await expect(page.getByText('New attachments can total up to 20 MiB per save.')).toBeVisible()
 await expect(page.locator('.pdf-attachment-name[title="extra.txt"]')).toHaveCount(0)
 const head=async()=>(await f.files.openFile(f.alice.token,file.fileId)).file.revision
 await page.keyboard.press('ControlOrMeta+s')
 await expect.poll(head,{timeout:35000}).not.toBe(file.revision)
 const revision=await head()
 await page.reload()
 await panel()
 for(const [name,buffer] of attachments){
  const entry=page.locator('.pdf-attachment').filter({has:page.getByText(name,{exact:true})})
  const [download]=await Promise.all([page.waitForEvent('download',{timeout:20000}),entry.getByRole('button',{name:'Export',exact:true}).click()])
  assert.equal(download.suggestedFilename(),name)
  assert.deepEqual(await readFile(await download.path()),buffer)
 }
 assert.equal(await head(),revision)
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
})

test('native Web PDF compares local files and downloads page images and an embedded attachment',{skip:!directory,timeout:90000},async t=>{
 let app
 const server=createServer((req,res)=>app.routing(req,res))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
 const origin='http://localhost:'+server.address().port
 const f=await fileFixture(t,{origin,buildApp:false})
 await f.preferences.update(f.alice.token,{language:'en'})
 const pdf=await PDFDocument.create()
 pdf.addPage([240,300]).drawText('Alpha Beta',{x:30,y:200,size:14})
 const attachment=Buffer.from('Embedded test content')
 await pdf.attach(attachment,'evidence.txt',{mimeType:'text/plain'})
 const original=Buffer.from(await pdf.save())
 const {file}=await importFile(f,f.alice.token,original,'comparison.pdf')
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,nativePdfDirectory:directory})
 f.cleanup.unshift(()=>app.close())
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage({acceptDownloads:true})
 const csrf=await(await page.request.get(origin+'/api/v1/auth/csrf')).json()
 assert.equal((await page.request.post(origin+'/api/v1/auth/login',{headers:{origin,'x-csrf-token':csrf.csrfToken},data:{username:'alice',password}})).status(),200)
 await page.goto(origin+'/native-pdf/?fileId='+file.fileId)
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready')
 await page.getByRole('button',{name:'View',exact:true}).click()
 await page.getByRole('button',{name:'Compare',exact:true}).click()
 const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.locator('.pdf-compare-pick').click()])
 const split=await PDFDocument.create(),splitPage=split.addPage([240,300])
 splitPage.drawText('Alpha',{x:30,y:200,size:14})
 splitPage.drawText('Beta',{x:40,y:190,size:14})
 const splitBytes=Buffer.from(await split.save())
 const desktop=await import('../../../pdf/src/main/read-text.ts')
 const desktopOriginal=(await desktop.readPdfText(original)).pages.map(page=>page.text)
 assert.deepEqual((await desktop.readPdfText(splitBytes)).pages.map(page=>page.text),desktopOriginal)
 const writes=[]
 let engineLoads=0
 const trackComparison=request=>{
  const path=new URL(request.url()).pathname
  const readingChat=path.endsWith('/assistant-chat')&&request.postDataJSON()?.updates?.length===0
  if(!readingChat&&!['GET','HEAD'].includes(request.method()))writes.push(path)
  if(/\/pdfium-[^/]+\.wasm$/.test(request.url()))engineLoads++
 }
 page.on('request',trackComparison)
 await chooser.setFiles({name:'same-text.pdf',mimeType:'application/pdf',buffer:splitBytes})
 await expect(page.getByText('Both documents carry the same text')).toBeVisible({timeout:10000})
 const changed=await PDFDocument.create(),changedPage=changed.addPage([240,300])
 changedPage.drawText('Alpha Beta',{x:30,y:200,size:14})
 changedPage.drawText('Extra comparison line',{x:30,y:120,size:14})
 const [different]=await Promise.all([page.waitForEvent('filechooser'),page.locator('.pdf-compare-pick').click()])
 await different.setFiles({name:'extra-line.pdf',mimeType:'application/pdf',buffer:Buffer.from(await changed.save())})
 await expect(page.locator('.pdf-compare-added')).toHaveText('+1 lines',{timeout:10000})
 page.off('request',trackComparison)
 assert.deepEqual(writes,[])
 assert.equal(engineLoads,1)
 await page.getByRole('button',{name:'Attachments',exact:true}).click()
 await expect(page.getByRole('button',{name:'Add attachment',exact:true})).toBeEnabled()
 const [embedded]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Export',exact:true}).click()])
 assert.equal(embedded.suggestedFilename(),'evidence.txt')
 assert.deepEqual(await readFile(await embedded.path()),attachment)

 await page.getByRole('button',{name:'Home',exact:true}).click()
 await page.getByRole('button',{name:'PDF Converter',exact:true}).click()
 await expect(page.getByRole('button',{name:'PDF to Markdown',exact:true})).toBeEnabled()
 const [images]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Export as PNG',exact:true}).click()])
 const archive=await JSZip.loadAsync(await readFile(await images.path()))
 assert.deepEqual(Object.keys(archive.files),['comparison-01.png'])
 const raster=PNG.sync.read(await archive.file('comparison-01.png').async('nodebuffer'))
 assert.deepEqual([raster.width,raster.height],[500,625])
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
 await page.getByRole('button',{name:'View',exact:true}).click()
 if(!await page.getByRole('button',{name:'Add attachment',exact:true}).isVisible()){
  await page.getByRole('button',{name:'Attachments',exact:true}).click()
 }
 const addedBytes=Buffer.from('New browser attachment')
 const [pickAttachment]=await Promise.all([page.waitForEvent('filechooser'),page.getByRole('button',{name:'Add attachment',exact:true}).click()])
 await pickAttachment.setFiles({name:'added.txt',mimeType:'text/plain',buffer:addedBytes})
 await expect(page.locator('.pdf-attachment-name[title="added.txt"]')).toBeVisible()
 const head=async()=>(await f.files.openFile(f.alice.token,file.fileId)).file.revision
 await page.getByRole('button',{name:'Home',exact:true}).click()
 await page.getByRole('button',{name:'PDF Converter',exact:true}).click()
 const [afterSave]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Export as JPG',exact:true}).click()])
 const afterZip=await JSZip.loadAsync(await readFile(await afterSave.path()))
 assert.deepEqual(Object.keys(afterZip.files),['comparison-01.jpg'])
 await expect.poll(head,{timeout:30000}).not.toBe(file.revision)
 await page.reload()
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready')
 await page.getByRole('button',{name:'View',exact:true}).click()
 await page.getByRole('button',{name:'Attachments',exact:true}).click()
 const added=page.locator('.pdf-attachment').filter({hasText:'added.txt'})
 const [stored]=await Promise.all([page.waitForEvent('download'),added.getByRole('button',{name:'Export',exact:true}).click()])
 assert.deepEqual(await readFile(await stored.path()),addedBytes)
})

test('native Web PDF merges local files in order into a separate download',{skip:!directory,timeout:90000},async t=>{
 let app
 const server=createServer((req,res)=>app.routing(req,res))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
 const origin='http://localhost:'+server.address().port
 const f=await fileFixture(t,{origin,buildApp:false})
 await f.preferences.update(f.alice.token,{language:'en',autoSave:false})
 const makePdf=async widths=>{
  const doc=await PDFDocument.create()
  for(const width of widths)doc.addPage([width,300]).drawText('Page '+width)
  if(widths.length===2){
   const [first,second]=doc.getPages()
   const name=PDFString.of('Next page')
   doc.catalog.set(PDFName.of('Names'),doc.context.obj({Dests:{Names:[name,[second.ref,'Fit']]}}))
   doc.catalog.set(PDFName.of('PageLabels'),doc.context.obj({Nums:[0,{S:'r',St:3}]}))
   const root=doc.context.obj({Type:'Outlines',Count:1}),rootRef=doc.context.register(root)
   const bookmark=doc.context.register(doc.context.obj({Title:PDFString.of('Donor chapter'),Parent:rootRef,Dest:name}))
   root.set(PDFName.of('First'),bookmark);root.set(PDFName.of('Last'),bookmark)
   doc.catalog.set(PDFName.of('Outlines'),rootRef)
   first.node.addAnnot(doc.context.register(doc.context.obj({
    Type:'Annot',Subtype:'Link',Rect:[10,230,110,275],Dest:name,
   })))
  }
  const field=doc.getForm().createTextField('customer')
  field.addToPage(doc.getPage(0),{x:30,y:160,width:120,height:22});field.setText('Customer '+widths[0])
  await doc.attach(Buffer.from('Attachment '+widths[0]),'report.txt',{mimeType:'text/plain'})
  return Buffer.from(await doc.save())
 }
 const original=await makePdf([240])
 const {file}=await importFile(f,f.alice.token,original,'merge-source.pdf')
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,nativePdfDirectory:directory})
 f.cleanup.unshift(()=>app.close())
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage({acceptDownloads:true})
 const errors=[]
 page.on('pageerror',error=>errors.push(error.message))
 const csrf=await(await page.request.get(origin+'/api/v1/auth/csrf')).json()
 assert.equal((await page.request.post(origin+'/api/v1/auth/login',{headers:{origin,'x-csrf-token':csrf.csrfToken},data:{username:'alice',password}})).status(),200)
 await page.goto(origin+'/native-pdf/?fileId='+file.fileId)
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready')
 await page.getByRole('button',{name:'Pages',exact:true}).click()
 await page.getByRole('button',{name:'Rotate right',exact:true}).click()
 const head=async()=>(await f.files.openFile(f.alice.token,file.fileId)).file.revision
 const pick=async()=> (await Promise.all([
  page.waitForEvent('filechooser',{timeout:5000}),
  page.getByRole('button',{name:'Merge PDF',exact:true}).click(),
 ]))[0]
 const canceled=await pick()
 await canceled.setFiles([])
 await expect(page.locator('.dyoffice-pdf-persistence-state')).toHaveAttribute('data-dirty','true')
 assert.equal(await head(),file.revision)
 const selected=await pick()
 assert.equal(selected.isMultiple(),true)
 const {createPdfStampsJob}=await import('../../server/src/pdf/stamps-job.mjs')
 const donor=await createPdfStampsJob({allowAcroForm:true}).execute(await makePdf([250,260]),JSON.stringify({
  version:1,action:'stamps',operation:{op:'set_header_footer',header_left:'Donor header',page_number:true},
 }))
 const [download]=await Promise.all([
  page.waitForEvent('download'),
  selected.setFiles([
   {name:'z-first.pdf',mimeType:'application/pdf',buffer:donor.bytes},
   {name:'a-second.pdf',mimeType:'application/pdf',buffer:await makePdf([270])},
  ]),
 ])
 assert.equal(download.suggestedFilename(),'merge-source-merged.pdf')
 const downloaded=await readFile(await download.path())
 const merged=await PDFDocument.load(downloaded)
 assert.deepEqual(merged.getPages().map(p=>p.getWidth()),[240,250,260,270])
 assert.equal(merged.getPage(0).getRotation().angle,90)
 const next=merged.getPage(1).node.Annots().lookup(0,PDFDict).lookup(PDFName.of('Dest'),PDFArray)
 assert.equal(String(next.get(0)),String(merged.getPage(2).ref))
 const fields=['customer','customer_2','customer_3'].map(name=>merged.getForm().getTextField(name))
 assert.deepEqual(fields.map(field=>field.getText()),['Customer 240','Customer 250','Customer 270'])
 assert.deepEqual(fields.map(field=>String(field.acroField.getWidgets()[0].P())),[0,1,3].map(index=>String(merged.getPage(index).ref)))
 const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs')
 const labelReader=getDocument({data:Uint8Array.from(downloaded)})
 try {
  const output=await labelReader.promise
  assert.deepEqual(await output.getPageLabels(),['1','iii','iv','4'])
  const [bookmark]=await output.getOutline()
  assert.equal(bookmark.title,'Donor chapter')
  assert.equal(await output.getPageIndex(bookmark.dest[0]),2)
 }
 finally { await labelReader.destroy() }
 const savedRevision=await head()
 assert.notEqual(savedRevision,file.revision)
 const saved=await PDFDocument.load(await f.files.readFile(f.alice.token,file.fileId,savedRevision))
 assert.equal(saved.getPageCount(),1)
 assert.equal(saved.getPage(0).getRotation().angle,90)
 assert.deepEqual(saved.getForm().getFields().map(field=>field.getName()),['customer'])
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
 const {file:copy}=await importFile(f,f.alice.token,downloaded,'merged-form.pdf')
 await page.goto(origin+'/native-pdf/?fileId='+copy.fileId)
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready')
 const imported=page.locator('.pdf-form-layer input[title="customer_2"]')
 await expect(imported).toHaveValue('Customer 250',{timeout:15000})
 await imported.fill('Updated imported value')
 await expect(page.locator('.dyoffice-pdf-persistence-state')).toHaveAttribute('data-dirty','true')
 await page.keyboard.press('Control+s')
 const copyHead=async()=>(await f.files.openFile(f.alice.token,copy.fileId)).file.revision
 await expect.poll(copyHead,{timeout:18000}).not.toBe(copy.revision)
 const savedCopyBytes=await f.files.readFile(f.alice.token,copy.fileId,await copyHead())
 const savedCopy=await PDFDocument.load(savedCopyBytes)
 assert.deepEqual(fields.map(field=>savedCopy.getForm().getTextField(field.getName()).getText()),['Customer 240','Updated imported value','Customer 270'])
 const text=(await readPdfLeafObjects(savedCopyBytes)).filter(item=>item.type===1).map(item=>item.text).join('|')
 for(const stamp of ['Donor header','1 / 2','2 / 2'])assert.ok(text.includes(stamp),stamp)
 await page.getByRole('button',{name:'View',exact:true}).click()
 await page.getByRole('button',{name:'Outline',exact:true}).click()
 await page.getByRole('treeitem',{name:'Donor chapter',exact:true}).click()
 await expect(page.locator('.tb-page-input')).toHaveValue('3')
 await page.getByRole('button',{name:'Attachments',exact:true}).click()
 for(const [name,content] of [['report.txt','Attachment 240'],['report (2).txt','Attachment 250'],['report (3).txt','Attachment 270']]){
  const entry=page.locator('.pdf-attachment').filter({has:page.getByText(name,{exact:true})})
  const [attachment]=await Promise.all([page.waitForEvent('download'),entry.getByRole('button',{name:'Export',exact:true}).click()])
  assert.equal(attachment.suggestedFilename(),name)
  assert.equal(await readFile(await attachment.path(),'utf8'),content)
 }
 assert.deepEqual(errors,[])
})

test('native Web PDF saves rotation, drawings, bookmarks and widget deletion together',{skip:!directory,timeout:90000},async t=>{
 let app
 const server=createServer((req,res)=>app.routing(req,res))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
 const origin='http://localhost:'+server.address().port
 const f=await fileFixture(t,{origin,buildApp:false})
 await f.preferences.update(f.alice.token,{language:'en',autoSave:false})
 const pdf=await PDFDocument.create()
 const p=pdf.addPage([240,300])
 p.drawText('PDF parity fixture')
 pdf.addPage([240,300]).drawText('Second page')
 const field=pdf.getForm().createTextField('old field')
 field.addToPage(p,{x:50,y:95,width:100,height:22})
 const outline=pdf.context.obj({Type:'Outlines',Count:1})
 const root=pdf.context.register(outline)
 const bookmark=pdf.context.register(pdf.context.obj({Title:PDFHexString.fromText('Original bookmark'),Parent:root,Dest:[p.ref,'XYZ',0,240,null]}))
 outline.set(PDFName.of('First'),bookmark)
 outline.set(PDFName.of('Last'),bookmark)
 pdf.catalog.set(PDFName.of('Outlines'),root)
 const original=Buffer.from(await pdf.save())
 const {file}=await importFile(f,f.alice.token,original,'mixed-save.pdf')
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,nativePdfDirectory:directory})
 f.cleanup.unshift(()=>app.close())
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage({acceptDownloads:true})
 const csrf=await(await page.request.get(origin+'/api/v1/auth/csrf')).json()
 assert.equal((await page.request.post(origin+'/api/v1/auth/login',{headers:{origin,'x-csrf-token':csrf.csrfToken},data:{username:'alice',password}})).status(),200)
 await page.goto(origin+'/native-pdf/?fileId='+file.fileId)
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready',{timeout:40000})

 const errors=[]
 page.on('pageerror', error=>errors.push(error.message))
 await page.getByRole('button',{name:'Pages',exact:true}).click()
 await page.getByRole('button',{name:'Rotate right',exact:true}).click()
 await expect(page.locator('.dyoffice-pdf-persistence-state')).toHaveAttribute('data-dirty','true')
 await page.getByRole('button',{name:'Annotate',exact:true}).click()
 const pen=page.getByRole('button',{name:'Draw',exact:true})
 await pen.click()
 const target=page.locator('.pdf-page').first()
 const box=await target.boundingBox()
 assert.ok(box)
 await page.mouse.move(box.x+40,box.y+65)
 await page.mouse.down()
 await page.mouse.move(box.x+85,box.y+100,{steps:6})
 await page.mouse.up()
 await pen.click()
 await page.getByRole('button',{name:'View',exact:true}).click()
 await page.getByRole('button',{name:'Outline',exact:true}).click()
 await page.getByRole('button',{name:'Edit bookmarks',exact:true}).click()
 await page.getByRole('button',{name:'Original bookmark',exact:true}).hover()
 await page.getByRole('button',{name:'Rename bookmark',exact:true}).click()
 const title=page.locator('.pdf-bookmark-row input')
 await title.fill('Updated bookmark')
 await title.press('Enter')
 await page.getByRole('button',{name:'Edit bookmarks',exact:true}).click()
 await page.getByRole('button',{name:'Form Design',exact:true}).click()
 await page.locator('[data-field-id]').first().click()
 await page.locator('.pdf-formdesign-remove').click()
 await page.keyboard.press('Control+s')
 const getRevision=async()=>(await f.files.openFile(f.alice.token,file.fileId)).file.revision
 await expect.poll(getRevision,{timeout:25000}).not.toBe(file.revision)
 const stored=await PDFDocument.load(await f.files.readFile(f.alice.token,file.fileId,await getRevision()))
 assert.equal(stored.getPage(0).getRotation().angle,90)
 const annots=stored.getPage(0).node.Annots().asArray().map(ref=>stored.context.lookup(ref,PDFDict))
 assert.deepEqual(annots.map(annot=>String(annot.get(PDFName.of('Subtype')))),['/Ink'])
 const savedBookmark=stored.catalog.lookup(PDFName.of('Outlines'),PDFDict).lookup(PDFName.of('First'),PDFDict)
 assert.equal(savedBookmark.lookup(PDFName.of('Title')).decodeText(),'Updated bookmark')
 assert.equal(stored.getForm().getFieldMaybe('old field'),undefined)
 assert.deepEqual(errors,[])
})
