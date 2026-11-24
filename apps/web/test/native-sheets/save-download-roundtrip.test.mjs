import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:https'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import JSZip from 'jszip'
import { fileFixture, importFile } from '../helpers/files.mjs'
import { password } from '../helpers/identity.mjs'
import { sheetsGateway } from '../helpers/sheets-gateway.mjs'
import { sandboxFixture } from '../helpers/native-sandbox.mjs'
import { createXlsxNativeWorker } from '../../worker/src/native/xlsx.ts'
import { createCrossPlatformProcess } from '../../worker/src/sandbox/cross-platform-process.ts'
import { buildLocalApp } from '../../server/src/app.ts'
import { createGlobalConfigService } from '../../server/src/modules/admin/service.ts'
import { createSkillService } from '../../server/src/modules/skills/service.ts'
import { syntheticAnalysisAdapter,syntheticAnalysisFrames } from '../helpers/analysis-delivery.mjs'
import { mockProviderNetwork } from '../helpers/provider-network.mjs'
import { configuredSheetsRuntime } from '../../server/src/modules/sheets/runtime.ts'
import { buildSheetsGateway } from '../../server/sheets/build.mjs'
import { holdFirstResponseEnd } from '../helpers/delayed-http-response.mjs'

async function fixture(t, autoSave = false, enableAssistant = false, replay = undefined, live = undefined, analysis = false, namedCopy = false, nativeSandbox) {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-sheets-download-'))
  let f, app, browser, server, analysisAdapter, beforeHttpRequest
  t.after(async () => {
    await browser?.close()
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    await app?.close()
    await rm(directory, { recursive: true, force: true })
  })
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'pipe' })
  server = createServer({ key: await readFile(join(directory, 'key.pem')), cert: await readFile(join(directory, 'cert.pem')) }, (req, res) => {
    beforeHttpRequest?.(req, res)
    app.routing(req, res)
  })
  await new Promise(resolve => server.listen(Number(process.env.DYOFFICE_TEST_SHEETS_PORT ?? 0), '127.0.0.1', resolve))
  const origin = `https://127.0.0.1:${server.address().port}`
  const gateway = namedCopy ? undefined : await sheetsGateway(t)
  if (namedCopy) await buildSheetsGateway(join(directory,'gateway.mjs'))
  const copyRuntime = namedCopy ? await configuredSheetsRuntime({DYOFFICE_AUTH_MODE:'local',DYOFFICE_SANDBOX_MODE:'subprocess',DYOFFICE_DEPLOYMENT_ID:randomUUID(),DYOFFICE_XLSX_NODE_ENGINE:join(directory,'xlsx-node-engine.mjs'),DYOFFICE_XLSX_GATEWAY_RUNNER:join(directory,'gateway-process.mjs')},{enabled:true}) : undefined
  if (copyRuntime) t.after(()=>copyRuntime.close())
  const original = await readFile(new URL('../fixtures/sheets/acceptance.xlsx', import.meta.url))
  // Test-only replay accepts only the checked-in synthetic fixture. The separate
  // native test below still requires the original systemd sandbox.
  const bound = result => async input => {assert.deepEqual(Buffer.from(input), original); return result}
  if (replay) assert.equal(createHash('sha256').update(original).digest('hex'), replay.fixtureSha256)
  const native = replay ? {
    inspect: bound({...replay.meta, visuals: []}),
    readRange: async (input, _name, range) => {
      const result = await bound(replay.range)(input)
      return {...result, cells: result.cells.filter(({row, column}) => range.startRow <= row && row <= range.endRow && range.startColumn <= column && column <= range.endColumn)}
    },
    readSheet: async (input, _name, kind) => bound(kind === 'formulas' ? replay.formulas : replay.outline)(input),
    savePlan: async () => assert.fail('The assistant must not save the workbook'),
  } : copyRuntime?.sheetsNative ?? createXlsxNativeWorker(nativeSandbox ?? await sandboxFixture('native'))
  const sheets = { ...(copyRuntime ?? { sheetsNative: native, sheetsPlanner: gateway.planWorkbookSave, sheetsPackageReader: gateway.readWorkbookPackage }), nativeSheetsDirectory: process.env.DYOFFICE_TEST_SHEETS_DIRECTORY ?? fileURLToPath(new URL('../../dist-sheets/', import.meta.url)) }
  f = await fileFixture(t, { origin, ...sheets })
  app = f.app
  if (enableAssistant) {
    const keyring = {activeKeyId: 'test', keys: {test: randomBytes(32)}}
    const baseUrl = live?.baseUrl ?? 'https://provider.example/v1'
    const profile = {deploymentId: f.deploymentId, entryId: 'primary', revision: 1, providerId: 'openai', model: live?.model ?? 'synthetic', baseUrl, endpoint: baseUrl + '/chat/completions', allowedIpv4: live?.allowedIpv4 ?? ['8.8.8.8'], maxOutputTokens: 128}
    const apiKey = live ? (await readFile(live.keyFile, 'utf8')).trim() : 'synthetic-private-key'
    const settings = createGlobalConfigService({transactions: f.transactions, keyring})
    await settings.saveGlobalConfig(f.adminSigned.token, 0, {upserts: [{id: profile.entryId, kind: 'chat', providerId: profile.providerId, label: 'Company Chat', model: profile.model, baseUrl: profile.baseUrl, enabled: true, apiKey}]})
    await f.ownerPool.query('INSERT INTO provider_budget_accounts(deployment_id,owner_id,entry_id,config_revision,available_units,per_call_units) VALUES($1,$2,$3,1,$4,10)', [f.deploymentId, f.alice.user.id, profile.entryId, live ? 30 : analysis || namedCopy ? 20 : 10])
    const skills = createSkillService(f.transactions)
    await skills.save(f.alice.token, 'alice-workbook', {description: 'Excel workbook skill', body: 'Alice workbook instructions.'})
    await skills.save(f.bob.token, 'bob-workbook', {description: 'Excel workbook skill', body: 'Bob workbook instructions.'})
    if(analysis)analysisAdapter=syntheticAnalysisAdapter(()=>app,{text:'=1+1,literal <script>cell</script>\n0012,TRUE',name:'analysis.csv',mediaType:'text/csv',role:'table'})
    app = await buildLocalApp({db: f.db, businessPool: f.businessPool, passwords: f.passwords, deploymentId: f.deploymentId, origin, csrfKey: f.csrfKey, objectStore: f.objects, globalConfigKeyring: keyring, providerGateway: {profiles: [profile]}, ...(analysisAdapter?{codingHarnesses:{adapters:[analysisAdapter],defaultId:analysisAdapter.descriptor.id}}:{}), ...sheets})
  }
  await f.preferences.update(f.alice.token, { language: 'en', autoSave, showAssistant: enableAssistant })
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
  return { ...f, page, original, opened, context, origin, analysisAdapter,
    observeHttpRequests(handler) { beforeHttpRequest = handler },
  }
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

