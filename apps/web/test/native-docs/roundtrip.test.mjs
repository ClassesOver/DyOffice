import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:https'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import JSZip from 'jszip'
import officeCrypto from 'officecrypto-tool'
import { PDFDocument } from 'pdf-lib'
import { fileFixture, docxBytes, importFile } from '../helpers/files.mjs'
import {createWorkspaceService} from '../../server/src/modules/workspace/service.ts'
import { password } from '../helpers/identity.mjs'
import { phaseDiagnostics, observeFirstRequest } from '../helpers/phase-diagnostics.mjs'
import { withInputDiagnostics } from '../helpers/input-diagnostics.mjs'
import { holdFirstResponseEnd } from '../helpers/delayed-http-response.mjs'
import { hashProtectionPassword, parseDocx, saveDocx } from '../../../../packages/docx-engine/src/index.ts'

const docsDirectory = process.env.DYOFFICE_TEST_NATIVE_DOCS_DIST ?? fileURLToPath(new URL('../../dist-docs/',import.meta.url))
async function fixture(t, {beforeCleanup = () => {}, beforeHttpRequest = () => {}, assistantChannels = false, localShellDirectory, autoSave = false, wordCollaboration} = {}) {
  const directory = await mkdtemp(join(tmpdir(),'dyoffice-native-docs-'))
  let f, browser, server
  t.after(async () => {
    beforeCleanup()
    await browser?.close()
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    await f?.app.close()
    await rm(directory,{ recursive: true,force: true })
  })
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(directory,'key.pem'),'-out',join(directory,'cert.pem'),'-days','1','-subj','/CN=localhost'],{ stdio: 'pipe' })
  // HTTP-only persistence fixture: no WebSocket upgrade is attached. A reconnect
  // notice is expected and must not replace the independent save-state assertions.
  server = createServer({ key: await readFile(join(directory,'key.pem')),cert: await readFile(join(directory,'cert.pem')) },(req,res) => {
    beforeHttpRequest(req,res)
    f.app.routing(req,res)
  })
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  const origin = `https://127.0.0.1:${server.address().port}`
  f = await fileFixture(t,{ origin,nativeDocsDirectory: docsDirectory,localShellDirectory,assistantChannels,wordCollaboration })
  await f.preferences.update(f.alice.token,{ language: 'en',autoSave,showAssistant: false })
  const zip = await JSZip.loadAsync(await docxBytes())
  zip.file('customXml/dyoffice-preserve.xml','<probe>Untouched custom part</probe>')
  const original = await zip.generateAsync({ type: 'nodebuffer' }), opened = await importFile(f,f.alice.token,original,'native-roundtrip.docx')
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ ignoreHTTPSErrors: true,viewport: { width: 1440,height: 1100 } }), page = await context.newPage()
  await page.goto(origin + '/')
  const status = await page.evaluate(async password => {
    const challenge = await (await fetch('/api/v1/auth/csrf')).json()
    return (await fetch('/api/v1/auth/login',{ method: 'POST',headers: { 'content-type': 'application/json','x-csrf-token': challenge.csrfToken },body: JSON.stringify({ username: 'alice',password }) })).status
  },password)
  assert.equal(status,200)
  return { ...f, original, opened, browser, context, page, origin }
}

// Do not treat a reconnect banner or an HTTP commit as proof of a clean native model.
async function expectCleanPersistence(page) {
  const status=page.locator('.dyoffice-docs-persistence-state')
  try {
    await expect(status).toHaveText('Editing')
    await expect(status).toHaveAttribute('data-dirty','false')
  } catch (error) {
    // Bounded state-only diagnostics: no document text, identities, URLs or tokens.
    console.error('native-save-state',JSON.stringify({
      outcome:await status.getAttribute('data-native-save'),
      reasons:await status.getAttribute('data-incomplete-reasons'),
      dirty:await status.getAttribute('data-dirty'),
      notification:await page.locator('.dyoffice-docs-notification-state').count()>0,
    }))
    throw error
  }
}

test('native Word Save As creates a workspace copy of the unsaved draft without AI', { timeout: 90_000 }, async t => {
  const f=await fixture(t), {page}=f, file=f.opened.file
  const marker='Manual Save As draft'
  const workspace=createWorkspaceService(f.transactions)
  const parent=await workspace.createFolder(f.alice.token,{name:'Reports',parentId:null})
  const folder=await workspace.createFolder(f.alice.token,{name:'Current',parentId:parent.id})
  await page.goto(f.origin+'/native-docx/?fileId='+file.fileId)
  const editor=page.locator('.tiptap.doc-page[contenteditable="true"]').first()
  await expect(editor).toBeVisible({timeout:30000})
  await editor.click()
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.insertText(marker)
  await page.keyboard.press('Enter')
  const persistence=page.locator('.dyoffice-docs-persistence-state')
  await expect(persistence).toHaveAttribute('data-dirty','true')
  await page.getByRole('button',{name:'File',exact:true}).click()
  const saveAs=page.locator('.file-menu').getByRole('button',{name:/^Save As/})
  await expect(saveAs).toBeEnabled()
  await saveAs.click()
  const confirmation=page.getByRole('dialog',{name:'Save a copy to your workspace'})
  const input=confirmation.getByRole('textbox',{name:'File name'})
  await expect(input).toHaveValue('native-roundtrip.docx')
  const location=confirmation.getByRole('combobox',{name:'Folder',exact:true})
  await expect(location).toBeEnabled()
  await expect(location).toHaveValue('')
  await confirmation.getByRole('button',{name:'Cancel',exact:true}).click()
  await expect(confirmation).toHaveCount(0)
  assert.equal((await f.files.listFiles(f.alice.token)).files.length,1)
  await workspace.moveFile(f.alice.token,file.fileId,{folderId:folder.id})
  await page.keyboard.press('ControlOrMeta+Shift+s')
  await expect(location).toHaveValue(folder.id)
  await input.fill('Manual copy')
  await confirmation.getByRole('button',{name:'Save copy',exact:true}).click()
  await expect.poll(async()=>(await f.files.listFiles(f.alice.token)).files.length).toBe(2)
  const copy=(await f.files.listFiles(f.alice.token)).files.find(item=>item.name==='Manual copy.docx')
  assert.ok(copy)
  assert.ok((await workspace.listFiles(f.alice.token,{folderId:folder.id})).files.some(item=>item.id===copy.id))
  const archive=await JSZip.loadAsync(await f.files.readFile(f.alice.token,copy.id,copy.revision))
  assert.ok((await archive.file('word/document.xml').async('string')).replace(/<[^>]+>/g,'').includes(marker))
  assert.equal(await archive.file('customXml/dyoffice-preserve.xml').async('string'),'<probe>Untouched custom part</probe>')
  assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
  assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),f.original)
  await expect(persistence).toHaveAttribute('data-dirty','true')
})

test('native Word Save As downloads named HTML and Markdown from the unsaved draft',{timeout:90000},async t=>{
 const f=await fixture(t),{page}=f,file=f.opened.file,marker='Text only present in the unsaved draft'
 await page.goto(f.origin+'/native-docx/?fileId='+file.fileId)
 const editor=page.locator('.tiptap.doc-page[contenteditable="true"]').first()
 await expect(editor).toBeVisible({timeout:30000})
 await editor.click()
 await page.keyboard.press('ControlOrMeta+Home')
 await page.keyboard.insertText(marker)
 await page.keyboard.press('Enter')
 const dialog=page.getByRole('dialog',{name:/^(Save a copy to your workspace|Download a copy)$/})
 for(const [format,name] of [['html','Web preview'],['md','Editorial notes']]){
  await page.keyboard.press('ControlOrMeta+Shift+s')
  await dialog.getByRole('combobox',{name:'File format',exact:true}).selectOption(format,{timeout:5000})
  await expect(dialog.getByRole('combobox',{name:'Folder',exact:true})).toBeHidden()
  await dialog.getByRole('textbox',{name:'File name'}).fill(name)
  const entry=page.waitForEvent('download')
  await dialog.getByRole('button',{name:'Download copy',exact:true}).click()
  const download=await entry
  assert.equal(download.suggestedFilename(),name+'.'+format)
  assert.match(await readFile(await download.path(),'utf8'),new RegExp(marker))
 }
 const originalTitle=await page.title()
 await page.evaluate(()=>{
  window.print=()=>{
   document.documentElement.dataset.printTitle=document.title
   window.dispatchEvent(new Event('beforeprint'))
  }
 })
 await page.keyboard.press('ControlOrMeta+Shift+s')
 await dialog.getByRole('combobox',{name:'File format',exact:true}).selectOption('pdf')
 const savePdf=page.getByRole('dialog',{name:'Save as PDF',exact:true})
 await expect(savePdf.getByRole('combobox',{name:'Folder',exact:true})).toBeHidden()
 await savePdf.getByRole('textbox',{name:'File name'}).fill('Quarterly draft')
 await savePdf.getByRole('button',{name:'Open print dialog',exact:true}).click()
 await expect(page.locator('html')).toHaveAttribute('data-print-title','Quarterly draft',{timeout:25000})
 try{
  const bytes=await page.pdf({preferCSSPageSize:true,printBackground:true})
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task=getDocument({data:Uint8Array.from(bytes)})
  try{
   const pdf=await task.promise
   assert.match((await (await pdf.getPage(1)).getTextContent()).items.map(item=>item.str??'').join(' '),new RegExp(marker))
  }finally{await task.destroy()}
 }finally{await page.evaluate(()=>window.dispatchEvent(new Event('afterprint')))}
 await expect(page.locator('style[data-docs-print-paper]')).toHaveCount(0)
 await expect.poll(()=>page.title()).toBe(originalTitle)
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),f.original)
 assert.equal((await f.files.listFiles(f.alice.token)).files.length,1)
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
 await expect(page.locator('.dyoffice-docs-persistence-state')).toHaveAttribute('data-dirty','true')
})

test('native Word Save As keeps the original password on a protected draft copy',{timeout:90000},async t=>{
 const f=await fixture(t),{page}=f,secret='文档复制 password',ciphertext=Buffer.from(officeCrypto.encrypt(f.original,{password:secret}))
 const stage=await f.files.stageUpload(f.alice.token,{name:'locked-source.docx',size:ciphertext.length})
 await f.files.receiveUpload(f.alice.token,stage.uploadId,ciphertext,{password:secret,format:'docx'})
 const {file}=await f.files.finishUpload(f.alice.token,stage.uploadId)
 const openUrl=id=>f.origin+'/native-docx/?fileId='+id
 const workspace=createWorkspaceService(f.transactions)
 const archiveFolder=await workspace.createFolder(f.alice.token,{name:'Archive',parentId:null})
 await page.goto(openUrl(file.fileId))
 const passwordDialog=page.getByRole('dialog').filter({hasText:'Open password-protected document'})
 const unlock=async value=>{
  await passwordDialog.getByLabel('Password',{exact:true}).fill(value)
  await passwordDialog.getByRole('button',{name:'Open',exact:true}).click()
 }
 await unlock(secret)
 const editor=page.locator('.tiptap.doc-page[contenteditable="true"]').first(),marker='Unsaved encrypted copy from Chromium'
 await expect(editor).toBeVisible({timeout:25000})
 await editor.click()
 await page.keyboard.press('ControlOrMeta+Home')
 await page.keyboard.insertText(marker)
 await page.keyboard.press('Enter')
 const persistence=page.locator('.dyoffice-docs-persistence-state')
 await expect(persistence).toHaveAttribute('data-dirty','true')
 await page.getByRole('button',{name:'File',exact:true}).click()
 const saveAs=page.locator('.file-menu').getByRole('button',{name:/^Save As/})
 await expect(saveAs).toBeEnabled()
 await saveAs.click()
 const confirm=page.getByRole('dialog',{name:'Save a copy to your workspace'})
 await expect(confirm.getByRole('combobox',{name:'File format',exact:true})).toHaveCount(0)
 await confirm.getByRole('textbox',{name:'File name'}).fill('Protected draft copy')
 await confirm.getByRole('combobox',{name:'Folder',exact:true}).selectOption(archiveFolder.id)
 const finishes=[]
 await page.route('**/uploads/*/finish',async route=>{
  finishes.push(route.request().url())
  if(finishes.length!==1)return route.continue()
  const result=await route.fetch()
  assert.equal(result.status(),200)
  await route.abort()
 })
 await confirm.getByRole('button',{name:'Save copy',exact:true}).click()
 const retry=page.getByRole('button',{name:'Confirm copy save',exact:true})
 await expect(retry).toBeVisible({timeout:20000})
 await page.getByRole('button',{name:'File',exact:true}).click()
 await expect(saveAs).toBeDisabled()
 await page.keyboard.press('Escape')
 await retry.click()
 await expect(page.getByText('Saved copy: Protected draft copy.docx',{exact:true})).toBeVisible()
 assert.equal(finishes.length,2)
 assert.equal(finishes[0],finishes[1])
 assert.equal((await f.files.listFiles(f.alice.token)).files.length,3)
 const copy=(await f.files.listFiles(f.alice.token)).files.find(item=>item.name==='Protected draft copy.docx')
 assert.ok(copy)
 assert.ok((await workspace.listFiles(f.alice.token,{folderId:archiveFolder.id})).files.some(item=>item.id===copy.id))
 const opened=await f.files.openFile(f.alice.token,copy.id)
 assert.equal(opened.documentPasswordProtected,true)
 const sealed=await f.files.readFile(f.alice.token,copy.id,copy.revision)
 const archive=await JSZip.loadAsync(await officeCrypto.decrypt(sealed,{password:secret}))
 assert.match(await archive.file('word/document.xml').async('string'),new RegExp(marker))
 assert.equal(await archive.file('customXml/dyoffice-preserve.xml').async('string'),'<probe>Untouched custom part</probe>')
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),ciphertext)
 await expect(persistence).toHaveAttribute('data-dirty','true')
 const copyPage=await page.context().newPage()
 await copyPage.goto(openUrl(copy.id))
 const dialog=copyPage.getByRole('dialog').filter({hasText:'Open password-protected document'})
 await dialog.getByLabel('Password',{exact:true}).fill('wrong')
 await dialog.getByRole('button',{name:'Open',exact:true}).click()
 await expect(dialog).toContainText('The document password is incorrect.')
 await dialog.getByLabel('Password',{exact:true}).fill(secret)
 await dialog.getByRole('button',{name:'Open',exact:true}).click()
 await expect(copyPage.locator('.tiptap.doc-page').first()).toContainText(marker,{timeout:20000})
})

