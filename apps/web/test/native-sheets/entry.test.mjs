import {sandboxFixture} from '../helpers/native-sandbox.mjs'
import {sheetsGateway} from '../helpers/sheets-gateway.mjs'
import {createXlsxNativeWorker} from '../../worker/src/native/xlsx.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:https'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import JSZip from 'jszip'
import officeCrypto from 'officecrypto-tool'
import { fileFixture, docxBytes, importFile } from '../helpers/files.mjs'
import { password } from '../helpers/identity.mjs'
import {buildSheetsGateway} from '../../server/sheets/build.mjs'
import {configuredSheetsRuntime} from '../../server/src/modules/sheets/runtime.ts'
import {sheetsSaveRequest} from '../helpers/sheets-request.mjs'

const sheetsDirectory = process.env.DYOFFICE_TEST_SHEETS_DIRECTORY ?? fileURLToPath(new URL('../../dist-sheets/',import.meta.url))
const workspaceDirectory = process.env.DYOFFICE_TEST_WORKSPACE_DIRECTORY ?? fileURLToPath(new URL('../../dist-local-shell/',import.meta.url))
async function fixture(t,{nodeEngine=false,sheetsQueryFetcher,workspaceShell=false}={}) {
  const directory = await mkdtemp(join(tmpdir(),'dyoffice-native-sheets-'))
  let f, browser, server
  t.after(async () => {
    await browser?.close()
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    await f?.app.close()
    await rm(directory,{ recursive: true,force: true })
  })
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(directory,'key.pem'),'-out',join(directory,'cert.pem'),'-days','1','-subj','/CN=localhost'],{ stdio: 'pipe' })
  server = createServer({ key: await readFile(join(directory,'key.pem')),cert: await readFile(join(directory,'cert.pem')) },(req,res) => f.app.routing(req,res))
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  const origin = `https://127.0.0.1:${server.address().port}`
  let engine,planWorkbookSave,readWorkbookPackage
  if(nodeEngine){
    await buildSheetsGateway(join(directory,'gateway.mjs'))
    const runtime=await configuredSheetsRuntime({
      DYOFFICE_AUTH_MODE:'local',DYOFFICE_SANDBOX_MODE:'subprocess',DYOFFICE_DEPLOYMENT_ID:randomUUID(),
      DYOFFICE_XLSX_NODE_ENGINE:join(directory,'xlsx-node-engine.mjs'),DYOFFICE_XLSX_GATEWAY_RUNNER:join(directory,'gateway-process.mjs'),
    },{enabled:true})
    t.after(()=>runtime.close())
    ;({sheetsNative:engine,sheetsPlanner:planWorkbookSave,sheetsPackageReader:readWorkbookPackage}=runtime)
  }else{
    ;({planWorkbookSave,readWorkbookPackage}=await sheetsGateway(t))
    engine=createXlsxNativeWorker(await sandboxFixture('native'))
  }
  const native=Object.fromEntries(Object.entries(engine).map(([name,operation])=>[name,async(...args)=>{try{return await operation(...args)}catch(error){t.diagnostic('Native '+name+' failed: '+String(error?.code ?? error?.message ?? error));throw error}}]))
  const planner=async(...args)=>{try{return await planWorkbookSave(...args)}catch(error){t.diagnostic('Workbook planner failed: '+String(error?.message ?? error));throw error}}
  f = await fileFixture(t,{ origin,nativeSheetsDirectory: sheetsDirectory,sheetsNative:native,sheetsPlanner:planner,sheetsPackageReader:readWorkbookPackage,sheetsQueryFetcher,...(workspaceShell?{localShellDirectory:workspaceDirectory}:{}) })
  await f.preferences.update(f.alice.token,{ language: 'en',autoSave: false,showAssistant: false })
  const original = await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url)), opened = await importFile(f,f.alice.token,original,'acceptance.xlsx')
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ ignoreHTTPSErrors: true,viewport: { width: 1440,height: 1100 } }), page = await context.newPage()
  const errors=[]
  const recordError=message=>errors.push(message.replace(/([?&]ticket=)[^&\s'"<>]+/g,'$1[redacted]').slice(0,1000))
  page.on('pageerror',error=>recordError(error.message))
  page.on('console',message=>{if(message.type()==='error')recordError(message.text())})
  page.on('response',response=>{if(response.status()>=400)errors.push(response.status()+' '+new URL(response.url()).pathname)})
  t.after(()=>{if(errors.length)console.error('Browser diagnostics:',errors)})
  await page.addInitScript(()=>{window.__genofficeDebugHooks=true})
  await page.goto(origin + '/')
  const status = await page.evaluate(async password => {
    const challenge = await (await fetch('/api/v1/auth/csrf')).json()
    return (await fetch('/api/v1/auth/login',{ method: 'POST',headers: { 'content-type': 'application/json','x-csrf-token': challenge.csrfToken },body: JSON.stringify({ username: 'alice',password }) })).status
  },password)
  assert.equal(status,200)
  errors.length=0
  return { ...f, original, opened, browser, context, page, origin, errors, planner }
}

test('workspace imports and opens a local encrypted XLSX after one correct password',{timeout:150000},async t=>{
 const f=await fixture(t,{nodeEngine:true,workspaceShell:true}),{page}=f
 const name='local-encrypted.xlsx',secret='  表格🔑 ',encrypted=Buffer.from(officeCrypto.encrypt(f.original,{password:secret}))
 await f.preferences.update(f.alice.token,{language:'zh'})
 await page.goto(f.origin)
 await page.getByRole('button',{name:/^打开本地文件/}).click()
 const dialog=page.getByRole('dialog',{name:'上传文件',exact:true})
 await dialog.locator('input[type=file]').setInputFiles({name,mimeType:'application/octet-stream',buffer:encrypted})
 await dialog.getByRole('button',{name:'开始上传（1）'}).click()
 const prompt=dialog.getByLabel(`输入 ${name} 的工作簿密码`)
 await expect(prompt).toBeFocused()
 const countImported=async()=>(await f.files.listFiles(f.alice.token)).files.filter(file=>file.name===name)
 assert.equal((await countImported()).length,0)
 await prompt.fill('wrong password')
 await dialog.getByRole('button',{name:'确认密码'}).click()
 await expect(dialog.getByRole('alert')).toContainText('工作簿密码错误')
 assert.equal((await countImported()).length,0)
 await expect(prompt).toHaveValue('')
 await prompt.fill(secret)
 await prompt.press('Enter')
 await expect(dialog).toContainText('已上传并打开',{timeout:35000})
 await dialog.getByRole('button',{name:'完成',exact:true}).click()
 const native=page.frameLocator(`iframe[title="${name}"]`)
 await expect(native.locator('html')).toHaveAttribute('data-document-loading','ready',{timeout:55000})
 await expect.poll(()=>native.locator('html').evaluate(element=>element.ownerDocument.defaultView.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange('A1').getValue()),{timeout:20000}).toBe('Revenue')
 await expect(native.locator('.encrypted-workbook-password-dialog')).toHaveCount(0)
 assert.equal((await countImported()).length,1)
 const [{id}]=await countImported(),opened=await f.files.openFile(f.alice.token,id)
 assert.equal(opened.workbookPasswordProtected,true)
 assert.deepEqual(await f.files.readFile(f.alice.token,id,opened.file.revision),encrypted)
 await native.locator('html').evaluate(element=>{element.ownerDocument.defaultView.location.reload()})
 await expect(native.locator('.encrypted-workbook-password-dialog')).toBeVisible({timeout:30000})
})

test('Web XLSX prompts for a password and saves edits as a protected revision',{timeout:120000},async t=>{
 const f=await fixture(t,{nodeEngine:true}),{page}=f
 const workbookPassword='表格 password fixture',zip=await JSZip.loadAsync(f.original)
 const path='xl/worksheets/sheet1.xml',xml=await zip.file(path).async('string')
 const modified=xml.replace(/<c\b[^>]*\br="A1"[^>]*>[\s\S]*?<\/c>/,'<c r="A1" t="inlineStr"><is><t>Locked workbook fixture</t></is></c>')
 assert.notEqual(modified,xml)
 zip.file(path,modified)
 const encrypted=Buffer.from(officeCrypto.encrypt(await zip.generateAsync({type:'nodebuffer'}),{password:workbookPassword}))
 const stage=await f.files.stageUpload(f.alice.token,{name:'locked.xlsx',size:encrypted.length})
 await f.files.receiveUpload(f.alice.token,stage.uploadId,encrypted,{password:workbookPassword})
 const {file}=await f.files.finishUpload(f.alice.token,stage.uploadId)
 const unlock=async value=>{
  const dialog=page.getByRole('dialog',{name:'Open password-protected workbook'})
  await dialog.getByLabel('Password').fill(value)
  const response=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/sheets/unlock'))
  await dialog.getByRole('button',{name:'Open',exact:true}).click()
  return (await response).status()
 }
 await page.goto(f.origin+'/native-xlsx/?fileId='+file.fileId)
 assert.equal(await unlock('wrong password'),422)
 await expect(page.getByRole('alert')).toContainText('The workbook password is incorrect.')
 assert.equal(await unlock(workbookPassword),200)
 await expect.poll(async()=>page.evaluate(()=>window.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange('A1').getValue()),{timeout:25000}).toBe('Locked workbook fixture')
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready')
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),encrypted)
 const current=()=>f.files.openFile(f.alice.token,file.fileId)
 let latest=file.revision
 for(const value of [73,89]){
  const prior=latest
  const reopened=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/sheets/inspect')&&response.request().postDataJSON()?.revision!==prior)
  await page.evaluate(value=>window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange('A2').setValue(value),value)
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(async()=>(await current()).file.revision,{timeout:16000}).not.toBe(latest)
  const saved=await current()
  latest=saved.file.revision
  assert.equal(saved.workbookPasswordProtected,true)
  const stored=await f.files.readFile(f.alice.token,file.fileId,latest)
  assert.equal(stored.subarray(0,8).toString('hex'),'d0cf11e0a1b11ae1')
  const decrypted=await JSZip.loadAsync(await officeCrypto.decrypt(stored,{password:workbookPassword}))
  assert.match(await decrypted.file(path).async('string'),new RegExp(`<c\\b[^>]*r="A2"[^>]*><v>${value}<\\/v>`))
  assert.equal((await reopened).status(),200)
  await expect.poll(async()=>page.evaluate(()=>window.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange('A2').getValue()),{timeout:20000}).toBe(value)
 }
 await page.reload()
 await expect(page.getByRole('dialog',{name:'Open password-protected workbook'})).toBeVisible()
 assert.equal(await unlock(workbookPassword),200)
 await expect.poll(async()=>page.evaluate(()=>window.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange('A2').getValue()),{timeout:20000}).toBe(89)
 assert.equal((await current()).file.revision,latest)
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),encrypted)
})

