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

const docsDirectory = fileURLToPath(new URL('../../dist-docs/',import.meta.url))
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(),'dyoffice-native-docs-'))
  let f, browser, server
  t.after(async () => {
    await browser?.close()
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    await f?.app.close()
    await rm(directory,{ recursive: true,force: true })
  })
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(directory,'key.pem'),'-out',join(directory,'cert.pem'),'-days','1','-subj','/CN=localhost'],{ stdio: 'pipe' })
  // HTTP-only persistence fixture: no WebSocket upgrade is attached. A reconnect
  // notice is expected and must not replace the independent save-state assertions.
  server = createServer({ key: await readFile(join(directory,'key.pem')),cert: await readFile(join(directory,'cert.pem')) },(req,res) => f.app.routing(req,res))
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  const origin = `https://127.0.0.1:${server.address().port}`
  f = await fileFixture(t,{ origin,nativeDocsDirectory: docsDirectory })
  await f.preferences.update(f.alice.token,{ language: 'en',autoSave: false,showAssistant: false })
  const zip = await JSZip.loadAsync(await docxBytes())
  zip.file('customXml/dyoffice-preserve.xml','<probe>Untouched custom part</probe>')
  const original = await zip.generateAsync({ type: 'nodebuffer' }), opened = await importFile(f,f.alice.token,original,'native-roundtrip.docx')
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ ignoreHTTPSErrors: true,viewport: { width: 1440,height: 1100 } }), page = await context.newPage()
  await page.goto(origin + '/')
  const status = await page.evaluate(async password => {
    const challenge = await (await fetch('/api/v1/auth/csrf')).json()
    return (await fetch('/api/v1/auth/login',{ method: 'POST',headers: { 'content-type': 'application/json','x-csrf-token': challenge.csrfToken },body: JSON.stringify({ username: 'alice',password }) })).status
  },password)
  assert.equal(status,200)
  return { ...f, original, opened, browser, context, page, origin }
}

// Do not treat a reconnect banner or an HTTP commit as proof of a clean native model.
async function expectCleanPersistence(page) {
  const status=page.locator('.dyoffice-docs-persistence-state')
  try {
    await expect(status).toHaveText('Editing')
    await expect(status).toHaveAttribute('data-dirty','false')
  } catch (error) {
    // Bounded state-only diagnostics: no document text, identities, URLs or tokens.
    console.error('native-save-state',JSON.stringify({
      outcome:await status.getAttribute('data-native-save'),
      dirty:await status.getAttribute('data-dirty'),
      notification:await page.locator('.dyoffice-docs-notification-state').count()>0,
    }))
    throw error
  }
}

