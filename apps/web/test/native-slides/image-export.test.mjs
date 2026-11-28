import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createServer} from 'node:https'
import {fileURLToPath} from 'node:url'
import {chromium,expect} from '@playwright/test'
import JSZip from 'jszip'
import { PNG } from 'pngjs'
import {imageSizeFromBytes} from '@genoffice/pptx-render'
import {buildLocalApp} from '../../server/src/app.ts'
import {openIsolatedPptxSession} from '../../worker/src/native/pptx-session-host.ts'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {hashProtectionPassword} from '../../../../packages/docx-engine/src/protection.ts'

async function fixture(t, browserArgs) {
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
  browser = browserArgs
    ? await chromium.launch({
      args:browserArgs,
      ...(process.env.DYOFFICE_TEST_CHROMIUM_PATH ? {executablePath:process.env.DYOFFICE_TEST_CHROMIUM_PATH} : {}),
    })
    : await launchTestBrowser()
  const context = await browser.newContext({acceptDownloads:true,ignoreHTTPSErrors:true})
  const page = await context.newPage()
  const csrf = await (await context.request.get(origin+'/api/v1/auth/csrf')).json()
  assert.equal((await context.request.post(origin+'/api/v1/auth/login',{headers:{origin,'x-csrf-token':csrf.csrfToken},data:{username:'alice',password}})).status(),200)
  return {...f,page,origin}
}

async function openDeck({page,origin}, fileId, theme, count=2) {
  await page.goto(origin+'/native-pptx/?fileId='+fileId)
  await expect(page.locator('html')).toHaveAttribute('data-theme',theme)
  await expect(page.locator('.app-main')).toBeVisible({timeout:45000})
  await expect.poll(()=>page.evaluate(async()=> (await window.slidesApi?.getRenderSlides())?.length ?? 0),{timeout:30000}).toBe(count)
}

const deckFixture = new URL('../fixtures/slides/acceptance.pptx',import.meta.url)

test('Web lays out and draws PPTX text with its embedded font',{timeout:120000},async t=>{
  const f=await fixture(t),{page}=f
  await f.preferences.update(f.alice.token,{theme:'light'})
  const font=await readFile(new URL('../../../docs/src/renderer/fonts/LiberationMono-Regular.ttf',import.meta.url))
  const family='宋体',marker='iiiiiiiiiiii'
  const deck=await JSZip.loadAsync(await readFile(deckFixture))
  const slidePath='ppt/slides/slide1.xml'
  const slideXml=await deck.file(slidePath).async('string')
  deck.file(slidePath,slideXml.replace(
    '<a:r><a:rPr/><a:t>Acceptance title</a:t></a:r>',
    `<a:r><a:rPr><a:latin typeface="${family}"/></a:rPr><a:t>${marker}</a:t></a:r>`,
  ))
  const fallback=await deck.generateAsync({type:'nodebuffer'})
  const presPath='ppt/presentation.xml',relsPath='ppt/_rels/presentation.xml.rels'
  deck.file(presPath,(await deck.file(presPath).async('string')).replace('</p:presentation>',
    `<p:embeddedFontLst><p:embeddedFont><p:font typeface="${family}"/><p:regular r:id="rId900"/></p:embeddedFont></p:embeddedFontLst></p:presentation>`))
  deck.file(relsPath,(await deck.file(relsPath).async('string')).replace('</Relationships>',
    '<Relationship Id="rId900" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/acceptance.fntdata"/></Relationships>'))
  deck.file('[Content_Types].xml',(await deck.file('[Content_Types].xml').async('string')).replace('</Types>',
    '<Default Extension="fntdata" ContentType="application/x-fontdata"/></Types>'))
  deck.file('ppt/fonts/acceptance.fntdata',font)
  const source=await deck.generateAsync({type:'nodebuffer'})
  const {file}=await importFile(f,f.alice.token,source,'With embedded font.pptx')
  const plain=await importFile(f,f.alice.token,fallback,'Without embedded font.pptx')
  const width=()=>page.evaluate(async marker=>{
    const [slide]=await window.slidesApi.getRenderSlides()
    return slide.nodes.flatMap(node=>node.text?.lines.flatMap(line=>line.runs)??[])
      .find(run=>run.text===marker)?.widthPx??0
  },marker)
  const browsersHasFont=(target=page)=>target.evaluate(family=>Array.from(document.fonts).some(
    face=>face.family===family&&face.status==='loaded',
  ),family)
  await openDeck(f,plain.file.fileId,'light')
  const fallbackWidth=await width()
  assert.ok(fallbackWidth>0)
  assert.equal(await browsersHasFont(),false)
  await openDeck(f,file.fileId,'light')
  await expect.poll(browsersHasFont,{timeout:15000}).toBe(true)
  assert.ok(await width()>fallbackWidth*1.7)
  assert.match(await page.evaluate(name=>window.__genofficeDisplayFontFamily(name),family),/^"宋体",/)
  await page.getByText('Slide Show',{exact:true}).first().click()
  await page.getByRole('button',{name:'Presenter View',exact:true}).click()
  const popup=page.waitForEvent('popup')
  await page.getByRole('button',{name:'Open Audience Window',exact:true}).click()
  const audience=await popup
  await expect.poll(()=>browsersHasFont(audience),{timeout:15000}).toBe(true)
  await page.getByRole('button',{name:/End Show/}).click()
  await expect(page.locator('.presenter')).toHaveCount(0)

  await page.locator('.notes-pane textarea').fill('Keep the original embedded face')
  await page.keyboard.press('Control+s')
  const revision=async()=>(await f.files.openFile(f.alice.token,file.fileId)).file.revision
  await expect.poll(revision,{timeout:15000}).not.toBe(file.revision)
  const saved=await JSZip.loadAsync(await f.files.readFile(f.alice.token,file.fileId,await revision()))
  assert.deepEqual(await saved.file('ppt/fonts/acceptance.fntdata').async('nodebuffer'),font)
  await openDeck(f,file.fileId,'light')
  await expect.poll(browsersHasFont,{timeout:15000}).toBe(true)
  const stripped=await page.evaluate(async({family,marker})=>{
    const [slide]=await window.slidesApi.getRenderSlides()
    const node=slide.nodes.find(node=>node.text?.lines.some(line=>line.runs.some(run=>run.text===marker)))
    await window.slidesApi.editText({slideIndex:0,sourceId:node.sourceId,paragraphs:[{runs:[{text:'🦔',fontFamily:family}]}]})
    return window.slidesApi.save()
  },{family,marker})
  assert.equal(stripped.ok,true)
  await expect.poll(browsersHasFont,{timeout:15000}).toBe(false)
  const edited=await JSZip.loadAsync(await f.files.readFile(f.alice.token,file.fileId,await revision()))
  assert.equal(edited.file('ppt/fonts/acceptance.fntdata'),null)
})

test('Web speaker notes warn on reload and save with Ctrl+S while focused',{timeout:90000},async t=>{
  const f=await fixture(t),{page}=f
  await f.preferences.update(f.alice.token,{theme:'light'})
  const {file}=await importFile(f,f.alice.token,await readFile(deckFixture),'Focused speaker notes.pptx')
  await openDeck(f,file.fileId,'light')
  const field=page.locator('.notes-pane textarea')
  const save=page.locator('button.qa-btn[aria-label^="Save"]')
  const note='Speaker notes saved without leaving the field'
  await field.click()
  await field.fill(note)
  await expect(save).toBeEnabled()

  const dismissed=page.waitForEvent('dialog').then(async dialog=>{
    assert.equal(dialog.type(),'beforeunload')
    await dialog.dismiss()
  })
  await page.evaluate(()=>{ setTimeout(()=>location.reload(),0) })
  await dismissed
  await expect(field).toHaveValue(note)
  await expect(field).toBeFocused()
  await field.press('Control+s')
  await expect(page.locator('.status-msg')).toContainText('Saved')
  await expect(field).toBeFocused()
  await expect(save).toBeDisabled()

  await page.reload()
  await expect(field).toHaveValue(note)
})

test('Web speaker notes retain overlong drafts across slides and block publishing',{timeout:90000},async t=>{
  const f=await fixture(t),{page}=f
  await f.preferences.update(f.alice.token,{theme:'light'})
  const {file}=await importFile(f,f.alice.token,await readFile(deckFixture),'Speaker notes limit.pptx')
  await openDeck(f,file.fileId,'light')
  const field=page.locator('.notes-pane textarea')
  const save=page.locator('button.qa-btn[aria-label^="Save"]')
  const thumbnails=page.locator('.thumb')
  const note='x'.repeat(65_537)
  await field.fill(note)
  await expect(field).toHaveAttribute('aria-invalid','true')
  await expect(page.locator('.notes-error')).toContainText('65536')
  await thumbnails.nth(1).click()
  await thumbnails.nth(1).click({button:'right'})
  await page.getByText('Duplicate Slide',{exact:true}).click()
  await expect(thumbnails).toHaveCount(3)

  await save.click()
  await expect(page.locator('.status-msg')).toContainText('Speaker notes on slide 1')
  assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
  await expect(save).toBeEnabled()
  await thumbnails.first().click()
  await expect(field).toHaveValue(note)

  const corrected=note.slice(0,-1)
  await field.fill(corrected)
  await field.press('Control+s')
  await expect(page.locator('.status-msg')).toContainText('Saved')
  await page.reload()
  await expect(thumbnails).toHaveCount(3)
  await expect(field).toHaveValue(corrected)
})

test('Web speaker notes wait for an in-flight write and retain drafts after rejection',{timeout:90000},async t=>{
  const f=await fixture(t),{page}=f
  await f.preferences.update(f.alice.token,{theme:'light'})
  const {file}=await importFile(f,f.alice.token,await readFile(deckFixture),'Speaker notes retry.pptx')
  await openDeck(f,file.fileId,'light')
  const field=page.locator('.notes-pane textarea')
  const save=page.locator('button.qa-btn[aria-label^="Save"]')
  const note='Keep this entire note until the server accepts it'
  const applyRoute='**/slides/apply'
  let finishWrite
  const stalled=new Promise(resolve=>{finishWrite=resolve})
  await page.route(applyRoute,async route=>{
    if (route.request().postDataJSON().ops?.[0]?.op!=='setNotes') return route.continue()
    await stalled
    await route.fulfill({status:400,json:{code:'INVALID_TEXT'}})
  })
  try {
    await field.fill(note)
    const write=page.waitForRequest(request=>request.url().endsWith('/slides/apply')&&request.postDataJSON().ops?.[0]?.op==='setNotes')
    await save.click()
    await write
    assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
  } finally {
    finishWrite()
  }
  await expect(page.locator('.status-msg')).toContainText('Could not write speaker notes')
  await expect(field).toHaveValue(note)
  await expect(save).toBeEnabled()
  assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)

  await page.unroute(applyRoute)
  await save.click()
  await expect(page.locator('.status-msg')).toContainText('Saved')
  await page.reload()
  await expect(field).toHaveValue(note)
})

test('Web speaker notes show the accepted text after the initial notes read fails',{timeout:90000},async t=>{
  const f=await fixture(t),{page}=f
  await f.preferences.update(f.alice.token,{theme:'light'})
  const {file}=await importFile(f,f.alice.token,await readFile(deckFixture),'Speaker notes read recovery.pptx')
  const notesRoute='**/slides/notes'
  await page.route(notesRoute,route=>route.fulfill({status:500,json:{code:'UNAVAILABLE'}}))
  const failedRead=page.waitForResponse(response=>response.url().endsWith('/slides/notes')&&response.status()===500)
  await openDeck(f,file.fileId,'light')
  await failedRead
  await page.unroute(notesRoute)

  const field=page.locator('.notes-pane textarea')
  const note='Replace notes after a read failure'
  await field.fill(note)
  await field.press('Control+s')
  await expect(page.locator('.status-msg')).toContainText('Saved')
  await expect(field).toHaveValue(note)
  await page.reload()
  await expect(field).toHaveValue(note)
})