test('native Word can copy a protected document after autosave advances the source in the naming dialog',{timeout:90000},async t=>{
 const f=await fixture(t,{autoSave:true}),{page}=f,secret='autosave protected'
 const ciphertext=Buffer.from(officeCrypto.encrypt(f.original,{password:secret}))
 const stage=await f.files.stageUpload(f.alice.token,{name:'autosave-locked.docx',size:ciphertext.length})
 await f.files.receiveUpload(f.alice.token,stage.uploadId,ciphertext,{password:secret,format:'docx'})
 const {file}=await f.files.finishUpload(f.alice.token,stage.uploadId)
 await page.goto(f.origin+'/native-docx/?fileId='+file.fileId)
 const passwordDialog=page.getByRole('dialog').filter({hasText:'Open password-protected document'})
 await passwordDialog.getByLabel('Password',{exact:true}).fill(secret)
 await passwordDialog.getByRole('button',{name:'Open',exact:true}).click()
 const editor=page.locator('.tiptap.doc-page[contenteditable="true"]').first(),marker='Saved while naming the copy'
 await expect(editor).toBeVisible({timeout:25000})
 await editor.click()
 await page.keyboard.press('ControlOrMeta+Home')
 await page.keyboard.insertText(marker)
 await page.keyboard.press('Enter')
 await page.keyboard.press('ControlOrMeta+Shift+s')
 const confirmation=page.getByRole('dialog',{name:'Save a copy to your workspace'})
 await expect(confirmation).toBeVisible()
 const commit=page.waitForResponse(response=>response.request().method()==='POST'&&response.url().endsWith('/commits')&&response.status()===200,{timeout:20000})
 await page.evaluate(()=>window.dispatchEvent(new Event('blur')))
 await commit
 const saved=(await f.files.openFile(f.alice.token,file.fileId)).file
 assert.notEqual(saved.revision,file.revision)
 await expect(page.locator('.dyoffice-docs-persistence-state')).toHaveAttribute('data-dirty','false')
 await confirmation.getByRole('textbox',{name:'File name'}).fill('Copy after autosave')
 await confirmation.getByRole('button',{name:'Save copy',exact:true}).click()
 await expect(page.getByText('Saved copy: Copy after autosave.docx',{exact:true})).toBeVisible({timeout:20000})
 const copy=(await f.files.listFiles(f.alice.token)).files.find(item=>item.name==='Copy after autosave.docx')
 assert.ok(copy)
 const sealed=await f.files.readFile(f.alice.token,copy.id,copy.revision)
 const archive=await JSZip.loadAsync(await officeCrypto.decrypt(sealed,{password:secret}))
 assert.match(await archive.file('word/document.xml').async('string'),new RegExp(marker))
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,saved.revision)
})

test('Word Protect Document saves and rotates the open password, then removes it',{timeout:160000},async t=>{
 const f=await fixture(t,{wordCollaboration:true,autoSave:true}),{page}=f,file=f.opened.file
 const address=f.origin+'/native-docx/?fileId='+file.fileId
 await page.goto(address)
 const editor=page.locator('.tiptap.doc-page[contenteditable="true"]').first()
 await expect(editor).toBeVisible({timeout:25000})
 const requestSave=async()=>{
  const committed=page.waitForResponse(response=>response.request().method()==='POST'&&response.url().endsWith('/commits')&&response.ok(),{timeout:25000})
  await page.keyboard.press('ControlOrMeta+s')
  await committed
  await expect(page.locator('.dyoffice-docs-persistence-state')).toHaveAttribute('data-dirty','false',{timeout:25000})
  await expect(editor).toBeVisible({timeout:20000})
  return (await getHead()).file.revision
 }
 const changePassword=async value=>{
  const protectDocument=page.getByRole('button',{name:'Protect Document',exact:true})
  if(!await protectDocument.isVisible())await page.getByRole('button',{name:'Review',exact:true}).click()
  await protectDocument.click()
  const protect=page.locator('.protect-dialog')
  await protect.locator('label.fld').filter({hasText:'Password to open this document'}).locator('input').fill(value)
  await protect.locator('label.fld').filter({hasText:'Confirm password'}).first().locator('input').fill(value)
  await protect.getByRole('button',{name:'OK',exact:true}).click()
  await expect(protect).toHaveCount(0)
  await expect(page.locator('.dyoffice-docs-persistence-state')).toHaveAttribute('data-dirty','true')
 }
 const first='  文档 first 🔑 ',second='rotated password',marker='Saved with the Word protection dialog'
 const getHead=()=>f.files.openFile(f.alice.token,file.fileId)
 const read=r=>f.files.readFile(f.alice.token,file.fileId,r)
 let passwordUploads=0
 page.on('request',request=>{if(new URL(request.url()).pathname.endsWith('/docx/password/uploads'))passwordUploads++})
 const copyWithPassword=async(label,secret,sourceRevision)=>{
  const priorUploads=passwordUploads
  await page.getByRole('button',{name:'File',exact:true}).click()
  const saveAs=page.locator('.file-menu').getByRole('button',{name:/^Save As/})
  await expect(saveAs).toBeEnabled()
  await saveAs.click()
  const confirm=page.getByRole('dialog',{name:'Save a copy to your workspace'})
  await confirm.getByRole('textbox',{name:'File name'}).fill(label)
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')))
  await confirm.getByRole('button',{name:'Save copy',exact:true}).click()
  await expect(page.getByText('Saved copy: '+label+'.docx',{exact:true})).toBeVisible({timeout:20000})
  const copy=(await f.files.listFiles(f.alice.token)).files.find(item=>item.name===label+'.docx')
  assert.ok(copy)
  const copyHead=await f.files.openFile(f.alice.token,copy.id)
  assert.equal(copyHead.documentPasswordProtected,secret?true:undefined)
  const bytes=await f.files.readFile(f.alice.token,copy.id,copy.revision)
  const archive=await JSZip.loadAsync(secret?await officeCrypto.decrypt(bytes,{password:secret}):bytes)
  assert.match(await archive.file('word/document.xml').async('string'),new RegExp(marker))
  assert.equal(passwordUploads,priorUploads)
  assert.equal((await getHead()).file.revision,sourceRevision)
  await expect(page.locator('.dyoffice-docs-persistence-state')).toHaveAttribute('data-dirty','true')
 }

 await editor.click()
 await page.keyboard.press('ControlOrMeta+Home')
 await page.keyboard.insertText(marker)
 await page.keyboard.press('Enter')
 await changePassword(first)
 await copyWithPassword('New password copy',first,file.revision)
 assert.equal((await getHead()).file.revision,file.revision)
 let releaseRenew,notifyRenew
 const holdRenew=new Promise(resolve=>{releaseRenew=resolve})
 const renewStarted=new Promise(resolve=>{notifyRenew=resolve})
 await page.route('**/lease/renew',async route=>{
  if(!route.request().postDataJSON().docxUnlockId){
   notifyRenew()
   await holdRenew
  }
  await route.continue()
 })
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')))
 let protectedRevision
 try{
  await renewStarted
  protectedRevision=await requestSave()
 }catch(error){releaseRenew();throw error}
 const denied=page.waitForResponse(response=>response.url().endsWith('/lease/renew')&&response.status()===423,{timeout:10000})
 releaseRenew()
 await denied
 await page.unroute('**/lease/renew')
 await expect(editor).toBeVisible()
 assert.notEqual(protectedRevision,file.revision)
 const protectedBytes=await read(protectedRevision)
 assert.equal((await getHead()).documentPasswordProtected,true)
 const firstArchive=await JSZip.loadAsync(await officeCrypto.decrypt(protectedBytes,{password:first}))
 assert.match(await firstArchive.file('word/document.xml').async('string'),new RegExp(marker))
 await changePassword(second)
 await copyWithPassword('Rotated password copy',second,protectedRevision)
 const changedRevision=await requestSave()
 const rotatedBytes=await read(changedRevision)
 await assert.rejects(officeCrypto.decrypt(rotatedBytes,{password:first}))
 const secondArchive=await JSZip.loadAsync(await officeCrypto.decrypt(rotatedBytes,{password:second}))
 assert.match(await secondArchive.file('word/document.xml').async('string'),new RegExp(marker))
 await changePassword('')
 await copyWithPassword('Plain copy',null,changedRevision)
 const clearedRevision=await requestSave()
 await page.getByRole('button',{name:'File',exact:true}).click()
 await expect(page.getByRole('button',{name:'Download unsaved draft copy',exact:true})).toBeEnabled()
 await page.keyboard.press('Escape')
 assert.equal((await getHead()).documentPasswordProtected,undefined)
 const archive=await JSZip.loadAsync(await read(clearedRevision))
 assert.match(await archive.file('word/document.xml').async('string'),new RegExp(marker))
 assert.deepEqual(await read(file.revision),f.original)
 assert.deepEqual(await read(protectedRevision),protectedBytes)
 assert.deepEqual(await read(changedRevision),rotatedBytes)
 const peer=await page.context().newPage()
 await peer.goto(address)
 const peerBody=peer.locator('.tiptap.doc-page[contenteditable="true"]').first(),peerMarker='Peer collaborator after password removal'
 await expect(peerBody).toContainText(marker,{timeout:20000})
 await peerBody.click()
 await peer.keyboard.press('ControlOrMeta+Home')
 await peer.keyboard.insertText(peerMarker)
 await peer.keyboard.press('Enter')
 await expect(editor).toContainText(peerMarker,{timeout:20000})
 await expect.poll(async()=>(await getHead()).file.revision,{timeout:20000}).not.toBe(clearedRevision)
 const collaborated=await JSZip.loadAsync(await read((await getHead()).file.revision))
 assert.match(await collaborated.file('word/document.xml').async('string'),new RegExp(peerMarker))
 await peer.close()
 await page.reload()
 await expect(editor).toContainText(peerMarker,{timeout:25000})
})

