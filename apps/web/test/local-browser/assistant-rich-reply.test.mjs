import test from 'node:test'
import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {PDFDocument} from 'pdf-lib'
import {expect} from '@playwright/test'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {stubHomeHero} from '../helpers/home-hero.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'

const nativePdfDirectory=process.env.DYOFFICE_TEST_NATIVE_PDF_DIST

test('native PDF assistant keeps wide tables and code inside their own scroll areas',{skip:!nativePdfDirectory,timeout:90000},async t=>{
 let app,browser
 t.after(async()=>{await browser?.close();app?.server.closeAllConnections();await app?.close()})
 const origin='http://127.0.0.1:4257',f=await fileFixture(t,{origin,buildApp:false})
 const keyring={activeKeyId:'rich',keys:{rich:new Uint8Array(32).fill(47)}}
 const revision='saved_revision_'.repeat(12)
 const content='# Review summary\n\nReview complete\n\nUse `reviewer_id` to match this record.\n\n## Checked fields\n\n- Reviewer is present\n- Saved version is recorded\n\n| Field | Value |\n| --- | --- |\n| Reviewer | Alice |\n| Source | '+revision+' |\n\n```json\n'+JSON.stringify({reviewer:'Alice',revision})+'\n```'
 mockProviderNetwork(t,()=>Readable.from([Buffer.from(`data: ${JSON.stringify({choices:[{delta:{content}}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`)]))
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[{id:'chat',kind:'chat',providerId:'deepseek',label:'Test model',model:'synthetic',baseUrl:'https://provider.example/v1/chat/completions',enabled:true,apiKey:'synthetic-key'}],defaults:{chat:'chat'}})
 const pdf=await PDFDocument.create();pdf.addPage([400,300]).drawText('Rich reply layout')
 const source=(await importFile(f,f.alice.token,Buffer.from(await pdf.save()),'rich.pdf')).file
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false,nativePdfDirectory,localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 await app.listen({host:'127.0.0.1',port:4257});browser=await launchTestBrowser()
 const page=await browser.newPage({viewport:{width:1440,height:1000}})
 await stubHomeHero(page)
 await page.goto(origin);await page.getByLabel('用户名',{exact:true}).fill('alice');await page.getByLabel('密码',{exact:true}).fill(password)
 await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('.home')).toBeVisible()
 await page.goto(origin+'/?entry=rich-reply#/file/'+source.fileId)
 const frame=page.locator('iframe.workspace-document-frame')
 await expect(frame).toHaveAttribute('src','/native-pdf/?fileId='+source.fileId)
 const editor=frame.contentFrame()
 await expect(editor.locator('html')).toHaveAttribute('data-document-loading','ready')
 await editor.getByRole('button',{name:'AI 助手',exact:true}).click()
 const assistant=editor.locator('.shared-editor-assistant')
 await assistant.getByRole('textbox',{name:'消息',exact:true}).fill('展示核对结果')
 await assistant.getByRole('button',{name:'发送',exact:true}).click()
 await expect(assistant.getByText('Review complete',{exact:true})).toBeVisible({timeout:30000})
 await mkdir('test-results/office-dock-unified',{recursive:true})
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000})
  for(const theme of ['light','dark']){
   await editor.locator('html').evaluate((root,theme)=>root.dataset.theme=theme,theme)
   await assistant.scrollIntoViewIfNeeded()
   const table=assistant.locator('.ai-md-table-wrap'),code=assistant.locator('.ai-md-pre')
   await expect(table).toBeVisible();await expect(code).toBeVisible()
   await expect(assistant.locator('.ai-md-h1')).toHaveText('Review summary')
   await expect(assistant.locator('.ai-md-h2')).toHaveText('Checked fields')
   await expect(assistant.locator('.ai-md p code')).toHaveText('reviewer_id')
   assert.ok(await assistant.locator('.ai-chat').evaluate(node=>node.scrollWidth<=node.clientWidth+1),'rich replies do not widen the conversation')
   for(const block of [table,code])assert.ok(await block.evaluate(node=>node.scrollWidth>node.clientWidth),'wide content scrolls within its block')
   assert.ok(await table.locator('th').first().evaluate(node=>node.getBoundingClientRect().width>=50),'table headings retain readable column widths')
   await assistant.locator('.ai-chat').evaluate(node=>node.scrollTop=0)
   await assistant.screenshot({path:`test-results/office-dock-unified/pdf-rich-reply-${width}-${theme}.png`,animations:'disabled'})
  }
 }
 assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,source.revision)
})
