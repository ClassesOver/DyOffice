import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createServer} from 'node:https'
import {fileURLToPath} from 'node:url'
import {expect} from '@playwright/test'
import JSZip from 'jszip'
import {imageSizeFromBytes} from '@genoffice/pptx-render'
import {buildLocalApp} from '../../server/src/app.ts'
import {openIsolatedPptxSession} from '../../worker/src/native/pptx-session-host.ts'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'

test('PPTX File menu downloads PNG and JPEG archives of visible slides without committing', {timeout:90000}, async t => {
  const directory = await mkdtemp(join(tmpdir(),'dyoffice-slide-image-export-'))
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(directory,'key.pem'),'-out',join(directory,'cert.pem'),'-days','1','-subj','/CN=localhost'],{stdio:'pipe'})
  let app,browser
  const server = createServer({key:await readFile(join(directory,'key.pem')),cert:await readFile(join(directory,'cert.pem'))},(req,res)=>app.routing(req,res))
  t.after(async()=>{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app?.close();await rm(directory,{recursive:true,force:true})})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const origin = 'https://127.0.0.1:'+server.address().port
  const f = await fileFixture(t,{origin,buildApp:false})
  await f.preferences.update(f.alice.token,{language:'en',autoSave:false})
  const zip = await JSZip.loadAsync(await readFile(new URL('../fixtures/slides/acceptance.pptx',import.meta.url)))
  const second = 'ppt/slides/slide2.xml'
  zip.file(second,(await zip.file(second).async('string')).replace(/<p:sld(?=\s)/,'<p:sld show="0"'))
  const original = await zip.generateAsync({type:'nodebuffer'})
  const initial = (await importFile(f,f.alice.token,original,'Quarterly deck.pptx')).file
  const slidesHost = {openSession(input){return openIsolatedPptxSession(input,{unsafeTestOnly:true,timeoutMs:60000})}}
  app = await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,slidesHost,nativeSlidesDirectory:process.env.DYOFFICE_TEST_SLIDES_DIST??fileURLToPath(new URL('../../dist-slides/',import.meta.url))})
  browser = await launchTestBrowser()
  const context = await browser.newContext({acceptDownloads:true,ignoreHTTPSErrors:true})
  const page = await context.newPage()
  const csrf = await (await context.request.get(origin+'/api/v1/auth/csrf')).json()
  assert.equal((await context.request.post(origin+'/api/v1/auth/login',{headers:{origin,'x-csrf-token':csrf.csrfToken},data:{username:'alice',password}})).status(),200)
  await page.goto(origin+'/native-pptx/?fileId='+initial.fileId)
  await expect(page.locator('.app-main')).toBeVisible({timeout:45000})
  await expect.poll(()=>page.evaluate(async()=> (await window.slidesApi?.getRenderSlides())?.length ?? 0),{timeout:30000}).toBe(2)
  const visible = await page.evaluate(async()=>{
    const slides = await window.slidesApi.getRenderSlides()
    return slides.filter(slide=>!slide.hidden).map(({widthPx,heightPx})=>({widthPx,heightPx}))
  })
  assert.equal(visible.length,1,'fixture must have one visible and one hidden slide')

  for (const format of ['png','jpg']) {
    await page.locator('.ribbon-tab-file').click()
    const [download] = await Promise.all([
      page.waitForEvent('download',{timeout:12000}),
      page.getByRole('button',{name:new RegExp('^Export as '+format.toUpperCase())}).click(),
    ])
    assert.equal(download.suggestedFilename(),'Quarterly deck-'+format+'.zip')
    const images = await JSZip.loadAsync(await readFile(await download.path()))
    const name = 'Quarterly deck-01.'+format
    assert.deepEqual(Object.keys(images.files),[name])
    const payload = await images.file(name).async('uint8array')
    assert.equal(payload[0],format==='png'?0x89:0xff)
    const size = imageSizeFromBytes(payload)
    assert.equal(size.w,Math.round(visible[0].widthPx*2))
    assert.equal(size.h,Math.round(visible[0].heightPx*2))
  }
  assert.equal((await f.files.openFile(f.alice.token,initial.fileId)).file.revision,initial.revision)
  assert.deepEqual(await f.files.readFile(f.alice.token,initial.fileId,initial.revision),original)
})