test('Web speaker notes include a second slide drafted while the first write is pending',{timeout:90000},async t=>{
  const f=await fixture(t),{page}=f
  await f.preferences.update(f.alice.token,{theme:'light'})
  const {file}=await importFile(f,f.alice.token,await readFile(deckFixture),'Speaker notes across slides.pptx')
  await openDeck(f,file.fileId,'light')
  const field=page.locator('.notes-pane textarea')
  const note1='Notes for the first slide'
  const note2='Notes for the next slide'
  let finishWrite
  const stalled=new Promise(resolve=>{finishWrite=resolve})
  await page.route('**/slides/apply',async route=>{
    const op=route.request().postDataJSON().ops?.[0]
    if (op?.op==='setNotes'&&op.target.slide===0) await stalled
    await route.continue()
  })
  try {
    await field.fill(note1)
    const write=page.waitForRequest(request=>request.url().endsWith('/slides/apply')&&request.postDataJSON().ops?.[0]?.op==='setNotes')
    await page.locator('.thumb').nth(1).click()
    await write
    await field.fill(note2)
    await field.press('Control+s')
  } finally {
    finishWrite()
  }
  await expect(page.locator('.status-msg')).toContainText('Saved')
  await page.reload()
  await expect(field).toHaveValue(note1)
  await page.locator('.thumb').nth(1).click()
  await expect(field).toHaveValue(note2)
})

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

  await page.getByRole('button',{name:'Enter modification password',exact:true}).click()
  const field=page.getByLabel('Modification password',{exact:true})
  const unlock=page.getByRole('button',{name:'Unlock editing',exact:true})
  await field.fill('Incorrect password')
  await unlock.click()
  await expect(page.getByText('Incorrect modification password.',{exact:true})).toBeVisible()
  await expect(page.getByText('Write-protected presentation',{exact:true})).toBeVisible()
  await field.fill('Synthetic PPTX modify password')
  await unlock.click()
  await expect(page.getByText('Write-protected presentation',{exact:true})).toHaveCount(0)
  await page.locator('.ribbon-tab-file').click()
  await expect(page.locator('.dyoffice-slides-download')).toBeEnabled()
  assert.equal(await page.evaluate(async()=>{
    await window.slidesApi.setNotes({slideIndex:0,text:'Edited after entering the modification password'})
    return (await window.slidesApi.save()).ok
  }),true)
  const saved=(await f.files.openFile(f.alice.token,file.fileId)).file
  assert.notEqual(saved.revision,file.revision)
  const edited=await JSZip.loadAsync(await f.files.readFile(f.alice.token,file.fileId,saved.revision))
  assert.ok((await edited.file(presentation).async('string')).includes(verifier))
  await page.reload()
  await expect(page.getByText('Write-protected presentation',{exact:true})).toBeVisible()
  await expect.poll(()=>page.evaluate(()=>window.slidesApi?.getNotes(0))).toBe('Edited after entering the modification password')
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


test('PPTX thumbnail menus copy and paste an editable slide that survives saving and reloading',{timeout:120000},async t=>{
  const f=await fixture(t),{page}=f
  const original=await readFile(deckFixture)
  const initial=(await importFile(f,f.alice.token,original,'Clipboard deck.pptx')).file
  await f.preferences.update(f.alice.token,{theme:'light'})
  await openDeck(f,initial.fileId,'light')
  const label='ClipboardRoundTrip'
  const added=await page.evaluate(text=>window.slidesApi.addElement({
    slideIndex:0,kind:'textbox',xPx:120,yPx:100,wPx:280,hPx:60,fitWidthPx:960,text,
  }),label)
  assert.ok(added?.sourceId)
  const note='Speaker notes preserved by copying'
  await page.evaluate(async ({note,sourceId})=>{
    await window.slidesApi.setNotes({slideIndex:0,text:note})
    await window.slidesApi.setLink({slideIndex:0,sourceId,target:{kind:'slide',slideIndex:1}})
  },{note,sourceId:added.sourceId})
  assert.equal(await page.evaluate(()=>window.slidesApi.getNotes(0)),note)

  await page.locator('.thumb').nth(0).click({button:'right'})
  await page.getByText('Copy Slide',{exact:true}).click()
  await expect.poll(()=>page.evaluate(()=>window.slidesApi.hasSlideClipboard())).toBe(true)
  await page.locator('.thumb').nth(1).click({button:'right'})
  await page.getByText('Paste Slide',{exact:true}).click()
  await expect(page.locator('.thumb')).toHaveCount(3)
  const copied=await page.evaluate(async text=>{
    const slides=await window.slidesApi.getRenderSlides()
    return slides[2].nodes.find(node=>node.text?.lines.some(line=>line.runs.map(run=>run.text).join('')===text))
  },label)
  assert.ok(copied?.sourceId)
  assert.equal(await page.evaluate(()=>window.slidesApi.getNotes(2)),note)
  assert.deepEqual(await page.evaluate(async()=>{
    return (await window.slidesApi.getSlideLinks(2)).map(link=>link.target)
  }),[{kind:'slide',slideIndex:1}])
  const edited='EditedClipboardSlide'
  await page.evaluate(({sourceId,text})=>window.slidesApi.editText({
    slideIndex:2,sourceId,paragraphs:[{runs:[{text}]}],
  }),{sourceId:copied.sourceId,text:edited})
  const saved=await page.evaluate(()=>window.slidesApi.save())
  assert.equal(saved.ok,true,JSON.stringify(saved))
  const current=(await f.files.openFile(f.alice.token,initial.fileId)).file
  assert.notEqual(current.revision,initial.revision)
  assert.deepEqual(await f.files.readFile(f.alice.token,initial.fileId,initial.revision),original)
  const archive=await JSZip.loadAsync(await f.files.readFile(f.alice.token,current.fileId,current.revision))
  assert.match(await archive.file('ppt/slides/slide3.xml').async('string'),/EditedClipboardSlide/)
  await page.reload()
  await expect(page.locator('.thumb')).toHaveCount(3,{timeout:45000})
  await expect.poll(()=>page.evaluate(()=>window.slidesApi.getNotes(2))).toBe(note)
  assert.deepEqual(await page.evaluate(async()=>{
    return (await window.slidesApi.getSlideLinks(2)).map(link=>link.target)
  }),[{kind:'slide',slideIndex:1}])
  const stillEditable=await page.evaluate(async text=>{
    const slides=await window.slidesApi.getRenderSlides()
    return !!slides[2].nodes.find(node=>node.sourceId&&node.text?.lines.some(line=>line.runs.map(run=>run.text).join('')===text))
  },edited)
  assert.equal(stillEditable,true)

  await page.locator('.thumb').nth(2).click({button:'right'})
  await page.getByText('Duplicate Slide',{exact:true}).click()
  await expect(page.locator('.thumb')).toHaveCount(4)
  assert.equal(await page.evaluate(()=>window.slidesApi.getNotes(3)),note)
  const updatedNote='Only on the duplicate'
  const duplicateSave=await page.evaluate(async text=>{
    if(!await window.slidesApi.setNotes({slideIndex:3,text}))return null
    return window.slidesApi.save()
  },updatedNote)
  assert.equal(duplicateSave?.ok,true,JSON.stringify(duplicateSave))
  await page.reload()
  await expect(page.locator('.thumb')).toHaveCount(4,{timeout:45000})
  await expect.poll(()=>page.evaluate(()=>window.slidesApi.getNotes(3))).toBe(updatedNote)
  assert.equal(await page.evaluate(()=>window.slidesApi.getNotes(2)),note)
})

test('PPTX keeps existing jumps to a slide cut and pasted back into its own deck',{timeout:90000},async t=>{
  const f=await fixture(t),{page}=f
  await f.preferences.update(f.alice.token,{theme:'light'})
  const {file}=await importFile(f,f.alice.token,await readFile(deckFixture),'Cut link.pptx')
  await openDeck(f,file.fileId,'light')
  await page.evaluate(async()=>{
    const node=await window.slidesApi.addElement({
      slideIndex:0,kind:'textbox',xPx:90,yPx:90,wPx:225,hPx:70,fitWidthPx:960,text:'Jump to the cut slide',
    })
    await window.slidesApi.setLink({slideIndex:0,sourceId:node.sourceId,target:{kind:'slide',slideIndex:1}})
  })
  const targets=()=>page.evaluate(async()=> (await window.slidesApi.getSlideLinks(0)).map(link=>link.target))
  const expected=[{kind:'slide',slideIndex:1}]
  assert.deepEqual(await targets(),expected)
  const thumbnails=page.locator('.thumb')
  await thumbnails.nth(1).click({button:'right'})
  await page.getByText('Cut Slide',{exact:true}).click()
  await expect(thumbnails).toHaveCount(1)
  await thumbnails.first().click({button:'right'})
  await page.getByText('Paste Slide',{exact:true}).click()
  await expect(thumbnails).toHaveCount(2)
  assert.deepEqual(await targets(),expected)
  assert.equal((await page.evaluate(()=>window.slidesApi.save())).ok,true)
  await openDeck(f,file.fileId,'light')
  assert.deepEqual(await targets(),expected)
})

test('PPTX keeps the section of a middle slide cut and pasted back at its original position',{timeout:90000},async t=>{
  const f=await fixture(t),{page}=f
  await f.preferences.update(f.alice.token,{theme:'light'})
  const {openPptx,insertBlankSlide,setSections,savePptx}=await import('@genoffice/pptx-engine')
  const deck=await openPptx(await readFile(deckFixture))
  assert.ok(insertBlankSlide(deck,1))
  const sections=['First','Cut target','Last'].map((name,index)=>({
    id:`{00000000-0000-4000-8000-00000000000${index+1}}`,name,slideIndices:[index],
  }))
  setSections(deck,sections)
  const {file}=await importFile(f,f.alice.token,Buffer.from(await savePptx(deck)),'Cut section.pptx')
  await openDeck(f,file.fileId,'light',3)
  const thumbnails=page.locator('.thumb')
  await expect(thumbnails).toHaveCount(3)
  const actual=()=>page.evaluate(()=>window.slidesApi.getSections())
  assert.deepEqual(await actual(),sections)
  await thumbnails.nth(1).click({button:'right'})
  await page.getByText('Cut Slide',{exact:true}).click()
  await expect(thumbnails).toHaveCount(2)
  await thumbnails.first().click({button:'right'})
  await page.getByText('Paste Slide',{exact:true}).click()
  await expect(thumbnails).toHaveCount(3)
  assert.deepEqual(await actual(),sections)
  assert.equal((await page.evaluate(()=>window.slidesApi.save())).ok,true)
  await openDeck(f,file.fileId,'light',3)
  await expect(thumbnails).toHaveCount(3)
  assert.deepEqual(await actual(),sections)
})

test('Web PowerPoint pastes a native clipboard picture when async clipboard reads are denied',{timeout:90000},async t=>{
  const f=await fixture(t),{page,origin}=f
  await f.preferences.update(f.alice.token,{theme:'light'})
  const original=await readFile(deckFixture)
  const {file}=await importFile(f,f.alice.token,original,'Clipboard picture.pptx')
  await openDeck(f,file.fileId,'light')
  const nodes=()=>page.evaluate(async()=> (await window.slidesApi.getRenderSlides())[0].nodes)
  const count=(await nodes()).length
  const picture=new PNG({width:4,height:3})
  for(let i=0;i<picture.data.length;i+=4)picture.data.set([35,80,170,255],i)
  await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin})
  await page.bringToFront()
  await page.evaluate(async(base64)=>{
    const bytes=Uint8Array.from(atob(base64),value=>value.charCodeAt(0))
    await navigator.clipboard.write([new ClipboardItem({
      'image/png':new Blob([bytes],{type:'image/png'}),
      'text/plain':new Blob(['Image source URL'],{type:'text/plain'}),
    })])
    Object.defineProperty(navigator.clipboard,'read',{value:async()=>{throw new DOMException('Clipboard read denied','NotAllowedError')}})
  },PNG.sync.write(picture).toString('base64'))
  await page.locator('.thumb').first().click()
  await page.keyboard.press('ControlOrMeta+v')
  await expect.poll(async()=> (await nodes()).slice(count).map(node=>node.type),{timeout:12000}).toEqual(['picture'])
  await page.keyboard.press('ControlOrMeta+s')
  const revision=async()=> (await f.files.openFile(f.alice.token,file.fileId)).file.revision
  await expect.poll(revision).not.toBe(file.revision)
  const saved=await JSZip.loadAsync(await f.files.readFile(f.alice.token,file.fileId,await revision()))
  const media=await Promise.all(saved.file(/^ppt\/media\/.*\.png$/).map(part=>part.async('nodebuffer')))
  assert.ok(media.some(bytes=>{
    const image=PNG.sync.read(bytes)
    return image.width===picture.width&&image.height===picture.height&&image.data.equals(picture.data)
  }))
  await openDeck(f,file.fileId,'light')
  await expect.poll(async()=> (await nodes()).slice(count).map(node=>node.type)).toEqual(['picture'])
})

