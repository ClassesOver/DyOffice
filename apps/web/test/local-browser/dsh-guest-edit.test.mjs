import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:https'
import {execFileSync} from 'node:child_process'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {officeBrowserAsset as dist} from '../helpers/office-browser-assets.mjs'
import {PDFDocument} from 'pdf-lib'
import {buildLocalApp} from '../../server/src/app.ts'
import {createCrossPlatformProcess} from '../../worker/src/sandbox/cross-platform-process.ts'
import {createXlsxNativeWorker} from '../../worker/src/native/xlsx.ts'
import {openIsolatedPptxSession} from '../../worker/src/native/pptx-session-host.ts'
import {sheetsGateway} from '../helpers/sheets-gateway.mjs'
import {chromium,expect} from '@playwright/test'
import {createAssistantChannelService} from '../../server/src/modules/assistant-channel/service.ts'
import {fileFixture,docxBytes,importFile} from '../helpers/files.mjs'

test('a signed-out browser edits and saves all four native formats with DSH tickets',{timeout:180000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'dyoffice-dsh-browser-'))
 let app,browser,server
 t.after(async()=>{
  await browser?.close()
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
  await app?.close()
  await rm(directory,{recursive:true,force:true})
 })
 const key=join(directory,'key.pem'),cert=join(directory,'cert.pem')
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost'],{stdio:'pipe'})
 server=createServer({key:await readFile(key),cert:await readFile(cert)},(req,res)=>app.routing(req,res))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const origin='https://127.0.0.1:'+server.address().port
 const f=await fileFixture(t,{origin,buildApp:false})
 const gateway=await sheetsGateway(t)
 const metadata=JSON.parse(await readFile(new URL('../../../../.dyoffice-native-build/host-manifest.json',import.meta.url),'utf8'))
 const sheetsNative=createXlsxNativeWorker(createCrossPlatformProcess({deploymentId:f.deploymentId,binary:metadata.nativeBinary,sha256:metadata.nativeSha256,allowedCommands:['open','read_range','read_formula_cells','read_row_outline','read_media','recalc_cells','save_archive','close']}))
 const slidesHost={openSession(input){return openIsolatedPptxSession({fileId:input.fileId,revision:input.revision,bytes:input.bytes},{timeoutMs:60000,unsafeTestOnly:true})}}
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,assistantChannels:true,
  nativeDocsDirectory:dist('docs'),nativeSheetsDirectory:dist('sheets'),nativeSlidesDirectory:dist('slides'),nativePdfDirectory:dist('pdf'),
  sheetsNative,sheetsPlanner:gateway.planWorkbookSave,sheetsPackageReader:gateway.readWorkbookPackage,slidesHost})
 const service=createAssistantChannelService({transactions:f.transactions,credentialKey:f.csrfKey})
 const pdf=await PDFDocument.create()
 pdf.addPage([400,300]).drawText('DSH guest PDF')
 const inputs={
  docx:await docxBytes(),
  xlsx:await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url)),
  pptx:await readFile(new URL('../fixtures/slides/acceptance.pptx',import.meta.url)),
  pdf:Buffer.from(await pdf.save()),
 }
 browser=await chromium.launch({headless:true})
 const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1100}})
 const page=await context.newPage()
 await page.addInitScript(()=>{window.__genofficeDebugHooks=true})
 page.on('response',response=>{if(response.status()>=400)t.diagnostic(response.status()+' '+new URL(response.url()).pathname)})
 const marker='DSH guest browser roundtrip'
 for(const [format,bytes] of Object.entries(inputs))await t.test(format,async()=>{
  const {file}=await importFile(f,f.alice.token,bytes,'guest.'+format)
  const {conversationId}=await service.createConversation(f.alice.token,{fileId:file.fileId})
  const {memberToken}=await service.issueDshToken(f.alice.token,conversationId,60,false,true)
  const {ticket}=await service.issueEditTicket(memberToken,file.fileId,undefined)
  await page.goto(origin+'/dsh-edit#'+ticket)
  await page.waitForURL(url=>url.pathname==='/native-'+format+'/')
  const committed=()=>page.waitForResponse(response=>new URL(response.url()).pathname==='/api/v1/files/'+file.fileId+'/commits'&&response.status()===200)
  if(format==='docx'){
   const editor=page.locator('.tiptap.doc-page[contenteditable="true"]').first()
   await expect(editor).toBeVisible({timeout:30000})
   await editor.click()
   await page.keyboard.press('Control+End')
   await page.keyboard.press('Enter')
   await page.keyboard.type(marker)
   await Promise.all([committed(),page.keyboard.press('Control+s')])
   await page.reload()
   await expect(page.locator('.tiptap.doc-page').filter({hasText:marker}).first()).toBeVisible()
  }else if(format==='xlsx'){
   await expect.poll(()=>page.evaluate(()=>!!window.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getActiveSheet()),{timeout:30000}).toBe(true)
   const outcome=await page.evaluate(text=>{const {applyOps,univerAPI}=window.__genofficeDebug;return applyOps([{op:'set_cell',sheetId:univerAPI.getActiveWorkbook().getActiveSheet().getSheetId(),address:'A1',value:text}])},marker)
   assert.equal(outcome.ok,true)
   await Promise.all([committed(),page.keyboard.press('Control+s')])
   await page.reload()
   await expect.poll(()=>page.evaluate(()=>window.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange('A1').getValue())).toBe(marker)
  }else if(format==='pptx'){
   await expect.poll(async()=>await page.evaluate(async()=>{try{return (await window.slidesApi?.getRenderSlides())?.length??0}catch{return 0}}),{timeout:30000}).toBeGreaterThan(0)
   await page.evaluate(async value=>{await window.slidesApi.setNotes({slideIndex:0,text:value});if(!(await window.slidesApi.save()).ok)throw Error('PPTX save failed')},marker)
   await expect.poll(()=>page.evaluate(()=>window.slidesApi.getNotes(0))).toBe(marker)
  }else{
   await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready',{timeout:30000})
   await page.getByRole('button',{name:'页面',exact:true}).click()
   await page.getByRole('button',{name:/向右旋转|顺时针旋转/}).first().click()
   await Promise.all([committed(),page.keyboard.press('Control+s')])
  }
  const current=await f.files.openFile(f.alice.token,file.fileId)
  assert.notEqual(current.file.revision,file.revision)
  if(format==='pdf'){
   const saved=await PDFDocument.load(await f.files.readFile(f.alice.token,file.fileId,current.file.revision))
   assert.equal(saved.getPage(0).getRotation().angle,90)
  }
  assert.equal((await context.cookies()).some(cookie=>cookie.name==='__Host-dyoffice-session'),false)
 })
})