test('workspace imports encrypted DOCX with one password, saves encrypted edits and reopens',{timeout:150000},async t=>{
 const shellDirectory=process.env.DYOFFICE_TEST_WORKSPACE_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell/',import.meta.url))
 const f=await fixture(t,{localShellDirectory:shellDirectory}),{page}=f
 const name='protected-browser.docx',secret='  文档 🔑 ',encrypted=Buffer.from(officeCrypto.encrypt(f.original,{password:secret}))
 const opens=[]
 page.on('request',request=>{
  const route=new URL(request.url()).pathname
  if(route.endsWith('/docx/unlock')||route.endsWith('/docx/import-unlock'))opens.push(route.split('/').at(-1))
 })
 await f.preferences.update(f.alice.token,{language:'zh'})
 await page.goto(f.origin)
 await page.getByRole('button',{name:/^打开本地文件/}).click()
 const upload=page.getByRole('dialog',{name:'上传文件',exact:true})
 await upload.locator('input[type=file]').setInputFiles({name,mimeType:'application/octet-stream',buffer:encrypted})
 await upload.getByRole('button',{name:'开始上传（1）'}).click()
 const importPassword=upload.getByLabel(`输入 ${name} 的文档密码`)
 await importPassword.fill('wrong')
 const rejectedUpload=page.waitForResponse(response=>response.request().method()==='PUT'&&new URL(response.url()).pathname.endsWith('/content'),{timeout:20000})
 await upload.getByRole('button',{name:'确认密码'}).click()
 assert.equal((await rejectedUpload).status(),422)
 await expect(upload.getByRole('alert')).toContainText('文档密码错误',{timeout:15000})
 assert.equal((await f.files.listFiles(f.alice.token)).files.filter(file=>file.name===name).length,0)
 await importPassword.fill(secret)
 await importPassword.press('Enter')
 await expect(upload).toContainText('已上传并打开',{timeout:25000})
 await upload.getByRole('button',{name:'完成',exact:true}).click()

 const frame=page.frameLocator(`iframe[title="${name}"]`),dialog=frame.getByRole('dialog').filter({hasText:'打开受密码保护的文档'})
 await expect(frame.locator('.tiptap.doc-page').first()).toContainText('A filler 1',{timeout:25000})
 await expect(dialog).toHaveCount(0)
 assert.deepEqual(opens,['import-unlock'])
 const [entry]=(await f.files.listFiles(f.alice.token)).files.filter(file=>file.name===name)
 const original=await f.files.openFile(f.alice.token,entry.id)
 const editor=frame.locator('.tiptap.doc-page[contenteditable="true"]').first(),marker='Protected revision from Chromium'
 await expect(editor).toBeVisible()
 await editor.click()
 await page.keyboard.press('ControlOrMeta+Home')
 await page.keyboard.insertText(marker)
 await page.keyboard.press('Enter')
 const commits=[]
 await page.route(`**/files/${entry.id}/commits`,async route=>{
  commits.push(route.request().postDataJSON())
  if(commits.length!==1)return route.continue()
  const result=await route.fetch()
  assert.equal(result.status(),200)
  await route.abort()
 })
 await page.keyboard.press('ControlOrMeta+s')
 const confirm=frame.getByRole('button',{name:'确认保存结果',exact:true})
 await expect(confirm).toBeVisible({timeout:25000})
 const lateMarker='Unsaved local recovery from Chromium'
 await editor.click()
 await page.keyboard.press('ControlOrMeta+Home')
 await page.keyboard.insertText(lateMarker)
 await page.keyboard.press('Enter')
 await frame.getByRole('button',{name:'文件',exact:true}).click()
 const recoveryButton=frame.getByRole('button',{name:'下载未保存草稿副本',exact:true})
 await expect(recoveryButton).toBeEnabled()
 let releaseRecovery
 const holdRecovery=new Promise(resolve=>{releaseRecovery=resolve})
 await page.route(/\/docx\/recovery-draft\?/,async route=>{
  const reply=await route.fetch()
  await holdRecovery
  await route.fulfill({response:reply})
 })
 const recoveryRequest=page.waitForRequest(request=>request.url().includes('/docx/recovery-draft?'),{timeout:15000})
 const downloaded=page.waitForEvent('download',{timeout:20000})
 void downloaded.catch(()=>{})
 await recoveryButton.click()
 try{
  await recoveryRequest
  assert.equal(commits.length,1)
  await expect(confirm).toBeVisible()
  await confirm.evaluate(button=>button.click())
  await expect(confirm).toHaveCount(0)
 }finally{releaseRecovery()}
 const recovery=await downloaded
 assert.match(recovery.suggestedFilename(),/-unsaved-draft\.docx$/)
 const recoveryBytes=await readFile(await recovery.path())
 const archive=await JSZip.loadAsync(await officeCrypto.decrypt(recoveryBytes,{password:secret}))
 assert.match(await archive.file('word/document.xml').async('string'),new RegExp(lateMarker))
 assert.equal(commits.length,2)
 assert.deepEqual(commits[1],commits[0])
 const saved=await f.files.openFile(f.alice.token,entry.id)
 assert.notEqual(saved.file.revision,original.file.revision)
 assert.equal(saved.documentPasswordProtected,true)
 const bytes=await f.files.readFile(f.alice.token,entry.id,saved.file.revision)
 const zip=await JSZip.loadAsync(await officeCrypto.decrypt(bytes,{password:secret}))
 assert.match(await zip.file('word/document.xml').async('string'),new RegExp(marker))
 assert.doesNotMatch(await zip.file('word/document.xml').async('string'),new RegExp(lateMarker))
 assert.deepEqual(await f.files.readFile(f.alice.token,entry.id,original.file.revision),encrypted)
 page.once('dialog',leave=>{void leave.accept()})
 await frame.locator('html').evaluate(element=>{element.ownerDocument.defaultView.location.reload()})
 await expect(dialog).toBeVisible({timeout:25000})
 await expect(frame.locator('.tiptap.doc-page')).toHaveCount(0)
 const submit=async value=>{
  await dialog.getByLabel('密码',{exact:true}).fill(value)
  await dialog.getByRole('button',{name:'打开',exact:true}).click()
 }
 await submit('wrong')
 await expect(dialog).toContainText('文档密码错误。',{timeout:15000})
 const unlockResponse=page.waitForResponse(response=>response.request().method()==='POST'&&response.url().endsWith('/docx/unlock')&&response.status()===200)
 await submit(secret)
 const unlocked=await unlockResponse
 await expect(frame.locator('.tiptap.doc-page').first()).toContainText(marker,{timeout:25000})
 const match=(await f.files.listFiles(f.alice.token)).files.filter(file=>file.name===name)
 assert.equal(match.length,1)
 const opened=await f.files.openFile(f.alice.token,match[0].id)
 assert.equal(opened.documentPasswordProtected,true)
 assert.equal(opened.file.revision,saved.file.revision)

 const secondMarker='Draft kept during reunlock'
 await expect(editor).toBeVisible()
 await editor.click()
 await page.keyboard.press('ControlOrMeta+Home')
 await page.keyboard.insertText(secondMarker)
 await page.keyboard.press('Enter')
 const revoke=await page.request.delete(unlocked.url(),{
  headers:{origin:f.origin,'x-csrf-token':await unlocked.request().headerValue('x-csrf-token')},
  data:{unlockId:await unlocked.headerValue('x-dyoffice-docx-unlock')},
 })
 assert.equal(revoke.status(),204)
 await page.keyboard.press('ControlOrMeta+s')
 await frame.getByRole('button',{name:'解锁编辑',exact:true}).click({timeout:25000})
 await expect(frame.locator('.tiptap.doc-page').first()).toContainText(secondMarker)
 const editUnlock=frame.getByRole('dialog').filter({hasText:'解锁编辑'})
 await editUnlock.getByLabel('密码',{exact:true}).fill(secret)
 await editUnlock.getByRole('button',{name:'解锁',exact:true}).click()
 await expect(editor).toContainText(secondMarker,{timeout:20000})
 const nextCommit=page.waitForResponse(response=>response.request().method()==='POST'&&response.url().endsWith('/commits')&&response.status()===200,{timeout:25000})
 await editor.click()
 await page.keyboard.press('ControlOrMeta+s')
 const next=await (await nextCommit).json()
 assert.notEqual(next.revision,saved.file.revision)
 const sealed=await f.files.readFile(f.alice.token,entry.id,next.revision)
 const nextZip=await JSZip.loadAsync(await officeCrypto.decrypt(sealed,{password:secret}))
 assert.match(await nextZip.file('word/document.xml').async('string'),new RegExp(secondMarker))
 assert.deepEqual(await f.files.readFile(f.alice.token,entry.id,saved.file.revision),bytes)
})