test('Review changes an encrypted XLSX password and reconciles a lost commit receipt',{timeout:160000},async t=>{
 const f=await fixture(t,{nodeEngine:true}),{page}=f,token=f.alice.token
 const oldPassword='Old workbook password',newPassword='  新密码 🔑 '
 const ciphertext=Buffer.from(officeCrypto.encrypt(f.original,{password:oldPassword}))
 const upload=await f.files.stageUpload(token,{name:'change-password.xlsx',size:ciphertext.length})
 await f.files.receiveUpload(token,upload.uploadId,ciphertext,{password:oldPassword})
 const {file}=await f.files.finishUpload(token,upload.uploadId),id=file.fileId
 await page.goto(`${f.origin}/native-xlsx/?fileId=${id}`)
 const open=page.getByRole('dialog',{name:'Open password-protected workbook'})
 const unlock=async password=>{
  await open.getByLabel('Password').fill(password)
  await open.getByRole('button',{name:'Open',exact:true}).click()
 }
 const cell=()=>page.evaluate(()=>window.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange('A2').getValue())
 const edit=value=>page.evaluate(value=>window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange('A2').setValue(value),value)
 const current=()=>f.files.openFile(token,id)
 const decrypt=async(revision,password)=>JSZip.loadAsync(await officeCrypto.decrypt(await f.files.readFile(token,id,revision),{password}))
 const sheetXml=workbook=>workbook.file('xl/worksheets/sheet1.xml').async('string')
 let allowUnlock,unlockRequested
 const pauseUnlock=new Promise(resolve=>{allowUnlock=resolve}),requestStarted=new Promise(resolve=>{unlockRequested=resolve})
 await page.route('**/sheets/unlock',async route=>{unlockRequested();await pauseUnlock;await route.continue()},{times:1})
 try{
  await unlock(oldPassword)
  await requestStarted
  assert.equal(await page.evaluate(()=>window.dyofficeEditorDispose()),false)
 }finally{allowUnlock()}
 await expect.poll(cell,{timeout:25000}).toBe(12.5)
 await page.getByRole('button',{name:'Review',exact:true}).click()
 await edit(97)
 await page.locator('.ribbon-tool[data-tip="Change Password"]').click()
 const dialog=page.getByRole('dialog',{name:'Change workbook password'})
 await dialog.getByLabel('New password',{exact:true}).fill(newPassword)
 await dialog.getByLabel('Confirm new password',{exact:true}).fill('different')
 await dialog.getByRole('button',{name:'Update Password',exact:true}).click()
 await expect(dialog.getByRole('alert')).toHaveText('The passwords do not match.')
 assert.equal((await current()).file.revision,file.revision)

 let rotationUpload,rotationGrant,rotationProof,receiptLost=false,prepares=0
 const commitAttempts=[]
 await page.route('**/sheets/password-uploads',async route=>{
  prepares++
  rotationGrant=route.request().postDataJSON().unlockId
  rotationProof=(await route.request().allHeaders())['x-csrf-token']
  const response=await route.fetch()
  rotationUpload=(await response.json()).uploadId
  await route.fulfill({response})
 })
 await page.route('**/commits',async route=>{
  const input=route.request().postDataJSON()
  if(input.uploadId!==rotationUpload)return route.continue()
  commitAttempts.push(input)
  if(receiptLost)return route.continue()
  const result=await route.fetch()
  receiptLost=result.ok()
  if(receiptLost){
   // The editor must also recover if the original in-memory grant is gone.
   const lock=await page.request.post(`${f.origin}/api/v1/files/${id}/sheets/lock`,{
    headers:{origin:f.origin,'x-csrf-token':rotationProof},data:{revision:input.baseRevision,unlockId:rotationGrant},
   })
   assert.equal(lock.status(),200)
  }
  await route.abort()
 })
 await dialog.getByLabel('Confirm new password',{exact:true}).fill(newPassword)
 await dialog.getByRole('button',{name:'Update Password',exact:true}).click()
 const confirm=dialog.getByRole('button',{name:'Confirm save outcome',exact:true})
 await expect(confirm).toBeVisible({timeout:40000})
 assert.equal(receiptLost,true)
 await confirm.click()
 await expect(dialog).not.toBeVisible({timeout:25000})
 assert.equal(prepares,1)
 assert.equal(commitAttempts.length,2)
 assert.deepEqual(commitAttempts[0],commitAttempts[1])
 const rotated=(await current()).file.revision
 assert.match(await sheetXml(await decrypt(rotated,newPassword)),/<c\b[^>]*r="A2"[^>]*><v>97<\/v>/)
 await expect.poll(cell).toBe(97)

 await edit(108)
 await page.keyboard.press('ControlOrMeta+s')
 await expect.poll(async()=>(await current()).file.revision,{timeout:25000}).not.toBe(rotated)
 const saved=(await current()).file.revision
 assert.match(await sheetXml(await decrypt(saved,newPassword)),/<c\b[^>]*r="A2"[^>]*><v>108<\/v>/)
 assert.deepEqual(await f.files.readFile(token,id,file.revision),ciphertext)
 await page.reload()
 await unlock(oldPassword)
 await expect(open.getByRole('alert')).toHaveText('The workbook password is incorrect.')
 await unlock(newPassword)
 await expect.poll(cell,{timeout:25000}).toBe(108)
})

