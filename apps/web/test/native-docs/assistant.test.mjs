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

test('native DOCX assistant delivers selected private Skill through the personal Provider Gateway', {timeout: 120_000}, async t => {
  const diagnostic=assistantDiagnostics(t.signal)
  t.after(()=>diagnostic.dispose())
  try {
  diagnostic.stage('fixture')
  const origin = 'http://localhost:4213', f = await fileFixture(t, {origin})
  const keyring = {activeKeyId: 'test', keys: {test: new Uint8Array(32).fill(25)}}
  const profile = {deploymentId: f.deploymentId, entryId: 'primary', revision: 1, providerId: 'openai', model: 'synthetic', baseUrl: 'https://provider.example/v1', endpoint: 'https://provider.example/v1/chat/completions', allowedIpv4: ['8.8.8.8'], maxOutputTokens: 128}
  const settings = createGlobalConfigService({transactions: f.transactions, keyring})
  diagnostic.stage('settings')
  await settings.saveGlobalConfig(f.adminSigned.token, 0, {upserts: [{id: profile.entryId, kind: 'chat', providerId: profile.providerId, label: 'Company Chat', model: profile.model, baseUrl: profile.baseUrl, enabled: true, apiKey: 'synthetic-private-key'}]})
  diagnostic.stage('budget-setup')
  await f.ownerPool.query('INSERT INTO provider_budget_accounts(deployment_id,owner_id,entry_id,config_revision,available_units,per_call_units) VALUES($1,$2,$3,1,20,10)', [f.deploymentId, f.alice.user.id, profile.entryId])
  diagnostic.stage('skills')
  const skill = createSkillService(f.transactions)
  await skill.save(f.alice.token, 'alice-report', {description: 'Alice report skill', body: 'Use Alice private instructions.'})
  await skill.save(f.bob.token, 'bob-report', {description: 'Bob report skill', body: 'Use Bob private instructions.'})
  diagnostic.stage('import')
  const original = await docxBytes(), opened = await importFile(f, f.alice.token, original)
  diagnostic.stage('app')
  const app = await buildLocalApp({db: f.db, businessPool: f.businessPool, passwords: f.passwords, deploymentId: f.deploymentId, origin, csrfKey: f.csrfKey, objectStore: f.objects, globalConfigKeyring: keyring, providerGateway: {profiles: [profile]}, nativeDocsDirectory: fileURLToPath(new URL('../../dist-docs', import.meta.url))})
  diagnostic.stage('listen')
  f.cleanup.push(() => app.close()); await app.listen({host: '127.0.0.1', port: 4213})
  diagnostic.stage('browser')
  const browser = await launchTestBrowser(); t.after(() => browser.close())
  const page = await browser.newPage(), errors = []
  diagnostic.observe(page)
  page.on('pageerror', error => errors.push(error.message))
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
  await expect(page.getByLabel('助手模型')).toHaveValue('primary')
  const attachSkill = async () => {
    await page.locator('.ai-plus-btn').click()
    const details = page.getByRole('menuitem', {name: '技能', exact: true})
    if (await details.isVisible()) await details.click()
    await expect(page.getByText('Bob report skill', {exact: true})).toHaveCount(0)
    const option = page.getByRole('menuitemcheckbox', {name: /alice-report/})
    await option.click()
    await expect(option).toHaveAttribute('aria-checked', 'true')
  }
  diagnostic.stage('skill-cancel')
  const composer = page.locator('.ai-panel textarea')
  const skillUrl = '**/api/v1/skills/alice-report'
  const reached = Promise.withResolvers(), resume = Promise.withResolvers()
  await page.route(skillUrl, async route => {
    reached.resolve()
    await resume.promise
    await route.continue()
  }, {times: 1})
  try {
    await attachSkill()
    await composer.fill('Cancel while reading the Skill')
    await composer.press('Enter')
  diagnostic.stage('skill-gate')
    await reached.promise
  diagnostic.stage('cancel-stop')
    await page.locator('.ai-panel .ai-stop-btn').click()
  } finally {
    resume.resolve()
  }
  diagnostic.stage('cancel-settled')
  await expect(page.locator('.ai-panel .ai-stop-btn')).toHaveCount(0)
  assert.equal(net.writes, 0)
  await attachSkill()
  // Reply text is streamed before durable budget settlement. Observe the exact
  // HTTP turn completion before starting another turn or asserting its ledger.
  diagnostic.stage('first-send')
  diagnostic.arm('first')
  const firstTurn = page.waitForResponse(r => r.url().endsWith('/api/v1/ai/turns') && r.request().method() === 'POST')
  await composer.fill('Summarize this document')
  await composer.press('Enter')
  diagnostic.stage('first-visible')
  await expect(page.getByText('Verified assistant reply', {exact: true})).toBeVisible({timeout: 20_000})
  diagnostic.stage('first-response')
  const firstResponse = await firstTurn
  assert.equal(firstResponse.status(),200)
  diagnostic.stage('first-finished')
  assert.equal(await firstResponse.finished(),null)
  diagnostic.stage('first-ui-settled')
  await expect(page.locator('.ai-panel .ai-stop-btn')).toHaveCount(0)
  diagnostic.stage('wire')
  const wire = JSON.parse(net.wire)
  assert.equal(wire.model, profile.model)
  assert.equal(wire.max_tokens, 128)
  assert.match(JSON.stringify(wire.messages), /Alice private instructions/)
  assert.doesNotMatch(JSON.stringify(wire), /Bob private instructions|synthetic-private-key/)
  assert.ok(!wire.tools.some(tool => tool.function.name === 'apply_ops'))
  diagnostic.stage('second-send')
  diagnostic.arm('second')
  const secondTurn = page.waitForResponse(r => r.url().endsWith('/api/v1/ai/turns') && r.request().method() === 'POST')
  await composer.fill('Follow-up without a Skill')
  await composer.press('Enter')
  diagnostic.stage('second-visible')
  await expect(page.getByText('Verified assistant reply', {exact: true})).toHaveCount(2)
  diagnostic.stage('second-response')
  const secondResponse = await secondTurn
  assert.equal(secondResponse.status(),200)
  diagnostic.stage('second-finished')
  assert.equal(await secondResponse.finished(),null)
  diagnostic.stage('second-ui-settled')
  await expect(page.locator('.ai-panel .ai-stop-btn')).toHaveCount(0)
  assert.equal(net.writes, 2)
  assert.doesNotMatch(net.wire.toString(), /Alice private instructions|Bob private instructions/)
  diagnostic.stage('ledger')
  const {rows: budgets} = await f.ownerPool.query('SELECT owner_id,state FROM provider_budget_reservations')
  assert.deepEqual(budgets, Array(2).fill({owner_id: f.alice.user.id, state: 'settled'}))
  diagnostic.stage('original-bytes')
  assert.deepEqual(await f.files.readFile(f.alice.token, opened.file.fileId, opened.file.revision), original)
  assert.deepEqual(errors, [])
  diagnostic.stage('complete')
  } catch(error) {diagnostic.report();throw error}
})
