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
import {syntheticAnalysisAdapter,syntheticAnalysisFrames} from '../helpers/analysis-delivery.mjs'
import JSZip from 'jszip'
import {password} from '../helpers/identity.mjs'

test('native DOCX inserts a verified synthetic artifact explicitly and saves a separate real revision', {timeout: 120_000}, async t => {
  const origin = 'http://localhost:4216', f = await fileFixture(t, {origin})
  const keyring = {activeKeyId: 'test', keys: {test: new Uint8Array(32).fill(25)}}
  const profile = {deploymentId: f.deploymentId, entryId: 'primary', revision: 1, providerId: 'openai', model: 'synthetic', baseUrl: 'https://provider.example/v1', endpoint: 'https://provider.example/v1/chat/completions', allowedIpv4: ['8.8.8.8'], maxOutputTokens: 128}
  const settings = createGlobalConfigService({transactions: f.transactions, keyring})
  await settings.saveGlobalConfig(f.adminSigned.token, 0, {upserts: [{id: profile.entryId, kind: 'chat', providerId: profile.providerId, label: 'Company Chat', model: profile.model, baseUrl: profile.baseUrl, enabled: true, apiKey: 'synthetic-private-key'}]})
  await f.ownerPool.query('INSERT INTO provider_budget_accounts(deployment_id,owner_id,entry_id,config_revision,available_units,per_call_units) VALUES($1,$2,$3,1,20,10)', [f.deploymentId, f.alice.user.id, profile.entryId])
  const skill = createSkillService(f.transactions)
  await skill.save(f.alice.token, 'alice-report', {description: 'Alice report skill', body: 'Use Alice private instructions.'})
  await skill.save(f.bob.token, 'bob-report', {description: 'Bob report skill', body: 'Use Bob private instructions.'})
  await f.preferences.update(f.alice.token,{language:'en',autoSave:true,showAssistant:true})
  const original = await docxBytes(), opened = await importFile(f, f.alice.token, original)
  let app
  const adapter=syntheticAnalysisAdapter(()=>app)
  app = await buildLocalApp({db: f.db, businessPool: f.businessPool, passwords: f.passwords, deploymentId: f.deploymentId, origin, csrfKey: f.csrfKey, objectStore: f.objects, globalConfigKeyring: keyring, providerGateway: {profiles: [profile]}, codingHarnesses:{adapters:[adapter],defaultId:adapter.descriptor.id}, nativeDocsDirectory: fileURLToPath(new URL('../../dist-docs', import.meta.url))})
  f.cleanup.push(() => app.close()); await app.listen({host: '127.0.0.1', port: 4216})
  const browser = await launchTestBrowser(); t.after(() => browser.close())
  const page = await browser.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  const auth = await page.request.get(origin + '/api/v1/auth/csrf')
  const {csrfToken} = await auth.json()
  assert.equal((await page.request.post(origin + '/api/v1/auth/login', {headers: {origin, 'x-csrf-token': csrfToken}, data: {username: 'alice', password}})).status(), 200)
  const net = mockProviderNetwork(t, syntheticAnalysisFrames())
  const catalog = page.waitForResponse(r => r.url().endsWith('/api/v1/ai/catalog'))
  await page.goto(origin + '/native-docx/?fileId=' + opened.file.fileId)
  const response = await catalog
  assert.equal(response.status(), 200)
  assert.equal((await response.json()).defaultId, 'primary')
  await expect(page.locator('.tiptap.doc-page').first()).toBeVisible({timeout: 45_000})
  await expect(page.locator('.ai-dock')).toBeAttached()
  assert.deepEqual(errors, [])
  if (await page.locator('.ai-rail').isVisible()) await page.locator('.ai-rail').click()
  await expect(page.getByLabel('助手模型')).toHaveValue('primary')
  const composer=page.locator('.ai-panel textarea')
  await composer.fill('Create the local synthetic analysis artifact')
  await composer.press('Enter')
  const deliveries=page.locator('.analysis-deliveries')
  await expect(deliveries.locator('summary')).toContainText('(1)',{timeout:30_000})
  await deliveries.locator('summary').click()
  await expect(deliveries.getByText('Synthetic literal content; not a real model result',{exact:true})).toBeVisible()
  assert.equal(adapter.runs,1);assert.equal(net.writes,2)
  assert.equal((await f.files.openFile(f.alice.token,opened.file.fileId)).file.revision,opened.file.revision)
  await deliveries.getByRole('button',{name:'Insert into document',exact:true}).click()
  await expect(deliveries).toContainText('Applied, not saved')
  await expect(page.locator('.tiptap.doc-page').first()).toContainText('Analysis literal <script>not executable</script>')
  await expect(page.locator('.tiptap.doc-page').first()).toContainText('Unverified analysis')
  // A normal blur must not persist analysisPending even with autosave enabled.
  await composer.focus();await page.evaluate(()=>window.dispatchEvent(new Event('blur')))
  await page.waitForTimeout(1100)
  assert.equal((await f.files.openFile(f.alice.token,opened.file.fileId)).file.revision,opened.file.revision)
  await deliveries.getByRole('button',{name:'Save document',exact:true}).click()
  await expect(deliveries).toContainText('Saved revision',{timeout:30_000})
  const saved=await f.files.openFile(f.alice.token,opened.file.fileId)
  assert.notEqual(saved.file.revision,opened.file.revision)
  await expect(deliveries).toContainText(saved.file.revision)
  const zip=await JSZip.loadAsync(await f.files.readFile(f.alice.token,saved.file.fileId,saved.file.revision))
  const xml=await zip.file('word/document.xml').async('string')
  assert.match(xml,/Analysis literal/);assert.match(xml,/&lt;script&gt;not executable&lt;\/script&gt;/);assert.match(xml,/Unverified analysis/)
  await page.reload()
  await expect(page.locator('.tiptap.doc-page').first()).toContainText('Analysis literal',{timeout:30_000})
  assert.deepEqual(errors,[])
})
