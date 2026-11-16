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
import { fileFixture, importFile } from '../helpers/files.mjs'
import { password } from '../helpers/identity.mjs'
import { sheetsGateway } from '../helpers/sheets-gateway.mjs'
import { sandboxFixture } from '../helpers/native-sandbox.mjs'
import { createXlsxNativeWorker } from '../../worker/src/native/xlsx.ts'

async function fixture(t, autoSave = false) {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-sheets-download-'))
  let f, browser, server
  t.after(async () => {
    await browser?.close()
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    await f?.app.close()
    await rm(directory, { recursive: true, force: true })
  })
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'pipe' })
  server = createServer({ key: await readFile(join(directory, 'key.pem')), cert: await readFile(join(directory, 'cert.pem')) }, (req, res) => f.app.routing(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `https://127.0.0.1:${server.address().port}`
  const gateway = await sheetsGateway(t)
  f = await fileFixture(t, { origin, nativeSheetsDirectory: process.env.DYOFFICE_TEST_SHEETS_DIRECTORY ?? fileURLToPath(new URL('../../dist-sheets/', import.meta.url)), sheetsNative: createXlsxNativeWorker(await sandboxFixture('native')), sheetsPlanner: gateway.planWorkbookSave, sheetsPackageReader: gateway.readWorkbookPackage })
  await f.preferences.update(f.alice.token, { language: 'en', autoSave, showAssistant: false })
  const original = await readFile(new URL('../fixtures/sheets/acceptance.xlsx', import.meta.url))
  const opened = await importFile(f, f.alice.token, original, 'independent-download.xlsx')
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1100 } })
  const page = await context.newPage()
  await page.addInitScript(() => { window.__genofficeDebugHooks = true })
  await page.goto(origin + '/')
  const status = await page.evaluate(async password => {
    const challenge = await (await fetch('/api/v1/auth/csrf')).json()
    return (await fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': challenge.csrfToken }, body: JSON.stringify({ username: 'alice', password }) })).status
  }, password)
  assert.equal(status, 200)
  await page.goto(origin + '/native-xlsx/?fileId=' + opened.file.fileId)
  await expect.poll(() => page.evaluate(() => window.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange('A2').getValue()), { timeout: 30000 }).toBe(12.5)
  await expect.poll(() => page.evaluate(() => window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange('B2').getValue()), { timeout: 30000 }).toBe(25)
  await page.evaluate(() => { window.__savedWorkbookIdentity = window.__genofficeDebug.univerAPI.getActiveWorkbook().getWorkbook() })
  return { ...f, page, original, opened, context, origin }
}

async function assertWorkbook(bytes, expectedA2, expectedA3 = 7.5) {
  const zip = await JSZip.loadAsync(bytes)
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string')
  const cell = address => new RegExp(`<c\\b[^>]*\\br="${address}"[^>]*>([\\s\\S]*?)<\\/c>`).exec(xml)?.[1]
  assert.match(cell('A2') ?? '', new RegExp(`<v>${String(expectedA2).replace('.', '\\.')}<\\/v>`))
  assert.match(cell('B2') ?? '', /<f>A2\*2<\/f>/)
  assert.match(cell('B2') ?? '', new RegExp(`<v>${expectedA2 * 2}<\\/v>`))
  assert.match(cell('F2') ?? '', new RegExp(`<v>${String(expectedA2 + expectedA3).replace('.', '\\.')}<\\/v>`))
  const chart = await zip.file('xl/charts/chart1.xml').async('string')
  assert.match(chart, new RegExp(`<c:pt idx="0"><c:v>${String(expectedA2).replace('.', '\\.')}<\\/c:v>`))
  assert.match(await zip.file('customXml/t09-preserve.xml').async('string'), /Preserve these exact bytes/)
}

const saveAndDownload = page => page.getByRole('button', { name: 'Save and download', exact: true })

test('dirty download submits the latest editor snapshot and downloads those exact native bytes', { timeout: 120000 }, async t => {
  const f = await fixture(t)
  // No formula/chart debounce wait: the product must settle before capture.
  await f.page.evaluate(() => window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange('A2').setValue(21.25))
  const ready = f.page.waitForEvent('download')
  await saveAndDownload(f.page).click()
  const downloaded = await readFile(await (await ready).path())
  await assertWorkbook(downloaded, 21.25)
  const head = (await f.files.openFile(f.alice.token, f.opened.file.fileId)).file
  assert.notEqual(head.revision, f.opened.file.revision)
  assert.deepEqual(downloaded, await f.files.readFile(f.alice.token, head.fileId, head.revision))
  assert.equal(await f.page.evaluate(() => window.__savedWorkbookIdentity === window.__genofficeDebug.univerAPI.getActiveWorkbook().getWorkbook()), true, 'ordinary save must retain the live workbook facade')
})

test('download waits for a blocked save receipt, then drains edits made after that save snapshot', { timeout: 120000 }, async t => {
  const f = await fixture(t)
  let entered, release, preparations = 0
  const reached = new Promise(resolve => { entered = resolve })
  const barrier = new Promise(resolve => { release = resolve })
  t.after(() => release())
  f.page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/sheets/uploads')) preparations++ })
  await f.page.route('**/commits', async route => {
    const response = await route.fetch()
    assert.equal(response.status(), 200)
    entered(); await barrier
    await route.fulfill({ response })
  }, { times: 1 })
  await f.page.evaluate(() => window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange('A2').setValue(40))
  const save = f.page.locator('.qa-btn').first()
  await expect(save).toBeEnabled()
  await save.click()
  await reached
  await f.page.evaluate(() => window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange('A3').setValue(17))
  let downloads = 0
  f.page.on('download', () => { downloads++ })
  const ready = f.page.waitForEvent('download')
  await saveAndDownload(f.page).click()
  assert.equal(downloads, 0, 'blocked commit must not serve the old download snapshot')
  release()
  const bytes = await readFile(await (await ready).path())
  await assertWorkbook(bytes, 40, 17)
  assert.equal(preparations, 2, 'late edits require one child revision, not replay of the first save')
  assert.equal(await f.page.evaluate(() => window.__savedWorkbookIdentity === window.__genofficeDebug.univerAPI.getActiveWorkbook().getWorkbook()), true)
})