test('XLSX chart moves once and the save shortcut persists its new anchor', {timeout:120_000}, async t => {
  const manifest = JSON.parse(await readFile(process.env.DYOFFICE_TEST_HOST_MANIFEST ?? new URL('../../../../.dyoffice-native-build/host-manifest.json',import.meta.url),'utf8'))
  const sandbox = createCrossPlatformProcess({deploymentId:randomUUID(),binary:manifest.nativeBinary,sha256:manifest.nativeSha256,
    allowedCommands:['open','read_range','read_formula_cells','read_row_outline','read_media','recalc_cells','save_archive','close']})
  const {page,files,alice,opened} = await fixture(t,false,false,undefined,undefined,false,false,sandbox)
  const chart = page.locator('.shape-editable').filter({has:page.locator('.xlsx-chart')})
  await expect(chart).toBeVisible()
  const before = await chart.boundingBox()
  const x = before.x + 15, y = before.y + 15
  await page.mouse.move(x,y)
  await page.mouse.down()
  await page.mouse.move(x+80,y+40,{steps:8})
  await expect(page.locator('.shape-drag-ghost')).toBeVisible()
  await expect(page.locator('.shape-drag-ghost .xlsx-chart')).toHaveCount(0)
  await page.mouse.up()
  await expect(page.locator('.shape-drag-ghost')).toHaveCount(0)
  await expect.poll(async()=>Math.round((await chart.boundingBox())?.x-before.x)).toBe(80)
  await page.keyboard.press('Control+s')
  await expect.poll(async()=>(await files.openFile(alice.token,opened.file.fileId)).file.revision,{timeout:15000}).not.toBe(opened.file.revision)
  const moved = await chart.boundingBox()
  await page.reload()
  await expect(chart).toBeVisible({timeout:30000})
  const reopened = await chart.boundingBox()
  assert.ok(Math.abs(reopened.x-moved.x)<2 && Math.abs(reopened.y-moved.y)<2)
  const revision = (await files.openFile(alice.token,opened.file.fileId)).file.revision
  await page.evaluate(()=>window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange('A2').setValue(19))
  await page.keyboard.press('Meta+s')
  await expect.poll(async()=>(await files.openFile(alice.token,opened.file.fileId)).file.revision,{timeout:15000}).not.toBe(revision)
})

