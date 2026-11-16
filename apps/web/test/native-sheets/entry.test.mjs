import {sandboxFixture} from '../helpers/native-sandbox.mjs'
import {sheetsGateway} from '../helpers/sheets-gateway.mjs'
import {createXlsxNativeWorker} from '../../worker/src/native/xlsx.ts'
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
import { fileFixture, docxBytes, importFile } from '../helpers/files.mjs'
import { password } from '../helpers/identity.mjs'

const sheetsDirectory = fileURLToPath(new URL('../../dist-sheets/',import.meta.url))
async function fixture(t) {
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
  const {planWorkbookSave,readWorkbookPackage}=await sheetsGateway(t)
  const native=createXlsxNativeWorker(await sandboxFixture('native'))
  f = await fileFixture(t,{ origin,nativeSheetsDirectory: sheetsDirectory,sheetsNative:native,sheetsPlanner:planWorkbookSave,sheetsPackageReader:readWorkbookPackage })
  await f.preferences.update(f.alice.token,{ language: 'en',autoSave: false,showAssistant: false })
  const original = await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url)), opened = await importFile(f,f.alice.token,original,'acceptance.xlsx')
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ ignoreHTTPSErrors: true,viewport: { width: 1440,height: 1100 } }), page = await context.newPage()
  const errors=[]
  page.on('pageerror',error=>errors.push(error.message))
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text().slice(0,1000))})
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
  return { ...f, original, opened, browser, context, page, origin, errors }
}

test('native Sheets edits, saves and reopens the hashed acceptance workbook through original Univer',{timeout:90000},async t=>{
 const f=await fixture(t)
 const response=await f.page.goto(f.origin+'/native-xlsx/?fileId='+f.opened.file.fileId)
 assert.equal(response.status(),200,'Native Sheets entry must exist and authorize the owned workbook')
 await f.page.locator('#univer-container canvas').first().waitFor({timeout:45000})
 await expect(f.page.locator('.dyoffice-sheets-state')).toContainText('Editing')
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
 // Wait for the dependent formula to settle before saving: the save payload
 // reads live formula cache values, so clicking during the async recalc
 // window would persist the stale cached 25 and fail the 42.5 assertion.
 await expect.poll(()=>f.page.evaluate(()=>window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange('B2').getValue()),{timeout:30000}).toBe(42.5)
 const save=f.page.locator('.qa-btn').first()
 await expect(save).toBeEnabled()
 await save.click()
 await expect.poll(async()=>(await f.files.openFile(f.alice.token,f.opened.file.fileId)).file.revision,{timeout:30000}).not.toBe(f.opened.file.revision)
 const saved=await f.files.openFile(f.alice.token,f.opened.file.fileId)
 const bytes=await f.files.readFile(f.alice.token,saved.file.fileId,saved.file.revision)
 const before=await JSZip.loadAsync(f.original),after=await JSZip.loadAsync(bytes)
 assert.deepEqual(await before.file('customXml/t09-preserve.xml').async('nodebuffer'),await after.file('customXml/t09-preserve.xml').async('nodebuffer'))
 const savedXml=await after.file('xl/worksheets/sheet1.xml').async('string')
 assert.match(savedXml,/<v>21\.25<\/v>/)
 assert.match(savedXml,/<c[^>]*r="B2"[^>]*>[\s\S]*?<f[^>]*>A2\*2<\/f>[\s\S]*?<v>42\.5<\/v>/)
 assert.match(await after.file('xl/workbook.xml').async('string'),/name="Revenue"/)
 assert.deepEqual(await before.file('xl/charts/chart1.xml').async('nodebuffer'),await after.file('xl/charts/chart1.xml').async('nodebuffer'))
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

test('chart format pane edits title and persists it through native save',{timeout:90000},async t=>{
 const f=await fixture(t),fileId=f.opened.file.fileId
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
 await expect(second.locator('.dyoffice-sheets-state')).toContainText('Read only',{timeout:30000})
 await expect.poll(()=>second.evaluate(()=>window.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange('A2').getValue()),{timeout:30000}).toBe(12.5)
 const stillReadOnly=await second.evaluate(async()=>{const r=window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange('A2');try{await r.setValue(77)}catch{}return r.getValue()})
 assert.equal(stillReadOnly,12.5,'readonly user command must not overwrite imported cells')
 const rejected=await second.evaluate(()=>{const d=window.__genofficeDebug,s=d.univerAPI.getActiveWorkbook().getActiveSheet().getSheetId();return d.applyOps([{op:'set_cell',sheetId:s,address:'A2',value:99}])})
 assert.equal(rejected.ok,false)
 assert.equal((await f.files.openFile(f.alice.token,id)).file.revision,f.opened.file.revision)
 await second.getByRole('button',{name:'Take over editing',exact:true}).click()
 await expect(second.locator('.dyoffice-sheets-state')).toContainText('Editing')
 await second.evaluate(()=>window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange('A2').setValue(99))
 await expect(second.locator('.qa-btn').first()).toBeEnabled();await second.locator('.qa-btn').first().click()
 await expect.poll(async()=>(await f.files.openFile(f.alice.token,id)).file.revision,{timeout:15000}).not.toBe(f.opened.file.revision)
 await expect(f.page.locator('.dyoffice-sheets-state')).toContainText('Editing permission expired',{timeout:20000})
})