for(const encrypted of [false,true])test(`Web XLSX refreshes a web query and saves the ${encrypted?'encrypted':'plain'} workbook`,{timeout:120000},async t=>{
 const source='https://data.example.test/revenue.csv'
 const fetched=[]
 let releaseSecond
 const pause=new Promise(resolve=>{releaseSecond=resolve})
 const f=await fixture(t,{nodeEngine:true,sheetsQueryFetcher:async url=>{
  fetched.push(url)
  if(fetched.length===2)await pause
  return {headers:['Fresh revenue'],rows:[['24.5']]}
 }}),{page}=f
 const zip=await JSZip.loadAsync(f.original)
 const book='xl/workbook.xml'
 const rel='xl/_rels/workbook.xml.rels'
 const ct='[Content_Types].xml'
 const sheet='xl/worksheets/sheet1.xml'
 const relationships='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
 const spreadsheet='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
 zip.file(book,(await zip.file(book).async('string')).replace('</definedNames>',
  '<definedName name="ExternalData_1" localSheetId="0" hidden="1">Acceptance!$A$1:$A$3</definedName></definedNames>'))
 zip.file(rel,(await zip.file(rel).async('string')).replace('</Relationships>',
  `<Relationship Id="rId900" Type="${relationships}/connections" Target="connections.xml"/></Relationships>`))
 zip.file('xl/connections.xml',`<connections xmlns="${spreadsheet}"><connection id="7" name="Revenue feed" type="4"><webPr url="${source}"/></connection></connections>`)
 zip.file('xl/queryTables/queryTable1.xml',`<queryTable xmlns="${spreadsheet}" name="ExternalData_1" connectionId="7"/>`)
 const sheetRels='xl/worksheets/_rels/sheet1.xml.rels'
 const current=await zip.file(sheetRels)?.async('string')??'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
 zip.file(sheetRels,current.replace('</Relationships>',
  `<Relationship Id="rId900" Type="${relationships}/queryTable" Target="../queryTables/queryTable1.xml"/></Relationships>`))
 zip.file(ct,(await zip.file(ct).async('string')).replace('</Types>',
  '<Override PartName="/xl/connections.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.connections+xml"/>'+
  '<Override PartName="/xl/queryTables/queryTable1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.queryTable+xml"/></Types>'))
 const original=await zip.generateAsync({type:'nodebuffer'})
 const password='Web query workbook fixture'
 const imported=encrypted?Buffer.from(officeCrypto.encrypt(original,{password})):original
 const upload=await f.files.stageUpload(f.alice.token,{name:'Web query.xlsx',size:imported.length})
 await f.files.receiveUpload(f.alice.token,upload.uploadId,imported,encrypted?{password}:undefined)
 const {file}=await f.files.finishUpload(f.alice.token,upload.uploadId)
 const unlock=async()=>{
  if(!encrypted)return
  const dialog=page.getByRole('dialog',{name:'Open password-protected workbook'})
  await dialog.getByLabel('Password').fill(password)
  await dialog.getByRole('button',{name:'Open',exact:true}).click()
 }
 await page.goto(f.origin+'/native-xlsx/?fileId='+file.fileId)
 await unlock()
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready',{timeout:45000})
 await page.getByRole('button',{name:'Data',exact:true}).click()
 const refresh=async()=>{
  await page.getByRole('button',{name:'Refresh query',exact:true}).click({timeout:10000})
  await page.getByRole('option',{name:'Revenue feed — data.example.test',exact:true}).click()
 }
 const reply=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/sheets/web-query'))
 await refresh()
 assert.equal((await reply).status(),200)
 const cell=address=>page.evaluate(address=>window.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange(address).getValue(),address)
 await expect.poll(()=>cell('A2'),{timeout:15000}).toBe(24.5)
 assert.equal(await cell('A1'),'Fresh revenue')
 assert.ok([null,undefined,''].includes(await cell('A3')))
 assert.deepEqual(fetched,[source])
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
 await page.keyboard.press('ControlOrMeta+s')
 const revision=async()=>(await f.files.openFile(f.alice.token,file.fileId)).file.revision
 await expect.poll(revision,{timeout:15000}).not.toBe(file.revision)
 const committed=await revision()
 const savedBytes=await f.files.readFile(f.alice.token,file.fileId,committed)
 const saved=await JSZip.loadAsync(encrypted?await officeCrypto.decrypt(savedBytes,{password}):savedBytes)
 assert.match(await saved.file(sheet).async('string'),/<c\b[^>]*r="A2"[^>]*><v>24\.5<\/v>/)
 assert.equal(await saved.file('xl/connections.xml').async('string'),await zip.file('xl/connections.xml').async('string'))
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),imported)
 await page.reload()
 await unlock()
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready',{timeout:45000})
 await expect.poll(()=>cell('A2'),{timeout:10000}).toBe(24.5)
 await page.getByRole('button',{name:'Data',exact:true}).click()
 await refresh()
 try {
  await expect.poll(()=>fetched.length,{timeout:15000}).toBe(2)
  await page.evaluate(()=>window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange('A2').setValue(88))
 } finally {
  releaseSecond()
 }
 await expect(page.locator('.workbook-status')).toHaveText('Could not refresh Revenue feed',{timeout:15000})
 assert.equal(await cell('A2'),88)
 assert.deepEqual(fetched,[source,source])
 assert.equal(await revision(),committed)
})