async function verifyAssistant(t, replay, live) {
  const {page, opened, files, original, alice, ownerPool} = await fixture(t, false, true, replay, live)
  const net = live ? undefined : mockProviderNetwork(t, [Buffer.from('data: {"choices":[{"delta":{"content":"Verified workbook reply"},"finish_reason":"stop"}]}\n\n'), Buffer.from('data: [DONE]\n\n')])
  const openAssistant = page.getByRole('button', {name: 'Open AI assistant', exact: true})
  if (await openAssistant.isVisible()) await openAssistant.click()
  await expect(page.getByRole('button', {name: 'Model: ' + (live?.model ?? 'synthetic'), exact: true})).toBeVisible()
  await page.locator('.ai-plus-btn').click()
  const skills = page.getByRole('menuitem', {name: 'Skills', exact: true})
  if (await skills.isVisible()) await skills.click()
  await page.getByRole('menuitemcheckbox', {name: /alice-workbook/}).click()
  await expect(page.getByText('bob-workbook', {exact: true})).toHaveCount(0)
  const composer = page.getByRole('textbox', {name: 'AI instruction', exact: true})
  await composer.fill(live ? 'What is the value of cell A2 on the Acceptance sheet? Return only the number.' : 'Summarize this workbook')
  await composer.press('Enter')
  await expect(page.locator('.copilot').getByText(live ? '12.5' : 'Verified workbook reply', {exact: true})).toBeVisible({timeout: 65_000})
  if (net) {
    const request = JSON.parse(net.wire)
    assert.match(JSON.stringify(request.messages), /Alice workbook instructions/)
    assert.doesNotMatch(JSON.stringify(request), /Bob workbook instructions|synthetic-private-key/)
    assert.ok(request.tools.length > 0)
    assert.ok(!request.tools.some(tool => tool.function.name === 'apply_ops'))
  }
  // Text can render before the terminal frame and durable settlement.
  await expect.poll(async () => {
    const {rows} = await ownerPool.query('SELECT owner_id,state FROM provider_budget_reservations')
    return rows.length >= 1 && rows.length <= (live ? 3 : 1) && rows.every(row => row.owner_id === alice.user.id && row.state === 'settled')
  }).toBe(true)
  assert.deepEqual(await files.readFile(alice.token, opened.file.fileId, opened.file.revision), original)
}
test('native XLSX assistant streams with the selected personal Skill and leaves the workbook unchanged', {timeout: 120_000}, t => verifyAssistant(t))

