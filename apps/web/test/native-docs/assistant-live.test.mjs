import test from 'node:test'
import assert from 'node:assert/strict'
import {randomBytes} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {expect} from '@playwright/test'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture, importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import JSZip from 'jszip'

const configFile = process.env.DYOFFICE_LIVE_ASSISTANT_TEST_CONFIG
test('native DOCX streams a synthetic document answer through a real provider', {skip: !configFile, timeout: 120_000}, async t => {
  const {baseUrl, model, allowedIpv4, keyFile} = JSON.parse(await readFile(configFile, 'utf8'))
  const key = (await readFile(keyFile, 'utf8')).trim()
  assert.ok(key.length > 0)
  const origin = 'http://localhost:4214', f = await fileFixture(t, {origin})
  const keyring = {activeKeyId: 'test', keys: {test: randomBytes(32)}}
  const profile = {deploymentId: f.deploymentId, entryId: 'live', revision: 1, providerId: 'openai', model, baseUrl, endpoint: baseUrl + '/chat/completions', allowedIpv4, maxOutputTokens: 128}
  await createGlobalConfigService({transactions: f.transactions, keyring}).saveGlobalConfig(f.adminSigned.token, 0, {upserts: [{id: profile.entryId, kind: 'chat', providerId: profile.providerId, label: 'Live acceptance', model, baseUrl, enabled: true, apiKey: key}]})
  await f.ownerPool.query('INSERT INTO provider_budget_accounts(deployment_id,owner_id,entry_id,config_revision,available_units,per_call_units) VALUES($1,$2,$3,1,1,1)', [f.deploymentId, f.alice.user.id, profile.entryId])

  const marker = 'coral-lantern-' + randomBytes(4).toString('hex')
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Test record code: ' + marker + '</w:t></w:r></w:p><w:sectPr/></w:body></w:document>')
  const original = await zip.generateAsync({type: 'nodebuffer'})
  const opened = await importFile(f, f.alice.token, original, 'synthetic-record.docx')
  const app = await buildLocalApp({db: f.db, businessPool: f.businessPool, passwords: f.passwords, deploymentId: f.deploymentId, origin, csrfKey: f.csrfKey, objectStore: f.objects, globalConfigKeyring: keyring, providerGateway: {profiles: [profile]}, nativeDocsDirectory: fileURLToPath(new URL('../../dist-docs', import.meta.url))})
  f.cleanup.push(() => app.close())
  await app.listen({host: '127.0.0.1', port: 4214})
  const browser = await launchTestBrowser()
  t.after(() => browser.close())
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.addInitScript(() => {
    const send = window.fetch.bind(window)
    window.fetch = async (...args) => {
      const result = await send(...args)
      if (String(args[0]).endsWith('/api/v1/ai/turns')) {
        window.liveAssistantFrames = result.clone().text().then(text => text.split('\n').filter(line => line.startsWith('event: ')))
      }
      return result
    }
  })
  const {csrfToken} = await (await page.request.get(origin + '/api/v1/auth/csrf')).json()
  assert.equal((await page.request.post(origin + '/api/v1/auth/login', {headers: {origin, 'x-csrf-token': csrfToken}, data: {username: 'alice', password}})).status(), 200)
  await page.goto(origin + '/native-docx/?fileId=' + opened.file.fileId)
  await expect(page.locator('.tiptap.doc-page').first()).toContainText(marker, {timeout: 45_000})
  if (await page.locator('.ai-rail').isVisible()) await page.locator('.ai-rail').click()
  await expect(page.getByLabel('助手模型')).toHaveValue('live')
  const composer = page.locator('.ai-panel textarea')
  const reply = page.waitForResponse(r => r.url().endsWith('/api/v1/ai/turns') && r.request().method() === 'POST')
  await composer.fill('From the open document, copy only the test record code. Do not call tools or add other text.')
  await composer.press('Enter')
  const response = await reply
  assert.equal(response.status(), 200)
  const frames = await page.evaluate(() => window.liveAssistantFrames)
  assert.ok(Array.isArray(frames) && frames.includes('event: delta'), 'real provider did not produce a text delta: ' + frames?.join(', '))
  assert.equal(frames.includes('event: error'), false)
  assert.equal(frames.filter(event => event === 'event: done').length, 1)
  await expect(page.locator('.ai-panel').getByText(marker, {exact: true})).toBeVisible()
  const {rows: [budget]} = await f.ownerPool.query('SELECT owner_id,state FROM provider_budget_reservations')
  assert.deepEqual(budget, {owner_id: f.alice.user.id, state: 'settled'})
  assert.deepEqual(await f.files.readFile(f.alice.token, opened.file.fileId, opened.file.revision), original)
})