for(const encrypted of [false,true])test(`Web XLSX Save As copies unsaved cells from a ${encrypted?'protected':'plain'} workbook`,{timeout:120000},async t=>{
 const f=await fixture(t,{nodeEngine:true}), {page}=f
 const password='Protected workbook copy fixture'
 const originalBytes=encrypted?Buffer.from(officeCrypto.encrypt(f.original,{password})):f.original
 let original=f.opened.file
 if(encrypted){
  const upload=await f.files.stageUpload(f.alice.token,{name:'protected.xlsx',size:originalBytes.length})
  await f.files.receiveUpload(f.alice.token,upload.uploadId,originalBytes,{password})
  original=(await f.files.finishUpload(f.alice.token,upload.uploadId)).file
 }
 const unlock=async(target=page)=>{
  if(!encrypted)return
  const prompt=target.getByRole('dialog',{name:'Open password-protected workbook'})
  await prompt.getByLabel('Password').fill(password)
  await prompt.getByRole('button',{name:'Open',exact:true}).click()
 }
 const cell=(target=page)=>target.evaluate(()=>window.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange('A2').getValue())
 await page.goto(f.origin+'/native-xlsx/?fileId='+original.fileId)
 await unlock()
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready',{timeout:45000})
 await expect.poll(cell,{timeout:30000}).toBe(12.5)
 await page.evaluate(()=>window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange('A2').setValue(21.25))
 await page.getByRole('button',{name:'File',exact:true}).click()
 const saveAs=page.getByRole('group',{name:'File',exact:true}).getByRole('button',{name:'Save As',exact:true})
 await expect(saveAs).toBeEnabled()
 await saveAs.click()
 const dialog=page.getByRole('dialog',{name:'Save a copy to your workspace'})
 const input=dialog.getByRole('textbox',{name:'File name'})
 await expect(input).toHaveValue(encrypted?'protected.xlsx':'acceptance.xlsx')
 await dialog.getByRole('button',{name:'Cancel',exact:true}).click()
 await expect(dialog).toHaveCount(0)
 assert.equal((await f.files.listFiles(f.alice.token)).files.length,encrypted?2:1)
 await page.keyboard.press('ControlOrMeta+Shift+s')
 await input.fill('Manual workbook copy')
 await dialog.getByRole('button',{name:'Save copy',exact:true}).click()
 await expect(page.getByText('Saved copy: Manual workbook copy.xlsx',{exact:true})).toBeVisible({timeout:30000})
 const copy=(await f.files.listFiles(f.alice.token)).files.find(item=>item.name==='Manual workbook copy.xlsx')
 assert.ok(copy)
 const stored=await f.files.readFile(f.alice.token,copy.id,copy.revision)
 const copyHead=await f.files.openFile(f.alice.token,copy.id)
 assert.equal(copyHead.workbookPasswordProtected,encrypted?true:undefined)
 const archive=await JSZip.loadAsync(encrypted?await officeCrypto.decrypt(stored,{password}):stored)
 assert.match(await archive.file('xl/worksheets/sheet1.xml').async('string'),/<c\b[^>]*r="A2"[^>]*><v>21\.25<\/v>/)
 assert.equal((await f.files.openFile(f.alice.token,original.fileId)).file.revision,original.revision)
 assert.deepEqual(await f.files.readFile(f.alice.token,original.fileId,original.revision),originalBytes)
 await expect.poll(cell).toBe(21.25)
 await expect(page.getByRole('button',{name:/^Save \(/})).toBeEnabled()
 const copyPage=await f.context.newPage()
 await copyPage.addInitScript(()=>{window.__genofficeDebugHooks=true})
 await copyPage.goto(f.origin+'/native-xlsx/?fileId='+copy.id)
 await unlock(copyPage)
 await expect.poll(()=>cell(copyPage),{timeout:30000}).toBe(21.25)
})

test('Web XLSX File menu and shortcut open Print preview and print without saving',{timeout:90000},async t=>{
 const f=await fixture(t,{nodeEngine:true})
 const original=f.opened.file
 await f.page.goto(f.origin+'/native-xlsx/?fileId='+original.fileId)
 await expect(f.page.locator('html')).toHaveAttribute('data-document-loading','ready',{timeout:45000})
 await f.page.evaluate(()=>{
  const sheet=window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet()
  sheet.getRange('A1').setValue('Draft revenue')
 })

 await f.page.getByRole('button',{name:'File',exact:true}).click()
 const filePrint=f.page.getByRole('group',{name:'File',exact:true}).getByRole('button',{name:'Print',exact:true})
 await expect(filePrint).toBeEnabled()
 await filePrint.click()
 const dialog=f.page.getByRole('dialog',{name:'Print',exact:true})
 await expect(dialog).toBeVisible()
 await dialog.getByRole('button',{name:'Cancel',exact:true}).click()
 await expect(dialog).toBeHidden()
 await f.page.keyboard.press('ControlOrMeta+p')
 await expect(dialog).toBeVisible()
 const print=dialog.getByRole('button',{name:'Print / Print to PDF',exact:true})
 const preview=dialog.frameLocator('iframe[title="Print"]')
 await expect(preview.getByText('Draft revenue',{exact:true})).toBeVisible()
 const previewPageCount=await preview.locator('.page').count()
 await expect(print).toBeEnabled()
 await f.page.evaluate(()=>{
  const append=document.body.append
  document.body.append=function(...children){
   for(const frame of children){
    if(!(frame instanceof HTMLIFrameElement)||!frame.sandbox.contains('allow-modals'))continue
    frame.addEventListener('load',()=>{
     const target=frame.contentWindow
     const browserPrint=target.print.bind(target)
     target.print=()=>{
      window.printedWorkbook={
       title:target.document.title,
       pages:target.document.querySelectorAll('.page').length,
       html:frame.srcdoc,
      }
      browserPrint()
     }
    },{capture:true,once:true})
   }
   return append.apply(this,children)
  }
 })
 await print.click()
 await expect(dialog).toBeHidden()
 const printed=await f.page.evaluate(()=>window.printedWorkbook)
 assert.equal(printed?.title,'acceptance')
 assert.equal(printed.pages,previewPageCount)
 const pdfPage=await f.context.newPage()
 try {
  await pdfPage.setContent(printed.html)
  const bytes=await pdfPage.pdf({preferCSSPageSize:true,printBackground:true})
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task=getDocument({data:Uint8Array.from(bytes)})
  try {
   const pdf=await task.promise
   assert.equal(pdf.numPages,printed.pages)
   const content=await (await pdf.getPage(1)).getTextContent()
   assert.ok(content.items.some(item=>item.str==='Draft revenue'))
  } finally {
   await task.destroy()
  }
 } finally {
  await pdfPage.close()
 }
 assert.equal((await f.files.openFile(f.alice.token,original.fileId)).file.revision,original.revision)
})

test('Node XLSX preserves existing cell notes when adding a note and saving in Chromium',{timeout:90000},async t=>{
 const f=await fixture(t,{nodeEngine:true})
 const request=sheetsSaveRequest('sheet-1',[])
 request.noteStates=[{sheetId:'sheet-1',notes:[{row:1,column:0,author:'Audit',text:'Existing note on A2'}]}]
 const plan=await f.planner(f.original,[{id:'sheet-1',name:'Acceptance'}],request)
 const zip=await JSZip.loadAsync(f.original)
 for(const path of plan.removedEntries)zip.remove(path)
 for(const parts of [plan.replaced,plan.added,plan.addedBinary])for(const [path,value] of parts)zip.file(path,value)
 const commentPart=zip.file(/^xl\/comments\d+\.xml$/)[0]
 const styledText='<r><rPr><b/></rPr><t xml:space="preserve">Existing note </t></r><r><t>on A2</t></r>'
 const seededComment=(await commentPart.async('string')).replace(/<t[^>]*>Existing note on A2<\/t>/,styledText)
 assert.ok(seededComment.includes(styledText))
 zip.file(commentPart.name,seededComment)
 const vmlPart=zip.file(/^xl\/drawings\/vmlDrawing\d+\.vml$/)[0]
 const geometry='width:152pt;height:77pt;z-index:1;visibility:visible'
 const seededVml=(await vmlPart.async('string')).replace('width:108pt;height:60pt;z-index:1;visibility:hidden',geometry)
 assert.ok(seededVml.includes(geometry))
 zip.file(vmlPart.name,seededVml)
 const {file}=await importFile(f,f.alice.token,await zip.generateAsync({type:'nodebuffer'}),'notes.xlsx')
 await f.page.goto(f.origin+'/native-xlsx/?fileId='+file.fileId)
 await expect(f.page.locator('html')).toHaveAttribute('data-document-loading','ready',{timeout:45000})
 const notes=()=>f.page.evaluate(()=>window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getNotes().map(note=>note.note))
 await expect.poll(notes).toEqual([expect.stringContaining('Existing note on A2')])
 await f.page.evaluate(()=>{
  const sheet=window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet()
  sheet.getRange('A3').createOrUpdateNote({id:'note-a3',row:2,col:0,width:220,height:90,note:'New note on A3'})
 })
 await expect.poll(notes).toEqual(expect.arrayContaining(['New note on A3']))
 const downloaded=f.page.waitForEvent('download')
 await f.page.locator('.dyoffice-sheets-download').click()
 const after=await JSZip.loadAsync(await readFile(await (await downloaded).path()))
 const comments=await after.file(commentPart.name).async('string')
 assert.ok(comments.includes(styledText))
 assert.match(comments,/New note on A3/)
 assert.ok((await after.file(vmlPart.name).async('string')).includes(geometry))
 const head=await f.files.openFile(f.alice.token,file.fileId)
 assert.notEqual(head.file.revision,file.revision)
 await f.page.reload()
 await expect(f.page.locator('html')).toHaveAttribute('data-document-loading','ready',{timeout:45000})
 await expect.poll(notes).toEqual(expect.arrayContaining([
  expect.stringContaining('Existing note on A2'),expect.stringContaining('New note on A3'),
 ]))
})

test('Node XLSX keeps password-protected ranges locked while saving allowed cells',{timeout:90000},async t=>{
 const f=await fixture(t,{nodeEngine:true})
 const zip=await JSZip.loadAsync(f.original)
 zip.file('xl/styles.xml','<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font/></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf applyProtection="1"><protection locked="0"/></xf></cellXfs></styleSheet>')
 const protection='<sheetProtection sheet="1"/><protectedRanges><protectedRange name="Open" sqref="C1"/><protectedRange name="Password" sqref="D1" password="CBEB"/></protectedRanges>'
 const sheetPath='xl/worksheets/sheet1.xml'
 zip.file(sheetPath,`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:D1"/><sheetData><row r="1"><c r="A1"><v>12</v></c><c r="B1" s="1"><v>18</v></c><c r="C1"><v>24</v></c><c r="D1"><v>36</v></c></row></sheetData>${protection}</worksheet>`)
 const original=await zip.generateAsync({type:'nodebuffer'})
 const {file}=await importFile(f,f.alice.token,original,'protected.xlsx')
 await f.page.goto(f.origin+'/native-xlsx/?fileId='+file.fileId)
 await expect(f.page.locator('html')).toHaveAttribute('data-document-loading','ready',{timeout:45000})
 const values=()=>f.page.evaluate(()=>{
  const sheet=window.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getActiveSheet()
  return ['A1','B1','C1','D1'].map(cell=>sheet?.getRange(cell).getValue())
 })
 await expect.poll(values,{timeout:30000}).toEqual([12,18,24,36])
 const setValue=(cell,value)=>f.page.evaluate(({cell,value})=>{
  window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange(cell).setValue(value)
 },{cell,value})
 // Initial paint can precede completion of the full preload. Wait until the
 // guard can reliably evaluate the unlocked cell's loaded style.
 await expect.poll(async()=>{
  if((await values())[1]!==19)await setValue('B1',19)
  return (await values())[1]
 },{timeout:30000}).toBe(19)
 for(const cell of ['A1','D1']){
  await setValue(cell,99)
  await expect(f.page.locator('.status-bar .status-msg')).toContainText('protected sheet')
  assert.deepEqual(await values(),[12,19,24,36])
 }
 await setValue('C1',25)
 await expect.poll(values).toEqual([12,19,25,36])
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)

 const [download]=await Promise.all([
  f.page.waitForEvent('download'),f.page.locator('.dyoffice-sheets-download').click(),
 ])
 const saved=(await f.files.openFile(f.alice.token,file.fileId)).file
 assert.notEqual(saved.revision,file.revision)
 const bytes=await readFile(await download.path())
 assert.deepEqual(bytes,await f.files.readFile(f.alice.token,file.fileId,saved.revision))
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
 const reopened=await JSZip.loadAsync(bytes)
 assert.ok((await reopened.file(sheetPath).async('string')).includes(protection))
 await f.page.reload()
 await expect.poll(values,{timeout:30000}).toEqual([12,19,25,36])
})

