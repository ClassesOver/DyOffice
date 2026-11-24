import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { expect } from '@playwright/test'
import { PDFDocument } from 'pdf-lib'
import { buildLocalApp } from '../../server/src/app.ts'
import { fileFixture, importFile } from '../helpers/files.mjs'
import { launchTestBrowser } from '../helpers/browser.mjs'
import { password } from '../helpers/identity.mjs'

const directory = process.env.DYOFFICE_TEST_NATIVE_PDF_DIST

test('Web PDF saves reusable visual signatures only for the signed-in browser account', {
  timeout: 90_000, skip: !directory,
}, async t => {
  let app
  const server = createServer((req, res) => app.routing(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  const origin = 'http://localhost:' + server.address().port
  const f = await fileFixture(t, { origin, buildApp: false })
  for (const account of [f.alice, f.bob]) {
    await f.preferences.update(account.token, { language: 'en', autoSave: false })
  }
  const pdf = await PDFDocument.create()
  pdf.addPage([612, 792]).drawText('Signature gallery fixture')
  const source = Buffer.from(await pdf.save())
  const { file: first } = await importFile(f, f.alice.token, source, 'first.pdf')
  const { file: second } = await importFile(f, f.alice.token, source, 'second.pdf')
  const { file: differentAccount } = await importFile(f, f.bob.token, source, 'bob.pdf')
  app = await buildLocalApp({
    db: f.db, businessPool: f.businessPool, passwords: f.passwords, deploymentId: f.deploymentId,
    origin, csrfKey: f.csrfKey, objectStore: f.objects, nativePdfDirectory: directory,
  })
  f.cleanup.unshift(() => app.close())
  const browser = await launchTestBrowser()
  f.cleanup.unshift(() => browser.close())
  const page = await browser.newPage()
  const csrf = async path => (await (await page.request.get(origin + '/api/v1/auth/' + path)).json()).csrfToken
  const login = async username => {
    assert.equal((await page.request.post(origin + '/api/v1/auth/login', {
      headers: { origin, 'x-csrf-token': await csrf('csrf') },
      data: { username, password },
    })).status(), 200)
  }
  const logout = async () => {
    assert.equal((await page.request.post(origin + '/api/v1/auth/logout', {
      headers: { origin, 'x-csrf-token': await csrf('session-proof') },
    })).status(), 204)
  }
  const open = async file => {
    await page.goto(origin + '/native-pdf/?fileId=' + file.fileId)
    await expect(page.locator('html')).toHaveAttribute('data-document-loading', 'ready')
  }
  const sign = async () => {
    await page.getByRole('button', { name: 'Annotate', exact: true }).click()
    await page.getByRole('button', { name: 'Sign', exact: true }).click()
    return page.getByRole('dialog', { name: 'Add signature', exact: true })
  }
  await login('alice')
  await open(first)
  const original = await sign()
  await original.getByRole('button', { name: 'Type', exact: true }).click()
  await original.getByPlaceholder('Enter your name').fill('Synthetic visual signature')
  await expect(original.getByRole('checkbox', { name: 'Save signature for reuse' })).toBeChecked()
  const writes = []
  const track = request => {
    const body = request.postData() ?? ''
    if (body.includes('iVBORw0KGgo') || body.includes('Synthetic visual signature')) writes.push(request.url())
  }
  page.on('request', track)
  await original.getByRole('button', { name: 'Place', exact: true }).click()
  await expect(original).toBeHidden()
  await page.keyboard.press('Escape')
  page.off('request', track)
  assert.deepEqual(writes, [])

  await open(second)
  const reused = await sign()
  await expect(reused.getByText('My signatures', { exact: true })).toBeVisible()
  await reused.locator('.pdf-sign-saved-pick').click()
  await expect(reused).toBeHidden()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Sign', exact: true }).click()
  const previousAccount = page.getByRole('dialog', { name: 'Add signature', exact: true })
  await expect(previousAccount.locator('.pdf-sign-saved-item')).toHaveCount(1)
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await expect(previousAccount.locator('.pdf-sign-saved-item')).toHaveCount(0)
  await logout()
  await login('bob')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(previousAccount.getByRole('alert')).toHaveText('Saved signatures are unavailable. You can still place a signature.')
  await expect(previousAccount.locator('.pdf-sign-saved-item')).toHaveCount(0)
  const stale = await page.evaluate(async () =>
    window.pdfApi.listSavedSignatures().then(() => 'accessible', () => 'rejected'),
  )
  assert.equal(stale, 'rejected')
  await open(differentAccount)
  const bobDialog = await sign()
  await expect(bobDialog.getByRole('button', { name: 'Place', exact: true })).toBeEnabled()
  await expect(bobDialog.getByText('My signatures', { exact: true })).toHaveCount(0)

  await logout()
  await login('alice')
  await open(second)
  const restored = await sign()
  await expect(restored.locator('.pdf-sign-saved-item')).toHaveCount(1)
  await restored.locator('.pdf-sign-saved-item').hover()
  await restored.getByTitle('Delete signature', { exact: true }).click()
  await expect(restored.locator('.pdf-sign-saved-item')).toHaveCount(0)
  await open(first)
  const reopened = await sign()
  await expect(reopened.getByRole('button', { name: 'Place', exact: true })).toBeEnabled()
  await expect(reopened.locator('.pdf-sign-saved-item')).toHaveCount(0)

  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', {
      get() { throw new DOMException('Test storage disabled', 'SecurityError') },
    })
  })
  await open(first)
  const unavailable = await sign()
  const option = unavailable.getByRole('checkbox', { name: 'Save signature for reuse' })
  await expect(option).toBeDisabled()
  await expect(option).not.toBeChecked()
  await expect(unavailable.getByRole('alert')).toHaveText('Saved signatures are unavailable. You can still place a signature.')
  await unavailable.getByRole('button', { name: 'Type', exact: true }).click()
  await unavailable.getByPlaceholder('Enter your name').fill('One-time signature')
  await unavailable.getByRole('button', { name: 'Place', exact: true }).click()
  await expect(unavailable).toBeHidden()
})
