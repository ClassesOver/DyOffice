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
import {hashProtectionPassword} from '../../../../packages/docx-engine/src/protection.ts'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(),'dyoffice-slide-image-export-'))
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(directory,'key.pem'),'-out',join(directory,'cert.pem'),'-days','1','-subj','/CN=localhost'],{stdio:'pipe'})
  let app,browser
  const server = createServer({key:await readFile(join(directory,'key.pem')),cert:await readFile(join(directory,'cert.pem'))},(req,res)=>app.routing(req,res))
  t.after(async()=>{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app?.close();await rm(directory,{recursive:true,force:true})})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const origin = 'https://127.0.0.1:'+server.address().port
  const f = await fileFixture(t,{origin,buildApp:false})
  await f.preferences.update(f.alice.token,{language:'en',autoSave:false})
  const slidesHost = {openSession(input){return openIsolatedPptxSession(input,{unsafeTestOnly:true,timeoutMs:60000})}}
  app = await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,slidesHost,nativeSlidesDirectory:process.env.DYOFFICE_TEST_SLIDES_DIST??fileURLToPath(new URL('../../dist-slides/',import.meta.url))})
  browser = await launchTestBrowser()
  const context = await browser.newContext({acceptDownloads:true,ignoreHTTPSErrors:true})
  const page = await context.newPage()
  const csrf = await (await context.request.get(origin+'/api/v1/auth/csrf')).json()
  assert.equal((await context.request.post(origin+'/api/v1/auth/login',{headers:{origin,'x-csrf-token':csrf.csrfToken},data:{username:'alice',password}})).status(),200)
  return {...f,page,origin}
}

async function openDeck({page,origin}, fileId, theme) {
  await page.goto(origin+'/native-pptx/?fileId='+fileId)
  await expect(page.locator('html')).toHaveAttribute('data-theme',theme)
  await expect(page.locator('.app-main')).toBeVisible({timeout:45000})
  await expect.poll(()=>page.evaluate(async()=> (await window.slidesApi?.getRenderSlides())?.length ?? 0),{timeout:30000}).toBe(2)
}

const deckFixture = new URL('../fixtures/slides/acceptance.pptx',import.meta.url)

test('PPTX displays modification protection and downloads the unmodified saved version',{timeout:90000},async t=>{
  const f=await fixture(t),{page}=f
  const archive=await JSZip.loadAsync(await readFile(deckFixture))
  const presentation='ppt/presentation.xml',xml=await archive.file(presentation).async('string')
  const {hash,salt,spinCount}=await hashProtectionPassword('Synthetic PPTX modify password',1000)
  const verifier=`<p:modifyVerifier algorithmName="SHA-512" hashValue="${hash}" saltValue="${salt}" spinCount="${spinCount}"/>`
  archive.file(presentation,xml.replace('</p:presentation>',verifier+'</p:presentation>'))
  const original=await archive.generateAsync({type:'nodebuffer'})
  const {file}=await importFile(f,f.alice.token,original,'write-protected.pptx')
  await f.preferences.update(f.alice.token,{theme:'light'})
  await openDeck(f,file.fileId,'light')
  await expect(page.getByText('Write-protected presentation',{exact:true})).toBeVisible()
  await page.locator('.ribbon-tab-file').click()
  await expect(page.locator('.dyoffice-slides-download')).toBeDisabled()
  const [download]=await Promise.all([
    page.waitForEvent('download'),page.locator('.dyoffice-slides-download-saved').click(),
  ])
  assert.equal(download.suggestedFilename(),'write-protected.pptx')
  assert.deepEqual(await readFile(await download.path()),original)
  assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
})