test('native GenOffice DOCX renders, edits, commits, refreshes and preserves unrelated original parts', { timeout: 120_000 }, async t => {
  const f = await fixture(t), errors = []
  const filePath = '/native-docx/?fileId=' + f.opened.file.fileId
  const cookie = token => ({ cookie: '__Host-dyoffice-session=' + token })
  assert.equal((await f.app.inject({ url: filePath })).statusCode,401)
  assert.equal((await f.app.inject({ url: filePath,headers: cookie(f.bob.token) })).statusCode,404)
  const html = await f.app.inject({ url: filePath,headers: cookie(f.alice.token) })
  assert.equal(html.statusCode,200)
  assert.deepEqual((await f.app.inject({ url: '/api/v1/capabilities',headers: cookie(f.alice.token) })).json(),{ docx: 'editable',xlsx: 'unsupported',pptx: 'unsupported',pdf: 'unsupported' })
  assert.equal((await f.app.inject({ url: '/api/v1/files/' + f.opened.file.fileId,headers: cookie(f.alice.token) })).json().capabilities.docx,'editable')
  assert.equal(html.headers['cache-control'],'private, no-store')
  const asset = html.body.match(/src="([^"]+\.js)"/)[1]
  assert.equal((await f.app.inject({ url: asset })).statusCode,401)
  assert.equal((await f.app.inject({ url: asset,headers: cookie(f.alice.token) })).statusCode,200)
  assert.equal((await f.app.inject({ url: '/native-docx/src/editors/docs-entry.tsx',headers: cookie(f.alice.token) })).statusCode,404)
  assert.equal((await f.app.inject({ url: `/api/v1/files/${f.opened.file.fileId}/revisions/${f.opened.file.revision}`,headers: cookie(f.bob.token) })).statusCode,404)
  f.page.on('pageerror' ,error => errors.push(String(error)))
  const response = await f.page.goto(f.origin + '/native-docx/?fileId=' + f.opened.file.fileId)
  assert.equal(response.status(),200)
  const editor = f.page.locator('.tiptap.doc-page[contenteditable="true"]')
  await editor.waitFor({ timeout: 45_000 })
  const marker = 'Web native paragraph 2026'
  await editor.click()
  await f.page.keyboard.press('Control+End'); await f.page.keyboard.press('Enter'); await f.page.keyboard.type(marker)
  assert.ok((await editor.innerText()).includes(marker))
  await f.page.keyboard.press('Control+z')
  assert.ok(!(await editor.innerText()).includes(marker))
  await f.page.keyboard.press('Control+Shift+z')
  assert.ok((await editor.innerText()).includes(marker))
  await f.page.keyboard.press('Enter')
  await f.page.getByRole('button',{ name: 'Insert',exact: true }).click()
  await f.page.getByRole('button',{ name: 'Table',exact: true }).click()
  await f.page.locator('.table-picker-grid .table-cell').nth(11).click()
  const cell = editor.locator('table td').first()
  await cell.click(); await f.page.keyboard.type('Native table cell')
  assert.equal(await editor.locator('table tr').count(),2)
  await f.context.grantPermissions(['clipboard-read','clipboard-write'])
  await f.page.evaluate(() => navigator.clipboard.writeText(' 浏览器剪贴板'))
  await f.page.keyboard.press('Control+v')
  await expect(cell).toContainText('浏览器剪贴板')
  const committed = f.page.waitForResponse(reply => reply.url().endsWith('/commits') && reply.request().method() === 'POST' && reply.status() === 200)
  await f.page.keyboard.press('Control+s')
  await committed
  const opened = await f.files.openFile(f.alice.token,f.opened.file.fileId)
  assert.notEqual(opened.file.revision,f.opened.file.revision)
  const bytes = await f.files.readFile(f.alice.token,opened.file.fileId,opened.file.revision), archive = await JSZip.loadAsync(bytes)
  assert.ok((await archive.file('word/document.xml').async('string')).replace(/<[^>]+>/g,'').includes(marker))
  assert.ok((await archive.file('word/document.xml').async('string')).includes('Native table cell'))
  assert.ok((await archive.file('word/document.xml').async('string')).includes('浏览器剪贴板'))
  assert.equal(await archive.file('customXml/dyoffice-preserve.xml').async('string'),'<probe>Untouched custom part</probe>')
  await expectCleanPersistence(f.page)
  const pendingDownload = f.page.waitForEvent('download')
  await f.page.getByRole('link',{ name: 'Download saved version' }).click()
  const download = await pendingDownload
  assert.equal(download.suggestedFilename(),'native-roundtrip.docx')
  assert.deepEqual(await readFile(await download.path()),bytes)
  const history = await f.context.request.get(`${f.origin}/api/v1/files/${opened.file.fileId}/revisions`)
  assert.equal(history.status(),200)
  assert.equal((await history.json()).revisions.length,2)
  await expectCleanPersistence(f.page)
  await f.page.reload()
  await f.page.locator('.tiptap.doc-page').waitFor({ timeout: 45_000 })
  await expect(f.page.locator('.tiptap.doc-page')).toContainText(marker,{ timeout: 45_000 })
  await expect(f.page.locator('.tiptap.doc-page table')).toContainText('Native table cell')
  assert.deepEqual(errors,[])
})

