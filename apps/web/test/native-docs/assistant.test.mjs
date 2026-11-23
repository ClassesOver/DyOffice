import {assistantDiagnostics} from '../helpers/assistant-diagnostics.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {expect} from '@playwright/test'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture, docxBytes, importFile} from '../helpers/files.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {createSkillService} from '../../server/src/modules/skills/service.ts'
import {password} from '../helpers/identity.mjs'

// Failure-only diagnostics contain counters and fixed UI states, never request
// bodies, headers, cookies, Skill text, or arbitrary URLs/error messages.
function observeSkillRequests(page, origin) {
  const counters = Object.fromEntries(['catalog', 'body', 'sessionProof'].map(key => [key, {requests: 0, failed: 0, statuses: {}}]))
  const kind = value => {
    try {
      const url = new URL(value)
      if (url.origin !== origin) return undefined
      return {'/api/v1/skills': 'catalog', '/api/v1/skills/alice-report': 'body', '/api/v1/auth/session-proof': 'sessionProof'}[url.pathname]
    } catch { return undefined }
  }
  page.on('request', request => {const key = kind(request.url()); if (key) counters[key].requests++})
  page.on('requestfailed', request => {const key = kind(request.url()); if (key) counters[key].failed++})
  page.on('response', response => {const key = kind(response.url()); if (key) {const status = response.status(); if (!Number.isInteger(status) || status < 100 || status > 599) return; counters[key].statuses[status] = (counters[key].statuses[status] ?? 0) + 1}})
  return counters
}
async function captureSkillMenuState(page) {
  try {
    return await page.evaluate(() => {
      const plus = document.querySelector('.ai-plus-btn'), menu = document.querySelector('.ai-plus-pop[role="menu"]')
      const expanded = plus?.getAttribute('aria-expanded')
      return {
        language: ['zh', 'en'].includes(document.documentElement.lang) ? document.documentElement.lang : 'other',
        hidden: document.hidden, focused: document.hasFocus(),
        plusCount: document.querySelectorAll('.ai-plus-btn').length,
        expanded: expanded === 'true' || expanded === 'false' ? expanded : 'missing',
        menuCount: document.querySelectorAll('.ai-plus-pop[role="menu"]').length,
        searchCount: menu?.querySelectorAll('.ai-plus-search').length ?? 0,
        checkboxCount: menu?.querySelectorAll('[role="menuitemcheckbox"]').length ?? 0,
        emptyCount: menu?.querySelectorAll('.ai-plus-empty').length ?? 0,
        dockCount: document.querySelectorAll('.ai-dock').length,
        railCount: document.querySelectorAll('.ai-rail').length,
      }
    })
  } catch { return {unavailable: true} }
}