test('Web PowerPoint saves a website picture pasted from HTML without a bitmap',{timeout:120000},async t=>{
  const f=await fixture(t),{page,origin}=f
  await f.preferences.update(f.alice.token,{theme:'light',showAssistant:false})
  const original=await readFile(deckFixture)
  const {file}=await importFile(f,f.alice.token,original,'Website picture.pptx')
  const url='https://clipboard-images.example/slide-picture.png'
  const html=`<img src="${url}" alt="Website picture">`
  const png=new PNG({width:7,height:5});png.data.fill(208)
  const bytes=PNG.sync.write(png)
  const requests=[]
  await page.route(url,route=>route.fulfill({status:403}))
  await page.route('**/api/v1/ai/media',async route=>{
    requests.push({body:route.request().postDataJSON(),csrf:!!route.request().headers()['x-csrf-token']})
    await route.fulfill({json:{mime:'image/png',base64:bytes.toString('base64')}})
  })
  await openDeck(f,file.fileId,'light')
  const nodes=()=>page.evaluate(async()=> (await window.slidesApi.getRenderSlides())[0].nodes)
  const count=(await nodes()).length
  const pastes=async()=> (await nodes()).slice(count).map(node=>node.type)
  await page.locator('.thumb').first().click()
  await page.evaluate(({html,url})=>{
    const transfer=new DataTransfer()
    transfer.setData('text/html',html)
    transfer.setData('text/plain',url)
    document.activeElement.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}))
  },{html,url})
  await expect.poll(pastes,{timeout:12000}).toEqual(['picture'])

  await page.getByRole('button',{name:'Home',exact:true}).click()
  await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin})
  await page.evaluate(({html,url})=>navigator.clipboard.write([new ClipboardItem({
    'text/html':new Blob([html],{type:'text/html'}),
    'text/plain':new Blob([url],{type:'text/plain'}),
  })]),{html,url})
  await page.getByRole('button',{name:'Paste',exact:true}).click()
  await expect.poll(pastes,{timeout:12000}).toEqual(['picture','picture'])

  await page.evaluate(html=>{
    const transfer=new DataTransfer()
    transfer.setData('text/html',`<p>Text with a picture ${html}</p>`)
    transfer.setData('text/plain','Text with a picture')
    document.activeElement.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}))
  },html)
  await expect.poll(pastes,{timeout:12000}).toEqual(['picture','picture','text'])
  assert.deepEqual(requests,Array.from({length:2},()=>({body:{action:'fetch_image',url},csrf:true})))

  await page.keyboard.press('ControlOrMeta+s')
  const revision=async()=> (await f.files.openFile(f.alice.token,file.fileId)).file.revision
  await expect.poll(revision).not.toBe(file.revision)
  const saved=await JSZip.loadAsync(await f.files.readFile(f.alice.token,file.fileId,await revision()))
  const media=await Promise.all(saved.file(/^ppt\/media\/.*\.png$/).map(part=>part.async('nodebuffer')))
  assert.ok(media.some(image=>image.equals(bytes)))
  assert.doesNotMatch(await saved.file('ppt/slides/slide1.xml').async('string'),/clipboard-images\.example/)
  assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
  await openDeck(f,file.fileId,'light')
  await expect.poll(pastes).toEqual(['picture','picture','text'])
})

test('PPTX prints named PDF notes for a selected hidden slide',{timeout:120000},async t=>{
  const f=await fixture(t),{page}=f
  const archive=await JSZip.loadAsync(await readFile(deckFixture))
  const slide='ppt/slides/slide2.xml'
  archive.file(slide,(await archive.file(slide).async('string')).replace(/<p:sld(?=\s)/,'<p:sld show="0"'))
  const source=await archive.generateAsync({type:'nodebuffer'})
  const {file}=await importFile(f,f.alice.token,source,'Review deck.pptx')
  await f.preferences.update(f.alice.token,{theme:'light'})
  await openDeck(f,file.fileId,'light')
  await page.evaluate(async()=>{
    await window.slidesApi.setNotes({slideIndex:0,text:'Excluded notes'})
    await window.slidesApi.setNotes({slideIndex:1,text:'Review comments for the hidden slide'})
    const append=document.body.append
    document.body.append=function(...children){
      for(const frame of children){
        if(!(frame instanceof HTMLIFrameElement)||!frame.sandbox.contains('allow-modals'))continue
        frame.addEventListener('load',()=>{
          const target=frame.contentWindow
          target.print=()=>{window.printedNotes={title:target.document.title,html:frame.srcdoc}}
        },{capture:true,once:true})
      }
      return append.apply(this,children)
    }
  })
  await page.locator('.ribbon-tab-file').click()
  await page.getByRole('button',{name:/^Print…/}).click()
  const dialog=page.getByRole('dialog',{name:'Print',exact:true})
  await dialog.getByRole('radio',{name:'Notes Pages',exact:true}).check()
  await dialog.getByRole('radio',{name:'Landscape',exact:true}).check()
  await dialog.getByRole('radio',{name:'Custom range',exact:true}).check()
  await dialog.getByPlaceholder('e.g. 1,3,5-8').fill('2')
  const exportPdf=dialog.getByRole('button',{name:'Export as PDF…',exact:true})
  const name=dialog.getByRole('textbox',{name:'File name',exact:true})
  await expect(name).toHaveValue('Review deck')
  await expect(exportPdf).toBeDisabled()
  await dialog.getByRole('checkbox',{name:'Print hidden slides',exact:true}).check()
  await name.fill('   ')
  await expect(exportPdf).toBeDisabled()
  await expect(dialog.getByRole('button',{name:'Print',exact:true})).toBeEnabled()
  await name.fill('Board review notes.pdf')
  await exportPdf.click()
  await expect.poll(()=>page.evaluate(()=>window.printedNotes?.title)).toBe('Board review notes')
  const printed=await page.evaluate(()=>window.printedNotes)
  const pdfPage=await page.context().newPage()
  try{
    await pdfPage.setContent(printed.html)
    const bytes=await pdfPage.pdf({preferCSSPageSize:true,printBackground:true})
    const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs')
    const task=getDocument({data:Uint8Array.from(bytes)})
    try{
      const pdf=await task.promise
      assert.equal(pdf.numPages,1)
      const first=await pdf.getPage(1)
      assert.ok(Math.abs(first.view[2]-842)<2)
      assert.ok(Math.abs(first.view[3]-595)<2)
      const text=(await first.getTextContent()).items.map(item=>item.str??'').join(' ')
      assert.match(text,/Review comments for the hidden slide/)
      assert.doesNotMatch(text,/Excluded notes/)
    }finally{await task.destroy()}
  }finally{await pdfPage.close()}
  await expect(dialog).toBeHidden()
  await page.locator('.ribbon-tab-file').click()
  await page.getByRole('button',{name:/^Print…/}).click()
  await name.fill('Custom name for export only')
  await dialog.getByRole('button',{name:'Print',exact:true}).click()
  await expect.poll(()=>page.evaluate(()=>window.printedNotes?.title)).toBe('Review deck')
  await expect(dialog).toBeHidden()
  assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
  assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),source)
})

test('PPTX downloads a PDF and pastes system clipboard text in the Web editor',{timeout:120000},async t=>{
  const f=await fixture(t),{page,origin}=f
  const archive=await JSZip.loadAsync(await readFile(deckFixture))
  const link='https://例子.example/报价?q=季度#页'
  const first='ppt/slides/slide1.xml',rels='ppt/slides/_rels/slide1.xml.rels'
  archive.file(first,(await archive.file(first).async('string')).replace('<p:cNvPr id="3" name="Shape 3">',
    '<p:cNvPr id="3" name="Shape 3"><a:hlinkClick r:id="rId99"/>'))
  archive.file(rels,(await archive.file(rels).async('string')).replace('</Relationships>',
    `<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${link}" TargetMode="External"/></Relationships>`))
  const second='ppt/slides/slide2.xml'
  archive.file(second,(await archive.file(second).async('string')).replace(/<p:sld(?=\s)/,'<p:sld show="0"'))
  const initial=(await importFile(f,f.alice.token,await archive.generateAsync({type:'nodebuffer'}),'Web export.pptx')).file
  await f.preferences.update(f.alice.token,{theme:'light'})
  await openDeck(f,initial.fileId,'light')
  await page.locator('.ribbon-tab-file').click()
  const [file]=await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button',{name:'Export as PDF…',exact:true}).click(),
  ])
  assert.equal(file.suggestedFilename(),'Web export.pdf')
  const {PDFDict,PDFDocument,PDFHexString,PDFName}=await import('pdf-lib')
  const pdf=await PDFDocument.load(await readFile(await file.path()))
  assert.equal(pdf.getPageCount(),1)
  assert.deepEqual(pdf.getPage(0).getSize(),{width:13.333*72,height:7.5*72})
  const links=pdf.getPage(0).node.Annots()
  assert.equal(links?.size(),1)
  const action=links.lookup(0,PDFDict).lookup(PDFName.of('A'),PDFDict)
  assert.equal(action.lookup(PDFName.of('URI'),PDFHexString).decodeText(),new URL(link).href)
  assert.equal((await f.files.openFile(f.alice.token,initial.fileId)).file.revision,initial.revision)
  await page.evaluate(()=>{
    const append=document.body.append
    document.body.append=function(...children){
      for(const frame of children){
        if(!(frame instanceof HTMLIFrameElement)||!frame.sandbox.contains('allow-modals'))continue
        frame.addEventListener('load',()=>{
          const target=frame.contentWindow
          const print=target.print.bind(target)
          target.print=()=>{
            window.printedSlides={title:target.document.title,html:frame.srcdoc,sandbox:frame.getAttribute('sandbox')}
            print()
          }
        },{capture:true,once:true})
      }
      return append.apply(this,children)
    }
  })
  await page.locator('.ribbon-tab-file').click()
  const searchablePdf=page.getByRole('button',{name:'Save as searchable PDF…',exact:true})
  await expect(searchablePdf).toBeEnabled()
  await searchablePdf.click()
  await expect.poll(()=>page.evaluate(()=>window.printedSlides?.title),{timeout:25000}).toBe('Web export')
  const printed=await page.evaluate(()=>window.printedSlides)
  assert.equal(printed.sandbox,'allow-same-origin allow-modals')
  const pdfPage=await page.context().newPage()
  try{
    await pdfPage.setContent(printed.html)
    const bytes=await pdfPage.pdf({preferCSSPageSize:true,printBackground:true})
    const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs')
    const task=getDocument({data:Uint8Array.from(bytes)})
    try{
      const vector=await task.promise
      assert.equal(vector.numPages,1)
      const first=await vector.getPage(1)
      assert.ok(Math.abs(first.view[2]-13.333*72)<2)
      assert.ok(Math.abs(first.view[3]-7.5*72)<2)
      assert.match((await first.getTextContent()).items.map(item=>item.str??'').join(' '),/Acceptance title/)
      assert.ok((await first.getAnnotations()).some(item=>item.url===new URL(link).href))
    }finally{await task.destroy()}
  }finally{await pdfPage.close()}
  assert.equal((await f.files.openFile(f.alice.token,initial.fileId)).file.revision,initial.revision)
  await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin})
  await page.locator('.thumb').first().click({button:'right'})
  await page.getByText('Copy Slide',{exact:true}).click()
  await expect(page.locator('.status-msg')).toContainText('Slide copied')
  await expect.poll(()=>page.evaluate(async()=> (await window.slidesApi.clipboardExternal()).kind)).toBe('slide')
  const marker='BrowserClipboardRoundTrip'
  await page.evaluate(text=>navigator.clipboard.writeText(text),marker)
  await page.locator('.thumb').first().click()
  await page.keyboard.press('Control+v')
  await expect.poll(()=>page.evaluate(async text=>{
    const [first]=await window.slidesApi.getRenderSlides()
    return first.nodes.some(node=>node.text?.lines.flatMap(line=>line.runs.map(run=>run.text)).join('')===text)
  },marker)).toBe(true)
  await page.getByRole('button',{name:'Insert',exact:true}).click()
  await expect(page.getByRole('button',{name:'Audio',exact:true})).toBeEnabled()
})