for (const theme of ['light','dark']) test(`native Sheets saves and downloads formulas and chart colors with the ${theme} UI theme`,{timeout:90000},async t=>{
 const f=await fixture(t)
 await f.preferences.update(f.alice.token,{theme})
 const response=await f.page.goto(f.origin+'/native-xlsx/?fileId='+f.opened.file.fileId)
 assert.equal(response.status(),200,'Native Sheets entry must exist and authorize the owned workbook')
 await expect(f.page.locator('html')).toHaveAttribute('data-theme',theme)
 await f.page.locator('#univer-container canvas').first().waitFor({timeout:45000})
 await expect(f.page.locator('html')).toHaveAttribute('data-document-loading','ready',{timeout:30000})
 const saveDownload=f.page.locator('.dyoffice-sheets-download')
 await expect(saveDownload).toBeEnabled()
 await expect(f.page.locator('.dyoffice-sheets-state')).toHaveCount(0)
 await expect.poll(()=>f.page.evaluate(()=>window.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange('A2').getValue()),{timeout:30000}).toBe(12.5)
 await expect.poll(()=>f.page.evaluate(()=>window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange('B2').getValue()),{timeout:30000}).toBe(25)
 await expect.poll(()=>f.page.evaluate(()=>window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange('F2').getValue()),{timeout:30000}).toBe(20)
 const formats=await f.page.evaluate(()=>{
  const sheet=window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet()
  return ['B2','C2','D2','E2','F2'].map(address=>{const r=sheet.getRange(address);return {value:r.getCellDatas()[0]?.[0]?.v,display:r.getDisplayValue(),formula:r.getFormula()}})
 })
 assert.equal(formats[0].formula,'=A2*2')
 assert.equal(formats[1].value,45292);assert.match(formats[1].display,/2024|24/)
 assert.equal(formats[2].value,0.125);assert.equal(formats[2].display,'12.50%')
 assert.equal(formats[3].value,1234.567);assert.match(formats[3].display,/^1234\.57[ \u00a0]kg$/)
 assert.equal(formats[4].formula,'=SUM(Revenue)')
 const revision=await f.files.openFile(f.alice.token,f.opened.file.fileId)
 assert.equal(revision.file.revision,f.opened.file.revision,'Opening a workbook must not create a saved revision')
 await f.page.evaluate(()=>{window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange('A2').setValue(21.25)})
 // Save immediately: formula and chart synchronization belong to the save
 // pipeline, not an acceptance-test delay that hides stale cache races.
 const [download]=await Promise.all([f.page.waitForEvent('download'),saveDownload.click()])
 await expect.poll(async()=>(await f.files.openFile(f.alice.token,f.opened.file.fileId)).file.revision,{timeout:30000}).not.toBe(f.opened.file.revision)
 const saved=await f.files.openFile(f.alice.token,f.opened.file.fileId)
 const bytes=await f.files.readFile(f.alice.token,saved.file.fileId,saved.file.revision)
 const downloadedBytes=await readFile(await download.path())
 assert.deepEqual(downloadedBytes,bytes)
 const before=await JSZip.loadAsync(f.original),after=await JSZip.loadAsync(downloadedBytes)
 assert.deepEqual(await before.file('customXml/t09-preserve.xml').async('nodebuffer'),await after.file('customXml/t09-preserve.xml').async('nodebuffer'))
 const savedXml=await after.file('xl/worksheets/sheet1.xml').async('string')
 assert.match(savedXml,/<v>21\.25<\/v>/)
 assert.match(savedXml,/<c[^>]*r="B2"[^>]*>[\s\S]*?<f[^>]*>A2\*2<\/f>[\s\S]*?<v>42\.5<\/v>/)
 assert.match(await after.file('xl/workbook.xml').async('string'),/name="Revenue"/)
 const savedChart=await after.file('xl/charts/chart1.xml').async('string')
 assert.match(savedChart,/<c:f>Acceptance!\$A\$2:\$A\$3<\/c:f>/)
 assert.match(savedChart,/<c:pt idx="0"><c:v>21\.25<\/c:v><\/c:pt>/)
 assert.match(savedChart,/<c:pt idx="1"><c:v>7\.5<\/c:v><\/c:pt>/)
 assert.match(savedChart,/<c:spPr><a:solidFill><a:srgbClr val="4472C4"\/>/)
 assert.deepEqual(await before.file('xl/drawings/drawing1.xml').async('nodebuffer'),await after.file('xl/drawings/drawing1.xml').async('nodebuffer'))
 await f.page.reload()
 await expect.poll(()=>f.page.evaluate(()=>window.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange('A2').getValue()),{timeout:30000}).toBe(21.25)

})