test('structural save fences new edits until the confirmed workbook is ready, then accepts the next save', { timeout: 120000 }, async t => {
  const f = await fixture(t)
  const preparations = []
  f.page.on('request', request => {
    if (new URL(request.url()).pathname.endsWith('/sheets/uploads')) preparations.push(request.postDataJSON().request)
  })
  let entered, release
  const reached = new Promise(resolve => { entered = resolve })
  const barrier = new Promise(resolve => { release = resolve })
  t.after(() => release())
  await f.page.route('**/commits', async route => {
    const response = await route.fetch()
    assert.equal(response.status(), 200)
    entered(); await barrier
    await route.fulfill({ response })
  }, { times: 1 })
  const changed = await f.page.evaluate(async () => {
    const debug = window.__genofficeDebug
    const sheetId = debug.univerAPI.getActiveWorkbook().getActiveSheet().getSheetId()
    return debug.applyOps([{ op: 'insert_rows', sheetId, row: 2, count: 1 }])
  })
  assert.equal(changed.ok, true)
  const save = f.page.locator('.qa-btn').first()
  await expect(save).toBeEnabled(); await save.click()
  await reached
  const rejected = await f.page.evaluate(async () => {
    const debug = window.__genofficeDebug
    const sheet = debug.univerAPI.getActiveWorkbook().getActiveSheet()
    const before = sheet.getRange('A4').getValue()
    try { await sheet.getRange('A4').setValue(999) } catch {}
    const after = sheet.getRange('A4').getValue()
    const result = await debug.applyOps([{ op: 'set_cell', sheetId: sheet.getSheetId(), address: 'A4', value: 999 }])
    return { before, after, result }
  })
  assert.equal(rejected.after, rejected.before, 'native mutation commands must not write through a structural snapshot')
  assert.equal(rejected.result.ok, false, 'tool writes must be fenced while structural save is frozen')
  release()
  await expect.poll(() => f.page.evaluate(() => window.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange('A3').getValue()), { timeout: 30000 }).toBe(12.5)
  await expect(f.page.locator('.qa-btn').first()).toBeDisabled({ timeout: 15000 })
  await expect(f.page.locator('.status-bar .status-msg')).not.toContainText('Saving workbook structure', { timeout: 15000 })
  await expect(f.page.locator('.status-bar .status-msg')).not.toContainText('Finishing pending workbook changes', { timeout: 15000 })
  const next = await f.page.evaluate(async () => {
    const debug = window.__genofficeDebug
    return debug.applyOps([{ op: 'set_cell', sheetId: debug.univerAPI.getActiveWorkbook().getActiveSheet().getSheetId(), address: 'A4', value: 17 }])
  })
  assert.equal(next.ok, true)
  const ready = f.page.waitForEvent('download')
  await saveAndDownload(f.page).click()
  const zip = await JSZip.loadAsync(await readFile(await (await ready).path()))
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string')
  assert.match(xml, /<c\b[^>]*r="A3"[^>]*>[\s\S]*?<v>12\.5<\/v>/)
  assert.match(xml, /<c\b[^>]*r="A4"[^>]*>[\s\S]*?<v>17<\/v>/)
  const response = await f.context.request.get(`${f.origin}/api/v1/files/${f.opened.file.fileId}/revisions`)
  assert.equal(response.status(), 200)
  assert.equal((await response.json()).revisions.length, 4, 'one import, two structural save phases and one follow-up commit; no structural replay')
  assert.equal(preparations.length, 3)
  assert.equal(preparations[0].structuralOps.length, 1)
  assert.deepEqual(preparations[1].structuralOps, [])
  assert.notEqual(preparations[1].definedNamesState, null, 'the second structural phase preserves shifted defined names')
  assert.deepEqual(preparations[2].structuralOps, [])
})

test('blur autosave confirms without replacing the live workbook or moving its selection', { timeout: 120000 }, async t => {
  const f = await fixture(t, true)
  await f.page.evaluate(() => {
    const sheet = window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet()
    sheet.getRange('A2').setValue(31)
    sheet.getRange('D2').activate()
  })
  const bounds = await f.page.locator('#univer-container').boundingBox()
  await f.page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await expect.poll(async () => (await f.files.openFile(f.alice.token, f.opened.file.fileId)).file.revision, { timeout: 30000 }).not.toBe(f.opened.file.revision)
  await expect(f.page.locator('.qa-btn').first()).toBeDisabled({ timeout: 15000 })
  assert.equal(await f.page.evaluate(() => window.__savedWorkbookIdentity === window.__genofficeDebug.univerAPI.getActiveWorkbook().getWorkbook()), true)
  const selection = await f.page.evaluate(() => {
    const range = window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveRange()
    return { row: range.getRow(), column: range.getColumn() }
  })
  assert.deepEqual(selection, { row: 1, column: 3 })
  assert.deepEqual(await f.page.locator('#univer-container').boundingBox(), bounds)
  const head = (await f.files.openFile(f.alice.token, f.opened.file.fileId)).file
  await assertWorkbook(await f.files.readFile(f.alice.token, head.fileId, head.revision), 31)
})