test('Web shape hyperlinks echo their target and are clickable in the slide show',{timeout:90000},async t=>{
  const f=await fixture(t),{page}=f
  const {file}=await importFile(f,f.alice.token,await readFile(deckFixture),'Show links.pptx')
  await f.preferences.update(f.alice.token,{theme:'light'})
  await openDeck(f,file.fileId,'light')
  const target=await page.evaluate(async()=>{
    const element=await window.slidesApi.addElement({
      slideIndex:0,kind:'textbox',xPx:90,yPx:90,wPx:225,hPx:70,fitWidthPx:960,text:'Jump to this slide',
    })
    const slide=await window.slidesApi.setLink({slideIndex:0,sourceId:element.sourceId,target:{kind:'slide',slideIndex:0}})
    const [link]=await window.slidesApi.getSlideLinks(0)
    const node=slide.nodes.find(item=>item.sourceId===link.sourceId||item.durableId===link.sourceId)
    return window.slidesApi.getLink(0,node.sourceId)
  })
  assert.deepEqual(target,{kind:'slide',slideIndex:0})
  assert.equal((await page.evaluate(()=>window.slidesApi.save())).ok,true)
  await openDeck(f,file.fileId,'light')
  const link=await page.evaluate(async()=>{
    const [slide]=await window.slidesApi.getRenderSlides()
    const [hyperlink]=await window.slidesApi.getSlideLinks(0)
    const node=slide.nodes.find(item=>item.sourceId===hyperlink.sourceId)
    return {box:node.box,width:slide.widthPx,height:slide.heightPx}
  })
  await page.getByText('Slide Show',{exact:true}).first().click()
  const loaded=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/slides/links')&&response.request().postDataJSON().index===0)
  await page.getByRole('button',{name:'From Beginning',exact:true}).click()
  await loaded
  const stage=page.locator('.ss-frame > div').first()
  const stageBox=await stage.boundingBox()
  const position={
    x:(link.box.x+link.box.w/2)*stageBox.width/link.width,
    y:(link.box.y+link.box.h/2)*stageBox.height/link.height,
  }
  await expect.poll(async()=>{await stage.hover({position});return stage.evaluate(element=>element.style.cursor)}).toBe('pointer')
  await stage.click({position})
  await expect(page.locator('.ss-counter')).toHaveText('1 / 2')
})

test('PPTX shape entrance animation keeps its link inactive until the shape appears',{timeout:90000},async t=>{
  const f=await fixture(t),{page}=f
  await f.preferences.update(f.alice.token,{theme:'light'})
  const {file}=await importFile(f,f.alice.token,await readFile(deckFixture),'Animation target.pptx')
  await openDeck(f,file.fileId,'light')
  const result=await page.evaluate(async()=>{
    const shape=await window.slidesApi.addElement({slideIndex:0,kind:'rect',xPx:150,yPx:140,wPx:200,hPx:90,fitWidthPx:960})
    const fill=await window.slidesApi.applyTxn({ops:[{op:'setFill',target:{slide:0,el:shape.sourceId},fill:'#FF0000'}]})
    const painted=(await window.slidesApi.getRenderSlides())[0].nodes.find(node=>node.fill?.color==='#FF0000')
    await window.slidesApi.setLink({slideIndex:0,sourceId:painted.sourceId,target:{kind:'slide',slideIndex:0}})
    const [link]=await window.slidesApi.getSlideLinks(0)
    const animation=await window.slidesApi.setAnimations({
      slideIndex:0,items:[{sourceId:link.sourceId,effect:'appear',trigger:'onClick',durationMs:0,delayMs:0}],
    })
    return {filled:fill?.applied,animation,saved:(await window.slidesApi.save()).ok}
  })
  assert.deepEqual(result,{filled:true,animation:true,saved:true})
  await openDeck(f,file.fileId,'light')
  await page.getByText('Slide Show',{exact:true}).first().click()
  const loaded=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/slides/animations')&&response.request().postDataJSON().index===0)
  const links=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/slides/links')&&response.request().postDataJSON().index===0)
  await page.getByRole('button',{name:'From Beginning',exact:true}).click()
  await Promise.all([loaded,links].map(async response=>(await response).finished()))
  const counter=page.locator('.ss-counter')
  await expect(counter).toHaveText('1 / 2')
  const stage=page.locator('.ss-frame > div').first()
  const bounds=await stage.boundingBox()
  const center={x:250*bounds.width/960,y:185*bounds.height/540}
  const centerPixel=()=>page.locator('.ss-frame canvas').first().evaluate(canvas=>{
    const x=Math.floor(250*canvas.width/960),y=Math.floor(185*canvas.height/540)
    return Array.from(canvas.getContext('2d').getImageData(x,y,1,1).data)
  })
  await expect.poll(centerPixel).not.toEqual([255,0,0,255])
  await stage.click({position:center})
  await expect.poll(centerPixel).toEqual([255,0,0,255])
  await expect(counter).toHaveText('1 / 2')
  await expect.poll(async()=>{await stage.hover({position:center});return stage.evaluate(element=>element.style.cursor)}).toBe('pointer')
  await stage.click({position:center})
  await expect(counter).toHaveText('1 / 2')
  await page.keyboard.press('ArrowRight')
  await expect(counter).toHaveText('2 / 2')
})

test('PPTX slideshow links follow the rotated shape bounds',{timeout:90000},async t=>{
  const f=await fixture(t),{page}=f
  await f.preferences.update(f.alice.token,{theme:'light'})
  const {file}=await importFile(f,f.alice.token,await readFile(deckFixture),'Rotated link.pptx')
  await openDeck(f,file.fileId,'light')
  assert.equal(await page.evaluate(async()=>{
    const shape=await window.slidesApi.addElement({slideIndex:0,kind:'rect',xPx:150,yPx:140,wPx:200,hPx:40,fitWidthPx:960})
    const slide=await window.slidesApi.editTransform({slideIndex:0,sourceId:shape.sourceId,
      fitWidthPx:960,xPx:150,yPx:140,wPx:200,hPx:40,rotationDeg:90})
    const rotated=slide.nodes.find(node=>node.box.rotationDeg===90)
    await window.slidesApi.setLink({slideIndex:0,sourceId:rotated.sourceId,target:{kind:'slide',slideIndex:0}})
    return (await window.slidesApi.save()).ok
  }),true)
  await openDeck(f,file.fileId,'light')
  await page.getByText('Slide Show',{exact:true}).first().click()
  const loaded=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/slides/links')&&response.request().postDataJSON().index===0)
  await page.getByRole('button',{name:'From Beginning',exact:true}).click()
  await (await loaded).finished()
  await expect(page.locator('.ss-counter')).toHaveText('1 / 2')
  const stage=page.locator('.ss-frame > div').first()
  const bounds=await stage.boundingBox()
  const position=(x,y)=>({x:x*bounds.width/960,y:y*bounds.height/540})
  await expect.poll(async()=>{await stage.hover({position:position(250,105)});return stage.evaluate(element=>element.style.cursor)}).toBe('pointer')
  await stage.click({position:position(250,105)})
  await expect(page.locator('.ss-counter')).toHaveText('1 / 2')
  await stage.click({position:position(165,160)})
  await expect(page.locator('.ss-counter')).toHaveText('2 / 2')
})

test('Web presenter opens and exits without a second display or an unhandled error',{timeout:90000},async t=>{
  const f=await fixture(t),{page}=f
  const {file}=await importFile(f,f.alice.token,await readFile(deckFixture),'presenter.pptx')
  await f.preferences.update(f.alice.token,{theme:'light'})
  await openDeck(f,file.fileId,'light')
  const errors=[]
  page.on('pageerror',error=>errors.push(error.message))
  await page.getByText('Slide Show',{exact:true}).first().click()
  await page.getByRole('button',{name:'Presenter View',exact:true}).click()
  await expect(page.locator('.presenter')).toBeVisible()
  await expect(page.locator('.pv-notes')).toBeVisible()
  await expect(page.getByRole('button',{name:/Swap Displays/})).toHaveCount(0)
  await page.getByRole('button',{name:/End Show/}).click()
  await expect(page.locator('.presenter')).toHaveCount(0)
  assert.deepEqual(errors,[])
})

test('Web Save as Picture downloads a transparent PNG from the selection context menu',{timeout:90000},async t=>{
  const f=await fixture(t),{page}=f
  const {file}=await importFile(f,f.alice.token,await readFile(deckFixture),'picture.pptx')
  await f.preferences.update(f.alice.token,{theme:'light'})
  await openDeck(f,file.fileId,'light')
  const point=await page.evaluate(async()=>{
    const [slide]=await window.slidesApi.getRenderSlides()
    const node=slide.nodes.find(item=>item.type==='text'&&!item.decoration)
    const canvas=document.querySelector('.stage-rel')
    if(!node||!canvas)return null
    const box=canvas.getBoundingClientRect()
    return {x:box.left+node.box.centerX*box.width/slide.widthPx,y:box.top+node.box.centerY*box.height/slide.heightPx}
  })
  assert.ok(point)
  await page.mouse.click(point.x,point.y,{button:'right'})
  const [download]=await Promise.all([
    page.waitForEvent('download',{timeout:8000}),
    page.getByText('Save as Picture…',{exact:true}).click({timeout:6000}),
  ])
  assert.match(download.suggestedFilename(),/\.png$/i)
  const png=await readFile(await download.path())
  assert.deepEqual([...png.subarray(0,8)],[137,80,78,71,13,10,26,10])
  assert.ok(imageSizeFromBytes(png)?.w>0)
  const alpha=PNG.sync.read(png).data.filter((_,index)=>index%4===3)
  assert.ok(alpha.some(value=>value===0)&&alpha.some(value=>value>0))
})

test('Web picture background and shape fill round-trip through a saved PPTX',{timeout:90000},async t=>{
  const f=await fixture(t),{page}=f
  const {file}=await importFile(f,f.alice.token,await readFile(deckFixture),'fill.pptx')
  await f.preferences.update(f.alice.token,{theme:'light'})
  await openDeck(f,file.fileId,'light')
  const errors=[]
  page.on('pageerror',error=>errors.push(error.message))
  await page.getByRole('button',{name:'Design',exact:true}).click()
  await page.getByRole('button',{name:'Format Background',exact:true}).click()
  const [chooser]=await Promise.all([
    page.waitForEvent('filechooser',{timeout:7000}),
    page.getByRole('button',{name:'Picture Fill',exact:true}).click(),
  ])
  const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')
  await chooser.setFiles({name:'tile.png',mimeType:'image/png',buffer:image})
  await expect(page.locator('.fp-bg-preview')).toBeVisible()
  await page.getByRole('button',{name:'Tile',exact:true}).click()
  await expect(page.getByRole('button',{name:'Tile',exact:true})).toHaveClass(/active/)
  await page.getByRole('button',{name:'Apply To All',exact:true}).click()
  await expect.poll(()=>page.evaluate(async()=>{
    const slides=await window.slidesApi.getRenderSlides()
    return slides.every(slide=>slide.background.kind==='image'&&slide.background.mode==='tile')
  })).toBe(true)
  const filled=await page.evaluate(async base64=>{
    const [slide]=await window.slidesApi.getRenderSlides()
    const node=slide.nodes.find(item=>item.type==='text'&&!item.decoration)
    if(!node)return false
    const result=await window.slidesApi.editImageFill({slideIndex:0,targets:[{sourceId:node.sourceId}],mode:'stretch',source:{base64,ext:'png'}})
    return !!result
  },image.toString('base64'))
  assert.equal(filled,true)
  const saved=await page.evaluate(()=>window.slidesApi.save())
  assert.equal(saved.ok,true)
  const revision=(await f.files.openFile(f.alice.token,file.fileId)).file.revision
  assert.notEqual(revision,file.revision)
  const archive=await JSZip.loadAsync(await f.files.readFile(f.alice.token,file.fileId,revision))
  assert.match(await archive.file('ppt/slides/slide1.xml').async('string'),/<a:blipFill rotWithShape="1">/)
  await openDeck(f,file.fileId,'light')
  assert.equal(await page.evaluate(async()=>{
    const slides=await window.slidesApi.getRenderSlides()
    return slides.every(slide=>slide.background.kind==='image'&&slide.background.mode==='tile')
  }),true)
  assert.deepEqual(errors,[])
})