test('lost commit response confirmation carries edits made while the real editor saved',{timeout:90000},async t=>{
 const f=await fixture(t)
 await f.page.goto(f.origin+'/native-xlsx/?fileId='+f.opened.file.fileId)
 await expect.poll(()=>f.page.evaluate(()=>window.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange('A2').getValue()),{timeout:30000}).toBe(12.5)
 let reached,release,preparations=0
 const entered=new Promise(resolve=>{reached=resolve}),gate=new Promise(resolve=>{release=resolve})
 f.page.on('request',request=>{if(new URL(request.url()).pathname.endsWith('/sheets/uploads'))preparations++})
 await f.page.route('**/commits',async route=>{
  const response=await route.fetch()
  assert.equal(response.status(),200)
  reached();await gate
  await route.abort('failed')
 },{times:1})
 await f.page.evaluate(()=>window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange('A2').setValue(40))
 const save=f.page.locator('.qa-btn').first()
 await expect(save).toBeEnabled();await save.click()
 await entered
 // This edit is newer than the captured save snapshot and must remain dirty.
 await f.page.evaluate(()=>window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange('A3').setValue(17))
 release()
 const confirm=f.page.getByRole('button',{name:'Confirm save outcome',exact:true})
 await expect(confirm).toBeVisible({timeout:15000})
 await confirm.click()
 await expect(confirm).toBeHidden({timeout:15000})
 await expect.poll(()=>f.page.evaluate(()=>window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange('A3').getValue()),{timeout:15000}).toBe(17)
 await expect(save).toBeEnabled()
 assert.equal(preparations,1)
 const first=(await f.files.openFile(f.alice.token,f.opened.file.fileId)).file
 const firstZip=await JSZip.loadAsync(await f.files.readFile(f.alice.token,first.fileId,first.revision))
 const firstXml=await firstZip.file('xl/worksheets/sheet1.xml').async('string')
 assert.match(firstXml,/<v>40<\/v>/);assert.doesNotMatch(firstXml,/<v>17<\/v>/)
 await save.click()
 await expect.poll(async()=>(await f.files.openFile(f.alice.token,first.fileId)).file.revision,{timeout:15000}).not.toBe(first.revision)
 await f.page.reload()
 await expect.poll(()=>f.page.evaluate(()=>window.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange('A3').getValue()),{timeout:30000}).toBe(17)
 assert.equal(preparations,2)
})