test('Web Word merges CSV and XLSX recipients into workspace and downloadable DOCX files',{timeout:150000},async t=>{
  const f=await fixture(t),{page}=f,file=f.opened.file
  await page.goto(f.origin+'/native-docx/?fileId='+file.fileId)
  const editor=page.locator('.tiptap.doc-page[contenteditable="true"]').first()
  await expect(editor).toBeVisible({timeout:30000})
  await editor.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.press('Enter')
  await page.keyboard.insertText('Greeting for ')
  await page.getByRole('button',{name:'Mailings',exact:true}).click()
  await page.getByRole('button',{name:'Start Mail Merge',exact:true}).click()
  const panel=page.locator('.modal-mailmerge')
  const picker=page.getByRole('dialog',{name:'Select a recipient list',exact:true})
  async function pick(name,mimeType,buffer){
    await panel.getByRole('button',{name:/Select Recipient List/}).click()
    await expect(picker).toBeVisible()
    const [chooser]=await Promise.all([
      page.waitForEvent('filechooser'),
      picker.getByRole('button',{name:'Choose local file…',exact:true}).click(),
    ])
    await chooser.setFiles({name,mimeType,buffer})
    await expect(panel.locator('.mailmerge-source-name')).toHaveText(name)
  }
  const output=page.getByRole('dialog',{name:'Save a copy to your workspace',exact:true})
  const outputFolder=output.getByRole('combobox',{name:'Folder',exact:true})
  async function chooseOutput(){
    await panel.getByRole('button',{name:'Finish & Merge',exact:true}).click()
    await expect(output).toBeVisible({timeout:15000})
  }
  async function merge(name){
    await chooseOutput()
    if(name)await output.getByRole('textbox',{name:'File name',exact:true}).fill(name)
    const [download]=await Promise.all([page.waitForEvent('download'),output.getByRole('button',{name:'Download merge output',exact:true}).click()])
    return download
  }
  async function documentXml(bytes){
    return (await JSZip.loadAsync(bytes)).file('word/document.xml').async('string')
  }
  function expectPaper(xml,width,height){
    const paper=Array.from(xml.matchAll(/<w:pgSz\b[^>]*>/g)).at(-1)?.[0]??''
    assert.match(paper,new RegExp(`\\bw:w="${width}"`))
    assert.match(paper,new RegExp(`\\bw:h="${height}"`))
  }
  const csv='Name,Code\nAda,0007\nGrace,0100'
  await pick('recipients.csv','text/csv',Buffer.from(csv))
  await panel.getByRole('button',{name:'Name',exact:true}).click()
  await expect(panel.locator('.mailmerge-preview')).toContainText('Ada')
  await panel.getByRole('radio',{name:'One document for all records'}).check()
  const single=await merge()
  assert.equal(single.suggestedFilename(),'native-roundtrip-merged.docx')
  const all=await documentXml(await readFile(await single.path()))
  assert.match(all,/<w:t[^>]*>[^<]*Ada/)
  assert.match(all,/<w:t[^>]*>[^<]*Grace/)
  assert.doesNotMatch(all,/MERGEFIELD/)

  const {csvToXlsxBuffer}=await import('@genoffice/xlsx-gateway/gateway/csv-import-xlsx')
  const xlsx=await csvToXlsxBuffer('Name,Code\nLee,0007\nLee,0100','Recipients')
  const workspace=createWorkspaceService(f.transactions)
  const folder=await workspace.createFolder(f.alice.token,{name:'Campaigns',parentId:null})
  const savedCsv=Buffer.from('Name,Code\nRiley,0007')
  const csvSource=(await importFile(f,f.alice.token,savedCsv,'online-recipients.csv')).file
  const recipient=(await importFile(f,f.alice.token,xlsx,'recipients.xlsx')).file
  await workspace.moveFile(f.alice.token,recipient.fileId,{folderId:folder.id})
  await importFile(f,f.bob.token,xlsx,'private-recipients.xlsx')
  await panel.getByRole('button',{name:/Select Recipient List/}).click()
  const files=picker.getByRole('listbox',{name:'Workspace files',exact:true})
  await expect(files.getByRole('option',{name:'Campaigns / recipients.xlsx',exact:true})).toBeAttached()
  await expect(files.getByRole('option',{name:'private-recipients.xlsx',exact:false})).toHaveCount(0)
  await picker.getByRole('button',{name:'Cancel',exact:true}).click()
  await expect(panel.locator('.mailmerge-source-name')).toHaveText('recipients.csv')
  await panel.getByRole('button',{name:/Select Recipient List/}).click()
  await picker.getByRole('combobox',{name:'File type',exact:true}).selectOption('csv')
  await picker.getByRole('searchbox',{name:'Search files',exact:true}).fill('online-recipients')
  await files.selectOption(csvSource.fileId)
  await picker.getByRole('button',{name:'Use selected file',exact:true}).click()
  await expect(panel.locator('.mailmerge-preview')).toContainText('Riley')
  const online=await merge('Online recipients')
  assert.equal(online.suggestedFilename(),'Online recipients.docx')
  assert.match(await documentXml(await readFile(await online.path())),/<w:t[^>]*>[^<]*Riley/)
  await panel.getByRole('button',{name:/Select Recipient List/}).click()
  await files.selectOption(recipient.fileId)
  const input=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/v1/files/${recipient.fileId}/content`)
  await picker.getByRole('button',{name:'Use selected file',exact:true}).click()
  const response=await input
  assert.ok(response.ok())
  assert.equal(new URL(response.url()).searchParams.get('revision'),recipient.revision)
  await expect(panel.locator('.mailmerge-source-name')).toHaveText('recipients.xlsx')
  await panel.getByRole('radio',{name:'One document per record'}).check()
  const batch=await merge()
  const zip=await JSZip.loadAsync(await readFile(await batch.path()))
  assert.deepEqual(Object.keys(zip.files),['Lee.docx','Lee-2.docx'])
  for(const entry of Object.values(zip.files)){
    const xml=await documentXml(await entry.async('nodebuffer'))
    assert.match(xml,/<w:t[^>]*>[^<]*Lee/)
    assert.doesNotMatch(xml,/MERGEFIELD/)
  }

  await panel.getByRole('radio',{name:'Label sheet',exact:true}).check()
  const labels=await merge()
  const labelXml=await documentXml(await readFile(await labels.path()))
  assert.match(labelXml,/<w:tbl[ >]/)
  assert.match(labelXml,/<w:t[^>]*>[^<]*Lee/)
  expectPaper(labelXml,12240,15840)

  await panel.getByRole('radio',{name:'Envelopes',exact:true}).check()
  const envelopes=await merge()
  const envelopeZip=await JSZip.loadAsync(await readFile(await envelopes.path()))
  assert.deepEqual(Object.keys(envelopeZip.files),['Lee.docx','Lee-2.docx'])
  const envelopeXml=await documentXml(await envelopeZip.file('Lee.docx').async('nodebuffer'))
  assert.match(envelopeXml,/<w:t[^>]*>[^<]*Lee/)
  expectPaper(envelopeXml,13680,5940)

  await workspace.moveFile(f.alice.token,file.fileId,{folderId:folder.id})
  const archive=await workspace.createFolder(f.alice.token,{name:'Mail merge results',parentId:null})
  await chooseOutput()
  await expect(outputFolder).toHaveValue(folder.id)
  await output.getByRole('button',{name:'Cancel',exact:true}).click()
  assert.equal((await f.files.listFiles(f.alice.token)).files.length,3)
  const listCopies=async()=>(await workspace.listFiles(f.alice.token,{folderId:archive.id})).files
  const verifyCopy=async name=>{
    const item=(await listCopies()).find(candidate=>candidate.name===name)
    assert.ok(item,name)
    const {file:copy}=await f.files.openFile(f.alice.token,item.id)
    return documentXml(await f.files.readFile(f.alice.token,copy.fileId,copy.revision))
  }
  const finishes=[]
  await page.route('**/api/v1/uploads/*/finish',async route=>{
    finishes.push(route.request().url())
    if(finishes.length===1){
      const response=await route.fetch()
      assert.equal(response.status(),200)
      return route.abort()
    }
    return route.continue()
  })
  await chooseOutput()
  await outputFolder.selectOption(archive.id)
  await output.getByRole('button',{name:'Save copies',exact:true}).click()
  await expect(panel.getByText(/Confirm the original mail merge save/)).toBeVisible({timeout:20000})
  await panel.getByRole('button',{name:'Close',exact:true}).click()
  const confirm=page.getByRole('button',{name:'Confirm mail merge save',exact:true})
  await confirm.click()
  await expect(confirm).toHaveCount(0,{timeout:20000})
  assert.deepEqual((await listCopies()).map(item=>item.name).sort(),['Lee-2.docx','Lee.docx'])
  assert.equal(finishes.length,3)
  assert.equal(finishes[0],finishes[1])
  assert.notEqual(finishes[2],finishes[0])
  for(const name of ['Lee.docx','Lee-2.docx']){
    const xml=await verifyCopy(name)
    assert.match(xml,/<w:t[^>]*>[^<]*Lee/)
    expectPaper(xml,13680,5940)
  }
  await page.getByRole('button',{name:'Start Mail Merge',exact:true}).click()
  await panel.getByRole('radio',{name:'Label sheet',exact:true}).check()
  await chooseOutput()
  await output.getByRole('textbox',{name:'File name',exact:true}).fill('Address labels')
  await outputFolder.selectOption(archive.id)
  await output.getByRole('button',{name:'Save copy',exact:true}).click()
  await expect.poll(async()=>(await listCopies()).map(item=>item.name)).toContain('Address labels.docx')
  const savedLabels=await verifyCopy('Address labels.docx')
  assert.match(savedLabels,/<w:tbl[ >]/)
  assert.match(savedLabels,/<w:t[^>]*>[^<]*Lee/)
  expectPaper(savedLabels,12240,15840)
  assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
  assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),f.original)
  assert.equal((await f.files.openFile(f.alice.token,recipient.fileId)).file.revision,recipient.revision)
  assert.deepEqual(await f.files.readFile(f.alice.token,recipient.fileId,recipient.revision),xlsx)
  assert.equal((await f.files.openFile(f.alice.token,csvSource.fileId)).file.revision,csvSource.revision)
  assert.deepEqual(await f.files.readFile(f.alice.token,csvSource.fileId,csvSource.revision),savedCsv)
  assert.equal((await f.files.listFiles(f.alice.token)).files.length,6)
})

test('Web Word compares an unsaved draft with a local DOCX without changing either file',{timeout:120000},async t=>{
  const f=await fixture(t),{page}=f
  async function comparisonDoc(paragraphs){
    const archive=await JSZip.loadAsync(f.original)
    const xml=await archive.file('word/document.xml').async('string')
    const body=paragraphs.map(text=>`<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('')
    archive.file('word/document.xml',xml.replace(/<w:body[\s>][\s\S]*<\/w:body>/,`<w:body>${body}</w:body>`))
    return archive.generateAsync({type:'nodebuffer'})
  }
  const source=await comparisonDoc(['Original title','Shared paragraph','Draft-only paragraph','Shared ending'])
  const {file}=await importFile(f,f.alice.token,source,'comparison-source.docx')
  const candidate=await comparisonDoc(['Updated title','Shared paragraph','Shared ending','Added target paragraph'])
  const {file:savedTarget}=await importFile(f,f.alice.token,candidate,'workspace-target.docx')
  await page.goto(f.origin+'/native-docx/?fileId='+file.fileId)
  const editor=page.locator('.tiptap.doc-page[contenteditable="true"]').first()
  await expect(editor.getByText('Original title',{exact:true})).toBeVisible({timeout:30000})
  await editor.getByText('Original title',{exact:true}).click()
  await page.keyboard.press('Home')
  await page.keyboard.insertText('Unsaved ')
  await expect(editor.getByText('Unsaved Original title',{exact:true})).toBeVisible()
  await page.getByRole('button',{name:'Review',exact:true}).click()
  const compare=page.getByRole('button',{name:'Compare',exact:true})
  await expect(compare).toBeEnabled()
  const picker=page.getByRole('dialog',{name:'Select a document to compare',exact:true})
  const panel=page.locator('.compare-pane')
  const chooseLocal=async()=>{
    await compare.click()
    await expect(picker).toBeVisible()
    const [chooser]=await Promise.all([
      page.waitForEvent('filechooser'),
      picker.getByRole('button',{name:'Choose local file…',exact:true}).click(),
    ])
    return chooser
  }
  await compare.click()
  await picker.getByRole('button',{name:'Cancel',exact:true}).click()
  await expect(panel).toHaveCount(0)
  await compare.click()
  await picker.getByRole('listbox',{name:'Workspace files',exact:true}).selectOption(savedTarget.fileId)
  const [download]=await Promise.all([
    page.waitForResponse(response=>new URL(response.url()).pathname===`/api/v1/files/${savedTarget.fileId}/content`),
    picker.getByRole('button',{name:'Use selected file',exact:true}).click(),
  ])
  assert.ok(download.ok())
  assert.equal(new URL(download.url()).searchParams.get('revision'),savedTarget.revision)
  await expect(panel.locator('.compare-meta')).toContainText('workspace-target.docx',{timeout:15000})
  await expect(panel.locator('.compare-changed .compare-left')).toHaveText('Unsaved Original title')
  await expect(panel.locator('.compare-changed .compare-right')).toHaveText('Updated title')
  await panel.getByRole('button',{name:'Close',exact:true}).click()
  const sessionProof='**/api/v1/auth/session-proof'
  await page.route(sessionProof,route=>route.abort())
  await (await chooseLocal()).setFiles({name:'comparison-target.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:candidate})
  await expect(panel.locator('.compare-meta')).toContainText('comparison-target.docx',{timeout:15000})
  await expect(panel.locator('.compare-changed .compare-left')).toHaveText('Unsaved Original title')
  await expect(panel.locator('.compare-changed .compare-right')).toHaveText('Updated title')
  await expect(panel.locator('.compare-removed .compare-left')).toHaveText('Draft-only paragraph')
  await expect(panel.locator('.compare-added .compare-right')).toHaveText('Added target paragraph')
  await expect(panel.locator('.compare-same')).toHaveCount(2)
  await page.unroute(sessionProof)
  await panel.getByRole('button',{name:'Close',exact:true}).click()
  await expect(panel).toHaveCount(0)
  await (await chooseLocal()).element().dispatchEvent('cancel')
  await expect(page.locator('input[type="file"][accept=".docx"]')).toHaveCount(0)
  await expect(panel).toHaveCount(0)
  await (await chooseLocal()).setFiles({name:'invalid.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:Buffer.from('This is not a Word package')})
  await expect(page.locator('.status-msg')).toContainText('Compare failed')
  await expect(panel).toHaveCount(0)
  await expect(page.locator('.dyoffice-docs-persistence-state')).toHaveAttribute('data-dirty','true')
  assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
  assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),source)
  assert.equal((await f.files.openFile(f.alice.token,savedTarget.fileId)).file.revision,savedTarget.revision)
  assert.deepEqual(await f.files.readFile(f.alice.token,savedTarget.fileId,savedTarget.revision),candidate)
  assert.equal((await f.files.listFiles(f.alice.token)).files.length,3)
})

test('workspace print shortcut follows the focused document tab', { timeout: 90_000 }, async t => {
  const localShellDirectory=process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell/',import.meta.url))
  const f=await fixture(t,{localShellDirectory}), {page}=f
  const first=f.opened.file
  const {file:second}=await importFile(f,f.alice.token,f.original,'second-print.docx')
  const frame=id=>page.frameLocator(`.workspace-document-frame[data-document-id="${id}"]`)
  await page.goto(f.origin+'/?print-shortcut=1#/file/'+first.fileId)
  await expect(frame(first.fileId).locator('html')).toHaveAttribute('data-document-loading','ready',{timeout:25000})
  await page.evaluate(id=>{location.hash='#/file/'+id},second.fileId)
  await expect(frame(second.fileId).locator('html')).toHaveAttribute('data-document-loading','ready',{timeout:25000})

  for (const [name,active,inactive] of [
    ['second-print.docx',second.fileId,first.fileId],
    ['native-roundtrip.docx',first.fileId,second.fileId],
  ]) {
    const tab=page.getByRole('tab',{name,exact:true})
    await tab.click()
    await expect(tab).toHaveAttribute('aria-selected','true')
    await expect(page.locator(`.workspace-document[data-file-id="${active}"] .document-loading-content`)).toHaveAttribute('data-loading','false')
    await tab.focus()
    await expect(tab).toBeFocused()
    await page.keyboard.press('ControlOrMeta+p')
    const dialog=frame(active).locator('.modal.print-dialog')
    await expect(dialog).toBeVisible()
    await expect(frame(inactive).locator('.modal.print-dialog')).toHaveCount(0)
    await dialog.getByRole('button',{name:'Cancel',exact:true}).click()
    await expect(dialog).toBeHidden()
  }
  const home=page.locator('.tab-home')
  await home.click()
  await expect(home).toHaveAttribute('aria-selected','true')
  await home.focus()
  await page.keyboard.press('ControlOrMeta+p')
  await expect(page.locator('.file-search input')).toBeFocused()
})

test('native Word exports a named PDF with mixed paper and bookmark links inside the selected range', { timeout: 90_000 }, async t => {
  const f = await fixture(t), {page} = f
  const zip = await JSZip.loadAsync(f.original)
  const portrait='<w:sectPr><w:type w:val="nextPage"/><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>'
  const landscape='<w:sectPr><w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/></w:sectPr>'
  zip.file('word/document.xml',`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
    <w:p><w:pPr>${portrait}</w:pPr><w:bookmarkStart w:id="1" w:name="ExcludedBookmark"/><w:r><w:t>Excluded section</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>
    <w:p><w:pPr>${portrait}</w:pPr><w:r><w:t xml:space="preserve">Portrait section </w:t></w:r>
      <w:hyperlink w:anchor="LandscapeBookmark"><w:r><w:t>Go to landscape</w:t></w:r></w:hyperlink>
      <w:r><w:t xml:space="preserve"> </w:t></w:r>
      <w:hyperlink w:anchor="ExcludedBookmark"><w:r><w:t>Go to excluded</w:t></w:r></w:hyperlink>
    </w:p>
    <w:p><w:bookmarkStart w:id="2" w:name="LandscapeBookmark"/><w:r><w:t>Landscape section</w:t></w:r><w:bookmarkEnd w:id="2"/></w:p>${landscape}
  </w:body></w:document>`)
  const original=await zip.generateAsync({type:'nodebuffer'})
  const {file}=await importFile(f,f.alice.token,original,'mixed-paper.docx')
  await page.goto(f.origin+'/native-docx/?fileId='+file.fileId)
  await expect(page.locator('.tiptap.ProseMirror').first()).toContainText('Landscape section')
  await expect(page.getByRole('complementary',{name:'Document notifications'}).getByText(/No model is available/)).toBeVisible()
  const originalTitle=await page.title()
  await page.evaluate(()=>{
    window.print=()=>{
      document.documentElement.dataset.printTitle=document.title
      window.dispatchEvent(new Event('beforeprint'))
    }
  })
  await page.keyboard.press('ControlOrMeta+p')
  const dialog=page.locator('.modal.print-dialog')
  await expect(dialog).toBeVisible()
  await expect(page.locator('.pagination-preview .pv-page')).toHaveCount(3)
  await dialog.getByRole('radio',{name:'Custom range',exact:true}).check()
  await dialog.getByPlaceholder('e.g. 1,3,5-8').fill('2-3')
  const fileName=dialog.getByRole('textbox',{name:'File name',exact:true})
  const exportPdf=dialog.getByRole('button',{name:'Export PDF',exact:true})
  await expect(fileName).toHaveValue('mixed-paper')
  await fileName.fill('   ')
  await expect(exportPdf).toBeDisabled()
  await expect(dialog.getByRole('button',{name:'Print',exact:true})).toBeEnabled()
  await fileName.fill('Binding proof.pdf')
  await exportPdf.click()
  await expect(page.locator('style[data-docs-print-paper]')).toHaveCount(1)
  await expect(page.locator('html')).toHaveAttribute('data-print-title','Binding proof')
  try {
    const bytes=await page.pdf({preferCSSPageSize:true,printBackground:true})
    const printed=await PDFDocument.load(bytes)
    assert.deepEqual(printed.getPages().map(p=>[Math.round(p.getWidth()),Math.round(p.getHeight())]),[[612,792],[792,612]])
    const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs')
    const task=getDocument({data:Uint8Array.from(bytes)})
    try {
      const doc=await task.promise
      const text=async n=>(await (await doc.getPage(n)).getTextContent()).items.map(item=>item.str??'').join(' ')
      assert.match(await text(1),/Portrait section/)
      assert.doesNotMatch(await text(1),/Excluded section/)
      assert.match(await text(2),/Landscape section/)
      const links=(await (await doc.getPage(1)).getAnnotations()).filter(annotation=>annotation.subtype==='Link')
      assert.equal(links.length,1,'Only the bookmark whose destination is printed should be linked')
      const destination=typeof links[0].dest==='string'?await doc.getDestination(links[0].dest):links[0].dest
      assert.ok(destination?.[0],'The bookmark must resolve to a PDF destination')
      assert.equal(await doc.getPageIndex(destination[0]),1,'The bookmark must land on the printed landscape page')
    } finally {
      await task.destroy()
    }
  } finally {
    await page.evaluate(()=>window.dispatchEvent(new Event('afterprint')))
  }
  await expect(dialog).toBeHidden()
  await expect(page.locator('style[data-docs-print-paper]')).toHaveCount(0)
  await expect.poll(()=>page.title()).toBe(originalTitle)
  await page.keyboard.press('ControlOrMeta+p')
  await dialog.getByRole('textbox',{name:'File name',exact:true}).fill('Ignored by ordinary printing')
  await dialog.getByRole('button',{name:'Print',exact:true}).click()
  try {
    await expect(page.locator('html')).toHaveAttribute('data-print-title',originalTitle)
  } finally {
    await page.evaluate(()=>window.dispatchEvent(new Event('afterprint')))
  }
  await expect(dialog).toBeHidden()
  await page.getByRole('button',{name:'Convert',exact:true}).click()
  await page.getByRole('button',{name:'Convert to PDF…',exact:true}).click()
  await expect(page.locator('style[data-docs-print-paper]')).toHaveCount(1,{timeout:25000})
  try{
    const printed=await PDFDocument.load(await page.pdf({preferCSSPageSize:true,printBackground:true}))
    assert.deepEqual(printed.getPages().map(p=>[Math.round(p.getWidth()),Math.round(p.getHeight())]),[[612,792],[612,792],[792,612]])
  }finally{await page.evaluate(()=>window.dispatchEvent(new Event('afterprint')))}
  await expect(page.locator('style[data-docs-print-paper]')).toHaveCount(0)
  assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
  assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
})

test('native Word shares live draft text only after consent and stops after saving', { timeout: 90_000 }, async t => {
  const f = await fixture(t), fileId = f.opened.file.fileId
  const opening = f.page.waitForEvent('popup')
  await f.page.evaluate(({origin,fileId}) => {
    window.receivedDrafts = []
    const child = window.open(origin + '/native-docx/?fileId=' + fileId)
    window.addEventListener('message', event => {
      if (event.origin === origin && event.source === child && event.data?.type === 'dsh-dyoffice:draft')
        window.receivedDrafts.push(event.data.draft)
    })
    setInterval(() => child.postMessage({type:'dsh-dyoffice:draft-request',fileId},origin),200)
  },{origin:f.origin,fileId})
  const popup = await opening
  const editor = popup.locator('.tiptap.doc-page[contenteditable="true"]')
  await editor.waitFor({timeout:45000})
  await editor.click()
  await popup.keyboard.press('Control+End')
  await popup.keyboard.press('Enter')
  await popup.keyboard.insertText('Draft shared before save')
  const share = popup.getByRole('button',{name:'Share unsaved text with DSH'})
  await expect(share).toBeVisible()
  assert.deepEqual(await f.page.evaluate(() => window.receivedDrafts),[])
  await share.click()
  await expect.poll(() => f.page.evaluate(() => window.receivedDrafts.at(-1)?.text)).toContain('Draft shared before save')
  assert.equal((await f.files.openFile(f.alice.token,fileId)).file.revision,f.opened.file.revision)
  await editor.click()
  await popup.keyboard.press('Control+s')
  await expect.poll(() => f.page.evaluate(() => window.receivedDrafts.at(-1)),{timeout:20000}).toBe(null)
})

async function openStreamedDshDraft(t) {
  const f = await fixture(t,{assistantChannels:true})
  const {createCsrfService} = await import('../../server/src/modules/auth/csrf.ts')
  const csrf = createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:f.origin,key:f.csrfKey})
  const base = '/api/v1/assistant-channels'
  const post = (path,payload,headers={cookie:'__Host-dyoffice-session='+f.alice.token,origin:f.origin,'x-csrf-token':csrf.sessionToken(f.alice.token)}) =>
    f.app.inject({method:'POST',url:base+path,headers,payload})
  const channel = await post('/channels',{})
  assert.equal(channel.statusCode,200,channel.body)
  const member = await post('/channels/'+channel.json().conversationId+'/dsh-token',{allowCreate:true})
  assert.equal(member.statusCode,200,member.body)
  const headers = {authorization:'Bearer '+member.json().memberToken}
  const created = await post('/member/documents',{format:'docx',title:'Direct draft'},headers)
  assert.equal(created.statusCode,200,created.body)
  const {fileId,previewProof} = created.json()
  const grant = await post('/member/documents/'+fileId+'/draft-sync',{origin:f.origin,write:true},{...headers,'x-dyoffice-document-preview':previewProof})
  assert.equal(grant.statusCode,200,grant.body)
  const initial = (await f.files.openFile(f.alice.token,fileId)).file.revision
  await f.context.route('**/api/v1/ai/catalog',route=>route.fulfill({json:{entries:[{id:'office-model',label:'Office model'}],defaultId:'office-model'}}))
  await f.context.addInitScript(()=>{
    const fetch=window.fetch.bind(window)
    window.officeDraftRequests=[]
    window.fetch=(resource,init)=>{
      if(resource!=='/api/v1/ai/turns' || init?.method!=='POST')return fetch(resource,init)
      window.officeDraftRequests.push(JSON.parse(init.body))
      const event=(type,data)=>new TextEncoder().encode('event: '+type+'\ndata: '+JSON.stringify(data)+'\n\n')
      if(window.officeDraftRequests.length===1) {
        return Promise.resolve(new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(event('tool_call',{id:'write-plan',name:'write_document',input:{plan:'概述目标和流程'}}))
            controller.enqueue(event('done',{}))
            controller.close()
          },
        }),{headers:{'Content-Type':'text/event-stream'}}))
      }
      if(window.officeDraftRequests.length>2) {
        const request=window.officeDraftRequests.at(-1).request
        const question=request.messages.at(-1).text
        const text=request.messages.at(-1).role==='tool'?'Word 草稿已完成。':
          question?.includes('怎么安排签到？')?'收到：怎么安排签到？':question?.includes('再简短说明一下')?'收到：再简短说明一下':'本地对话正常。'
        return Promise.resolve(new Response(
          `event: delta\ndata: ${JSON.stringify({text})}\n\nevent: done\ndata: {}\n\n`,
          {headers:{'Content-Type':'text/event-stream'}}))
      }
      return Promise.resolve(new Response(new ReadableStream({
        start(controller){
          controller.enqueue(event('delta',{text:'<h1>活动目标</h1><p>提高交流效率</p>'}))
          window.finishOfficeDraft=(reason)=>{
            try { controller.enqueue(event('delta',{text:'<h2>活动流程</h2><p>签到和交流</p>'})) } catch { return }
            if(reason) controller.enqueue(event('stop_reason',{reason}))
            controller.enqueue(event('done',{}))
            controller.close()
          }
        },
        cancel(){},
      }),{headers:{'Content-Type':'text/event-stream'}}))
    }
  })
  const opening = f.page.waitForEvent('popup')
  await f.page.evaluate(({origin,fileId,ticket}) => {
    window.receivedDrafts = []
    window.writing = {id:crypto.randomUUID(),topic:'活动策划',skill:{name:'events',content:'Include a registration desk. '+ 'Task reference. '.repeat(170)+'Include the event owner.'}}
    window.writeReceipt = null
    const child = window.open(origin+'/native-docx/?fileId='+fileId)
    window.addEventListener('message', event => {
      if (event.origin === origin && event.source === child && event.data?.type === 'dsh-dyoffice:draft') {
        window.receivedDrafts.push(event.data.draft)
        window.writeReceipt = event.data.writing
        window.officeAnswer = event.data.followup
      }
    })
    setInterval(() => child.postMessage({type:'dsh-dyoffice:draft-request',fileId,ticket,writing:window.writing,followup:window.officeQuestion},origin),250)
  },{origin:f.origin,fileId,ticket:grant.json().ticket})
  const popup = await opening
  const editor = popup.locator('.tiptap.doc-page[contenteditable="true"]')
  await editor.waitFor({timeout:45000})
  await expect(popup.getByRole('button',{name:'Pause live text'})).toBeVisible()
  await expect.poll(() => f.page.evaluate(() => window.writeReceipt?.state)).toBe('writing')
  await expect(editor).toContainText('提高交流效率')
  const assistant=popup.getByRole('complementary',{name:'AI Assistant'})
  const conversation=assistant.locator('.ai-chat')
  await expect(conversation.locator('.ai-msg-user').filter({hasText:'活动策划'})).toHaveCount(1)
  const runningSteps=conversation.locator('.ai-msg-assistant .ai-work-group-summary.running')
  await expect(runningSteps).toBeVisible()
  await expect(runningSteps).toHaveAttribute('aria-expanded','false')
  await expect(runningSteps).toContainText('write_document')
  await expect(runningSteps.locator('.ai-work-group-label')).toHaveCSS('white-space','nowrap')
  await expect(conversation.locator('.ai-work-group-body')).toHaveCSS('transition-duration','0s')
  const requests=await popup.evaluate(()=>window.officeDraftRequests)
  assert.equal(requests.length,2)
  assert.equal(requests[0].modelId,'office-model')
  assert.match(requests[0].request.messages.at(-1).text,/活动策划/)
  assert.ok(requests[0].request.tools.some(t=>t.name==='write_document'))
  assert.match(requests[0].request.messages.at(-1).text,/Include a registration desk/)
  assert.match(requests[1].request.messages.at(-1).text,/Include a registration desk/)
  assert.match(requests[1].request.messages.at(-1).text,/Include the event owner/)
  assert.deepEqual(requests[1].request.tools,[])
  assert.match(requests[1].request.messages.at(-1).text,/概述目标和流程/)
  await expect.poll(() => f.page.evaluate(() => window.receivedDrafts.at(-1)?.text)).toContain('提高交流效率')
  assert.equal((await f.files.openFile(f.alice.token,fileId)).file.revision,initial)
  const finish = reason => popup.evaluate(value => window.finishOfficeDraft(value),reason)
  return {f,popup,conversation,editor,fileId,initial,finish}
}