test('Web Edit Points uses the rendered slide width when converting canvas coordinates',{timeout:90000},async t=>{
  const f=await fixture(t),{page}=f
  const session=await openIsolatedPptxSession({fileId:'edit-points-viewport',revision:'r-1',bytes:await readFile(deckFixture)},{unsafeTestOnly:true,timeoutMs:60000})
  t.after(()=>session.close())
  const geometry={x:3000000,y:4500000,cx:2100000,cy:1300000}
  const added=await session.apply(0,[{op:'addElement',target:{slide:0},kind:'rect',offset:geometry,fill:'#137970'}])
  assert.equal(added.transaction.applied,true)
  const {file}=await importFile(f,f.alice.token,Buffer.from((await session.exportBytes(added.generation)).bytes),'edit-points.pptx')
  await f.preferences.update(f.alice.token,{theme:'light'})
  await openDeck(f,file.fileId,'light')
  const points=await page.evaluate(async()=>{
    const [slide]=await window.slidesApi.getRenderSlides()
    const rect=slide.nodes.findLast(node=>node.type==='shape'&&!node.decoration)
    const stage=document.querySelector('.stage-rel')?.getBoundingClientRect()
    if(!rect||!stage)return null
    const sx=stage.width/slide.widthPx,sy=stage.height/slide.heightPx
    return {
      width:slide.widthPx,
      corner:{x:stage.left+rect.box.x*sx,y:stage.top+rect.box.y*sy},
      center:{x:stage.left+rect.box.centerX*sx,y:stage.top+rect.box.centerY*sy},
    }
  })
  assert.ok(points)
  assert.equal(points.width,960)
  await page.mouse.click(points.center.x,points.center.y,{button:'right'})
  await page.getByText('Edit Points',{exact:true}).click()
  const request=page.waitForRequest(candidate=>candidate.url().endsWith('/slides/apply')&&candidate.postDataJSON()?.ops?.[0]?.op==='setShapeCustomGeometry',{timeout:8000})
  await page.mouse.move(points.corner.x,points.corner.y)
  await page.mouse.down()
  await page.mouse.move(points.corner.x+24,points.corner.y+14,{steps:8})
  await page.mouse.up()
  const {ops:[commit]}=(await request).postDataJSON()
  assert.ok(Math.abs(commit.path.w-geometry.cx)<=1)
  assert.ok(Math.abs(commit.path.h-geometry.cy)<=1)
  assert.ok(commit.path.cmds.some(command=>command.pts.some(value=>value!==0&&value!==geometry.cx&&value!==geometry.cy)))
})

test('Web reads existing footer and timed transitions without changing the deck',{timeout:90000},async t=>{
 const f=await fixture(t),{page}=f
 const {openPptx,applyHeaderFooter,savePptx}=await import('@genoffice/pptx-engine')
 const deck=await openPptx(await readFile(deckFixture))
 assert.equal(applyHeaderFooter(deck,{footer:'Existing Web footer',slideNum:true}),true)
 const zip=await JSZip.loadAsync(await savePptx(deck))
 const part='ppt/slides/slide1.xml'
 const xml=await zip.file(part).async('string')
 zip.file(part,xml.replace('</p:sld>','<p:transition advClick="0" advTm="900"><p:fade/></p:transition></p:sld>'))
 const {file}=await importFile(f,f.alice.token,await zip.generateAsync({type:'nodebuffer'}),'show-settings.pptx')
 await f.preferences.update(f.alice.token,{theme:'light'})
 await openDeck(f,file.fileId,'light')
 await page.getByText('Insert',{exact:true}).first().click()
 await page.getByRole('button',{name:'Header & Footer',exact:true}).click()
 const footer=page.getByRole('dialog',{name:'Header and Footer',exact:true})
 await expect(footer.getByRole('checkbox',{name:'Footer',exact:true})).toBeChecked()
 await expect(footer.getByPlaceholder('Footer text')).toHaveValue('Existing Web footer')
 await expect(footer.getByRole('checkbox',{name:'Slide number',exact:true})).toBeChecked()
 await page.keyboard.press('Escape')
 await page.getByText('Transitions',{exact:true}).first().click()
 await expect(page.getByRole('button',{name:'Fade',exact:true})).toHaveClass(/\bactive\b/)
 assert.equal(await page.evaluate(async()=>(await window.slidesApi.getShowTiming(0)).advanceMs),900)
 await page.getByText('Slide Show',{exact:true}).first().click()
 await page.getByRole('button',{name:'From Beginning',exact:true}).click()
 await expect(page.locator('.ss-counter')).toHaveText('2 / 2')
 await page.keyboard.press('Escape')
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
})

test('Web preserves the fixed slide date and reads Morph pairing keys for each rendered page',{timeout:90000},async t=>{
 const f=await fixture(t),{page}=f
 const {openPptx,applyHeaderFooter,setSlideTransition,savePptx}=await import('@genoffice/pptx-engine')
 const deck=await openPptx(await readFile(deckFixture))
 assert.equal(applyHeaderFooter(deck,{date:'Fixed April date',dateAuto:false}),true)
 setSlideTransition(deck.deck.slides[1],'morph')
 const {file}=await importFile(f,f.alice.token,Buffer.from(await savePptx(deck)),'fixed-date-morph.pptx')
 await f.preferences.update(f.alice.token,{theme:'light'})
 await openDeck(f,file.fileId,'light')
 await page.getByText('Insert',{exact:true}).first().click()
 await page.getByRole('button',{name:'Header & Footer',exact:true}).click()
 const footer=page.getByRole('dialog',{name:'Header and Footer',exact:true})
 await expect(footer.getByRole('checkbox',{name:'Date and time',exact:true})).toBeChecked()
 await expect(footer.getByRole('checkbox',{name:/Update automatically/})).not.toBeChecked()
 await expect(footer.getByRole('textbox')).toHaveValue('Fixed April date')
 await footer.getByRole('button',{name:'Apply to All',exact:true}).click()
 await expect.poll(()=>page.evaluate(()=>window.slidesApi.isDirty())).toBe(true)
 assert.equal((await page.evaluate(()=>window.slidesApi.save())).ok,true)
 const saved=(await f.files.openFile(f.alice.token,file.fileId)).file
 const archive=await JSZip.loadAsync(await f.files.readFile(f.alice.token,saved.fileId,saved.revision))
 for(const part of ['ppt/slides/slide1.xml','ppt/slides/slide2.xml']){
  const xml=await archive.file(part).async('string')
  assert.match(xml,/<a:t>Fixed April date<\/a:t>/)
  assert.doesNotMatch(xml,/<a:fld\b[^>]*type="datetime/)
 }
 await openDeck(f,file.fileId,'light')
 const presentation=await page.evaluate(async()=>{
  const slides=await window.slidesApi.getRenderSlides()
  const [first,second,transition]=await Promise.all([
   window.slidesApi.getShapeKeys(0),window.slidesApi.getShapeKeys(1),window.slidesApi.getTransition(1),
  ])
  const sameShape=[first,second].map(keys=>keys.find(key=>key.name==='Shape 3'))
  return {
   transition,
   shapeIds:sameShape.map(key=>key?.spid),
   rendered:sameShape.map((key,index)=>slides[index].nodes.some(node=>!node.decoration&&node.sourceId===key?.sourceId)),
  }
 })
 assert.deepEqual(presentation,{transition:'morph',shapeIds:[3,3],rendered:[true,true]})
})

test('Web saves a pointer-drawn PPTX stroke with its original vector data',{timeout:90000},async t=>{
 const f=await fixture(t),{page}=f
 const {file}=await importFile(f,f.alice.token,await readFile(deckFixture),'ink.pptx')
 await f.preferences.update(f.alice.token,{theme:'light'})
 await openDeck(f,file.fileId,'light')
 await page.getByText('Draw',{exact:true}).first().click()
 await page.getByRole('button',{name:'Pencil',exact:true}).first().click()
 const overlay=page.locator('.ink-overlay').first()
 await expect(overlay).toBeVisible()
 const box=await overlay.boundingBox()
 assert.ok(box)
 await page.route('**/slides/media',async route=>{
  await new Promise(resolve=>setTimeout(resolve,500))
  await route.continue()
 })
 for(const offset of [0,16]){
  await page.mouse.move(box.x+65,box.y+70+offset)
  await page.mouse.down()
  await page.mouse.move(box.x+110,box.y+90+offset,{steps:4})
  await page.mouse.up()
 }
 const readInk=()=>page.evaluate(async()=>{
  const slides=await window.slidesApi.getRenderSlides()
  return slides?.[0].nodes.filter(node=>node.type==='picture'&&node.name?.startsWith('aislides-ink')).map(node=>node.descr)??[]
 })
 await expect.poll(async()=> (await readInk()).length).toBe(2)
 const payload=await readInk()
 assert.ok(payload.every(value=>JSON.parse(value).tool==='pencil'))
 const saved=await page.evaluate(()=>window.slidesApi.save())
 assert.equal(saved.ok,true,JSON.stringify(saved))
 await page.reload()
 await expect(page.locator('.app-main')).toBeVisible({timeout:45000})
 await expect.poll(readInk,{timeout:30000}).toEqual(payload)
 assert.notEqual((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
})


test('Web records microphone narration, saves it, and plays and clears it after reopening',{timeout:90000},async t=>{
  const f=await fixture(t,['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'])
  const {page}=f
  const initial=(await importFile(f,f.alice.token,await readFile(deckFixture),'narration.pptx')).file
  await f.preferences.update(f.alice.token,{theme:'light'})
  await page.context().grantPermissions(['microphone'],{origin:f.origin})
  await openDeck(f,initial.fileId,'light')

  const showTab=page.getByText('Slide Show',{exact:true}).first()
  await showTab.click()
  await page.getByRole('button',{name:'Record',exact:true}).click()
  await page.getByRole('button',{name:'Record from Current Slide',exact:true}).click()
  await expect(page.locator('.ss-record-dot.on')).toBeVisible()
  // The recorder emits data in 1s slices, so wait for a real, decodable take.
  await page.waitForTimeout(1800)
  await page.keyboard.press('Escape')
  const savePrompt=page.locator('.modal').filter({hasText:'Record Narration'})
  await expect(savePrompt).toBeVisible()
  await savePrompt.getByRole('button',{name:'Save',exact:true}).click()
  await expect(savePrompt).toBeHidden()
  const timing=()=>page.evaluate(()=>window.slidesApi.getShowTiming(0))
  await expect.poll(async()=> (await timing()).narrationIds.length).toBe(1)
  assert.ok((await timing()).advanceMs>1000)
  assert.equal((await f.files.openFile(f.alice.token,initial.fileId)).file.revision,initial.revision)

  await page.locator('.ribbon-tab-file').click()
  const [download]=await Promise.all([
    page.waitForEvent('download',{timeout:20000}),
    page.locator('.dyoffice-slides-download').click(),
  ])
  const archive=await JSZip.loadAsync(await readFile(await download.path()))
  const wavParts=archive.file(/^ppt\/media\/.+\.wav$/)
  assert.equal(wavParts.length,1)
  const wav=await wavParts[0].async('nodebuffer')
  assert.equal(wav.subarray(0,4).toString(),'RIFF')

  await openDeck(f,initial.fileId,'light')
  const reopened=await timing()
  assert.equal(reopened.narrationIds.length,1)
  const animations=await page.evaluate(()=>window.slidesApi.getAnimations(0))
  assert.ok(animations.some(item=>item.effect==='mediaPlay'&&item.sourceId===reopened.narrationIds[0]))
  await showTab.click()
  await page.getByRole('button',{name:'From Beginning',exact:true}).click()
  const audio=page.locator('.slideshow audio').first()
  await expect(audio).toHaveAttribute('src',/^blob:/)
  await expect.poll(()=>audio.evaluate(el=>el.currentTime),{intervals:[100,150,200]}).toBeGreaterThan(0)
  await page.keyboard.press('Escape')
  await expect(page.locator('.slideshow')).toHaveCount(0)
  await page.getByRole('button',{name:'Record',exact:true}).click()
  await page.getByRole('button',{name:'Clear Narration on All Slides',exact:true}).click()
  await expect.poll(async()=> (await timing()).narrationIds.length).toBe(0)

  // Exercise the browser stop and keep-take path using a shortened normal limit.
  await page.evaluate(()=>Object.assign(window.slidesApi.recordingLimits,{totalMs:1200}))
  await page.getByRole('button',{name:'Record',exact:true}).click()
  await page.getByRole('button',{name:'Record from Current Slide',exact:true}).click()
  await expect(savePrompt.getByText('Recording stopped at the Web recording limit. You can save this take.')).toBeVisible()
  await expect(savePrompt.getByRole('button',{name:'Save',exact:true})).toBeEnabled()
  await savePrompt.getByRole('button',{name:"Don't Save",exact:true}).click()
})

test('Web drops a mixed batch of pictures and audio on one slide and preserves the saved bytes',{timeout:90000},async t=>{
  const f=await fixture(t),{page}=f
  await f.preferences.update(f.alice.token,{theme:'light'})
  const original=await readFile(deckFixture)
  const {file}=await importFile(f,f.alice.token,original,'Mixed media drop.pptx')
  await openDeck(f,file.fileId,'light')
  const files=['image/png','image/png','application/octet-stream'].map((type,index)=>{
    const image=new PNG({width:16+index*4,height:12})
    image.data.fill(40+index*75)
    return {name:`drop-${index}.PNG`,type,bytes:PNG.sync.write(image)}
  })
  const audio=Buffer.alloc(44+320)
  audio.write('RIFF');audio.writeUInt32LE(audio.length-8,4);audio.write('WAVEfmt ',8)
  audio.writeUInt32LE(16,16);audio.writeUInt16LE(1,20);audio.writeUInt16LE(1,22)
  audio.writeUInt32LE(8000,24);audio.writeUInt32LE(16000,28);audio.writeUInt16LE(2,32);audio.writeUInt16LE(16,34)
  audio.write('data',36);audio.writeUInt32LE(audio.length-44,40)
  files.splice(1,0,{name:'note.wav',type:'',bytes:audio})
  const nodes=()=>page.evaluate(async()=> (await window.slidesApi.getRenderSlides())[0].nodes)
  const initialNodeCount=(await nodes()).length
  const mediaKinds=async()=> (await nodes()).slice(initialNodeCount).map(node=>node.media??node.type)
  await page.locator('.stage-rel').evaluate((stage,files)=>{
    const transfer=new DataTransfer()
    for(const {name,type,base64} of files)transfer.items.add(new File([Uint8Array.from(atob(base64),value=>value.charCodeAt(0))],name,{type}))
    const rect=stage.getBoundingClientRect()
    stage.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer,clientX:rect.left+rect.width/3,clientY:rect.top+rect.height/3}))
  },files.map(({name,type,bytes})=>({name,type,base64:bytes.toString('base64')})))
  await expect.poll(mediaKinds,{timeout:15000}).toEqual(['picture','audio','picture','picture'])
  await page.keyboard.press('ControlOrMeta+s')
  const revision=async()=> (await f.files.openFile(f.alice.token,file.fileId)).file.revision
  await expect.poll(revision).not.toBe(file.revision)
  const saved=await JSZip.loadAsync(await f.files.readFile(f.alice.token,file.fileId,await revision()))
  const savedMedia=await Promise.all(saved.file(/^ppt\/media\//).map(part=>part.async('nodebuffer')))
  for(const {name,bytes} of files)assert.ok(savedMedia.some(part=>part.equals(bytes)),name)
  assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
  await openDeck(f,file.fileId,'light')
  await expect.poll(mediaKinds).toEqual(['picture','audio','picture','picture'])
})

test('Web inserts embedded video and audio, then reopens and plays the saved deck',{timeout:90000},async t=>{
  const f=await fixture(t),{page}=f
  await page.goto(f.origin+'/api/v1/auth/csrf')
  const encoded=await page.evaluate(async()=>{
    const canvas=document.createElement('canvas')
    canvas.width=64
    canvas.height=48
    const context=canvas.getContext('2d')
    const stream=canvas.captureStream(25)
    const recorder=new MediaRecorder(stream,{mimeType:'video/webm'})
    const chunks=[]
    recorder.addEventListener('dataavailable',event=>chunks.push(event.data))
    const stopped=new Promise(resolve=> recorder.addEventListener('stop',resolve,{once:true}))
    recorder.start()
    for(let frame=0;frame<30;frame++){
      context.fillStyle=frame%2?'#bf4221':'#154582'
      context.fillRect(0,0,64,48)
      await new Promise(resolve=>setTimeout(resolve,40))
    }
    recorder.stop()
    await stopped
    stream.getTracks().forEach(track=>track.stop())
    const bytes=new Uint8Array(await new Blob(chunks).arrayBuffer())
    return btoa(String.fromCharCode(...bytes))
  })
  const video=Buffer.from(encoded,'base64')
  const {file}=await importFile(f,f.alice.token,await readFile(deckFixture),'embedded-video.pptx')
  await f.preferences.update(f.alice.token,{theme:'light'})
  await openDeck(f,file.fileId,'light')
  await page.getByRole('button',{name:'Insert',exact:true}).click()
  const insert=page.getByRole('button',{name:'Video',exact:true})
  await expect(insert).toBeEnabled()
  const rejected=page.waitForResponse(response=>response.url().endsWith('/slides/embedded-media'))
  await assert.rejects(page.evaluate(async()=>window.slidesApi.addMediaBytes({slideIndex:0,kind:'video',ext:'webm',fitWidthPx:960,base64:btoa('plain text, not a media file')})),/supported audio or video/)
  assert.equal((await rejected).status(),400)
  const chooser=page.waitForEvent('filechooser')
  await insert.click()
  await (await chooser).setFiles({name:'clip.webm',mimeType:'video/webm',buffer:video})
  await expect.poll(()=>page.evaluate(async()=> (await window.slidesApi.getRenderSlides())[0].nodes.some(node=>node.media==='video'))).toBe(true)
  const center=await page.evaluate(async()=>{
    const [slide]=await window.slidesApi.getRenderSlides()
    const node=slide.nodes.find(node=>node.media==='video')
    const stage=document.querySelector('.stage-rel')?.getBoundingClientRect()
    if(!node||!stage)return null
    return {x:stage.left+node.box.centerX*stage.width/slide.widthPx,
      y:stage.top+node.box.centerY*stage.height/slide.heightPx}
  })
  assert.ok(center)
  await page.mouse.dblclick(center.x,center.y)
  const editorVideo=page.locator('.stage-rel video')
  await expect(editorVideo).toHaveAttribute('src',/^blob:/)
  await expect.poll(()=>editorVideo.evaluate(el=>el.currentTime)).toBeGreaterThan(0)
  await page.keyboard.press('Escape')
  await expect(editorVideo).toHaveCount(0)

  await page.getByText('Slide Show',{exact:true}).first().click()
  await page.getByRole('button',{name:'From Beginning',exact:true}).click()
  const showVideo=page.locator('.slideshow video')
  await expect(showVideo).toHaveAttribute('src',/^blob:/)
  await showVideo.click()
  await expect.poll(()=>showVideo.evaluate(el=>el.currentTime)).toBeGreaterThan(0)
  await page.keyboard.press('Escape')
  await expect(page.locator('.slideshow')).toHaveCount(0)

  const audio=Buffer.alloc(44+1600)
  audio.write('RIFF',0);audio.writeUInt32LE(audio.length-8,4);audio.write('WAVEfmt ',8)
  audio.writeUInt32LE(16,16);audio.writeUInt16LE(1,20);audio.writeUInt16LE(1,22)
  audio.writeUInt32LE(8000,24);audio.writeUInt32LE(16000,28);audio.writeUInt16LE(2,32);audio.writeUInt16LE(16,34)
  audio.write('data',36);audio.writeUInt32LE(audio.length-44,40)
  for(let i=0;i<800;i++)audio.writeInt16LE(Math.round(Math.sin(i/8)*4000),44+i*2)
  await page.locator('.stage-rel').evaluate((stage,bytes)=>{
    const transfer=new DataTransfer()
    transfer.items.add(new File([Uint8Array.from(bytes)],'note.wav',{type:'audio/wav'}))
    const rect=stage.getBoundingClientRect()
    stage.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer,clientX:rect.left+rect.width/4,clientY:rect.top+rect.height/4}))
  },[...audio])
  const mediaKinds=()=>page.evaluate(async()=> (await window.slidesApi.getRenderSlides())[0].nodes.map(node=>node.media).filter(Boolean).sort())
  await expect.poll(mediaKinds).toEqual(['audio','video'])
  await page.locator('button.qa-btn[aria-label^="Undo"]').click()
  await expect.poll(mediaKinds).toEqual(['video'])
  await page.locator('button.qa-btn[aria-label^="Redo"]').click()
  await expect.poll(mediaKinds).toEqual(['audio','video'])
  await page.keyboard.press('ControlOrMeta+s')
  const revision=async()=> (await f.files.openFile(f.alice.token,file.fileId)).file.revision
  await expect.poll(revision).not.toBe(file.revision)
  const zip=await JSZip.loadAsync(await f.files.readFile(f.alice.token,file.fileId,await revision()))
  assert.deepEqual(await zip.file(/^ppt\/media\/.*\.webm$/)[0]?.async('nodebuffer'),video)
  assert.deepEqual(await zip.file(/^ppt\/media\/.*\.wav$/)[0]?.async('nodebuffer'),audio)
  await openDeck(f,file.fileId,'light')
  await expect.poll(mediaKinds).toEqual(['audio','video'])
})

