import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { expect } from '@playwright/test'
import forge from 'node-forge'
import { PDFDocument } from 'pdf-lib'
import { readPdfSignatures } from '../../../pdf/src/main/pdf-signatures.ts'
import { buildLocalApp } from '../../server/src/app.ts'
import { createWorkspaceService } from '../../server/src/modules/workspace/service.ts'
import { fileFixture, importFile } from '../helpers/files.mjs'
import { launchTestBrowser } from '../helpers/browser.mjs'
import { password } from '../helpers/identity.mjs'
import { officeBrowserAsset } from '../helpers/office-browser-assets.mjs'
import { stubHomeHero } from '../helpers/home-hero.mjs'

const directory = process.env.DYOFFICE_TEST_NATIVE_PDF_DIST

function makeCertificate(password) {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date(Date.now() - 60_000)
  cert.validity.notAfter = new Date(Date.now() + 3_600_000)
  cert.setSubject([{ name: 'commonName', value: 'Local PDF signer' }])
  cert.setIssuer(cert.subject.attributes)
  cert.sign(keys.privateKey, forge.md.sha256.create())
  const asn = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password)
  return Buffer.from(forge.asn1.toDer(asn).getBytes(), 'binary')
}

test('Web PDF signs with a local PKCS#12 and downloads or saves a verifiable copy', {
  timeout: 120_000, skip: !directory,
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
  await f.preferences.update(f.alice.token, { language: 'en', autoSave: false })
  const pdf = await PDFDocument.create()
  pdf.addPage([612, 792]).drawText('Authenticated source document')
  const source = Buffer.from(await pdf.save())
  const { file } = await importFile(f, f.alice.token, source, 'source.pdf')
  app = await buildLocalApp({
    db: f.db, businessPool: f.businessPool, passwords: f.passwords, deploymentId: f.deploymentId,
    origin, csrfKey: f.csrfKey, objectStore: f.objects, nativePdfDirectory: directory,
    localShellDirectory: officeBrowserAsset('local-shell'),
  })
  f.cleanup.unshift(() => app.close())
  const browser = await launchTestBrowser()
  f.cleanup.unshift(() => browser.close())
  const page = await browser.newPage({ acceptDownloads: true })
  await stubHomeHero(page)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const csrf = await (await page.request.get(origin + '/api/v1/auth/csrf')).json()
  assert.equal((await page.request.post(origin + '/api/v1/auth/login', {
    headers: { origin, 'x-csrf-token': csrf.csrfToken },
    data: { username: 'alice', password },
  })).status(), 200)
  await page.goto(origin + '/native-pdf/?fileId=' + file.fileId)
  await expect(page.locator('html')).toHaveAttribute('data-document-loading', 'ready')
  const certificatePassword = 'browser-only test passphrase'
  const certificateBytes = makeCertificate(certificatePassword)
  const privateRequests = []
  page.on('request', request => {
    const body = request.postDataBuffer()
    if (body?.includes(certificateBytes) || body?.includes(certificatePassword) || body?.includes('local-signer.p12')) {
      privateRequests.push(request.url())
    }
  })
  async function checkCertificate(dialog, testWrongPassword = false) {
    const [picker] = await Promise.all([
      page.waitForEvent('filechooser'),
      dialog.getByRole('button', { name: 'Choose certificate…' }).click(),
    ])
    await picker.setFiles({
      name: 'local-signer.p12', mimeType: 'application/x-pkcs12', buffer: certificateBytes,
    })
    const secret = dialog.locator('input[type=password]')
    const check = dialog.getByRole('button', { name: 'Check certificate' })
    if (testWrongPassword) {
      await secret.fill('incorrect')
      await check.click()
      await expect(dialog.getByText('The certificate password is wrong')).toBeVisible()
    }
    await secret.fill(certificatePassword)
    await check.click()
    await expect(dialog.getByText('Local PDF signer', { exact: true })).toBeVisible()
  }
  await page.getByRole('button', { name: 'Annotate', exact: true }).click()
  await page.getByRole('button', { name: 'Certificate sign', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Sign with a digital certificate' })
  await expect(dialog.getByRole('option', { name: 'System certificate store' })).toHaveCount(0)
  await checkCertificate(dialog, true)
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'Sign and download' }).click(),
  ])
  assert.equal(download.suggestedFilename(), 'source-signed.pdf')
  const signed = await readFile(await download.path())
  assert.deepEqual(signed.subarray(0, source.length), source)
  const [signature] = await readPdfSignatures(signed)
  assert.equal(signature.coversWholeDocument, true)
  assert.equal(signature.signer.commonName, 'Local PDF signer')
  assert.deepEqual(signature.problems, ['self-signed'])
  await expect(dialog).toHaveCount(0)
  assert.equal((await f.files.openFile(f.alice.token, file.fileId)).file.revision, file.revision)

  const workspace = createWorkspaceService(f.transactions)
  const folder = await workspace.createFolder(f.alice.token, { name: 'Approvals', parentId: null })
  await page.goto(origin + '/#/file/' + file.fileId)
  const editor = page.frameLocator(`iframe[data-document-id="${file.fileId}"]`)
  await expect(editor.locator('html')).toHaveAttribute('data-document-loading', 'ready', { timeout: 30000 })
  await editor.getByRole('button', { name: 'Annotate', exact: true }).click()
  await editor.getByRole('button', { name: 'Certificate sign', exact: true }).click()
  const workspaceDialog = editor.getByRole('dialog', { name: 'Sign with a digital certificate' })
  await checkCertificate(workspaceDialog)
  const saveAs = workspaceDialog.getByRole('button', { name: 'Sign and save as…', exact: true })
  const destination = editor.getByRole('dialog', { name: 'Save a copy to your workspace' })
  await saveAs.click({ timeout: 5000 })
  await expect(destination.getByRole('textbox', { name: 'File name' })).toHaveValue('source-signed.pdf')
  await destination.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(saveAs).toBeEnabled()
  assert.equal((await f.files.listFiles(f.alice.token)).files.length, 1)

  await saveAs.click()
  await destination.getByRole('textbox', { name: 'File name' }).fill('Offline copy')
  const [workspaceDownload] = await Promise.all([
    page.waitForEvent('download'),
    destination.getByRole('button', { name: 'Download signed copy', exact: true }).click(),
  ])
  assert.equal(workspaceDownload.suggestedFilename(), 'Offline copy.pdf')
  const [downloadedSignature] = await readPdfSignatures(await readFile(await workspaceDownload.path()))
  assert.equal(downloadedSignature.coversWholeDocument, true)
  await expect(workspaceDialog).toHaveCount(0)
  assert.equal((await f.files.listFiles(f.alice.token)).files.length, 1)
  await editor.getByRole('button', { name: 'Certificate sign', exact: true }).click()
  await checkCertificate(workspaceDialog)

  await saveAs.click()
  await destination.getByRole('textbox', { name: 'File name' }).fill('Approved contract')
  await destination.getByRole('combobox', { name: 'Folder' }).selectOption(folder.id)
  let committed
  await page.route('**/api/v1/uploads/*/finish', async route => {
    try {
      const request = route.request()
      const response = await app.inject({
        method: 'POST', url: new URL(request.url()).pathname, headers: await request.allHeaders(),
      })
      assert.equal(response.statusCode, 200)
      committed = response.json().file
    } finally {
      await route.abort('failed')
    }
  }, { times: 1 })
  await destination.getByRole('button', { name: 'Save copy', exact: true }).click()
  await expect(workspaceDialog).toHaveCount(0, { timeout: 20000 })
  const confirm = editor.getByRole('button', { name: '确认副本保存结果', exact: true })
  await expect(confirm).toBeVisible()
  assert.ok(committed)
  await confirm.click()
  await expect(page).toHaveURL(origin + '/#/file/' + committed.fileId)
  const signedEditor = page.frameLocator(`iframe[data-document-id="${committed.fileId}"]`)
  await expect(signedEditor.locator('html')).toHaveAttribute('data-document-loading', 'ready', { timeout: 30000 })
  const copies = (await workspace.listFiles(f.alice.token, { folderId: folder.id })).files
  assert.deepEqual(copies.map(copy => [copy.id, copy.name]), [[committed.fileId, 'Approved contract.pdf']])
  assert.equal((await f.files.listFiles(f.alice.token)).files.length, 2)
  const workspaceSigned = await f.files.readFile(f.alice.token, committed.fileId, committed.revision)
  assert.deepEqual(workspaceSigned.subarray(0, source.length), source)
  const [savedSignature] = await readPdfSignatures(workspaceSigned)
  assert.equal(savedSignature.coversWholeDocument, true)
  assert.equal(savedSignature.signer.commonName, 'Local PDF signer')
  assert.deepEqual(savedSignature.problems, ['self-signed'])
  assert.equal((await f.files.openFile(f.alice.token, file.fileId)).file.revision, file.revision)
  assert.deepEqual(await f.files.readFile(f.alice.token, file.fileId, file.revision), source)
  assert.deepEqual(privateRequests, [])
  assert.deepEqual(errors, [])
})
