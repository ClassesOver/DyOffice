import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile} from 'node:fs/promises'
import {expect} from '@playwright/test'
import {PDFDocument} from 'pdf-lib'
import {buildLocalApp} from '../../server/src/app.ts'
import {createWorkspaceService} from '../../server/src/modules/workspace/service.ts'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {officeBrowserAsset} from '../helpers/office-browser-assets.mjs'
import {stubHomeHero} from '../helpers/home-hero.mjs'
import {decryptDocument,WrongPasswordError} from '../../../pdf/src/main/pdf-crypt.ts'

const directory=process.env.DYOFFICE_TEST_NATIVE_PDF_DIST

test('Web PDF downloads or saves an encrypted copy while leaving the original editable',{skip:!directory,timeout:120000},async t=>{
 let app
 const server=createServer((request,reply)=>app.routing(request,reply))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
 const origin='http://localhost:'+server.address().port
 const f=await fileFixture(t,{origin,buildApp:false})
 await f.preferences.update(f.alice.token,{language:'en',autoSave:false})
 const fixture=await PDFDocument.create()
 fixture.addPage([240,300]).drawText('Protected copy fixture')
 const original=Buffer.from(await fixture.save())
 const {file}=await importFile(f,f.alice.token,original,'plain.pdf')
 app=await buildLocalApp({
  db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,
  origin,csrfKey:f.csrfKey,objectStore:f.objects,nativePdfDirectory:directory,
  localShellDirectory:officeBrowserAsset('local-shell'),
 })
 f.cleanup.unshift(()=>app.close())
 const browser=await launchTestBrowser()
 f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage({acceptDownloads:true})
 await stubHomeHero(page)
 const csrf=await (await page.request.get(origin+'/api/v1/auth/csrf')).json()
 assert.equal((await page.request.post(origin+'/api/v1/auth/login',{
  headers:{origin,'x-csrf-token':csrf.csrfToken},data:{username:'alice',password},
 })).status(),200)
 await page.goto(origin+'/native-pdf/?fileId='+file.fileId)
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready')
 await page.getByRole('button',{name:'Pages',exact:true}).click()
 await page.getByRole('button',{name:'Rotate right',exact:true}).click()
 await expect(page.locator('.dyoffice-pdf-persistence-state')).toHaveAttribute('data-dirty','true')
 await page.getByRole('button',{name:'Annotate',exact:true}).click()
 await page.getByRole('button',{name:'Protect',exact:true}).click()
 const dialog=page.getByRole('dialog',{name:'Download a protected copy'})
 await expect(dialog).toBeVisible()
 const userPassword='copy-test-user-64',ownerPassword='copy-test-owner-83'
 let passwordRequests=0
 page.on('request',request=>{
  const requestData=request.url()+'\n'+(request.postData()??'')
  if(requestData.includes(userPassword)||requestData.includes(ownerPassword))passwordRequests++
 })
 async function fillProtection(dialog){
  const passwordFields=dialog.locator('input[type="password"]')
  await passwordFields.nth(0).fill(userPassword)
  await passwordFields.nth(1).fill(userPassword)
  await passwordFields.nth(2).fill(ownerPassword)
  const permissionBoxes=dialog.getByRole('checkbox')
  await permissionBoxes.nth(0).uncheck()
  await permissionBoxes.nth(3).uncheck()
 }
 await fillProtection(dialog)
 const [download]=await Promise.all([
  Promise.race([
   page.waitForEvent('download',{timeout:30000}),
   dialog.getByRole('alert').waitFor({timeout:30000}).then(async()=>{
    const status=page.locator('.dyoffice-pdf-persistence-state')
    throw Error('Protected copy failed: '+await dialog.getByRole('alert').textContent()+
      ' ('+await status.textContent()+', '+await status.getAttribute('title')+')')
   }),
  ]),
  dialog.getByRole('button',{name:'Download protected copy',exact:true}).click(),
 ])
 assert.equal(download.suggestedFilename(),'plain-protected.pdf')
 const encrypted=await readFile(await download.path())
 await assert.rejects(decryptDocument(encrypted,'invalid'),WrongPasswordError)
 const result=await decryptDocument(encrypted,userPassword)
 assert.equal(result.unlockedAs,'user')
 assert.deepEqual(result.permissions,{printing:false,modifying:true,annotating:true,copying:false})
 assert.equal((await PDFDocument.load(result.bytes)).getPage(0).getRotation().angle,90)
 assert.equal((await decryptDocument(encrypted,ownerPassword)).unlockedAs,'owner')
 const latest=(await f.files.openFile(f.alice.token,file.fileId)).file
 assert.notEqual(latest.revision,file.revision)
 const latestBytes=await f.files.readFile(f.alice.token,file.fileId,latest.revision)
 assert.equal((await PDFDocument.load(latestBytes)).getPage(0).getRotation().angle,90)
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
 await expect(dialog).toHaveCount(0)
 await expect(page.locator('.dyoffice-pdf-persistence-state')).toHaveAttribute('data-dirty','false')

 const workspace=createWorkspaceService(f.transactions)
 const folder=await workspace.createFolder(f.alice.token,{name:'Confidential',parentId:null})
 await page.goto(origin+'/#/file/'+file.fileId)
 const editor=page.frameLocator(`iframe[data-document-id="${file.fileId}"]`)
 await expect(editor.locator('html')).toHaveAttribute('data-document-loading','ready',{timeout:30000})
 await editor.getByRole('button',{name:'Pages',exact:true}).click()
 await editor.getByRole('button',{name:'Rotate right',exact:true}).click()
 await expect(editor.locator('.dyoffice-pdf-persistence-state')).toHaveAttribute('data-dirty','true')
 await editor.getByRole('button',{name:'Annotate',exact:true}).click()
 await editor.getByRole('button',{name:'Protect',exact:true}).click()
 const protect=editor.getByRole('dialog',{name:'Save a protected copy',exact:true})
 await fillProtection(protect)
 const choose=protect.getByRole('button',{name:'Choose where to save',exact:true})
 const destination=editor.getByRole('dialog',{name:'Save a copy to your workspace',exact:true})
 await choose.click()
 await expect(destination.getByRole('textbox',{name:'File name'})).toHaveValue('plain-protected.pdf')
 await destination.getByRole('button',{name:'Cancel',exact:true}).click()
 await expect(choose).toBeEnabled()
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,latest.revision)
 await expect(editor.locator('.dyoffice-pdf-persistence-state')).toHaveAttribute('data-dirty','true')

 await choose.click()
 await destination.getByRole('textbox',{name:'File name'}).fill('Restricted review')
 await destination.getByRole('combobox',{name:'Folder'}).selectOption(folder.id)
 let committed
 await page.route('**/api/v1/uploads/*/finish',async route=>{
  try{
   const request=route.request()
   const response=await app.inject({method:'POST',url:new URL(request.url()).pathname,headers:await request.allHeaders()})
   assert.equal(response.statusCode,200)
   committed=response.json().file
  }finally{await route.abort('failed')}
 },{times:1})
 await destination.getByRole('button',{name:'Save copy',exact:true}).click()
 await expect(protect).toHaveCount(0,{timeout:30000})
 const confirmCopy=editor.getByRole('button',{name:'确认副本保存结果',exact:true})
 await expect(confirmCopy).toBeVisible()
 assert.ok(committed)
 await confirmCopy.click()
 await expect(page).toHaveURL(origin+'/#/file/'+committed.fileId)
 const copy=page.frameLocator(`iframe[data-document-id="${committed.fileId}"]`)
 const unlock=copy.getByRole('dialog').locator('input[type=password]')
 await unlock.fill(userPassword)
 await unlock.press('Enter')
 await expect(copy.locator('html')).toHaveAttribute('data-document-loading','ready',{timeout:30000})
 await expect(copy.locator('.tb-readonly')).toContainText('encrypted PDFs')

 const savedFiles=(await workspace.listFiles(f.alice.token,{folderId:folder.id})).files
 assert.deepEqual(savedFiles.map(file=>[file.id,file.name]),[[committed.fileId,'Restricted review.pdf']])
 assert.equal((await f.files.listFiles(f.alice.token)).files.length,2)
 const ciphertext=await f.files.readFile(f.alice.token,committed.fileId,committed.revision)
 await assert.rejects(decryptDocument(ciphertext,'invalid'),WrongPasswordError)
 const decrypted=await decryptDocument(ciphertext,userPassword)
 assert.equal(decrypted.unlockedAs,'user')
 assert.deepEqual(decrypted.permissions,result.permissions)
 assert.equal((await PDFDocument.load(decrypted.bytes)).getPage(0).getRotation().angle,180)
 assert.equal((await decryptDocument(ciphertext,ownerPassword)).unlockedAs,'owner')
 const finalSource=(await f.files.openFile(f.alice.token,file.fileId)).file
 assert.equal((await PDFDocument.load(await f.files.readFile(f.alice.token,file.fileId,finalSource.revision))).getPage(0).getRotation().angle,180)
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
 assert.equal(passwordRequests,0)
})