test('editing during a delayed native save keeps the newer draft dirty and saves a later child revision', { timeout: 120_000 },async t => {
  const f = await fixture(t)
  await f.page.goto(f.origin + '/native-docx/?fileId=' + f.opened.file.fileId)
  const editor = f.page.locator('.tiptap.doc-page[contenteditable="true"]')
  await editor.waitFor({ timeout: 45_000 })
  await editor.click(); await f.page.keyboard.press('Control+End'); await f.page.keyboard.press('Enter'); await f.page.keyboard.type('Captured snapshot')
  let reached, release, first = true
  const started = new Promise(resolve => { reached = resolve }), wait = new Promise(resolve => { release = resolve })
  t.after(() => release())
  await f.page.route('**/commits',async route => {
    if (!first) return route.continue()
    first = false
    const response = await route.fetch()
    reached(); await wait; await route.fulfill({ response })
  })
  await f.page.keyboard.press('Control+s'); await started
  await editor.click(); await f.page.keyboard.press('Control+End'); await f.page.keyboard.press('Enter'); await f.page.keyboard.type('Newer unsaved draft')
  const firstRef = await f.files.openFile(f.alice.token,f.opened.file.fileId)
  const firstZip = await JSZip.loadAsync(await f.files.readFile(f.alice.token,firstRef.file.fileId,firstRef.file.revision))
  assert.ok(!(await firstZip.file('word/document.xml').async('string')).includes('Newer unsaved draft'))
  release()
  await expect(f.page.locator('.dyoffice-docs-persistence-state')).toHaveText('',{ timeout: 15_000 })
  await expect(editor).toContainText('Newer unsaved draft')
  const next = f.page.waitForResponse(reply => reply.url().endsWith('/commits') && reply.status() === 200)
  await f.page.keyboard.press('Control+s'); await next
  const current = await f.files.openFile(f.alice.token,f.opened.file.fileId)
  assert.notEqual(current.file.revision,firstRef.file.revision)
  const currentZip = await JSZip.loadAsync(await f.files.readFile(f.alice.token,current.file.fileId,current.file.revision))
  assert.ok((await currentZip.file('word/document.xml').async('string')).includes('Newer unsaved draft'))
})

test('native editor preserves unsaved text and becomes read only after another tab takes over', { timeout: 120_000 },async t => {
  const f = await fixture(t), path = f.origin + '/native-docx/?fileId=' + f.opened.file.fileId
  await f.page.goto(path)
  const editor = f.page.locator('.tiptap.doc-page[contenteditable="true"]')
  await editor.waitFor({ timeout: 45_000 })
  await editor.click(); await f.page.keyboard.press('Control+End'); await f.page.keyboard.type('Unsaved first tab')
  const second = await f.context.newPage()
  await second.goto(path)
  await expect(second.getByRole('button',{ name: 'Take over editing' })).toBeVisible({ timeout: 45_000 })
  await expect(second.locator('.tiptap.doc-page')).toHaveAttribute('contenteditable','false')
  await second.getByRole('button',{ name: 'Take over editing' }).click()
  await expect(second.locator('.tiptap.doc-page')).toHaveAttribute('contenteditable','true')
  await f.page.bringToFront()
  await expect(f.page.locator('.tiptap.doc-page')).toHaveAttribute('contenteditable','false',{ timeout: 25_000 })
  await expect(f.page.locator('.tiptap.doc-page')).toContainText('Unsaved first tab')
  assert.equal((await f.files.openFile(f.alice.token,f.opened.file.fileId)).file.revision,f.opened.file.revision)
})

test('native lost-response warning keeps the draft until the original commit receipt is confirmed', { timeout: 120_000 },async t => {
  const f = await fixture(t)
  await f.page.goto(f.origin + '/native-docx/?fileId=' + f.opened.file.fileId)
  const editor = f.page.locator('.tiptap.doc-page[contenteditable="true"]')
  await editor.waitFor({ timeout: 45_000 })
  await editor.click(); await f.page.keyboard.press('Control+End'); await f.page.keyboard.type('Lost response native draft')
  const commits = []; let drop = true
  await f.page.route('**/commits',async route => {
    commits.push(route.request().postDataJSON())
    if (!drop) return route.continue()
    drop = false
    await route.fetch(); await route.abort('failed')
  })
  await f.page.keyboard.press('Control+s')
  await expect(f.page.getByRole('button',{ name: 'Confirm save outcome' })).toBeVisible({ timeout: 15_000 })
  await expect(editor).toContainText('Lost response native draft')
  const current = await f.files.openFile(f.alice.token,f.opened.file.fileId)
  assert.notEqual(current.file.revision,f.opened.file.revision)
  await f.page.getByRole('button',{ name: 'Confirm save outcome' }).click()
  await expect(f.page.getByRole('button',{ name: 'Confirm save outcome' })).toHaveCount(0)
  assert.deepEqual(commits[1],commits[0])
  assert.equal((await f.files.openFile(f.alice.token,f.opened.file.fileId)).file.revision,current.file.revision)
})