const readReplay = async () => JSON.parse(await readFile(new URL('../fixtures/sheets/assistant-replay.json', import.meta.url), 'utf8'))
test('XLSX browser CSV bridge confirms loss and downloads current values without committing the workbook', {timeout:120_000}, async t=>{
 const f=await fixture(t,false,false,await readReplay())
 await f.page.evaluate(()=>window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange('A2').setValue(21.25))
 await expect.poll(()=>f.page.evaluate(()=>window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange('B2').getValue())).toBe(42.5)
 const request=await f.page.evaluate(()=>({fileName:'工作表.csv',content:'项目,金额\r\n'+window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange('A2:B2').getValues()[0].join(',')+'\r\n',hasFormulas:true,activeSheetName:'Acceptance'}))
 let downloads=0;f.page.on('download',()=>downloads++)
 const dialog=f.page.getByRole('dialog')
 const exportCsv=()=>f.page.evaluate(request=>window.desktopApi.exportCsv(request),request)
 const [canceled]=await Promise.all([exportCsv(),(async()=>{
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText(/formatting.*Formulas.*values.*Acceptance/)
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click()
 })()])
 assert.deepEqual(canceled,{canceled:true})
 assert.equal(downloads,0)
 const [download,result]=await Promise.all([
  f.page.waitForEvent('download',{timeout:30_000}),
  exportCsv(),
  dialog.getByRole('button',{name:'Continue as CSV',exact:true}).click(),
 ])
 assert.deepEqual(result,{canceled:false,path:'工作表.csv'})
 assert.equal(download.suggestedFilename(),'工作表.csv')
 assert.deepEqual(await readFile(await download.path()),Buffer.from('\uFEFF项目,金额\r\n21.25,42.5\r\n'))
 const head=(await f.files.openFile(f.alice.token,f.opened.file.fileId)).file
 assert.equal(head.revision,f.opened.file.revision)
 assert.deepEqual(await f.files.readFile(f.alice.token,head.fileId,head.revision),f.original)
})
test('XLSX assistant browser flow with recorded synthetic workbook data', {timeout: 120_000}, async t => {
  await verifyAssistant(t, await readReplay())
})
test('XLSX AI naming confirms an independent current draft and leaves no copy on cancel', {timeout:120_000}, async t=>{
 const f=await fixture(t,false,true,undefined,undefined,false,true)
 const {page}=f
 const network=mockProviderNetwork(t,[Buffer.from('data: {"choices":[{"delta":{"content":"Sales Draft"},"finish_reason":"stop"}]}\n\n'),Buffer.from('data: [DONE]\n\n')])
 const requests=[],exports=[]
 page.on('request',request=>{
   if(request.method()!=='POST')return
   const path=new URL(request.url()).pathname
   requests.push(path)
   if(path.endsWith('/sheets/export'))exports.push(request.postDataJSON())
 })
 assert.equal((await page.evaluate(async()=>{
   const debug=window.__genofficeDebug,sheet=debug.univerAPI.getActiveWorkbook().getActiveSheet()
   await sheet.getRange('A2').setValue(21.25)
   return debug.applyOps([
     {op:'insert_rows',sheetId:sheet.getSheetId(),row:9,count:1},
     {op:'set_cell',sheetId:sheet.getSheetId(),address:'J1',value:'Item'},
     {op:'set_cell',sheetId:sheet.getSheetId(),address:'J2',value:'Draft row'},
     {op:'add_table',sheetId:sheet.getSheetId(),range:'J1:J2',name:'DraftItems'},
   ])
 })).ok,true)
 const naming=page.getByRole('button',{name:'Name with AI…',exact:true})
 const dialog=page.getByRole('dialog').filter({has:page.getByRole('textbox',{name:'File name'})})
 await expect(naming).toBeEnabled()
 await naming.click()
 await expect(dialog.getByRole('textbox',{name:'File name'})).toHaveValue('Sales Draft.xlsx',{timeout:30000})
 await dialog.getByRole('button',{name:'Cancel',exact:true}).click()
 await expect(dialog).toHaveCount(0)
 assert.equal((await f.files.listFiles(f.alice.token)).files.length,1)
 assert.ok(!requests.some(path=>path.endsWith('/sheets/export')||path.endsWith('/uploads')))
 await naming.click()
 await dialog.getByRole('textbox',{name:'File name'}).fill('Reviewed Draft.xlsx')
 await dialog.getByRole('button',{name:'Save copy',exact:true}).click()
 await expect(page.getByText('Saved copy: Reviewed Draft.xlsx',{exact:true})).toBeVisible({timeout:30000})
 const {files}=await f.files.listFiles(f.alice.token)
 const copy=files.find(file=>file.name==='Reviewed Draft.xlsx')
 assert.ok(copy);assert.notEqual(copy.id,f.opened.file.fileId)
 const copyZip=await JSZip.loadAsync(await f.files.readFile(f.alice.token,copy.id,copy.revision))
 assert.match(await copyZip.file('xl/worksheets/sheet1.xml').async('string'),/<v>21\.25<\/v>/)
 const tables=await Promise.all(copyZip.file(/^xl\/tables\/table\d+\.xml$/).map(part=>part.async('string')))
 assert.ok(tables.some(table=>/name="DraftItems"/.test(table)))
 assert.equal(exports.length,1)
 assert.equal(exports[0].phases.length,2)
 assert.equal(exports[0].phases[0].structuralOps.length,1)
 assert.equal(exports[0].phases[1].tableAdditions[0].name,'DraftItems')
 assert.equal((await f.files.openFile(f.alice.token,f.opened.file.fileId)).file.revision,f.opened.file.revision)
 assert.deepEqual(await f.files.readFile(f.alice.token,f.opened.file.fileId,f.opened.file.revision),f.original)
 await expect.poll(()=>page.evaluate(()=>window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange('A2').getValue())).toBe(21.25)
 assert.equal(await page.evaluate(()=>window.__savedWorkbookIdentity===window.__genofficeDebug.univerAPI.getActiveWorkbook().getWorkbook()),true)
 await expect(page.getByRole('button',{name:/^Save \(/})).toBeEnabled()
 assert.equal(network.writes,2)
 assert.ok(!requests.some(path=>path.endsWith('/sheets/uploads')||path.endsWith('/commits')))
})
const liveConfig = process.env.DYOFFICE_LIVE_ASSISTANT_TEST_CONFIG
test('XLSX assistant reads recorded synthetic cells through a real provider', {timeout: 120_000, skip: !liveConfig}, async t => {
  await verifyAssistant(t, await readReplay(), JSON.parse(await readFile(liveConfig, 'utf8')))
})

// Exercise the original Univer command/journal and UI save path, not desktopApi
// injection. A10:T509 is 10,000 cells inside the default 1000x26 grid; U10
// crosses the historical IPC threshold without changing dimensions or formulas.
async function editBulkCells(page, oversized = false) {
  await page.evaluate(async oversized => {
    const sheet = window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet()
    const values = Array.from({length: 500}, (_, row) =>
      Array.from({length: 20}, (_, column) => oversized ? '界'.repeat(150) : row * 20 + column + 1))
    await sheet.getRange('A10:T509').setValues(values)
    await sheet.getRange('U10').setValue('末尾-10001')
  }, oversized)
}

async function assertBulkStillLive(page, oversized = false) {
  assert.equal(await page.evaluate(oversized => {
    const sheet = window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet()
    const values = sheet.getRange('A10:T509').getValues()
    return values.length === 500 && values.every((row, r) => row.length === 20 &&
      row.every((value, c) => value === (oversized ? '界'.repeat(150) : r * 20 + c + 1))) &&
      sheet.getRange('U10').getValue() === '末尾-10001'
  }, oversized), true, 'all 10001 edits must remain in the live workbook')
}

test('bulk 10001 cells save through the real editor, download and reopen with native bytes', {timeout: 120000}, async t => {
  const f = await fixture(t)
  const preparations = []
  f.page.on('request', request => {
    if (new URL(request.url()).pathname.endsWith('/sheets/uploads')) preparations.push(request.postDataJSON().request)
  })
  await editBulkCells(f.page)
  await assertBulkStillLive(f.page)
  await expect(f.page.locator('.qa-btn').first()).toBeEnabled()
  const [download] = await Promise.all([
    f.page.waitForEvent('download'),
    saveAndDownload(f.page).click(),
  ])
  const bytes = await readFile(await download.path())
  assert.equal(preparations.length, 1)
  assert.equal(preparations[0].edits.length, 10001, 'the real save snapshot must cross the old IPC threshold')
  assert.equal(preparations[0].editsTransferId, undefined)
  const head = (await f.files.openFile(f.alice.token, f.opened.file.fileId)).file
  assert.notEqual(head.revision, f.opened.file.revision)
  assert.deepEqual(bytes, await f.files.readFile(f.alice.token, head.fileId, head.revision))
  await expect(f.page.locator('.qa-btn').first()).toBeDisabled()
  const zip = await JSZip.loadAsync(bytes, {checkCRC32: true})
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string')
  const cells = new Map([...xml.matchAll(/<c\b[^>]*\br="([^"]+)"[^>]*>([\s\S]*?)<\/c>/g)].map(match => [match[1], match[2]]))
  for (let row = 0; row < 500; row++) for (let col = 0; col < 20; col++) {
    assert.match(cells.get(`${String.fromCharCode(65 + col)}${row + 10}`) ?? '',
      new RegExp(`<v>${row * 20 + col + 1}</v>`))
  }
  // Reopen the actual downloaded archive in the real native worker as well as
  // a fresh renderer session. No recorded reader, provider replay or mock save.
  const native = createXlsxNativeWorker(await sandboxFixture('native'))
  const reopened = await native.readRange(bytes, 'Acceptance', {startRow: 9, endRow: 9, startColumn: 20, endColumn: 20})
  assert.equal(reopened.cells.find(cell => cell.column === 20)?.value, '末尾-10001')
  await f.page.reload()
  await expect.poll(() => f.page.evaluate(() => window.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange('A10').getValue()), {timeout: 30000}).toBe(1)
  await expect(f.page.locator('.qa-btn').first()).toBeDisabled()
})

test('bulk 10001 cells over the UTF-8 limit remain unsaved without a download or revision', {timeout: 120000}, async t => {
  const f = await fixture(t)
  let preparations = 0, commits = 0, downloads = 0
  f.page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (path.endsWith('/sheets/uploads')) preparations++
    if (path.endsWith('/commits')) commits++
  })
  f.page.on('download', () => downloads++)
  // The text alone is 4,500,000 UTF-8 bytes, already above 4MiB, while
  // each cell remains well below its individual string-size limit.
  assert.ok(Buffer.byteLength('界'.repeat(150), 'utf8') * 10000 > 4 * 1024 * 1024)
  await editBulkCells(f.page, true)
  await assertBulkStillLive(f.page, true)
  await saveAndDownload(f.page).click()
  await expect(f.page.locator('.workbook-status').filter({hasText: 'Web save exceeds the request limit. Your edits are still unsaved; keep this page open and reduce the changes before retrying.'})).toBeVisible()
  await expect(f.page.locator('.qa-btn').first()).toBeEnabled()
  await assertBulkStillLive(f.page, true)
  assert.equal(preparations, 0)
  assert.equal(commits, 0)
  assert.equal(downloads, 0)
  const head = (await f.files.openFile(f.alice.token, f.opened.file.fileId)).file
  assert.equal(head.revision, f.opened.file.revision)
  assert.deepEqual(await f.files.readFile(f.alice.token, head.fileId, head.revision), f.original)
})

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
  assert.deepEqual(await f.files.readFile(f.alice.token, head.fileId, f.opened.file.revision), f.original)
  const native = createXlsxNativeWorker(await sandboxFixture('native'))
  const reopened = await native.readRange(downloaded, 'Acceptance', {startRow: 1, endRow: 1, startColumn: 0, endColumn: 1})
  assert.equal(reopened.cells.find(cell => cell.column === 0)?.value, 21.25)
  assert.equal(reopened.cells.find(cell => cell.column === 1)?.value, 42.5)
  await f.page.reload()
  await expect.poll(() => f.page.evaluate(() => window.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange('A2').getValue()), {timeout: 30000}).toBe(21.25)
  await expect.poll(() => f.page.evaluate(() => window.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange('B2').getValue()), {timeout: 30000}).toBe(42.5)
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
  const responses = []
  f.page.on('request', request => {
    if (new URL(request.url()).pathname.endsWith('/sheets/uploads')) preparations.push(request.postDataJSON().request)
  })
  const commitPath = `/api/v1/files/${f.opened.file.fileId}/commits`
  const held = holdFirstResponseEnd(req => req.method === 'POST' && req.url === commitPath)
  t.after(held.release)
  f.observeHttpRequests((req, res) => held.intercept(req, res))
  f.page.on('response', response => {
    const path = new URL(response.url()).pathname
    if (path === commitPath || path.endsWith('/sheets/uploads')) {
      responses.push([path === commitPath ? 'commit' : 'prepare', response.status()])
    }
  })
  const changed = await f.page.evaluate(async () => {
    const debug = window.__genofficeDebug
    const sheetId = debug.univerAPI.getActiveWorkbook().getActiveSheet().getSheetId()
    return debug.applyOps([{ op: 'insert_rows', sheetId, row: 2, count: 1 }])
  })
  assert.equal(changed.ok, true)
  const save = f.page.locator('.qa-btn').first()
  await expect(save).toBeEnabled(); await save.click()
  assert.equal(await held.started, 200)
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
  held.release()
  await expect.poll(() => f.page.evaluate(() => window.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange('A3').getValue()), { timeout: 30000 }).toBe(12.5)
  await expect(f.page.locator('.qa-btn').first()).toBeDisabled({ timeout: 15000 })
  try {
    await expect(f.page.locator('.status-bar .status-msg')).not.toContainText('Saving workbook structure', { timeout: 15000 })
    await expect(f.page.locator('.status-bar .status-msg')).not.toContainText('Finishing pending workbook changes', { timeout: 15000 })
  } catch (error) {
    t.diagnostic(`Structural save responses: ${JSON.stringify(responses)}`)
    throw error
  }
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


