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
import { fileFixture, docxBytes, importFile } from '../helpers/files.mjs'
import { password } from '../helpers/identity.mjs'
import {buildSheetsGateway} from '../../server/sheets/build.mjs'
import {configuredSheetsRuntime} from '../../server/src/modules/sheets/runtime.ts'
import {sheetsSaveRequest} from '../helpers/sheets-request.mjs'

const sheetsDirectory = process.env.DYOFFICE_TEST_SHEETS_DIRECTORY ?? fileURLToPath(new URL('../../dist-sheets/',import.meta.url))
async function fixture(t,{nodeEngine=false}={}) {
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
  f = await fileFixture(t,{ origin,nativeSheetsDirectory: sheetsDirectory,sheetsNative:native,sheetsPlanner:planner,sheetsPackageReader:readWorkbookPackage })
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