test('native Word streams DyOffice writing and shows the returned DSH review', { timeout: 90_000 }, async t => {
  const {f,popup,conversation,fileId,initial,finish} = await openStreamedDshDraft(t)
  const summary = conversation.locator('.ai-work-group-summary')
  const summaryPosition = () => summary.evaluate(button => {
    const reply = button.closest('.ai-msg-assistant').getBoundingClientRect()
    const caret = button.querySelector('.ai-tool-chip-caret').getBoundingClientRect()
    return {x: caret.left - reply.left, y: button.getBoundingClientRect().top - reply.top}
  })
  const runningPosition = await summaryPosition()
  const indicator = summary.locator('.ai-tool-chip-spinner')
  const ripple = await indicator.evaluate(dot => {
    const [animation] = dot.getAnimations({subtree:true})
    if (!animation) return null
    const sample = time => {
      animation.currentTime = time
      const {x, y, width, height} = dot.getBoundingClientRect()
      const ring = getComputedStyle(dot, '::before')
      return {
        bounds: [x, y, width, height],
        dotOpacity: getComputedStyle(dot).opacity,
        scale: new DOMMatrixReadOnly(ring.transform === 'none' ? undefined : ring.transform).a,
        ringOpacity: Number(ring.opacity),
      }
    }
    animation.pause()
    const start = sample(0)
    const middle = sample(animation.effect.getComputedTiming().duration / 2)
    return {start, middle}
  })
  assert.ok(ripple && ripple.middle.scale > ripple.start.scale, 'The running indicator has an expanding ring')
  assert.ok(ripple.middle.ringOpacity < ripple.start.ringOpacity, 'The ring fades as it expands')
  assert.equal(ripple.middle.dotOpacity, ripple.start.dotOpacity)
  assert.deepEqual(ripple.start.bounds, ripple.middle.bounds)
  await popup.emulateMedia({reducedMotion: 'reduce'})
  await expect.poll(() => indicator.evaluate(dot => dot.getAnimations({subtree:true}).length)).toBe(0)
  await popup.emulateMedia({reducedMotion: 'no-preference'})
  await finish()
  await expect.poll(() => f.page.evaluate(() => window.writeReceipt?.state),{timeout:20_000}).toBe('saved')
  await expect(summary).not.toHaveClass(/running/)
  const completedPosition = await summaryPosition()
  assert.deepEqual(
    {
      caretShift: Math.abs(completedPosition.x - runningPosition.x) > 0.5,
      rowShift: Math.abs(completedPosition.y - runningPosition.y) > 0.5,
    },
    {caretShift: false, rowShift: false},
  )
  const saved = (await f.files.openFile(f.alice.token,fileId)).file
  assert.notEqual(saved.revision, initial)
  assert.equal(await f.page.evaluate(()=>window.writeReceipt.revision),saved.revision)
  assert.deepEqual(await f.page.evaluate(()=>Object.keys(window.writeReceipt).sort()),['id','reply','revision','state'])
  await f.page.evaluate(()=>{window.writing.review={state:'ready',text:'建议明确活动负责人与场地。'}})
  await expect(conversation.locator('.ai-msg-assistant').filter({hasText:'Word 草稿已完成。'})).toHaveCount(1)
  await expect(conversation.locator('.dyoffice-collaboration-message').filter({hasText:'建议明确活动负责人与场地。'})).toBeVisible()
  assert.equal(await f.page.evaluate(()=>window.writeReceipt.reply),'Word 草稿已完成。')
  for(const question of ['怎么安排签到？','再简短说明一下']) {
    await f.page.evaluate(question=>{window.officeQuestion={id:crypto.randomUUID(),question}},question)
    await expect(conversation.getByText('收到：'+question,{exact:true})).toBeVisible()
  }
  await f.page.evaluate(()=>{delete window.officeQuestion.question;window.officeAnswer=null})
  await expect.poll(()=>f.page.evaluate(()=>window.officeAnswer?.answer)).toBe('收到：再简短说明一下')
  await f.page.evaluate(()=>{window.officeQuestion={id:crypto.randomUUID()};window.officeAnswer=null})
  await expect.poll(()=>f.page.evaluate(()=>window.officeAnswer?.state)).toBe('unknown')
  await f.page.evaluate(()=>{window.officeQuestion={id:crypto.randomUUID(),scope:'previous-editor',question:'Old instruction'};window.officeAnswer=null})
  await expect.poll(()=>f.page.evaluate(()=>window.officeAnswer?.state)).toBe('unknown')
  const requests=await popup.evaluate(()=>window.officeDraftRequests)
  assert.equal(requests.length,5)
  const handoffReport=requests[2].request
  assert.equal(handoffReport.messages.at(-1).role,'tool')
  assert.match(handoffReport.messages.at(-1).results[0].output,/Content written by the system/)
  const followup=requests[4].request
  assert.ok(followup.tools.some(t=>t.name==='write_document'))
  assert.match(followup.messages.at(-1).text,/再简短说明一下/)
  assert.doesNotMatch(JSON.stringify(followup.messages),/Include a registration desk/)
  assert.ok(followup.messages.some(m=>m.role==='assistant'&&m.text?.includes('收到：怎么安排签到？')))
  const zip = await JSZip.loadAsync(await f.files.readFile(f.alice.token,fileId,saved.revision))
  const xml = await zip.file('word/document.xml').async('string')
  assert.match(xml,/提高交流效率/)
  assert.match(xml,/签到和交流/)
  assert.doesNotMatch(xml,/建议明确/)
  const composer=popup.locator('.ai-panel textarea')
  await composer.fill('直接问 Office 的私人问题')
  await composer.press('Enter')
  await expect(conversation.getByText('本地对话正常。',{exact:true})).toBeVisible()
  const native=(await popup.evaluate(()=>window.officeDraftRequests)).at(-1).request
  assert.ok(native.tools.some(tool=>tool.name==='write_document'))
  assert.match(native.messages.at(-1).text,/直接问 Office 的私人问题/)
  assert.ok(native.messages.some(m=>m.role==='assistant'&&m.text?.includes('收到：再简短说明一下')))

})