test('native DOCX assistant delivers selected private Skill through the personal Provider Gateway', {timeout: 120_000}, async t => {
  const diagnostic=assistantDiagnostics(t.signal)
  t.after(()=>diagnostic.dispose())
  try {
  diagnostic.stage('fixture')
  let phase = 'fixture'
  const turns = {headers: 0, finished: 0, failed: 0}
  const onAbort = () => t.diagnostic(JSON.stringify({stage: 'assistant-abort', phase, turns}))
  t.signal.addEventListener('abort', onAbort, {once: true})
  t.after(() => t.signal.removeEventListener('abort', onAbort))
  const atPhase = async (name, operation) => {
    phase = name
    let timer
    try {
      return await Promise.race([operation(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Assistant phase timeout: ' + name)), 20_000)
      })])
    } catch (error) {
      t.diagnostic(JSON.stringify({stage: 'assistant-wait', phase, turns}))
      throw error
    } finally { clearTimeout(timer) }
  }
  const origin = 'http://localhost:4213', f = await fileFixture(t, {origin})
  async function waitForSettlement(name, count, response, previousTurnIds = []) {
    const {turnId} = response.request().postDataJSON()
    assert.match(turnId, /^[A-Za-z0-9_-]{1,128}$/)
    assert.ok(!previousTurnIds.includes(turnId), 'Each request must have a distinct turn ID')
    const turnIds = [...previousTurnIds, turnId].sort()
    assert.equal(turnIds.length, count)
    phase = name
    await expect(page.locator('.ai-panel .ai-stop-btn')).toHaveCount(0, {timeout: 20_000})
    await expect.poll(async () => {
      const {rows} = await f.ownerPool.query('SELECT turn_id,owner_id,state FROM provider_budget_reservations WHERE deployment_id=$1', [f.deploymentId])
      return {turnIds: rows.map(row => row.turn_id).sort(), count: rows.length, allOwned: rows.every(row => row.owner_id === f.alice.user.id), allSettled: rows.every(row => row.state === 'settled')}
    }, {timeout: 20_000}).toEqual({turnIds, count, allOwned: true, allSettled: true})
    return turnId
  }
  const keyring = {activeKeyId: 'test', keys: {test: new Uint8Array(32).fill(25)}}
  const profile = {deploymentId: f.deploymentId, entryId: 'primary', revision: 1, providerId: 'openai', model: 'synthetic', baseUrl: 'https://provider.example/v1', endpoint: 'https://provider.example/v1/chat/completions', allowedIpv4: ['8.8.8.8'], maxOutputTokens: 128}
  const settings = createGlobalConfigService({transactions: f.transactions, keyring})
  diagnostic.stage('settings')
  await settings.saveGlobalConfig(f.adminSigned.token, 0, {upserts: [{id: profile.entryId, kind: 'chat', providerId: profile.providerId, label: 'Company Chat', model: profile.model, baseUrl: profile.baseUrl, enabled: true, apiKey: 'synthetic-private-key'}]})
  diagnostic.stage('budget-setup')
  await f.ownerPool.query('INSERT INTO provider_budget_accounts(deployment_id,owner_id,entry_id,config_revision,available_units,per_call_units) VALUES($1,$2,$3,1,20,10)', [f.deploymentId, f.alice.user.id, profile.entryId])
  diagnostic.stage('skills')
  const skill = createSkillService(f.transactions)
  await skill.save(f.alice.token, 'alice-report', {description: 'Alice report skill', body: 'Use Alice private instructions to summarize a DOCX document.'})
  await skill.save(f.bob.token, 'bob-report', {description: 'Bob report skill', body: 'Use Bob private instructions to summarize a DOCX document.'})
  diagnostic.stage('import')
  const original = await docxBytes(), opened = await importFile(f, f.alice.token, original)
  diagnostic.stage('app')
  const app = await buildLocalApp({db: f.db, businessPool: f.businessPool, passwords: f.passwords, deploymentId: f.deploymentId, origin, csrfKey: f.csrfKey, objectStore: f.objects, globalConfigKeyring: keyring, providerGateway: {profiles: [profile]}, nativeDocsDirectory: fileURLToPath(new URL('../../dist-docs', import.meta.url))})
  diagnostic.stage('listen')
  f.cleanup.push(() => app.close()); await app.listen({host: '127.0.0.1', port: 4213})
  diagnostic.stage('browser')
  phase = 'browser-launch'
  const browser = await launchTestBrowser(); t.after(() => browser.close())
  const page = await browser.newPage(), errors = []
  diagnostic.observe(page)
  page.on('pageerror', error => errors.push(error.message))
  const isTurn = request => request.url() === origin + '/api/v1/ai/turns' && request.method() === 'POST'
  page.on('response', response => {if (isTurn(response.request())) turns.headers++})
  page.on('requestfinished', request => {if (isTurn(request)) turns.finished++})
  page.on('requestfailed', request => {if (isTurn(request)) turns.failed++})
  const skillRequests = observeSkillRequests(page, origin)
  diagnostic.stage('auth')
  const auth = await page.request.get(origin + '/api/v1/auth/csrf')
  const {csrfToken} = await auth.json()
  assert.equal((await page.request.post(origin + '/api/v1/auth/login', {headers: {origin, 'x-csrf-token': csrfToken}, data: {username: 'alice', password}})).status(), 200)
  const net = mockProviderNetwork(t, [Buffer.from('data: {"choices":[{"delta":{"content":"Verified assistant reply"},"finish_reason":"stop"}]}\n\n'), Buffer.from('data: [DONE]\n\n')])
  diagnostic.stage('catalog')
  const catalog = page.waitForResponse(r => r.url().endsWith('/api/v1/ai/catalog'))
  await page.goto(origin + '/native-docx/?fileId=' + opened.file.fileId)
  const response = await catalog
  assert.equal(response.status(), 200)
  assert.equal((await response.json()).defaultId, 'primary')
  diagnostic.stage('editor')
  await expect(page.locator('.tiptap.doc-page').first()).toBeVisible({timeout: 45_000})
  await expect(page.locator('.ai-dock')).toBeAttached()
  assert.deepEqual(errors, [])
  if (await page.locator('.ai-rail').isVisible()) await page.locator('.ai-rail').click()
  await expect(page.getByRole('button', {name: '模型: synthetic', exact: true})).toBeVisible()
  let attachAttempt = 0
  const attachSkill = async () => {
    attachAttempt++
    phase = 'attach-skill-' + attachAttempt
    try {
      await page.locator('.ai-plus-btn').click()
      const details = page.getByRole('menuitem', {name: '技能', exact: true})
      if (await details.isVisible()) await details.click()
      const option = page.getByRole('menuitemcheckbox', {name: /alice-report/})
      await option.click()
      await expect(option).toHaveAttribute('aria-checked', 'true')
      await expect(page.getByText('Bob report skill', {exact: true})).toHaveCount(0)
    } catch (error) {
      t.diagnostic(JSON.stringify({stage: 'attachSkill', attempt: attachAttempt, pageerrorCount: errors.length, requests: skillRequests, menu: await captureSkillMenuState(page)}))
      throw error
    }
  }
  diagnostic.stage('skill-cancel')
  const composer = page.locator('.ai-panel textarea')
  // Body-only Office classification reads the Skill while populating the menu.
  // Finish that prefetch before pausing the separate send-time read below.
  await attachSkill()
  assert.equal(net.writes, 0)
  const skillUrl = '**/api/v1/skills/alice-report'
  const reached = Promise.withResolvers(), resume = Promise.withResolvers()
  await page.route(skillUrl, async route => {
    reached.resolve()
    await resume.promise
    await route.continue()
  }, {times: 1})
  try {
    await composer.fill('Cancel while reading the Skill')
    await composer.press('Enter')
    diagnostic.stage('skill-gate')
    await atPhase('cancel-skill-read-reached', () => reached.promise)
    diagnostic.stage('cancel-stop')
    await page.locator('.ai-panel .ai-stop-btn').click()
  } finally {
    resume.resolve()
  }
  diagnostic.stage('cancel-settled')
  await expect(page.locator('.ai-panel .ai-stop-btn')).toHaveCount(0)
  assert.equal(net.writes, 0)
  await attachSkill()
  // The transport cancels its reader after the SSE terminal event. Require
  // terminal UI and exact durable settlement, rather than network EOF.
  diagnostic.stage('first-send');diagnostic.arm('first')
  const firstTurn = page.waitForResponse(r => r.url() === origin + '/api/v1/ai/turns' && r.request().method() === 'POST')
  await composer.fill('Summarize this document')
  phase = 'send-turn'
  await composer.press('Enter')
  diagnostic.stage('first-visible')
  await expect(page.getByText('Verified assistant reply', {exact: true})).toBeVisible({timeout: 20_000})
  diagnostic.stage('first-response')
  const firstResponse = await atPhase('first-response-headers', () => firstTurn)
  assert.equal(firstResponse.status(), 200)
  diagnostic.stage('first-ui-settled')
  const firstTurnId = await waitForSettlement('first-settlement', 1, firstResponse)
  diagnostic.stage('wire')
  const wire = JSON.parse(net.wire)
  assert.equal(wire.model, profile.model)
  assert.equal(wire.max_tokens, 128)
  assert.match(JSON.stringify(wire.messages), /Alice private instructions/)
  assert.doesNotMatch(JSON.stringify(wire), /Bob private instructions|synthetic-private-key/)
  assert.ok(wire.tools.some(tool => tool.function.name === 'apply_ops'), 'Native DOCX supports editing the open document')
  diagnostic.stage('second-send');diagnostic.arm('second')
  const secondTurn = page.waitForResponse(r => r.url() === origin + '/api/v1/ai/turns' && r.request().method() === 'POST')
  await composer.fill('Follow-up without a Skill')
  phase = 'send-turn'
  await composer.press('Enter')
  diagnostic.stage('second-visible')
  await expect(page.getByText('Verified assistant reply', {exact: true})).toHaveCount(2)
  diagnostic.stage('second-response')
  const secondResponse = await atPhase('second-response-headers', () => secondTurn)
  assert.equal(secondResponse.status(), 200)
  diagnostic.stage('second-ui-settled')
  await waitForSettlement('second-settlement', 2, secondResponse, [firstTurnId])
  assert.equal(net.writes, 2)
  assert.doesNotMatch(net.wire.toString(), /Alice private instructions|Bob private instructions/)
  diagnostic.stage('ledger')
  phase = 'budget-read'
  const {rows: budgets} = await f.ownerPool.query('SELECT owner_id,state FROM provider_budget_reservations')
  assert.deepEqual(budgets, Array(2).fill({owner_id: f.alice.user.id, state: 'settled'}))
  diagnostic.stage('original-bytes')
  phase = 'file-read'
  assert.deepEqual(await f.files.readFile(f.alice.token, opened.file.fileId, opened.file.revision), original)
  assert.deepEqual(errors, [])
  phase = 'cleanup'
  diagnostic.stage('complete')
  } catch(error) {diagnostic.report();throw error}
})