test('PPTX exports the same visible-slide PNG and JPEG images in both UI themes without committing', {timeout:120000}, async t => {
  const f = await fixture(t), {page} = f
  const zip = await JSZip.loadAsync(await readFile(deckFixture))
  const second = 'ppt/slides/slide2.xml'
  zip.file(second,(await zip.file(second).async('string')).replace(/<p:sld(?=\s)/,'<p:sld show="0"'))
  const original = await zip.generateAsync({type:'nodebuffer'})
  const initial = (await importFile(f,f.alice.token,original,'Quarterly deck.pptx')).file
  const lightImages = new Map()
  for (const theme of ['light','dark']) {
    await f.preferences.update(f.alice.token,{theme})
    await openDeck(f,initial.fileId,theme)
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
      if (theme==='light') lightImages.set(format,payload)
      else assert.deepEqual(payload,lightImages.get(format),format+' export changed with the UI theme')
    }
  }
  assert.equal((await f.files.openFile(f.alice.token,initial.fileId)).file.revision,initial.revision)
  assert.deepEqual(await f.files.readFile(f.alice.token,initial.fileId,initial.revision),original)
})

test('PPTX saves authored shape colors and reopens editable objects in both UI themes', {timeout:120000}, async t => {
  const f = await fixture(t), {page} = f
  const original = await readFile(deckFixture)
  const before = await JSZip.loadAsync(original)
  const label = 'F15 native shape'
  const initialColor = '#A14173', nextColor = '#17B382'

  for (const theme of ['light','dark']) {
    await f.preferences.update(f.alice.token,{theme})
    const name = `Shape color ${theme}.pptx`
    const initial = (await importFile(f,f.alice.token,original,name)).file
    await openDeck(f,initial.fileId,theme)
    const inserted = await page.evaluate(({label,initialColor})=>window.slidesApi.addElement({
      slideIndex:0,kind:'rect',xPx:40,yPx:60,wPx:280,hPx:70,fitWidthPx:960,text:label,fillColor:initialColor,
    }),{label,initialColor})
    assert.ok(inserted?.sourceId)
    assert.equal((await f.files.openFile(f.alice.token,initial.fileId)).file.revision,initial.revision)

    await page.locator('.ribbon-tab-file').click()
    const [download] = await Promise.all([
      page.waitForEvent('download',{timeout:20000}),
      page.locator('.dyoffice-slides-download').click(),
    ])
    assert.equal(download.suggestedFilename(),name)
    const current = (await f.files.openFile(f.alice.token,initial.fileId)).file
    assert.notEqual(current.revision,initial.revision)
    const downloaded = await readFile(await download.path())
    assert.deepEqual(downloaded,await f.files.readFile(f.alice.token,current.fileId,current.revision))
    const archive = await JSZip.loadAsync(downloaded)
    const slide = await archive.file('ppt/slides/slide1.xml').async('string')
    const shape = [...slide.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map(([markup])=>markup).find(markup=>markup.includes(label))
    assert.ok(shape)
    assert.match(shape,/<a:prstGeom prst="rect"/)
    assert.match(shape,/<a:solidFill><a:srgbClr val="A14173"\/><\/a:solidFill>/)
    for (const part of ['ppt/slides/slide2.xml','ppt/theme/theme1.xml']) {
      assert.deepEqual(await archive.file(part).async('nodebuffer'),await before.file(part).async('nodebuffer'),part)
    }

    await openDeck(f,initial.fileId,theme)
    const reopened = await page.evaluate(async label=>{
      const [first] = await window.slidesApi.getRenderSlides()
      return first.nodes.find(node=>node.text?.lines.some(line=>line.runs.map(run=>run.text).join('')===label))
    },label)
    assert.equal(reopened?.type,'shape')
    assert.equal(reopened.fill?.color?.toUpperCase(),initialColor)
    const editedFill = await page.evaluate(async ({sourceId,nextColor})=>{
      const slide = await window.slidesApi.editFill({slideIndex:0,sourceId,fill:nextColor})
      return slide?.nodes.find(node=>node.sourceId===sourceId)?.fill
    },{sourceId:reopened.sourceId,nextColor})
    assert.equal(editedFill?.color?.toUpperCase(),nextColor)
    assert.deepEqual(await f.files.readFile(f.alice.token,initial.fileId,initial.revision),original)
  }
})