test('Name Manager edits a definition and preserves it through native save and reopen',{timeout:90000},async t=>{
 const f=await fixture(t),fileId=f.opened.file.fileId
 await f.page.goto(f.origin+'/native-xlsx/?fileId='+fileId)
 await expect.poll(()=>f.page.evaluate(()=>window.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange('F2').getValue()),{timeout:30000}).toBe(20)
 await f.page.getByRole('button',{name:'Formulas',exact:true}).click()
 await f.page.getByRole('button',{name:/Name Manager/}).click()
 const dialog=f.page.getByRole('dialog',{name:'Name Manager',exact:true})
 await expect(dialog).toBeVisible()
 await dialog.getByRole('cell',{name:'Revenue',exact:true}).click()
 await dialog.getByPlaceholder('=Sheet1!$A$1:$B$9').fill('=Acceptance!$A$2')
 await dialog.getByRole('button',{name:'Update',exact:true}).click()
 await dialog.getByRole('button',{name:'Close',exact:true}).click()
 await expect.poll(()=>f.page.evaluate(()=>window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange('F2').getValue()),{timeout:15000}).toBe(12.5)
 const save=f.page.locator('.qa-btn').first();await expect(save).toBeEnabled();await save.click()
 await expect.poll(async()=>(await f.files.openFile(f.alice.token,fileId)).file.revision,{timeout:15000}).not.toBe(f.opened.file.revision)
 const saved=(await f.files.openFile(f.alice.token,fileId)).file
 const zip=await JSZip.loadAsync(await f.files.readFile(f.alice.token,fileId,saved.revision))
 assert.match(await zip.file('xl/workbook.xml').async('string'),/<definedName[^>]*name="Revenue"[^>]*>Acceptance!\$A\$2<\/definedName>/)
 await f.page.reload()
 await expect.poll(()=>f.page.evaluate(()=>window.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange('F2').getValue()),{timeout:30000}).toBe(12.5)
})

