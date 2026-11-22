import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect } from '@playwright/test'
import { launchTestBrowser } from '../helpers/browser.mjs'
import { fileFixture, importFile } from '../helpers/files.mjs'
import { password } from '../helpers/identity.mjs'
import { officeBrowserAsset } from '../helpers/office-browser-assets.mjs'
import { buildLocalApp } from '../../server/src/app.ts'
import { configuredSheetsRuntime } from '../../server/src/modules/sheets/runtime.ts'
import { openIsolatedPptxSession } from '../../worker/src/native/pptx-session-host.ts'

const built = Boolean(process.env.DYOFFICE_TEST_NATIVE_DOCS_DIST && process.env.DYOFFICE_TEST_SHEETS_DIST && process.env.DYOFFICE_TEST_SLIDES_DIST)

test('native Office editors render signed packages read only and download exact originals', {skip:!built,timeout:150000}, async t => {
  const origin='http://localhost:4476', f=await fileFixture(t,{origin,buildApp:false})
  await f.preferences.update(f.alice.token,{language:'en',autoSave:false,showAssistant:false})
  const gateway=fileURLToPath(new URL('../../dist-sheets-server/',import.meta.url))
  const sheets=await configuredSheetsRuntime({
    DYOFFICE_AUTH_MODE:'local',DYOFFICE_SANDBOX_MODE:'subprocess',DYOFFICE_DEPLOYMENT_ID:f.deploymentId,
    DYOFFICE_XLSX_NODE_ENGINE:join(gateway,'xlsx-node-engine.mjs'),DYOFFICE_XLSX_GATEWAY_RUNNER:join(gateway,'gateway-process.mjs'),
    DYOFFICE_NATIVE_XLSX_DIRECTORY:officeBrowserAsset('sheets'),
  },{enabled:true})
  f.cleanup.unshift(()=>sheets.close())
  const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,
    csrfKey:f.csrfKey,objectStore:f.objects,localShellDirectory:officeBrowserAsset('local-shell'),nativeDocsDirectory:officeBrowserAsset('docs'),
    nativeSlidesDirectory:officeBrowserAsset('slides'),slidesHost:{openSession:input=>openIsolatedPptxSession(input,{timeoutMs:60000,unsafeTestOnly:true})},...sheets})
  f.cleanup.unshift(()=>app.close())
  await app.listen({port:4476,host:'127.0.0.1'})
  const browser=await launchTestBrowser()
  f.cleanup.unshift(()=>browser.close())
  const page=await browser.newPage({viewport:{width:1440,height:1050}})
  await page.goto(origin)
  await page.getByLabel('用户名',{exact:true}).fill('alice')
  await page.getByLabel('密码',{exact:true}).fill(password)
  await page.getByRole('button',{name:'登录',exact:true}).click()
  await expect(page.locator('.home')).toBeVisible()
  for(const format of ['docx','xlsx','pptx']){
    const bytes=await readFile(new URL(`../fixtures/signed-office/hello-world-signed.${format}`,import.meta.url))
    const {file}=await importFile(f,f.alice.token,bytes,`signed.${format}`)
    await page.goto(`${origin}/native-${format}/?fileId=${file.fileId}`)
    await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready',{timeout:30000})
    const notice=page.locator('.document-notification').getByText('Signed file opened read only',{exact:true})
    if(!await notice.isVisible()){
      const notifications=page.getByRole('button',{name:/^Notifications \(/})
      if(await notifications.getAttribute('aria-expanded')==='true')await notifications.click()
      await notifications.click()
    }
    await expect(notice).toBeVisible()
    await expect(page.getByRole('button',{name:'Take over editing',exact:true})).toHaveCount(0)
    if(format==='docx'){
      const editor=page.locator('.tiptap.doc-page').first()
      await expect(editor).toHaveAttribute('contenteditable','false')
      await editor.click()
      await page.keyboard.type('This edit must be blocked')
      await expect(editor).not.toContainText('This edit must be blocked')
    }
    if(format==='pptx')await expect(page.locator('.thumb.active')).toHaveCount(1)
    await page.getByRole('button',{name:'File',exact:true}).click()
    await expect(page.locator('.file-menu').getByRole('button',{name:'Save and download',exact:true})).toBeDisabled()
    const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('link',{name:'Download saved version',exact:true}).click()])
    assert.deepEqual(await readFile(await download.path()),bytes)
    assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
  }
})