test('native Word reports truncated writing without handing it to DSH for review', { timeout: 90_000 }, async t => {
  const {f,conversation,fileId,initial,finish} = await openStreamedDshDraft(t)
  await finish('max_tokens')
  await expect.poll(() => f.page.evaluate(() => window.writeReceipt?.state)).toBe('outputLimit')
  await expect(conversation.locator('.ai-msg-assistant')).not.toHaveCount(0)
  assert.equal((await f.files.openFile(f.alice.token,fileId)).file.revision,initial)
})

test('native Word stops streamed DyOffice writing when the user edits the draft', { timeout: 90_000 }, async t => {
  const {f,popup,editor,fileId,initial,finish} = await openStreamedDshDraft(t)
  await editor.click()
  await popup.keyboard.insertText('人工补充')
  await finish()
  await expect.poll(() => f.page.evaluate(() => window.writeReceipt?.state)).toBe('conflict')
  await expect(editor).toContainText('人工补充')
  await expect(editor).not.toContainText('签到和交流')
  assert.equal((await f.files.openFile(f.alice.token,fileId)).file.revision,initial)
})

test('Word AI naming confirms an independent copy of the unsaved draft', {timeout:90000},async t=>{
  const f=await fixture(t),file=f.opened.file,marker='Quarterly review draft'
  await f.preferences.update(f.alice.token,{showAssistant:true})
  await f.context.route('**/api/v1/ai/catalog',route=>route.fulfill({json:{entries:[{id:'mock',label:'Test model'}],defaultId:'mock'}}))
  const requests=[]
  await f.context.route('**/api/v1/ai/turns',route=>{
    requests.push(route.request().postDataJSON())
    return route.fulfill({contentType:'text/event-stream',body:'event: delta\ndata: {"text":"Quarterly review.docx"}\n\nevent: done\ndata: {}\n\n'})
  })
  await f.page.goto(f.origin+'/native-docx/?fileId='+file.fileId)
  const editor=f.page.locator('.tiptap.doc-page[contenteditable="true"]')
  await editor.waitFor({timeout:45000})
  await editor.first().click()
  // The model names the document from its opening excerpt; this fixture is longer.
  await f.page.keyboard.press('Control+Home')
  await f.page.keyboard.insertText(marker)
  await f.page.keyboard.press('Enter')
  await expect(f.page.locator('.dyoffice-docs-persistence-state')).toHaveAttribute('data-dirty','true')
  await f.page.getByRole('button',{name:'File',exact:true}).click()
  const namingButton=f.page.locator('.qa-name-with-ai')
  await expect(namingButton).toBeEnabled()
  // A background proof request must not consume the refusal intended for naming.
  const proofPath='**/api/v1/auth/session-proof',denyProof=route=>route.fulfill({status:503,json:{}})
  await f.page.route(proofPath,denyProof)
  try {
    await namingButton.click()
    await expect(f.page.getByText('Could not verify this workspace session. Your draft is still open.')).toBeVisible()
    assert.equal(requests.length,0)
  } finally {
    await f.page.unroute(proofPath,denyProof)
  }
  async function choose(name){
    await f.page.getByRole('button',{name:'File',exact:true}).click()
    const button=f.page.locator('.qa-name-with-ai')
    await expect(button).toBeEnabled()
    await button.click()
    const confirmation=f.page.getByRole('dialog',{name:'Save a copy to your workspace'})
    const input=confirmation.getByRole('textbox',{name:'File name'})
    await expect(input).toHaveValue('Quarterly review.docx')
    if(name!==null)await input.fill(name)
    await confirmation.getByRole('button',{name:name===null?'Cancel':'Save copy'}).click()
    await expect(confirmation).toHaveCount(0)
  }
  await choose(null)
  assert.equal((await f.files.listFiles(f.alice.token)).files.length,1)
  await choose('Reviewed quarterly notes')
  await expect.poll(async()=>(await f.files.listFiles(f.alice.token)).files.length).toBe(2)
  const copy=(await f.files.listFiles(f.alice.token)).files.find(item=>item.name==='Reviewed quarterly notes.docx')
  assert.ok(copy)
  const archive=await JSZip.loadAsync(await f.files.readFile(f.alice.token,copy.id,copy.revision))
  assert.ok((await archive.file('word/document.xml').async('string')).replace(/<[^>]+>/g,'').includes(marker))
  assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),f.original)
  assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
  await expect(f.page.locator('.dyoffice-docs-persistence-state')).toHaveAttribute('data-dirty','true')
  assert.equal(requests.length,2)
  for(const {modelId,request} of requests){
    assert.equal(modelId,'mock');assert.equal(request.format,'docx');assert.deepEqual(request.tools,[])
    assert.ok(request.messages[0].text.includes(marker))
  }
})

test('native DyOffice DOCX renders, edits, commits, refreshes and preserves unrelated original parts', { timeout: 120_000 }, async t => {
  const f = await fixture(t), errors = []
  const filePath = '/native-docx/?fileId=' + f.opened.file.fileId
  const cookie = token => ({ cookie: '__Host-dyoffice-session=' + token })
  assert.equal((await f.app.inject({ url: filePath })).statusCode,401)
  assert.equal((await f.app.inject({ url: filePath,headers: cookie(f.bob.token) })).statusCode,404)
  const html = await f.app.inject({ url: filePath,headers: cookie(f.alice.token) })
  assert.equal(html.statusCode,200)
  assert.deepEqual((await f.app.inject({ url: '/api/v1/capabilities',headers: cookie(f.alice.token) })).json(),{ docx: 'editable',xlsx: 'unsupported',pptx: 'unsupported',pdf: 'unsupported' })
  assert.equal((await f.app.inject({ url: '/api/v1/files/' + f.opened.file.fileId,headers: cookie(f.alice.token) })).json().capabilities.docx,'editable')
  assert.equal(html.headers['cache-control'],'private, no-store')
  const asset = html.body.match(/src="([^"]+\.js)"/)[1]
  assert.equal((await f.app.inject({ url: asset })).statusCode,401)
  assert.equal((await f.app.inject({ url: asset,headers: cookie(f.alice.token) })).statusCode,200)
  assert.equal((await f.app.inject({ url: '/native-docx/src/editors/docs-entry.tsx',headers: cookie(f.alice.token) })).statusCode,404)
  assert.equal((await f.app.inject({ url: `/api/v1/files/${f.opened.file.fileId}/revisions/${f.opened.file.revision}`,headers: cookie(f.bob.token) })).statusCode,404)
  f.page.on('pageerror' ,error => errors.push(String(error)))
  const response = await f.page.goto(f.origin + '/native-docx/?fileId=' + f.opened.file.fileId)
  assert.equal(response.status(),200)
  const editor = f.page.locator('.tiptap.doc-page[contenteditable="true"]')
  await editor.waitFor({ timeout: 45_000 })
  const marker = 'Web native paragraph 2026'
  await editor.click()
  await f.page.keyboard.press('Control+End'); await f.page.keyboard.press('Enter'); await f.page.keyboard.type(marker)
  assert.ok((await editor.innerText()).includes(marker))
  await f.page.keyboard.press('Control+z')
  assert.ok(!(await editor.innerText()).includes(marker))
  await f.page.keyboard.press('Control+Shift+z')
  assert.ok((await editor.innerText()).includes(marker))
  await f.page.keyboard.press('Enter')
  await f.page.getByRole('button',{ name: 'Insert',exact: true }).click()
  await f.page.getByRole('button',{ name: 'Table',exact: true }).click()
  await f.page.locator('.table-picker-grid .table-cell').nth(11).click()
  const cell = editor.locator('table td').first()
  await cell.click(); await f.page.keyboard.type('Native table cell')
  assert.equal(await editor.locator('table tr').count(),2)
  await f.context.grantPermissions(['clipboard-read','clipboard-write'])
  await f.page.evaluate(() => navigator.clipboard.writeText(' 浏览器剪贴板'))
  await f.page.keyboard.press('Control+v')
  await expect(cell).toContainText('浏览器剪贴板')
  const committed = f.page.waitForResponse(reply => reply.url().endsWith('/commits') && reply.request().method() === 'POST' && reply.status() === 200)
  await f.page.keyboard.press('Control+s')
  await committed
  const opened = await f.files.openFile(f.alice.token,f.opened.file.fileId)
  assert.notEqual(opened.file.revision,f.opened.file.revision)
  const bytes = await f.files.readFile(f.alice.token,opened.file.fileId,opened.file.revision), archive = await JSZip.loadAsync(bytes)
  assert.ok((await archive.file('word/document.xml').async('string')).replace(/<[^>]+>/g,'').includes(marker))
  assert.ok((await archive.file('word/document.xml').async('string')).includes('Native table cell'))
  assert.ok((await archive.file('word/document.xml').async('string')).includes('浏览器剪贴板'))
  assert.equal(await archive.file('customXml/dyoffice-preserve.xml').async('string'),'<probe>Untouched custom part</probe>')
  await expectCleanPersistence(f.page)
  await f.page.getByRole('button',{ name: 'File',exact: true }).click()
  const savedDownload = f.page.getByRole('link',{ name: 'Download saved version',exact: true })
  await expect(savedDownload).toBeVisible()
  const [download] = await Promise.all([
    f.page.waitForEvent('download'),
    savedDownload.click(),
  ])
  assert.equal(download.suggestedFilename(),'native-roundtrip.docx')
  assert.deepEqual(await readFile(await download.path()),bytes)
  const history = await f.context.request.get(`${f.origin}/api/v1/files/${opened.file.fileId}/revisions`)
  assert.equal(history.status(),200)
  assert.equal((await history.json()).revisions.length,2)
  await expectCleanPersistence(f.page)
  await f.page.reload()
  await f.page.locator('.tiptap.doc-page').waitFor({ timeout: 45_000 })
  await expect(f.page.locator('.tiptap.doc-page')).toContainText(marker,{ timeout: 45_000 })
  await expect(f.page.locator('.tiptap.doc-page table')).toContainText('Native table cell')
  assert.deepEqual(errors,[])
})

test('native Word saves a styled paragraph and an anchored review comment', {timeout:120_000}, async t => {
  const f = await fixture(t), {page} = f
  const original = await readFile(new URL('../../../shell/build/shell-new/blank.docx',import.meta.url))
  const {file} = await importFile(f,f.alice.token,original,'styled-review.docx')
  const title = 'F01 review heading', comment = 'Review the native heading before release.'
  await page.goto(f.origin+'/native-docx/?fileId='+file.fileId)
  const editor = page.locator('.tiptap.doc-page[contenteditable="true"]')
  await editor.waitFor({timeout:45_000})
  await editor.click()
  await page.keyboard.type(title)
  await page.getByRole('button',{name:'Styles',exact:true}).click()
  await page.locator('.style-gallery-menu [data-style-id="Heading1"]').click()
  await expect(editor.getByRole('heading',{name:title,level:1})).toBeVisible()

  await page.getByRole('button',{name:'Review',exact:true}).click()
  await editor.getByRole('heading',{name:title,level:1}).click()
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+End')
  await expect.poll(()=>page.evaluate(()=>window.getSelection()?.toString())).toBe(title)
  await page.getByRole('button',{name:'New Comment',exact:true}).click()
  await page.getByPlaceholder('Type a comment…').fill(comment)
  await page.locator('.comment-compose').getByRole('button',{name:'Comment',exact:true}).click()
  const commentsPane = page.locator('.comments-pane')
  await expect(commentsPane.locator('.comment-text')).toHaveText(comment)

  const committed = page.waitForResponse(reply=>reply.url().endsWith('/commits')&&reply.request().method()==='POST'&&reply.status()===200)
  await page.keyboard.press('Control+s')
  await committed
  await expectCleanPersistence(page)
  const current = (await f.files.openFile(f.alice.token,file.fileId)).file
  assert.notEqual(current.revision,file.revision)
  await page.getByRole('button',{name:'File',exact:true}).click()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link',{name:'Download saved version',exact:true}).click(),
  ])
  const bytes = await readFile(await download.path())
  assert.deepEqual(bytes,await f.files.readFile(f.alice.token,file.fileId,current.revision))
  assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
  const archive = await JSZip.loadAsync(bytes)
  const commentsXml = await archive.file('word/comments.xml').async('string')
  assert.ok(commentsXml.includes(comment))
  const commentId = commentsXml.match(/<w:comment\b[^>]*\bw:id="(\d+)"/)?.[1]
  assert.ok(commentId)
  const documentXml = await archive.file('word/document.xml').async('string')
  const headingXml = [...documentXml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].find(([xml])=>xml.includes(title))?.[0]
  assert.ok(headingXml)
  assert.match(headingXml,/<w:pStyle\s+w:val="Heading1"/)
  const start = headingXml.indexOf(`<w:commentRangeStart w:id="${commentId}"`)
  const end = headingXml.indexOf(`<w:commentRangeEnd w:id="${commentId}"`)
  const content = headingXml.indexOf(title)
  assert.ok(start>=0&&start<content&&content<end,'comment must anchor the saved heading text')
  assert.ok(headingXml.includes(`<w:commentReference w:id="${commentId}"`))
  assert.match(await archive.file('word/_rels/document.xml.rels').async('string'),/Target="comments\.xml"/)
  assert.match(await archive.file('[Content_Types].xml').async('string'),/PartName="\/word\/comments\.xml"/)

  await page.reload()
  await expect(editor.getByRole('heading',{name:title,level:1})).toBeVisible({timeout:45_000})
  await page.locator('.ribbon-mode-split .mode-menu-wrap').getByRole('button',{name:'Show Comments',exact:true}).click()
  await page.getByRole('menuitemradio',{name:'List',exact:true}).click()
  await expect(commentsPane.locator('.comment-card')).toContainText(comment)
  await expect(commentsPane.locator('.comment-anchor')).toContainText(title)
})