test('Web migrates legacy custom shows through duplicate names and rename',{timeout:90000},async t=>{
 const f=await fixture(t),{page}=f
 await f.preferences.update(f.alice.token,{theme:'light'})
 const bytes=await readFile(deckFixture),name='Same display name.pptx'
 const first=(await importFile(f,f.alice.token,bytes,name)).file
 const second=(await importFile(f,f.alice.token,bytes,name)).file
 assert.notEqual(first.fileId,second.fileId)
 assert.equal(first.name,second.name)
 const openShows=async()=>{
  const button=page.getByRole('button',{name:'Custom Slide Show',exact:true})
  if(!await button.isVisible())await page.getByText('Slide Show',{exact:true}).first().click()
  await button.click()
  return page.getByRole('dialog',{name:'Custom Shows'})
 }
 await openDeck(f,first.fileId,'light')
 const legacyKey='ai-slides-custom-shows:workspace:'+first.fileId
 await page.evaluate(key=>localStorage.setItem(key,JSON.stringify([
  {id:'legacy',name:'First deck only',slideIndices:[0]},
 ])),legacyKey)
 const one=await openShows()
 await expect(one.getByRole('option',{name:/First deck only/})).toBeVisible()
 await one.getByPlaceholder('Custom show name').fill('Migrated deck show')
 await one.getByRole('button',{name:'Close',exact:true}).click()
 await expect(one).toHaveCount(0)
 assert.ok(await page.evaluate(key=>localStorage.getItem(key),legacyKey))
 await page.locator('.thumb').nth(1).click({button:'right'})
 await page.getByText('New Slide',{exact:true}).click()
 await expect(page.locator('.thumb')).toHaveCount(3)
 await page.locator('button.qa-btn[aria-label^="Undo"]').click()
 await expect(page.locator('.thumb')).toHaveCount(2)
 const afterUndo=await openShows()
 await expect(afterUndo.getByRole('option',{name:/Migrated deck show/})).toBeVisible()
 await expect(afterUndo.getByRole('option',{name:/First deck only/})).toHaveCount(0)
 await afterUndo.getByRole('button',{name:'Close',exact:true}).click()
 await expect(afterUndo).toHaveCount(0)
 await page.keyboard.press('Control+s')
 await expect(page.locator('.status-msg')).toContainText('Saved')
 assert.equal(await page.evaluate(key=>localStorage.getItem(key),legacyKey),null)

 await openDeck(f,second.fileId,'light')
 const two=await openShows()
 await expect(two.getByText('No custom shows yet')).toBeVisible()

 await f.files.renameFile(f.alice.token,first.fileId,'Renamed slides.pptx')
 await openDeck(f,first.fileId,'light')
 const reopened=await openShows()
 await expect(reopened.getByRole('option',{name:/Migrated deck show/})).toBeVisible()
 await expect(reopened.getByRole('option',{name:/Second deck only/})).toHaveCount(0)
 await expect(reopened.getByRole('checkbox',{name:'Slide 1',exact:true})).toBeChecked()
})

