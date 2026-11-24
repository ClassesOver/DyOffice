import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { expect } from '@playwright/test'
import forge from 'node-forge'
import { PDFDocument } from 'pdf-lib'
import { readPdfSignatures } from '../../../pdf/src/main/pdf-signatures.ts'
import { buildLocalApp } from '../../server/src/app.ts'
import { fileFixture, importFile } from '../helpers/files.mjs'
import { launchTestBrowser } from '../helpers/browser.mjs'
import { password } from '../helpers/identity.mjs'

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

test('Web PDF inspects and signs with a local PKCS#12 and downloads a verifiable copy', {
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
  await f.preferences.update(f.alice.token, { language: 'en', autoSave: false })
  const pdf = await PDFDocument.create()
  pdf.addPage([612, 792]).drawText('Authenticated source document')
  const source = Buffer.from(await pdf.save())
  const { file } = await importFile(f, f.alice.token, source, 'source.pdf')
  app = await buildLocalApp({
    db: f.db, businessPool: f.businessPool, passwords: f.passwords, deploymentId: f.deploymentId,
    origin, csrfKey: f.csrfKey, objectStore: f.objects, nativePdfDirectory: directory,
  })
  f.cleanup.unshift(() => app.close())
  const browser = await launchTestBrowser()
  f.cleanup.unshift(() => browser.close())
  const page = await browser.newPage({ acceptDownloads: true })
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
  const privateRequests = []
  page.on('request', request => {
    if (request.postData()?.includes(certificatePassword) || request.postData()?.includes('local-signer.p12')) {
      privateRequests.push(request.url())
    }
  })
  await page.getByRole('button', { name: 'Annotate', exact: true }).click()
  await page.getByRole('button', { name: 'Certificate sign', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Sign with a digital certificate' })
  await expect(dialog.getByRole('option', { name: 'System certificate store' })).toHaveCount(0)
  const [picker] = await Promise.all([
    page.waitForEvent('filechooser'),
    dialog.getByRole('button', { name: 'Choose certificate…' }).click(),
  ])
  await picker.setFiles({
    name: 'local-signer.p12', mimeType: 'application/x-pkcs12', buffer: makeCertificate(certificatePassword),
  })
  const secret = dialog.locator('input[type=password]')
  await secret.fill('incorrect')
  await dialog.getByRole('button', { name: 'Check certificate' }).click()
  await expect(dialog.getByText('The certificate password is wrong')).toBeVisible()
  await secret.fill(certificatePassword)
  await dialog.getByRole('button', { name: 'Check certificate' }).click()
  await expect(dialog.getByText('Local PDF signer', { exact: true })).toBeVisible()
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
  assert.deepEqual(privateRequests, [])
  assert.deepEqual(errors, [])
})