for(const nodeEngine of [false,true]) test(`${nodeEngine?'Node XLSX ':''}chart format pane edits title and persists it through native save`,{timeout:90000},async t=>{
 const f=await fixture(t,{nodeEngine}),fileId=f.opened.file.fileId
 await f.page.goto(f.origin+'/native-xlsx/?fileId='+fileId)
 const chart=f.page.locator('.xlsx-chart').first();await expect(chart).toBeVisible({timeout:30000})
 await chart.click({button:'right',position:{x:30,y:30}})
 await f.page.getByText('Format Selection…',{exact:true}).click()
 const title=f.page.locator('.chart-format-pane input[type="text"]').first()
 await expect(title).toHaveValue('') // Fixture has an object name, but no chart title.
 await title.fill('Updated revenue');await title.press('Enter')
 const save=f.page.locator('.qa-btn').first();await expect(save).toBeEnabled();await save.click()
 await expect.poll(async()=>(await f.files.openFile(f.alice.token,fileId)).file.revision,{timeout:15000}).not.toBe(f.opened.file.revision)
 const saved=(await f.files.openFile(f.alice.token,fileId)).file
 const zip=await JSZip.loadAsync(await f.files.readFile(f.alice.token,fileId,saved.revision))
 assert.match(await zip.file('xl/charts/chart1.xml').async('string'),/Updated revenue/)
 await f.page.reload()
 await expect(f.page.locator('.xlsx-chart').first()).toContainText('Updated revenue',{timeout:30000})
})


test('one original tool batch is undone together and redo persists through native save',{timeout:90000},async t=>{
 const f=await fixture(t),id=f.opened.file.fileId
 await f.page.goto(f.origin+'/native-xlsx/?fileId='+id)
 await expect.poll(()=>f.page.evaluate(()=>window.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange('A2').getValue()),{timeout:30000}).toBe(12.5)
 const result=await f.page.evaluate(async()=>{
  const d=window.__genofficeDebug,s=d.univerAPI.getActiveWorkbook().getActiveSheet().getSheetId()
  return d.applyOps([{op:'set_cell',sheetId:s,address:'A2',value:100},{op:'set_cell',sheetId:s,address:'A3',value:200}])
 })
 assert.equal(result.ok,true)
 const values=()=>f.page.evaluate(()=>{const s=window.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getActiveSheet();return s ? [s.getRange('A2').getValue(),s.getRange('A3').getValue()] : null})
 await expect.poll(values).toEqual([100,200])
 await f.page.getByRole('button',{name:'Undo',exact:true}).click()
 await expect.poll(values).toEqual([12.5,7.5])
 await f.page.getByRole('button',{name:'Redo',exact:true}).click()
 await expect.poll(values).toEqual([100,200])
 await f.page.locator('.qa-btn').first().click()
 await expect.poll(async()=>(await f.files.openFile(f.alice.token,id)).file.revision,{timeout:15000}).not.toBe(f.opened.file.revision)
 await f.page.reload()
 await expect.poll(values,{timeout:30000}).toEqual([100,200])
})


test('second browser editor is read only until explicit takeover',{timeout:90000},async t=>{
 const f=await fixture(t),id=f.opened.file.fileId,url=f.origin+'/native-xlsx/?fileId='+id
 await f.page.goto(url)
 await expect.poll(()=>f.page.evaluate(()=>window.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange('A2').getValue()),{timeout:30000}).toBe(12.5)
 const second=await f.context.newPage();await second.addInitScript(()=>{window.__genofficeDebugHooks=true});await second.goto(url)
 // Lease authority errors and transient realtime information can coexist.
 // Select the semantic error role, never the first arbitrary notification.
 const secondAuthority = second.locator('.document-notification[role="alert"]')
 await expect(secondAuthority).toHaveCount(1,{timeout:30000})
 await expect(secondAuthority).toContainText('Read only',{timeout:30000})
 await expect(second.locator('.dyoffice-sheets-download')).toBeDisabled()
 await expect.poll(()=>second.evaluate(()=>window.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange('A2').getValue()),{timeout:30000}).toBe(12.5)
 const stillReadOnly=await second.evaluate(async()=>{const r=window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange('A2');try{await r.setValue(77)}catch{}return r.getValue()})
 assert.equal(stillReadOnly,12.5,'readonly user command must not overwrite imported cells')
 const rejected=await second.evaluate(()=>{const d=window.__genofficeDebug,s=d.univerAPI.getActiveWorkbook().getActiveSheet().getSheetId();return d.applyOps([{op:'set_cell',sheetId:s,address:'A2',value:99}])})
 assert.equal(rejected.ok,false)
 assert.equal((await f.files.openFile(f.alice.token,id)).file.revision,f.opened.file.revision)
 await second.getByRole('button',{name:'Take over editing',exact:true}).click()
 await expect(second.locator('.dyoffice-sheets-download')).toBeEnabled()
 await second.evaluate(()=>window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange('A2').setValue(99))
 await expect(second.locator('.qa-btn').first()).toBeEnabled();await second.locator('.qa-btn').first().click()
 await expect.poll(async()=>(await f.files.openFile(f.alice.token,id)).file.revision,{timeout:15000}).not.toBe(f.opened.file.revision)
 const formerAuthority = f.page.locator('.document-notification[role="alert"]')
 await expect(formerAuthority).toHaveCount(1,{timeout:20000})
 await expect(formerAuthority).toContainText('Editing permission expired',{timeout:20000})
 await expect(f.page.locator('.dyoffice-sheets-download')).toBeDisabled()
})