test('native XLSX explicitly writes literal analysis cells and independently saves a real revision', {timeout:120_000},async t=>{
 const f=await fixture(t,true,true,undefined,undefined,true),{page,opened,files,alice}=f
 const net=mockProviderNetwork(t,syntheticAnalysisFrames())
 if(await page.locator('.expand-copilot').isVisible())await page.locator('.expand-copilot').click()
 const composer=page.locator('.copilot textarea')
 await composer.fill('Create the local synthetic analysis table');await composer.press('Enter')
 const panel=page.locator('.analysis-deliveries')
 // The delivery can arrive before the provider's second reply. Wait for that
 // reply's text before checking the exact two-turn request count; this does
 // not assert that the SSE stream or durable budget settlement has finished.
 await expect(page.locator('.copilot').getByText('Synthetic artifact ready. Insert and save are separate user actions.',{exact:true})).toBeVisible({timeout:30_000})
 await page.getByRole('tab',{name:/^(?:Tasks|任务)(?:\s*\d+)?$/}).click()
 await expect(panel.locator('summary')).toContainText('(1)',{timeout:30_000})
 await panel.locator('summary').click()
 assert.equal(f.analysisAdapter.runs,1);assert.equal(net.writes,2)
 // Explicitly select a free area using the existing test-only native editor hook.
 await page.evaluate(()=>window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange('J10').activate())
 await expect(panel).toContainText('overwrite')
 await panel.getByRole('button',{name:'Write to selection',exact:true}).click()
 await expect(panel).toContainText('Applied, not saved')
 await expect.poll(()=>page.evaluate(()=>window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange('J10').getValue())).toBe('=1+1')
 await expect.poll(()=>page.evaluate(()=>window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange('J11').getValue())).toBe('0012')
 await expect.poll(()=>page.evaluate(()=>window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange('K11').getValue())).toBe('TRUE')
 await composer.focus();await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await page.waitForTimeout(1100)
 assert.equal((await files.openFile(alice.token,opened.file.fileId)).file.revision,opened.file.revision)
 await panel.getByRole('button',{name:'Save document',exact:true}).click()
 await expect(panel).toContainText('Saved revision',{timeout:30_000})
 const saved=await files.openFile(alice.token,opened.file.fileId);assert.notEqual(saved.file.revision,opened.file.revision)
 await expect(panel).toContainText(saved.file.revision)
 const zip=await JSZip.loadAsync(await files.readFile(alice.token,saved.file.fileId,saved.file.revision))
 const xml=await zip.file('xl/worksheets/sheet1.xml').async('string')
 const cell=/<c\b[^>]*\br="J10"[^>]*>([\s\S]*?)<\/c>/.exec(xml)?.[1]
 assert.ok(cell,'Saved J10 must exist');assert.doesNotMatch(cell,/<f(?:>|\s)/,'Formula-looking analysis text must not become a formula')
 await page.reload()
 await expect.poll(()=>page.evaluate(()=>window.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange('J10').getValue()),{timeout:30_000}).toBe('=1+1')
 await expect.poll(()=>page.evaluate(()=>window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange('J11').getValue())).toBe('0012')
})