test('Web custom shows round-trip in PPTX and keep the intended slides after reordering',{timeout:90000},async t=>{
 const f=await fixture(t),{page}=f
 await f.preferences.update(f.alice.token,{theme:'light'})
 const path='ppt/presentation.xml'
 const zip=await JSZip.loadAsync(await readFile(deckFixture))
 zip.file(path,(await zip.file(path).async('string')).replace('</p:presentation>',
  '<p:custShowLst><p:custShow name="Imported reverse order" id="1"><p:sldLst><p:sld r:id="rId3"/><p:sld r:id="rId2"/></p:sldLst></p:custShow></p:custShowLst></p:presentation>'))
 const {file}=await importFile(f,f.alice.token,await zip.generateAsync({type:'nodebuffer'}),'Custom show links.pptx')
 const showDialog=async()=>{
  await page.getByText('Slide Show',{exact:true}).first().click()
  await page.getByRole('button',{name:'Custom Slide Show',exact:true}).click()
  return page.getByRole('dialog',{name:'Custom Shows'})
 }
 const getPaths=()=>page.evaluate(async()=> (await window.slidesApi.getRenderSlides()).map(s=>s.partPath))
 await openDeck(f,file.fileId,'light')
 const initial=await getPaths()
 const dialog=await showDialog()
 await expect(dialog.getByRole('option',{name:/Imported reverse order/})).toBeVisible()
 await dialog.getByRole('button',{name:'New',exact:true}).click()
 await dialog.getByPlaceholder('Custom show name').fill('Second slide only')
 await dialog.getByRole('checkbox',{name:'Slide 2',exact:true}).check()
 await dialog.getByRole('button',{name:'Close',exact:true}).click()
 await expect(dialog).toHaveCount(0)
 await page.evaluate(async()=>{
  await window.slidesApi.moveSlides({slideIndexes:[1],insertAt:0,fitWidthPx:960})
  if(!(await window.slidesApi.save()).ok)throw Error('Could not save reordered deck')
 })
 const current=(await f.files.openFile(f.alice.token,file.fileId)).file
 const saved=await JSZip.loadAsync(await f.files.readFile(f.alice.token,file.fileId,current.revision))
 const xml=await saved.file(path).async('string')
 assert.match(xml,/<p:custShow name="Imported reverse order"/)
 assert.match(xml,/<p:custShow name="Second slide only"/)
 await page.evaluate(()=>localStorage.clear())
 await openDeck(f,file.fileId,'light')
 assert.deepEqual(await getPaths(),initial.toReversed())
 const reopened=await showDialog()
 await reopened.getByRole('option',{name:/Second slide only/}).click()
 await expect(reopened.getByRole('checkbox',{name:'Slide 1',exact:true})).toBeChecked()
 await expect(reopened.getByRole('checkbox',{name:'Slide 2',exact:true})).not.toBeChecked()
})

test('Web reference lines stay with the workspace file through duplicate names and rename',{timeout:90000},async t=>{
 const f=await fixture(t),{page}=f
 await f.preferences.update(f.alice.token,{theme:'light'})
 const bytes=await readFile(deckFixture),name='Same guide name.pptx'
 const first=(await importFile(f,f.alice.token,bytes,name)).file
 const second=(await importFile(f,f.alice.token,bytes,name)).file
 assert.notEqual(first.fileId,second.fileId)
 const reveal=async()=>{
  await page.getByText('View',{exact:true}).first().click()
  const guide=page.locator('.guide-draggable.guide-v').first()
  if(!await guide.isVisible())await page.getByRole('button',{name:'Guides',exact:true}).click()
  await expect(guide).toBeVisible()
  return guide
 }
 await openDeck(f,first.fileId,'light')
 const a=await reveal()
 await expect(a).toHaveAttribute('style',/left: 50%/)
 const rect=await a.boundingBox()
 assert.ok(rect)
 const x=rect.x+rect.width/2,y=rect.y+rect.height*.25
 await page.mouse.move(x,y)
 await page.mouse.down()
 await page.mouse.move(x+70,y,{steps:7})
 await page.mouse.up()
 await expect(a).not.toHaveAttribute('style',/left: 50%/)
 const position=await a.getAttribute('style')
 await openDeck(f,second.fileId,'light')
 const b=await reveal()
 await expect(b).toHaveAttribute('style',/left: 50%/)
 await f.files.renameFile(f.alice.token,first.fileId,'Renamed guides.pptx')
 await openDeck(f,first.fileId,'light')
 await expect(await reveal()).toHaveAttribute('style',position)
})

test('Web shows speaker notes from a read-only presentation without offering note editing',{timeout:90000},async t=>{
 const f=await fixture(t),{page}=f
 const {openPptx,savePptx,setSlideNotes,getSlideNotes}=await import('@genoffice/pptx-engine')
 // Exercise the protected package path. Its signature marker remains present
 // after the synthetic note is added by the fixture, so the Web host opens it read-only.
 const bytes=await readFile(new URL('../fixtures/signed-office/hello-world-signed.pptx',import.meta.url))
 const source=await openPptx(bytes)
 const notes='Existing notes on an immutable test presentation'
 assert.equal(setSlideNotes(source,0,notes),true)
 const payload=await savePptx(source),reloaded=await openPptx(payload)
 assert.equal(getSlideNotes(reloaded.archive,reloaded.deck.slides[0].path),notes)
 const {file}=await importFile(f,f.alice.token,Buffer.from(payload),'Readonly notes.pptx')
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).officeSignatureProtected,true)
 await page.goto(f.origin+'/native-pptx/?fileId='+file.fileId)
 await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready',{timeout:45000})
 await expect(page.getByText('Signed file opened read only',{exact:true})).toBeVisible()
 const editor=page.locator('.notes-pane textarea')
 await expect(editor).toHaveValue(notes,{timeout:15000})
 await expect(editor).toHaveAttribute('readonly','')
 await page.getByText('Slide Show',{exact:true}).first().click()
 await page.getByRole('button',{name:'Presenter View',exact:true}).click()
 await expect(page.locator('.pv-notes')).toContainText(notes)
})

test('PPTX shows section edits in the thumbnail rail through history and reopen',{timeout:120000},async t=>{
  const f=await fixture(t),{page}=f
  await f.preferences.update(f.alice.token,{theme:'light'})
  const {file}=await importFile(f,f.alice.token,await readFile(deckFixture),'Section history.pptx')
  await openDeck(f,file.fileId,'light')
  const titles=page.locator('.section-header .section-name')
  const thumbnails=page.locator('.thumb')
  await expect(thumbnails).toHaveCount(2)
  await thumbnails.nth(1).click({button:'right'})
  await page.getByText('Add Section (before this slide)',{exact:true}).click()
  await expect(titles).toHaveText(['Default Section','Untitled Section'])

  const undo=page.getByRole('button',{name:'Undo',exact:true})
  const redo=page.getByRole('button',{name:'Redo',exact:true})
  await undo.click()
  await expect(titles).toHaveCount(0)
  await redo.click()
  await expect(titles).toHaveText(['Default Section','Untitled Section'])

  await page.locator('.section-header').nth(1).click({button:'right'})
  await page.getByText('Move Section Up',{exact:true}).click()
  await expect(titles).toHaveText(['Untitled Section','Default Section'])
  await page.locator('.section-header').first().click({button:'right'})
  await page.getByText('Remove Section & Slides',{exact:true}).click()
  await expect(thumbnails).toHaveCount(1)
  await expect(titles).toHaveText(['Default Section'])
  await undo.click()
  await expect(thumbnails).toHaveCount(2)
  await expect(titles).toHaveText(['Untitled Section','Default Section'])

  assert.equal((await page.evaluate(()=>window.slidesApi.save())).ok,true)
  await openDeck(f,file.fileId,'light')
  await expect(titles).toHaveText(['Untitled Section','Default Section'])
})

test('PPTX copies whole slides across browser tabs and respects external clipboard replacement',{timeout:110000},async t=>{
  const f=await fixture(t),{page,origin}=f
  await f.preferences.update(f.alice.token,{theme:'light'})
  const bytes=await readFile(deckFixture)
  const source=(await importFile(f,f.alice.token,bytes,'Clipboard source.pptx')).file
  const target=(await importFile(f,f.alice.token,bytes,'Clipboard target.pptx')).file
  await openDeck(f,source.fileId,'light')
  const destination=await page.context().newPage()
  await openDeck({...f,page:destination},target.fileId,'light')
  await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin})

  await page.bringToFront()
  await page.locator('.thumb').first().click({button:'right'})
  await page.getByText('Copy Slide',{exact:true}).click()
  await expect.poll(()=>page.evaluate(async()=> (await navigator.clipboard.read()).flatMap(item=>item.types)))
    .toContain('web application/x-dyoffice-slide-reference')

  await destination.bringToFront()
  assert.deepEqual(await destination.evaluate(()=>window.slidesApi.clipboardExternal()),{kind:'slide'})
  const thumbnails=destination.locator('.thumb')
  await thumbnails.first().click({button:'right'})
  const paste=destination.getByText('Paste Slide',{exact:true})
  await expect(paste).toBeEnabled()
  await paste.click()
  await expect(thumbnails).toHaveCount(3)

  await destination.evaluate(()=>navigator.clipboard.writeText('External clipboard text'))
  await thumbnails.first().click({button:'right'})
  await expect(paste).toBeDisabled()
  assert.deepEqual(await destination.evaluate(()=>window.slidesApi.clipboardExternal()),{kind:'text',text:'External clipboard text'})
  assert.equal(await destination.evaluate(()=>window.slidesApi.pasteSlide({afterIndex:0,fitWidthPx:960})),null)
  await expect(thumbnails).toHaveCount(3)
})

test('PPTX pastes a copied object as an editable shape across browser tabs',{timeout:110000},async t=>{
  const f=await fixture(t),{page,origin}=f
  await f.preferences.update(f.alice.token,{theme:'light'})
  const bytes=await readFile(deckFixture)
  const source=(await importFile(f,f.alice.token,bytes,'Object source.pptx')).file
  const target=(await importFile(f,f.alice.token,bytes,'Object target.pptx')).file
  await openDeck(f,source.fileId,'light')
  const destination=await page.context().newPage()
  await openDeck({...f,page:destination},target.fileId,'light')
  await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin})

  const label='Editable clipboard shape'
  const png=PNG.sync.write({width:1,height:1,data:Buffer.from([255,0,0,255])}).toString('base64')
  await page.bringToFront()
  assert.equal(await page.evaluate(async ({label,png})=>{
    const {sourceId}=await window.slidesApi.addElement({slideIndex:0,kind:'textbox',xPx:90,yPx:90,wPx:225,hPx:70,fitWidthPx:960,text:label})
    const clipboardToken=crypto.randomUUID()
    return await window.slidesApi.copyElements({slideIndex:0,sourceIds:[sourceId],clipboardToken})===1
      && await window.slidesApi.copyElementsImage(clipboardToken,png)
  },{label,png}),true)

  await destination.bringToFront()
  const formats=await destination.evaluate(async()=> (await navigator.clipboard.read()).flatMap(item=>item.types))
  assert.ok(formats.includes('web application/x-dyoffice-slide-reference'))
  assert.ok(formats.includes('image/png'))
  await destination.locator('.thumb').first().click()
  await destination.keyboard.press('Control+v')
  await expect.poll(()=>destination.evaluate(async text=>{
    const [first]=await window.slidesApi.getRenderSlides()
    return first.nodes.some(node=>node.text?.lines.flatMap(line=>line.runs.map(run=>run.text)).join('')===text)
  },label)).toBe(true)

  const pictureCount=()=>destination.evaluate(async()=>{
    const [first]=await window.slidesApi.getRenderSlides()
    return first.nodes.filter(node=>node.type==='picture').length
  })
  const before=await pictureCount()
  // The system clipboard can outlive the server-side editable bundle.
  await destination.route('**/slides/clipboard-paste',route=>route.fulfill({json:null,contentType:'application/json'}))
  await destination.keyboard.press('Control+v')
  await expect.poll(pictureCount).toBe(before+1)
})