test('native Word preserves modify-password protection across read-only open, edit and save',{timeout:120_000},async t=>{
  const f=await fixture(t),{page}=f
  const modifyPassword='Synthetic acceptance password'
  const document=await parseDocx(f.original)
  const originalBlocks=document.blocks.filter(block=>!block.hidden&&block.docxIndex!==null)
    .map(block=>({kind:'original',docxIndex:block.docxIndex}))
  const original=Buffer.from(await saveDocx(document,originalBlocks,{
    writeProtection:await hashProtectionPassword(modifyPassword,1000),
  }))
  const {file}=await importFile(f,f.alice.token,original,'write-protected.docx')
  const revision=async()=>(await f.files.openFile(f.alice.token,file.fileId)).file.revision
  await page.goto(f.origin+'/native-docx/?fileId='+file.fileId)
  const dialog=page.getByRole('dialog').filter({hasText:'Write-Protected'})
  const editor=page.locator('.tiptap.doc-page')
  await expect(dialog).toBeVisible({timeout:45000})
  await dialog.locator('input').fill('Incorrect fixture password')
  await dialog.getByRole('button',{name:'OK',exact:true}).click()
  await expect(dialog.getByText('The password is incorrect. Try again.')).toBeVisible()
  await dialog.getByRole('button',{name:'Open Read-Only',exact:true}).click()
  await expect(editor).toHaveAttribute('contenteditable','false')
  await editor.click()
  await page.keyboard.type('This edit must be blocked')
  await expect(editor).not.toContainText('This edit must be blocked')
  await expect(page.getByRole('button',{name:/^Save \(/})).toBeDisabled()
  assert.equal(await revision(),file.revision)
  await page.getByRole('button',{name:'File',exact:true}).click()
  const [download]=await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link',{name:'Download saved version',exact:true}).click(),
  ])
  assert.deepEqual(await readFile(await download.path()),original)

  await page.reload()
  await expect(dialog).toBeVisible({timeout:45000})
  await dialog.locator('input').fill(modifyPassword)
  await dialog.getByRole('button',{name:'OK',exact:true}).click()
  await expect(dialog).toHaveCount(0)
  await expect(editor).toHaveAttribute('contenteditable','true')
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  const marker='The authorized edit survived the save.'
  await page.keyboard.type(marker)
  await expect(editor).toContainText(marker)
  const committed=page.waitForResponse(reply=>reply.url().endsWith('/commits')&&reply.request().method()==='POST'&&reply.status()===200)
  await page.keyboard.press('Control+s')
  await committed
  await expectCleanPersistence(page)
  const savedRevision=await revision()
  assert.notEqual(savedRevision,file.revision)
  const saved=await f.files.readFile(f.alice.token,file.fileId,savedRevision)
  const [before,after]=await Promise.all([JSZip.loadAsync(original),JSZip.loadAsync(saved)])
  const protection=(zip)=>zip.file('word/settings.xml').async('string').then(xml=>xml.match(/<w:writeProtection\b[^>]*\/>/)?.[0])
  const expected=await protection(before)
  assert.ok(expected)
  assert.equal(await protection(after),expected)
  assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
  await page.reload()
  await expect(dialog).toBeVisible({timeout:45000})
  await dialog.getByRole('button',{name:'Open Read-Only',exact:true}).click()
  await expect(editor).toHaveAttribute('contenteditable','false')
  await expect(editor).toContainText(marker)
})

test('editing during a delayed native save keeps the newer draft dirty and saves a later child revision', { timeout: 120_000 },async t => {
  const diagnostic = phaseDiagnostics(t.signal)
  t.after(() => diagnostic.dispose())
  try {
  let requestDiagnostic, commitPath
  // Pause the real authenticated server reply after the commit, without a
  // Chromium route.fetch/fulfill replay of the TLS request or its response.
  const held = holdFirstResponseEnd(
    req => req.method === 'POST' && commitPath !== undefined && req.url === commitPath,
    status => { diagnostic.count('commit-response-held'); diagnostic.status(status) },
  )
  const f = await fixture(t, {
    beforeCleanup() { requestDiagnostic?.beginCleanup(); held.release() },
    beforeHttpRequest(req,res) {
      if (held.intercept(req,res)) diagnostic.count('commit-request')
    },
  })
  f.page.on('pageerror', () => diagnostic.count('pageerror'))
  requestDiagnostic = observeFirstRequest(f.page, diagnostic, {signal: t.signal})
  t.after(() => requestDiagnostic.dispose())
  diagnostic.stage('open')
  await f.page.goto(f.origin + '/native-docx/?fileId=' + f.opened.file.fileId)
  const editor = f.page.locator('.tiptap.doc-page[contenteditable="true"]')
  diagnostic.stage('editor-ready')
  await editor.waitFor({ timeout: 45_000 })
  diagnostic.stage('type-first')
  await editor.click(); await f.page.keyboard.press('Control+End'); await f.page.keyboard.press('Enter'); await f.page.keyboard.type('Captured snapshot')
  commitPath = '/api/v1/files/' + f.opened.file.fileId + '/commits'
  const matchesCommit = request => request.method() === 'POST' && request.url() === f.origin + commitPath
  let firstRequest
  const watch = request => {
    if (!matchesCommit(request)) return
    firstRequest = request
    requestDiagnostic.watch(request)
    f.page.off('request',watch)
  }
  f.page.on('request',watch)
  t.after(() => f.page.off('request',watch))
  diagnostic.stage('first-save-key')
  await f.page.keyboard.press('Control+s')
  diagnostic.stage('first-commit-wait')
  assert.equal(await held.started,200)
  assert.ok(firstRequest)
  assert.equal(firstRequest.postDataJSON().baseRevision,f.opened.file.revision)
  diagnostic.stage('edit-newer')
  await editor.click(); await f.page.keyboard.press('Control+End'); await f.page.keyboard.press('Enter'); await f.page.keyboard.type('Newer unsaved draft')
  diagnostic.stage('read-first')
  const firstRef = await f.files.openFile(f.alice.token,f.opened.file.fileId)
  assert.notEqual(firstRef.file.revision,f.opened.file.revision)
  const firstZip = await JSZip.loadAsync(await f.files.readFile(f.alice.token,firstRef.file.fileId,firstRef.file.revision))
  const firstXml = await firstZip.file('word/document.xml').async('string')
  assert.ok(firstXml.includes('Captured snapshot'))
  assert.ok(!firstXml.includes('Newer unsaved draft'))
  // Wait for that exact response and check the native draft still remains
  // dirty after settlement before observing save two.
  const firstResponse = f.page.waitForResponse(reply => reply.request() === firstRequest && reply.status() === 200)
  diagnostic.stage('release')
  held.release()
  diagnostic.stage('first-response-wait')
  const releasedResponse = await firstResponse
  diagnostic.stage('first-response-finished')
  try {
    assert.equal(await requestDiagnostic.finished(releasedResponse),null)
  } catch (error) {
    // Chromium can report an abort for the held response after the editor has
    // consumed its receipt. Require that same receipt to settle the draft.
    if (firstRequest.failure()?.errorText !== 'net::ERR_ABORTED') throw error
    const state = f.page.locator('.dyoffice-docs-persistence-state')
    const acknowledged = await expect.poll(() => state.evaluate(element =>
      element.textContent === 'Unsaved' && element.getAttribute('data-native-save') === 'incomplete' &&
      (element.getAttribute('data-incomplete-reasons') ?? '').split(',').includes('document'),
    undefined,{ timeout: 500 }),{ timeout: 3000 }).toBe(true).then(() => true,() => false)
    console.error('first-native-save-receipt',JSON.stringify({acknowledged}))
    if (!acknowledged) throw error
  }
  diagnostic.stage('native-incomplete')
  await expect(f.page.locator('.dyoffice-docs-persistence-state')).toHaveAttribute('data-native-save','incomplete')
  diagnostic.stage('native-dirty')
  await expect(f.page.locator('.dyoffice-docs-persistence-state')).toHaveAttribute('data-dirty','true')
  diagnostic.stage('dirty-assert')
  await expect(f.page.locator('.dyoffice-docs-persistence-state')).toHaveText('Unsaved',{ timeout: 15_000 })
  await expect(f.page.locator('.dyoffice-docs-persistence-state')).toHaveAttribute('data-incomplete-reasons',/(^|,)document(,|$)/)
  await expect(editor).toContainText('Newer unsaved draft')
  diagnostic.stage('second-save-wait')
  const next = f.page.waitForResponse(reply => matchesCommit(reply.request()) && reply.request() !== firstRequest && reply.status() === 200)
  await f.page.keyboard.press('Control+s')
  const latestResponse = await next
  assert.equal(latestResponse.request().postDataJSON().baseRevision,firstRef.file.revision)
  diagnostic.stage('read-final')
  const current = await f.files.openFile(f.alice.token,f.opened.file.fileId)
  assert.notEqual(current.file.revision,firstRef.file.revision)
  const currentZip = await JSZip.loadAsync(await f.files.readFile(f.alice.token,current.file.fileId,current.file.revision))
  assert.ok((await currentZip.file('word/document.xml').async('string')).includes('Newer unsaved draft'))
  await expectCleanPersistence(f.page)
  diagnostic.stage('complete')
  } catch (error) { diagnostic.report(); throw error }
})

test('native editor preserves unsaved text and becomes read only after another tab takes over', { timeout: 120_000 },async t => {
  const f = await fixture(t), path = f.origin + '/native-docx/?fileId=' + f.opened.file.fileId
  await f.page.goto(path)
  const editor = f.page.locator('.tiptap.doc-page[contenteditable="true"]')
  await editor.waitFor({ timeout: 45_000 })
  await editor.click(); await f.page.keyboard.press('Control+End'); await f.page.keyboard.type('Unsaved first tab')
  const second = await f.context.newPage()
  await second.goto(path)
  await expect(second.getByRole('button',{ name: 'Take over editing' })).toBeVisible({ timeout: 45_000 })
  await expect(second.locator('.tiptap.doc-page')).toHaveAttribute('contenteditable','false')
  try {
  await second.getByRole('button',{ name: 'Take over editing' }).click()
  } catch(error) {
    const state=await second.evaluate(()=>{
      const button=document.querySelector('[data-takeover-blockers]')
      const allowed=new Set(['loading','no-handle','taking-over','downloading','dirty','local-busy','host-unknown','host-saving'])
      return {present:!!button,disabled:button instanceof HTMLButtonElement?button.disabled:null,blockers:(button?.getAttribute('data-takeover-blockers')??'').split(',').filter(value=>allowed.has(value))}
    }).catch(()=>({unavailable:true}))
    console.error('takeover-state',JSON.stringify(state))
    throw error
  }
  await expect(second.locator('.tiptap.doc-page')).toHaveAttribute('contenteditable','true')
  await f.page.bringToFront()
  await expect(f.page.locator('.tiptap.doc-page')).toHaveAttribute('contenteditable','false',{ timeout: 25_000 })
  await expect(f.page.locator('.tiptap.doc-page')).toContainText('Unsaved first tab')
  assert.equal((await f.files.openFile(f.alice.token,f.opened.file.fileId)).file.revision,f.opened.file.revision)
})

test('native lost-response warning keeps the draft until the original commit receipt is confirmed', { timeout: 120_000 },async t => {
  const f = await fixture(t)
  await withInputDiagnostics(f.page, async () => {
  await f.page.goto(f.origin + '/native-docx/?fileId=' + f.opened.file.fileId)
  const editor = f.page.locator('.tiptap.doc-page[contenteditable="true"]')
  await editor.waitFor({ timeout: 45_000 })
  await editor.click(); await f.page.keyboard.press('Control+End'); await f.page.keyboard.type('Lost response native draft')
  const commits = []; let drop = true
  await f.page.route('**/commits',async route => {
    commits.push(route.request().postDataJSON())
    if (!drop) return route.continue()
    drop = false
    await route.fetch(); await route.abort('failed')
  })
  await f.page.keyboard.press('Control+s')
  await expect(f.page.getByRole('button',{ name: 'Confirm save outcome' })).toBeVisible({ timeout: 15_000 })
  await expect(editor).toContainText('Lost response native draft')
  const current = await f.files.openFile(f.alice.token,f.opened.file.fileId)
  assert.notEqual(current.file.revision,f.opened.file.revision)
  await f.page.getByRole('button',{ name: 'Confirm save outcome' }).click()
  await expect(f.page.getByRole('button',{ name: 'Confirm save outcome' })).toHaveCount(0)
  assert.deepEqual(commits[1],commits[0])
  assert.equal((await f.files.openFile(f.alice.token,f.opened.file.fileId)).file.revision,current.file.revision)
  })
})

