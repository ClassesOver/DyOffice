import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {Readable} from 'node:stream'
import {expect} from '@playwright/test'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {syncFileAssistantChat} from '../../server/src/modules/files/assistant-chat.ts'
import {createXlsxNativeWorker} from '../../worker/src/native/xlsx.ts'
import {openIsolatedPptxSession} from '../../worker/src/native/pptx-session-host.ts'
import {createCrossPlatformProcess} from '../../worker/src/sandbox/cross-platform-process.ts'
import {password} from '../helpers/identity.mjs'
import {stubHomeHero} from '../helpers/home-hero.mjs'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {docxBytes,fileFixture,importFile} from '../helpers/files.mjs'
import {officeBrowserAsset as dist} from '../helpers/office-browser-assets.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {sheetsGateway} from '../helpers/sheets-gateway.mjs'

test('Word, Sheets and Slides can start a fresh chat after restoring file history',{timeout:120000},async t=>{
 const origin='http://127.0.0.1:43691',f=await fileFixture(t,{origin,buildApp:false})
 const keyring={activeKeyId:'fixture',keys:{fixture:new Uint8Array(32).fill(42)}}
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[
  {id:'fixture',kind:'chat',providerId:'openai',label:'Test model',model:'synthetic',baseUrl:'https://provider.example/v1/chat/completions',enabled:true,apiKey:'fixture-key'},
 ],defaults:{chat:'fixture'}})
 await f.preferences.update(f.alice.token,{language:'zh',showAssistant:true,autoSave:false})
 const gateway=await sheetsGateway(t)
 const manifest=JSON.parse(await readFile(process.env.DYOFFICE_TEST_HOST_MANIFEST??new URL('../../../../.dyoffice-native-build/host-manifest.json',import.meta.url),'utf8'))
 const sheetsNative=createXlsxNativeWorker(createCrossPlatformProcess({deploymentId:f.deploymentId,binary:manifest.nativeBinary,sha256:manifest.nativeSha256,
  allowedCommands:['open','read_range','read_formula_cells','read_row_outline','read_media','recalc_cells','save_archive','close']}))
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,
  globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false,rateLimit:{max:5000,windowMs:60000},
  nativeDocsDirectory:dist('docs'),nativeSheetsDirectory:dist('sheets'),nativeSlidesDirectory:dist('slides'),localShellDirectory:dist('local-shell'),
  slidesHost:{openSession(input){return openIsolatedPptxSession(input,{timeoutMs:60000,unsafeTestOnly:true})}},
  sheetsNative,sheetsPlanner:gateway.planWorkbookSave,sheetsPackageReader:gateway.readWorkbookPackage})
 f.cleanup.unshift(()=>app.close())
 await app.listen({host:'127.0.0.1',port:43691})
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const report='## FRESH-REPLY\n\n| 指标 | 同比 |\n|---|---|\n| 收入 | **+13.5%** |\n\n1. **[查看明细](sheetnav://B12)**'
 const observed=[]
 const provider=mockProviderNetwork(t,()=>{
  observed.push(JSON.parse(provider.wire.toString()).messages)
  return Readable.from([Buffer.from('data: '+JSON.stringify({choices:[{delta:{content:report},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n')])
 })
 const page=await browser.newPage({viewport:{width:1440,height:1000}})
 await page.addInitScript(()=>{window.__genofficeDebugHooks=true})
 await stubHomeHero(page)
 await page.goto(origin)
 await page.getByLabel('用户名',{exact:true}).fill('alice')
 await page.getByLabel('密码',{exact:true}).fill(password)
 await page.getByRole('button',{name:'登录',exact:true}).click()
 await expect(page.locator('.home')).toBeVisible()
 for(const [format,bytes] of [['docx',await docxBytes()],['xlsx',await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url))],['pptx',await readFile(new URL('../fixtures/slides/acceptance.pptx',import.meta.url))]]){
  await t.test(format,async()=>{
   const {file}=await importFile(f,f.alice.token,bytes,'new-chat.'+format)
   await page.goto(origin+'/native-'+format+'/?fileId='+file.fileId)
   await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready',{timeout:30000})
   const rail=page.locator(format==='xlsx'?'.expand-copilot':'.ai-rail').first()
   if(await rail.isVisible())await rail.click()
   const panel=page.locator(format==='xlsx'?'.copilot:not(.collapsed)':'.ai-panel')
   const composer=panel.locator('textarea'),reset=panel.getByRole('button',{name:'新对话',exact:true})
   await expect(composer).toBeVisible();await expect(reset).toHaveCount(0)
   const turnId=randomUUID()
   const history=updates=>syncFileAssistantChat(f.transactions,f.alice.token,file.fileId,{updates})
   await history([{turnId,role:'user',state:'done',seq:0,text:'OLD-QUESTION'},{turnId,role:'assistant',state:'done',seq:1,text:'OLD-REPLY'}])
   await expect(panel.getByText('OLD-REPLY',{exact:true})).toBeVisible()
   await composer.fill('FRESH-QUESTION-'+format)
   await reset.click({timeout:5000})
   await expect(reset).toHaveCount(0)
   await expect(panel.getByText('OLD-REPLY',{exact:true})).toHaveCount(0)
   await expect(composer).toHaveValue('FRESH-QUESTION-'+format)
   const count=observed.length
   await panel.getByRole('button',{name:'发送',exact:true}).click()
   await expect(panel.getByText('FRESH-REPLY',{exact:true})).toBeVisible({timeout:15000})
   assert.equal(observed.length,count+1)
   assert.match(JSON.stringify(observed.at(-1)),new RegExp('FRESH-QUESTION-'+format))
   assert.doesNotMatch(JSON.stringify(observed.at(-1)),/OLD-QUESTION|OLD-REPLY/)
   await expect(reset).toBeVisible()
   await expect.poll(async()=>(await history([])).messages.map(m=>m.text)).toEqual(['OLD-QUESTION','OLD-REPLY','FRESH-QUESTION-'+format,report])
   await page.reload()
   await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready',{timeout:30000})
   if(await rail.isVisible())await rail.click()
   const restored=panel.locator('.ai-msg-assistant').filter({hasText:'FRESH-REPLY'})
   await expect(restored.locator('.ai-md-h2')).toHaveText('FRESH-REPLY')
   await expect(restored.locator('table td strong')).toHaveText('+13.5%')
   await expect(restored.locator('ol li')).toHaveCount(1)
   if(format==='xlsx'){
    await restored.getByRole('link',{name:'查看明细'}).click()
    await expect.poll(()=>page.evaluate(()=>{const range=window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveRange();return [range.getRow(),range.getColumn()]})).toEqual([11,1])
   }
   assert.equal(observed.length,count+1,'restoring a reply does not call the model again')
   assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
  })
 }
})