test('Ctrl+S names an untitled presentation from the first slide once', {timeout:90000},async t=>{
  const f=await fixture(t),{page}=f
  const bytes=await readFile(new URL('../../../shell/build/shell-new/blank.pptx',import.meta.url))
  const upload=await f.files.stageUpload(f.alice.token,{name:'未命名.pptx',size:bytes.length,autoName:true})
  await f.files.receiveUpload(f.alice.token,upload.uploadId,bytes)
  const {file}=await f.files.finishUpload(f.alice.token,upload.uploadId)
  await page.goto(f.origin+'/native-pptx/?fileId='+file.fileId)
  await expect(page.locator('.app-main')).toBeVisible({timeout:45000})
  await expect.poll(()=>page.evaluate(async()=>(await window.slidesApi?.getRenderSlides())?.length??0),{timeout:30000}).toBeGreaterThan(0)
  const title='季度工作回顾'
  const added=await page.evaluate(text=>window.slidesApi.addElement({slideIndex:0,kind:'textbox',xPx:40,yPx:40,wPx:360,hPx:60,fitWidthPx:960,text}),title)
  assert.ok(added?.sourceId)
  const save=async()=>{
    const [commit]=await Promise.all([page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/v1/files/'+file.fileId+'/commits',{timeout:15000}),page.keyboard.press('Control+s')])
    assert.ok(commit.ok(),'commit status '+commit.status())
  }
  await save()
  const name=async()=>(await f.files.openFile(f.alice.token,file.fileId)).name
  await expect.poll(name,{timeout:10000}).toBe(title+'.pptx')
  await expect(page.locator('.qa-btn.qa-name-with-ai')).toHaveCount(0)
  const next=await page.evaluate(()=>window.slidesApi.addElement({slideIndex:0,kind:'textbox',xPx:40,yPx:140,wPx:360,hPx:60,fitWidthPx:960,text:'补充说明'}))
  assert.ok(next?.sourceId)
  await save()
  assert.equal(await name(),title+'.pptx')
})

test('Web screen recording embeds the chosen capture and handles a cancelled picker',{timeout:90000},async t=>{
  const f=await fixture(t),{page}=f
  await f.preferences.update(f.alice.token,{theme:'light',autoSave:false})
  await page.addInitScript(()=>{
    window.cancelCapture=true;window.screenCaptureFrames=0
    if(!navigator.mediaDevices)return
    navigator.mediaDevices.getDisplayMedia=async()=>{
      if(window.cancelCapture)throw new DOMException('Selection cancelled','NotAllowedError')
      const canvas=document.createElement('canvas')
      canvas.width=96;canvas.height=64
      const ctx=canvas.getContext('2d'),stream=canvas.captureStream(20)
      const track=stream.getVideoTracks()[0]
      window.screenCaptureTrack=track
      let frame=0
      const paint=()=>{ctx.fillStyle=(window.screenCaptureFrames=++frame)%2?'#154582':'#bf4221';ctx.fillRect(0,0,96,64)}
      paint()
      const timer=setInterval(()=>{if(track.readyState==='ended')clearInterval(timer);else paint()},50)
      return stream
    }
  })
  const {file}=await importFile(f,f.alice.token,await readFile(deckFixture),'recorded-screen.pptx')
  await openDeck(f,file.fileId,'light')
  await page.getByRole('button',{name:'Insert',exact:true}).click()
  const start=page.getByRole('button',{name:'Screen Recording',exact:true})
  const stop=page.getByRole('button',{name:'Stop Recording',exact:true})
  await expect(start).toBeEnabled()
  await start.click()
  await expect(page.locator('.status-msg')).toContainText('Screen recording unavailable')
  assert.equal(await page.evaluate(()=>window.slidesApi.isDirty()),false)
  await page.evaluate(()=>{window.cancelCapture=false})
  await start.click()
  await expect(stop).toBeVisible()
  assert.equal(await page.evaluate(()=>window.dyofficeEditorCanSleep()),false)
  await expect.poll(()=>page.evaluate(()=>window.screenCaptureTrack?.readyState)).toBe('live')
  await page.waitForFunction(()=>window.screenCaptureFrames>=5)
  await page.locator('.thumb').nth(1).click()
  await stop.click()
  await expect(page.locator('.status-msg')).toContainText('Screen recording inserted')
  assert.equal(await page.evaluate(()=>window.screenCaptureTrack.readyState),'ended')
  assert.equal(await page.evaluate(()=>window.dyofficeEditorCanSleep()),true)
  const hasVideo=()=>page.evaluate(async()=> (await window.slidesApi.getRenderSlides())[0].nodes.some(node=>node.media==='video'))
  await expect.poll(hasVideo).toBe(true)
  await page.keyboard.press('ControlOrMeta+s')
  const revision=async()=> (await f.files.openFile(f.alice.token,file.fileId)).file.revision
  await expect.poll(revision).not.toBe(file.revision)
  const zip=await JSZip.loadAsync(await f.files.readFile(f.alice.token,file.fileId,await revision()))
  assert.equal(zip.file(/^ppt\/media\/.*\.webm$/).length,1)
  await openDeck(f,file.fileId,'light')
  await expect.poll(hasVideo).toBe(true)
  await page.getByRole('button',{name:'Slide Show',exact:true}).click()
  await page.getByRole('button',{name:'From Beginning',exact:true}).click()
  const player=page.locator('.slideshow video')
  await expect(player).toHaveAttribute('src',/^blob:/)
  await player.click()
  await expect.poll(()=>player.evaluate(video=>video.currentTime)).toBeGreaterThan(0)
  await page.keyboard.press('Escape')
})

test('PPTX exports a playable MP4 from the visible slides of the current Web draft',{timeout:120000},async t=>{
  const f=await fixture(t),{page}=f
  await f.preferences.update(f.alice.token,{theme:'light',autoSave:false})
  const archive=await JSZip.loadAsync(await readFile(deckFixture))
  const hidden='ppt/slides/slide2.xml'
  archive.file(hidden,(await archive.file(hidden).async('string')).replace(/<p:sld(?=\s)/,'<p:sld show="0"'))
  const {file}=await importFile(f,f.alice.token,await archive.generateAsync({type:'nodebuffer'}),'Quarterly review.pptx')
  await openDeck(f,file.fileId,'light')
  await page.getByRole('button',{name:'Design',exact:true}).click()
  await page.getByRole('button',{name:'Slide Size',exact:true}).click()
  await page.getByRole('button',{name:'Standard (4:3)',exact:true}).click()
  await expect.poll(()=>page.evaluate(()=>window.slidesApi.getSlideSize())).toEqual({cx:9144000,cy:6858000})
  await page.locator('.ribbon-tab-file').click()
  const exportVideo=page.getByRole('button',{name:'Export as Video (MP4)…',exact:true})
  await expect(exportVideo).toBeEnabled()
  await exportVideo.click()
  const dialog=page.locator('.export-video-dialog')
  await dialog.getByLabel('Resolution').selectOption('720')
  await dialog.getByLabel('Seconds spent on each slide').fill('1')
  const [download]=await Promise.all([
    page.waitForEvent('download',{timeout:45000}),
    dialog.getByRole('button',{name:'Create Video',exact:true}).click(),
  ])
  assert.equal(download.suggestedFilename(),'Quarterly review.mp4')
  const encoded=await readFile(await download.path())
  assert.equal(encoded.toString('ascii',4,8),'ftyp')
  const metadata=await page.evaluate(base64=>new Promise((resolve,reject)=>{
    const video=document.createElement('video')
    const data=Uint8Array.from(atob(base64),c=>c.charCodeAt(0))
    const url=URL.createObjectURL(new Blob([data],{type:'video/mp4'}))
    video.onloadeddata=()=>{
      resolve({width:video.videoWidth,height:video.videoHeight,duration:video.duration})
      URL.revokeObjectURL(url)
    }
    video.onerror=()=>{URL.revokeObjectURL(url);reject(Error(video.error?.message||'MP4 playback failed'))}
    video.preload='auto'
    video.src=url
  }),encoded.toString('base64'))
  assert.equal(metadata.width,960)
  assert.equal(metadata.height,720)
  assert.ok(metadata.duration>=0.95&&metadata.duration<1.2,JSON.stringify(metadata))
  assert.equal(await page.evaluate(()=>window.slidesApi.isDirty()),true)
  assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)

  const wav=Buffer.alloc(44+1600)
  wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8)
  wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22)
  wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34)
  wav.write('data',36);wav.writeUInt32LE(1600,40)
  for(let i=0;i<800;i++)wav.writeInt16LE(Math.round(Math.sin(i/8)*4000),44+i*2)
  await page.evaluate(wavBase64=>window.slidesApi.saveRecording({slides:[{slideIndex:0,wavBase64,durationMs:100,advanceMs:1000}]}),wav.toString('base64'))
  const aac=await page.evaluate(async()=>typeof AudioEncoder==='function'&&(await AudioEncoder.isConfigSupported({codec:'mp4a.40.2',sampleRate:48000,numberOfChannels:1,bitrate:96000})).supported)
  await page.locator('.ribbon-tab-file').click()
  await exportVideo.click()
  await dialog.getByLabel('Resolution').selectOption('720')
  await expect(dialog.getByRole('checkbox',{name:/Use recorded timings/})).toBeChecked()
  const create=dialog.getByRole('button',{name:'Create Video',exact:true})
  if(aac){
    const [withNarration]=await Promise.all([page.waitForEvent('download',{timeout:45000}),create.click()])
    assert.ok((await readFile(await withNarration.path())).includes(Buffer.from('soun')))
  }else{
    const stray=[]
    page.on('download',value=>stray.push(value))
    await create.click()
    await expect(page.locator('.status-msg')).toContainText('cannot encode AAC narration')
    await expect(dialog).toHaveCount(0)
    assert.equal(stray.length,0)
  }
})

test('Web inserts and turns a real GLB model and preserves it after saving',{timeout:90000},async t=>{
  const f=await fixture(t,['--use-angle=swiftshader','--enable-unsafe-swiftshader']),{page}=f
  await f.preferences.update(f.alice.token,{theme:'light',autoSave:false})
  const positions=Buffer.alloc(36)
  ;[-1,-1,0,1,-1,0,0,1,0].forEach((value,index)=>positions.writeFloatLE(value,index*4))
  const model={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],
    meshes:[{primitives:[{attributes:{POSITION:0}}]}],buffers:[{
      byteLength:positions.length,uri:'data:application/octet-stream;base64,'+positions.toString('base64'),
    }],
    bufferViews:[{buffer:0,byteLength:positions.length}],
    accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[-1,-1,0],max:[1,1,0]}]}
  function glb(content){
    const json=Buffer.from(JSON.stringify(content))
    const jsonSize=Math.ceil(json.length/4)*4
    const output=Buffer.alloc(20+jsonSize,0x20)
    output.writeUInt32LE(0x46546c67,0);output.writeUInt32LE(2,4);output.writeUInt32LE(output.length,8)
    output.writeUInt32LE(jsonSize,12);output.writeUInt32LE(0x4e4f534a,16);json.copy(output,20)
    return output
  }
  const bytes=glb(model)
  const {file}=await importFile(f,f.alice.token,await readFile(deckFixture),'Model demo.pptx')
  await openDeck(f,file.fileId,'light')
  await page.getByRole('button',{name:'Insert',exact:true}).click()
  const insert=page.getByRole('button',{name:'3D Models',exact:true})
  await expect(insert).toBeEnabled()
  const acceptedExternalBuffer=await page.evaluate(async base64=>{
    const bytes=Uint8Array.from(atob(base64),character=>character.charCodeAt(0))
    try{await window.slidesApi.addModel3d({slideIndex:0,bytes,name:'external.glb',aspect:1,fitWidthPx:960});return true}
    catch{return false}
  },glb({...model,buffers:[{byteLength:positions.length,uri:'external.bin'}]}).toString('base64'))
  assert.equal(acceptedExternalBuffer,false)
  const chosen=page.waitForEvent('filechooser')
  await insert.click()
  await (await chosen).setFiles({name:'triangle.glb',mimeType:'model/gltf-binary',buffer:bytes})
  const getModel=()=>page.evaluate(async()=> (await window.slidesApi.getRenderSlides())[0].nodes.find(node=>node.model3d)?.model3d??null)
  const getPoster=()=>page.evaluate(async()=> (await window.slidesApi.getRenderSlides())[0].nodes.find(node=>node.model3d)?.dataUrl??'')
  await expect.poll(getModel,{timeout:15000}).toEqual({ax:0,ay:0,az:0})
  const originalPoster=await getPoster()
  assert.match(originalPoster,/^data:image\/png;base64,/)
  const handle=page.getByRole('button',{name:'Drag to turn the 3D model',exact:true})
  await expect(handle).toBeVisible()
  const box=await handle.boundingBox()
  assert.ok(box)
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2)
  await page.mouse.down()
  await page.mouse.move(box.x+box.width/2+36,box.y+box.height/2+16,{steps:6})
  await page.mouse.up()
  await expect.poll(async()=>Math.abs((await getModel())?.ay??0)).toBeGreaterThan(0)
  await expect.poll(getPoster).not.toBe(originalPoster)
  const rotation=await getModel()
  const turnedPoster=await getPoster()
  assert.match(turnedPoster,/^data:image\/png;base64,/)
  await page.keyboard.press('ControlOrMeta+s')
  const revision=async()=> (await f.files.openFile(f.alice.token,file.fileId)).file.revision
  await expect.poll(revision).not.toBe(file.revision)
  const zip=await JSZip.loadAsync(await f.files.readFile(f.alice.token,file.fileId,await revision()))
  assert.deepEqual(await zip.file(/^ppt\/media\/.*\.glb$/)[0]?.async('nodebuffer'),bytes)
  assert.match(await zip.file('ppt/slides/slide1.xml').async('string'),/<am3d:rot[^>]* ay="-?\d+"/)
  await openDeck(f,file.fileId,'light')
  await expect.poll(getModel).toEqual(rotation)
  await expect.poll(getPoster).toBe(turnedPoster)
})