test('native Word preserves the unsaved draft through an offline save and reconnect, then retries a canceled download', {timeout:120_000},async t=>{
  let downloadPath,downloadResponse
  const interrupted=holdFirstResponseEnd(req=>req.method==='GET'&&req.url===downloadPath,()=>downloadResponse.flushHeaders())
  const f=await fixture(t,{
    beforeCleanup:interrupted.release,
    beforeHttpRequest(req,res){if(interrupted.intercept(req,res))downloadResponse=res},
  })
  const {fileId,revision}=f.opened.file
  const head=async()=>(await f.files.openFile(f.alice.token,fileId)).file.revision
  const marker='Draft saved after reconnect'
  await f.page.goto(f.origin+'/native-docx/?fileId='+fileId)
  const editor=f.page.locator('.tiptap.doc-page[contenteditable="true"]')
  const status=f.page.locator('.dyoffice-docs-persistence-state')
  await editor.click()
  await f.page.keyboard.press('Control+End')
  await f.page.keyboard.type(marker)
  await expect(status).toHaveAttribute('data-dirty','true')
  await f.context.setOffline(true)
  try{
    const failed=f.page.waitForEvent('requestfailed',{predicate:request=>request.method()==='POST'&&request.url().endsWith(`/files/${fileId}/uploads`),timeout:15000})
    await f.page.keyboard.press('Control+s')
    assert.match((await failed).failure()?.errorText??'',/ERR_INTERNET_DISCONNECTED/)
    await expect(status).toHaveAttribute('data-native-save','incomplete')
    await expect(status).toHaveAttribute('data-dirty','true')
    await expect(editor).toContainText(marker)
    assert.equal(await head(),revision)
  }finally{await f.context.setOffline(false)}
  const committed=f.page.waitForResponse(response=>response.url().endsWith(`/files/${fileId}/commits`)&&response.request().method()==='POST'&&response.ok(),{timeout:30000})
  await f.page.keyboard.press('Control+s')
  await committed
  await expectCleanPersistence(f.page)
  const savedRevision=await head()
  assert.notEqual(savedRevision,revision)
  assert.deepEqual(await f.files.readFile(f.alice.token,fileId,revision),f.original)
  downloadPath=`/api/v1/files/${fileId}/content?revision=${savedRevision}&download=1`
  const fileMenu=f.page.getByRole('button',{name:'File',exact:true})
  const downloadLink=f.page.getByRole('link',{name:'Download saved version',exact:true})
  await fileMenu.click()
  await expect(downloadLink).toHaveAttribute('href',downloadPath)
  const canceled=f.page.waitForEvent('download',{timeout:15000})
  await downloadLink.click()
  const first=await canceled
  assert.equal(await interrupted.started,200)
  await first.cancel()
  assert.equal(await first.failure(),'canceled')
  interrupted.release()
  await expectCleanPersistence(f.page)
  await f.page.keyboard.press('Escape')
  await fileMenu.click()
  const retried=f.page.waitForEvent('download',{timeout:15000})
  await downloadLink.click()
  const savedBytes=await f.files.readFile(f.alice.token,fileId,savedRevision)
  assert.deepEqual(await readFile(await (await retried).path()),savedBytes)
  assert.equal(await head(),savedRevision)
  await f.page.reload()
  await expect(f.page.locator('.tiptap.doc-page')).toContainText(marker,{timeout:45000})
})

// The total deadline covers database setup and three actual server processes.
test('actual server entry serves built native DOCX without a format flag and rejects invalid storage settings', { timeout: 60_000 },async t => {
  const { spawn,execFile } = await import('node:child_process')
  const { once } = await import('node:events'), { promisify } = await import('node:util')
  const f = await fileFixture(t), opened = await importFile(f,f.alice.token,await docxBytes())
  const cwd = fileURLToPath(new URL('../../',import.meta.url))
  const env = { ...process.env,NODE_ENV: 'development',DYOFFICE_AUTH_MODE: 'local',DYOFFICE_DATABASE_URL: '',DYOFFICE_AUTH_DATABASE_URL: f.urls.auth,DYOFFICE_BUSINESS_DATABASE_URL: f.urls.business,DYOFFICE_DEPLOYMENT_ID: f.deploymentId,DYOFFICE_ORIGIN: 'https://office.example',DYOFFICE_CSRF_KEY: f.csrfKey,DYOFFICE_USER_TOKEN: '',DYOFFICE_ADMIN_TOKEN: '',DYOFFICE_OBJECT_STORE: 'local-dev',DYOFFICE_OBJECT_DIRECTORY: f.directory,DYOFFICE_NATIVE_DOCX_DIRECTORY: '',PORT: '0',HOST: '127.0.0.1' }
  const child = spawn(process.execPath,['--import','tsx','server/index.mjs'],{ cwd,env,stdio: ['ignore','pipe','pipe'] })
  f.cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child,'exit') } })
  const exited = once(child,'exit')
  const [output] = await Promise.race([once(child.stdout,'data'),exited.then(() => { throw new Error('Native entry exited before startup') })])
  const address = String(output).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
  assert.ok(address)
  const path = address + '/native-docx/?fileId=' + opened.file.fileId, headers = { cookie: '__Host-dyoffice-session=' + f.alice.token }
  assert.equal((await fetch(path)).status,401)
  assert.equal((await fetch(path,{ headers })).status,200)
  assert.equal((await (await fetch(address + '/api/v1/capabilities',{ headers })).json()).docx,'editable')
  child.kill('SIGTERM'); assert.deepEqual(await exited,[0,null])
  for (const invalid of [{ DYOFFICE_OBJECT_STORE: 'invalid' },{ DYOFFICE_OBJECT_DIRECTORY: '' }]) {
    await assert.rejects(promisify(execFile)(process.execPath,['--import','tsx','server/index.mjs'],{ cwd,env: { ...env,...invalid },timeout: 10000 }),error => {
      assert.equal(error.code,1)
      assert.equal(error.stderr.includes(f.urls.auth),false)
      return true
    })
  }
})

test('page-color edits during a delayed native commit remain dirty and persist on the next save', { timeout: 120_000 },async t => {
  const f = await fixture(t)
  await f.page.goto(f.origin + '/native-docx/?fileId=' + f.opened.file.fileId)
  await f.page.locator('.tiptap.doc-page[contenteditable="true"]').waitFor({ timeout: 45_000 })
  let reached, release, first = true
  const started = new Promise(resolve => { reached = resolve }), gate = new Promise(resolve => { release = resolve })
  t.after(() => release())
  await f.page.route('**/commits',async route => {
    if (!first) return route.continue()
    first = false
    const response = await route.fetch()
    reached(); await gate; await route.fulfill({ response })
  })
  await f.page.keyboard.press('Control+s'); await started
  await f.page.getByRole('button',{ name: 'Design',exact: true }).click()
  await f.page.getByRole('button',{ name: 'Page Color',exact: true }).click()
  await f.page.getByRole('gridcell',{ name: 'Red',exact: true }).click()
  release()
  const persistence = f.page.locator('.dyoffice-docs-persistence-state')
  await expect(persistence).toHaveText('Unsaved')
  await expect(persistence).toHaveAttribute('data-native-save','incomplete')
  await expect(persistence).toHaveAttribute('data-dirty','true')
  await expect(persistence).toHaveAttribute('data-incomplete-reasons',/(^|,)metadata:pageColorDirty(,|$)/)
  await expect(f.page.locator('.doc-zoom').first()).toHaveCSS('--page-bg','#FF0000')
  const next = f.page.waitForResponse(reply => reply.url().endsWith('/commits') && reply.status() === 200)
  await f.page.keyboard.press('Control+s'); await next
  await expectCleanPersistence(f.page)
  const current = await f.files.openFile(f.alice.token,f.opened.file.fileId)
  const zip = await JSZip.loadAsync(await f.files.readFile(f.alice.token,current.file.fileId,current.file.revision))
  assert.match(await zip.file('word/document.xml').async('string'),/w:background[^>]*w:color="FF0000"/)
  await f.page.reload()
  await expect(f.page.locator('.doc-zoom').first()).toHaveCSS('--page-bg','#FF0000',{ timeout: 45_000 })
})

for (const theme of ['light', 'dark']) test(`Word saves and downloads the authored page color with the ${theme} UI theme`, { timeout: 120_000 }, async t => {
  const f = await fixture(t)
  await f.preferences.update(f.alice.token, { theme })
  await f.page.goto(f.origin + '/native-docx/?fileId=' + f.opened.file.fileId)
  await expect(f.page.locator('html')).toHaveAttribute('data-theme', theme)
  await f.page.locator('.tiptap.doc-page[contenteditable="true"]').waitFor({ timeout: 45_000 })
  await expectCleanPersistence(f.page)
  await f.page.getByRole('button', { name: 'Design', exact: true }).click()
  await f.page.getByRole('button', { name: 'Page Color', exact: true }).click()
  await f.page.getByRole('gridcell', { name: 'Red', exact: true }).click()
  await expect(f.page.locator('.doc-zoom').first()).toHaveCSS('--page-bg', '#FF0000')
  const persistence = f.page.locator('.dyoffice-docs-persistence-state')
  await expect(persistence).toHaveText('Unsaved')
  await expect(persistence).toHaveAttribute('data-dirty', 'true')
  assert.equal((await f.files.openFile(f.alice.token, f.opened.file.fileId)).file.revision, f.opened.file.revision)
  const committed = f.page.waitForResponse(reply => reply.url().endsWith('/commits') && reply.status() === 200)
  await f.page.keyboard.press('Control+s'); await committed
  await expectCleanPersistence(f.page)
  const current = await f.files.openFile(f.alice.token, f.opened.file.fileId)
  assert.notEqual(current.file.revision, f.opened.file.revision)
  const bytes = await f.files.readFile(f.alice.token, current.file.fileId, current.file.revision)
  await f.page.getByRole('button', { name: 'File', exact: true }).click()
  const [download] = await Promise.all([
    f.page.waitForEvent('download'),
    f.page.getByRole('link', { name: 'Download saved version', exact: true }).click(),
  ])
  const downloadedBytes = await readFile(await download.path())
  assert.deepEqual(downloadedBytes, bytes)
  const zip = await JSZip.loadAsync(downloadedBytes)
  assert.match(await zip.file('word/document.xml').async('string'), /w:background[^>]*w:color="FF0000"/)
  assert.equal(await zip.file('customXml/dyoffice-preserve.xml').async('string'), '<probe>Untouched custom part</probe>')
  await f.page.reload()
  await expect(f.page.locator('.doc-zoom').first()).toHaveCSS('--page-bg', '#FF0000', { timeout: 45_000 })
  await expectCleanPersistence(f.page)
})


test('Web Word sets a modify password independently of the open password',{timeout:90000},async t=>{
  const f=await fixture(t),{page}=f
  const {fileId,revision}=f.opened.file
  await page.goto(f.origin+'/native-docx/?fileId='+fileId)
  await expect(page.locator('.tiptap.doc-page[contenteditable="true"]').first()).toBeVisible({timeout:45000})
  await page.getByRole('button',{name:'Review',exact:true}).click()
  await page.getByRole('button',{name:'Protect Document',exact:true}).click()
  const dialog=page.locator('.protect-dialog')
  await expect(dialog).toBeVisible()
  const openPassword=dialog.locator('label.fld').filter({hasText:'Password to open this document'}).locator('input')
  await expect(openPassword).toBeVisible()
  await expect(openPassword).toHaveValue('')
  const modifyPassword=dialog.locator('.fld-row').filter({hasText:'Password to modify this document'})
  await modifyPassword.locator('label.fld').filter({hasText:'Password to modify this document'}).locator('input').fill('Synthetic Web protection')
  await modifyPassword.locator('label.fld').filter({hasText:'Confirm password'}).locator('input').fill('Synthetic Web protection')
  await dialog.getByRole('button',{name:'OK',exact:true}).click()
  await expect(dialog).toHaveCount(0)
  await page.keyboard.press('Control+s')
  const head=async()=>(await f.files.openFile(f.alice.token,fileId)).file.revision
  await expect.poll(head,{timeout:30000}).not.toBe(revision)
  assert.equal((await f.files.openFile(f.alice.token,fileId)).documentPasswordProtected,undefined)
  const saved=await JSZip.loadAsync(await f.files.readFile(f.alice.token,fileId,await head()))
  assert.match(await saved.file('word/settings.xml').async('string'),/<w:writeProtection\b/)
})

test('Ctrl+S names an untitled Word document from its first paragraph', {timeout:90000},async t=>{
 const f=await fixture(t),{page}=f
 const bytes=await readFile(new URL('../../../shell/build/shell-new/blank.docx',import.meta.url))
 const upload=await f.files.stageUpload(f.alice.token,{name:'未命名.docx',size:bytes.length,autoName:true})
 await f.files.receiveUpload(f.alice.token,upload.uploadId,bytes)
 const {file}=await f.files.finishUpload(f.alice.token,upload.uploadId)
 await page.goto(f.origin+'/native-docx/?fileId='+file.fileId)
 const editor=page.locator('.tiptap.doc-page[contenteditable="true"]').first()
 await editor.click({timeout:45000});await page.keyboard.insertText('Quarterly review')
 const dialogs=[]
 page.on('dialog',async dialog=>{dialogs.push(dialog.message());await dialog.dismiss()})
 assert.equal(await page.evaluate(()=>window.dyofficeEditorCanClose()),false)
 assert.match(dialogs.pop(),/未保存/)
 const rename=page.waitForRequest(r=>r.url().endsWith('/auto-name'))
 let resumeName
 const nameGate=new Promise(resolve=>{resumeName=resolve})
 await page.route('**/auto-name',async route=>{await nameGate;await route.continue()})
 await page.keyboard.press('Control+s')
 await rename
 try {
   await expect(page.locator('.dyoffice-docs-persistence-state')).toHaveAttribute('data-native-save','pending')
   await page.evaluate(()=>{
     window.closeAfterSave=window.dyofficeEditorCanClose()
   })
 } finally {resumeName()}
 assert.equal(await page.evaluate(()=>window.closeAfterSave),true)
 assert.deepEqual(dialogs,[])
 await expect.poll(async()=>(await f.files.openFile(f.alice.token,file.fileId)).name,{timeout:10000}).toBe('Quarterly review.docx')
 await expect(page.locator('.qa-btn.qa-name-with-ai')).toHaveCount(0)
 assert.equal(await page.evaluate(()=>window.dyofficeEditorDispose()),true)
})
