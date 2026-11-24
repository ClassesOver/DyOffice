import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile} from 'node:fs/promises'
import {expect} from '@playwright/test'
import {PDFDocument} from 'pdf-lib'
import {buildLocalApp} from '../../server/src/app.ts'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {decryptDocument,WrongPasswordError} from '../../../pdf/src/main/pdf-crypt.ts'

const directory=process.env.DYOFFICE_TEST_NATIVE_PDF_DIST

test('Web PDF downloads an encrypted copy while leaving the workspace revision editable',{skip:!directory,timeout:90000},async t=>{
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
 })
 f.cleanup.unshift(()=>app.close())
 const browser=await launchTestBrowser()
 f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage({acceptDownloads:true})
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
 const passwordFields=dialog.locator('input[type="password"]')
 await passwordFields.nth(0).fill(userPassword)
 await passwordFields.nth(1).fill(userPassword)
 await passwordFields.nth(2).fill(ownerPassword)
 const permissionBoxes=dialog.getByRole('checkbox')
 await permissionBoxes.nth(0).uncheck()
 await permissionBoxes.nth(3).uncheck()
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
 assert.equal(passwordRequests,0)
 await expect(dialog).toHaveCount(0)
 await expect(page.locator('.dyoffice-pdf-persistence-state')).toHaveAttribute('data-dirty','false')
})