test('actual server entry enables only the explicit native build and refuses missing File API or an unknown mode', { timeout: 30_000 },async t => {
  const { spawn,execFile } = await import('node:child_process')
  const { once } = await import('node:events'), { promisify } = await import('node:util')
  const f = await fileFixture(t), opened = await importFile(f,f.alice.token,await docxBytes())
  const cwd = fileURLToPath(new URL('../../',import.meta.url))
  const env = { ...process.env,NODE_ENV: 'development',DYOFFICE_AUTH_MODE: 'local',DYOFFICE_DATABASE_URL: '',DYOFFICE_AUTH_DATABASE_URL: f.urls.auth,DYOFFICE_BUSINESS_DATABASE_URL: f.urls.business,DYOFFICE_DEPLOYMENT_ID: f.deploymentId,DYOFFICE_ORIGIN: 'https://office.example',DYOFFICE_CSRF_KEY: f.csrfKey,DYOFFICE_USER_TOKEN: '',DYOFFICE_ADMIN_TOKEN: '',DYOFFICE_FILE_API: 'experimental',DYOFFICE_OBJECT_STORE: 'local-dev',DYOFFICE_OBJECT_DIRECTORY: f.directory,DYOFFICE_NATIVE_DOCX: 'experimental',DYOFFICE_NATIVE_DOCX_DIRECTORY: '',PORT: '0',HOST: '127.0.0.1' }
  const child = spawn(process.execPath,['--import','tsx','server/index.mjs'],{ cwd,env,stdio: ['ignore','pipe','pipe'] })
  f.cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child,'exit') } })
  const exited = once(child,'exit')
  const [output] = await Promise.race([once(child.stdout,'data'),exited.then(() => { throw new Error('Native entry exited before startup') })])
  const address = String(output).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
  assert.ok(address)
  const path = address + '/native-docx/?fileId=' + opened.file.fileId, headers = { cookie: '__Host-dyoffice-session=' + f.alice.token }
  assert.equal((await fetch(path)).status,401)
  assert.equal((await fetch(path,{ headers })).status,200)
  assert.equal((await (await fetch(address + '/api/v1/capabilities',{ headers })).json()).docx,'editable')
  child.kill('SIGTERM'); assert.deepEqual(await exited,[0,null])
  for (const invalid of [{ DYOFFICE_NATIVE_DOCX: 'enabled' },{ DYOFFICE_FILE_API: '',DYOFFICE_OBJECT_STORE: '' }]) {
    await assert.rejects(promisify(execFile)(process.execPath,['--import','tsx','server/index.mjs'],{ cwd,env: { ...env,...invalid },timeout: 5000 }),error => {
      assert.equal(error.code,1)
      assert.equal(error.stderr.includes(f.urls.auth),false)
      return true
    })
  }
})

test('page-color edits during a delayed native commit remain dirty and persist on the next save', { timeout: 120_000 },async t => {
  const f = await fixture(t)
  await f.page.goto(f.origin + '/native-docx/?fileId=' + f.opened.file.fileId)
  await f.page.locator('.tiptap.doc-page[contenteditable="true"]').waitFor({ timeout: 45_000 })
  let reached, release, first = true
  const started = new Promise(resolve => { reached = resolve }), gate = new Promise(resolve => { release = resolve })
  t.after(() => release())
  await f.page.route('**/commits',async route => {
    if (!first) return route.continue()
    first = false
    const response = await route.fetch()
    reached(); await gate; await route.fulfill({ response })
  })
  await f.page.keyboard.press('Control+s'); await started
  await f.page.getByRole('button',{ name: 'Design',exact: true }).click()
  await f.page.getByRole('button',{ name: 'Page Color',exact: true }).click()
  await f.page.getByRole('gridcell',{ name: 'Red',exact: true }).click()
  release()
  await expect(f.page.locator('.dyoffice-docs-persistence-state')).toHaveText('')
  await expect(f.page.locator('.doc-zoom').first()).toHaveCSS('--page-bg','#FF0000')
  const next = f.page.waitForResponse(reply => reply.url().endsWith('/commits') && reply.status() === 200)
  await f.page.keyboard.press('Control+s'); await next
  await expectCleanPersistence(f.page)
  const current = await f.files.openFile(f.alice.token,f.opened.file.fileId)
  const zip = await JSZip.loadAsync(await f.files.readFile(f.alice.token,current.file.fileId,current.file.revision))
  assert.match(await zip.file('word/document.xml').async('string'),/w:background[^>]*w:color="FF0000"/)
  await f.page.reload()
  await expect(f.page.locator('.doc-zoom').first()).toHaveCSS('--page-bg','#FF0000',{ timeout: 45_000 })
})
