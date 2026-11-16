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

// Diagnostic only: no production hooks, no artificial engine delay, no mocked writes.
// Same-turn mode is a scheduling stress probe; the ordinary UI mode separately
// represents consecutive user actions without waiting for formula settlement.
for(const mode of ['unchanged-control','ui-next-action','same-turn-handler']){
 test(`diagnostic named range immediate native save/reopen: ${mode}`,{timeout:90000},async t=>{
  const f=await fixture(t),id=f.opened.file.fileId
  await f.page.goto(f.origin+'/native-xlsx/?fileId='+id)
  const value=()=>f.page.evaluate(()=>window.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange('F2').getValue())
  await expect.poll(value,{timeout:30000}).toBe(20)
  // Independent literal edit makes Save genuinely enabled even before changing
  // a name; avoids manufacturing a click on a disabled button in same-turn mode.
  await f.page.evaluate(()=>window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange('G20').setValue('synthetic diagnostic marker'))
  const save=f.page.locator('.qa-btn').first();await expect(save).toBeEnabled()
  let timing
  if(mode==='unchanged-control')await save.click()
  else{
   await f.page.getByRole('button',{name:'Formulas',exact:true}).click()
   await f.page.getByRole('button',{name:/Name Manager/}).click()
   const dialog=f.page.getByRole('dialog',{name:'Name Manager',exact:true})
   await expect(dialog).toBeVisible();await dialog.getByRole('cell',{name:'Revenue',exact:true}).click()
   await dialog.getByPlaceholder('=Sheet1!$A$1:$B$9').fill('=Acceptance!$A$2')
   if(mode==='ui-next-action'){
    await dialog.getByRole('button',{name:'Update',exact:true}).click()
    await dialog.getByRole('button',{name:'Close',exact:true}).click()
    // Deliberately no formula poll/delay between Update and Save.
    await save.click()
   }else{
    timing=await f.page.evaluate(()=>{
     const wb=window.__genofficeDebug.univerAPI.getActiveWorkbook(),cell=wb.getActiveSheet().getRange('F2'),before=cell.getValue(),start=performance.now()
     const dialog=[...document.querySelectorAll('[role="dialog"]')].find(e=>e.textContent.includes('Name Manager'))
     const button=label=>[...dialog.querySelectorAll('button')].find(b=>b.textContent.trim()===label)
     button('Update').click();const afterUpdate=cell.getValue();button('Close').click()
     const save=document.querySelector('.qa-btn');if(save.disabled)throw new Error('Diagnostic save button disabled')
     save.click();return{before,afterUpdate,afterSaveClick:cell.getValue(),dispatchElapsedMs:performance.now()-start}
    })
   }
  }
  await expect.poll(async()=>(await f.files.openFile(f.alice.token,id)).file.revision,{timeout:30000}).not.toBe(f.opened.file.revision)
  const originalZip=await JSZip.loadAsync(f.original)
  const originalSheet=await originalZip.file('xl/worksheets/sheet1.xml').async('string')
  const originalF2=originalSheet.match(/<c\b[^>]*\br="F2"[^>]*>[\s\S]*?<\/c>/)?.[0]??null
  const saved=(await f.files.openFile(f.alice.token,id)).file
  const zip=await JSZip.loadAsync(await f.files.readFile(f.alice.token,id,saved.revision))
  const sheet=await zip.file('xl/worksheets/sheet1.xml').async('string'),book=await zip.file('xl/workbook.xml').async('string')
  const cell=sheet.match(/<c\b[^>]*\br="F2"[^>]*>[\s\S]*?<\/c>/)?.[0]
  const cache=cell?.match(/<v>([^<]*)<\/v>/)?.[1]??null,formula=cell?.match(/<f[^>]*>([^<]*)<\/f>/)?.[1]??null
  const definition=book.match(/<definedName\b[^>]*\bname="Revenue"[^>]*>([^<]*)<\/definedName>/)?.[1]??null
  const calculationProperties=book.match(/<calcPr\b[^>]*\/?\s*>/)?.[0]??null
  await f.page.reload()
  const expected=mode==='unchanged-control'?20:12.5
  let reopenedMatches=true
  try{await expect.poll(value,{timeout:30000}).toBe(expected)}catch{reopenedMatches=false}
  const reopened=await value()
  console.log('NAME_SAVE_DIAGNOSTIC '+JSON.stringify({mode,timing,originalF2,savedCache:cache,formula,definition,calculationProperties,reopened,reopenedMatches,expected}))
  assert.equal(formula,'SUM(Revenue)')
  assert.equal(definition,mode==='unchanged-control'?'Acceptance!$A$2:$A$3':'Acceptance!$A$2')
  assert.equal(Number(cache),expected,'Diagnostic: saved XLSX cached value must match the new named range')
  assert.equal(reopenedMatches,true,'Native browser reopen must converge to the same value')
 })
}
