import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, mkdir, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createServer} from 'node:https'
import {fileURLToPath} from 'node:url'
import {expect} from '@playwright/test'
import JSZip from 'jszip'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture, docxBytes, importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'

const docsDirectory = fileURLToPath(new URL('../../dist-docs/', import.meta.url))
const documentPart = 'word/document.xml'
const originalText = ['Colored editable text', 'Black explicit text', 'Automatic editable text', 'Highlighted original text', 'Shaded original text', 'Plain editable text']
const editedText = originalText.map((text, index) => [0, 2, 5].includes(index) ? text + ' edited in native DOCX' : text)

async function coloredDocx() {
  // Keep the existing valid OOXML package scaffold, with one small page that
  // exercises authored RGB, automatic ink, highlight and paragraph shading.
  const archive = await JSZip.loadAsync(await docxBytes())
  archive.file(documentPart, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    '<w:p><w:r><w:rPr><w:color w:val="215E99"/></w:rPr><w:t>Colored editable text</w:t></w:r></w:p>' +
    '<w:p><w:r><w:rPr><w:color w:val="000000"/></w:rPr><w:t>Black explicit text</w:t></w:r></w:p>' +
    '<w:p><w:r><w:rPr><w:color w:val="auto"/></w:rPr><w:t>Automatic editable text</w:t></w:r></w:p>' +
    '<w:p><w:r><w:rPr><w:color w:val="C00000"/><w:highlight w:val="yellow"/></w:rPr><w:t>Highlighted original text</w:t></w:r></w:p>' +
    '<w:p><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="E2F0D9"/></w:pPr><w:r><w:rPr><w:color w:val="7F6000"/></w:rPr><w:t>Shaded original text</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Plain editable text</w:t></w:r></w:p>' +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>' +
    '</w:body></w:document>')
  archive.file('customXml/dyoffice-theme-preserve.xml', '<probe xmlns="urn:dyoffice:test:theme"><color>215E99</color><text>Untouched theme sentinel</text></probe>')
  return archive.generateAsync({type: 'nodebuffer'})
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-native-theme-'))
  let f, browser, server
  t.after(async () => {
    await browser?.close()
    if (server) {server.closeAllConnections(); await new Promise(resolve => server.close(resolve))}
    await f?.app.close()
    await rm(directory, {recursive: true, force: true})
  })
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], {stdio: 'pipe'})
  server = createServer({key: await readFile(join(directory, 'key.pem')), cert: await readFile(join(directory, 'cert.pem'))}, (req, res) => f.app.routing(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `https://127.0.0.1:${server.address().port}`
  f = await fileFixture(t, {origin, nativeDocsDirectory: docsDirectory})
  browser = await launchTestBrowser()
  t.diagnostic('Native DOCX theme verification with Chromium ' + browser.version())
  return {...f, browser, origin}
}

async function semantics(page, xml) {
  return page.evaluate(value => {
    const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
    const document = new DOMParser().parseFromString(value, 'application/xml')
    if (document.querySelector('parsererror')) throw new Error('Invalid saved document XML')
    const elements = (parent, localName) => [...parent.getElementsByTagNameNS(ns, localName)]
    const attrs = element => Object.fromEntries([...element.attributes].map(attribute => [attribute.name, attribute.value]).sort(([a], [b]) => a.localeCompare(b)))
    return {
      paragraphs: elements(document, 'p').map(paragraph => elements(paragraph, 't').map(text => text.textContent).join('')),
      colors: elements(document, 'color').map(attrs),
      highlights: elements(document, 'highlight').map(attrs),
      shading: elements(document, 'shd').map(attrs),
      backgrounds: elements(document, 'background').map(attrs),
    }
  }, xml)
}

// Real TLS, Cookie/CSRF login, PostgreSQL, object storage, native GenOffice
// renderer/serializer, commit and browser download. This covers DOCX editing;
// it makes no claim that the XLSX/PPTX/PDF native editors are connected.
test('native DOCX light and dark themes save the same edits without changing document colors or untouched parts', {timeout: 180_000}, async t => {
  const f = await fixture(t), original = await coloredDocx(), originalZip = await JSZip.loadAsync(original)
  const imported = new Map()
  for (const theme of ['light', 'dark']) imported.set(theme, await importFile(f, f.alice.token, original, `theme-${theme}.docx`))
  const saved = new Map(), paint = new Map(), errors = []
  for (const theme of ['light', 'dark']) {
    t.diagnostic('Opening, editing, saving and downloading in ' + theme + ' theme')
    await f.preferences.update(f.alice.token, {theme, language: 'en', autoSave: false, showAssistant: false})
    const context = await f.browser.newContext({ignoreHTTPSErrors: true, viewport: {width: 1440, height: 1100}})
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(f.origin + '/')
    const status = await page.evaluate(async password => {
      const challenge = await (await fetch('/api/v1/auth/csrf')).json()
      return (await fetch('/api/v1/auth/login', {method: 'POST', headers: {'content-type': 'application/json', 'x-csrf-token': challenge.csrfToken}, body: JSON.stringify({username: 'alice', password})})).status
    }, password)
    assert.equal(status, 200)
    const opened = imported.get(theme), fileId = opened.file.fileId
    const response = await page.goto(f.origin + '/native-docx/?fileId=' + fileId)
    assert.equal(response.status(), 200)
    const editor = page.locator('.tiptap.doc-page[contenteditable="true"]')
    await editor.waitFor({timeout: 45_000})
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await expect(page.locator('.workspace.page-dark')).toHaveCount(theme === 'dark' ? 1 : 0)
    paint.set(theme, await editor.evaluate(element => ({paper: getComputedStyle(element).backgroundColor, ink: getComputedStyle(element).color})))
    const before = await semantics(page, await originalZip.file(documentPart).async('string'))
    assert.deepEqual(before.paragraphs, originalText)
    for (const index of [0, 2, 5]) {
      const paragraph = editor.locator('p').filter({hasText: originalText[index]})
      await paragraph.click()
      await page.keyboard.press('End')
      await page.keyboard.type(' edited in native DOCX')
      await expect(paragraph).toHaveText(editedText[index])
    }
    const committed = page.waitForResponse(reply => reply.url().endsWith('/commits') && reply.request().method() === 'POST')
    await page.keyboard.press('Control+s')
    assert.equal((await committed).status(), 200)
    await expect(page.locator('.dyoffice-docs-state')).toHaveText('EditingDownload saved version')
    const current = await f.files.openFile(f.alice.token, fileId)
    assert.notEqual(current.file.revision, opened.file.revision, theme + ' must create an edited revision')
    assert.notEqual(current.file.sha256, opened.file.sha256, theme + ' must save edited bytes, not re-download the original')
    const bytes = await f.files.readFile(f.alice.token, fileId, current.file.revision)
    const archive = await JSZip.loadAsync(bytes), xml = await archive.file(documentPart).async('string')
    const after = await semantics(page, xml)
    assert.deepEqual(after.paragraphs, editedText, theme + ' saved text')
    assert.deepEqual(after.colors, before.colors, theme + ' must retain authored RGB and automatic ink')
    assert.deepEqual(after.highlights, before.highlights, theme + ' must retain authored highlight')
    assert.deepEqual(after.shading, before.shading, theme + ' must retain authored shading')
    assert.deepEqual(after.backgrounds, before.backgrounds, theme + ' must not persist a dark page background')
    const paths = Object.values(originalZip.files).filter(part => !part.dir).map(part => part.name).sort()
    assert.deepEqual(Object.values(archive.files).filter(part => !part.dir).map(part => part.name).sort(), paths)
    for (const path of paths.filter(path => path !== documentPart)) {
      assert.deepEqual(await archive.file(path).async('nodebuffer'), await originalZip.file(path).async('nodebuffer'), theme + ' untouched part ' + path)
    }
    const downloading = page.waitForEvent('download')
    await page.getByRole('link', {name: 'Download saved version', exact: true}).click()
    const download = await downloading
    assert.equal(download.suggestedFilename(), `theme-${theme}.docx`)
    assert.deepEqual(await readFile(await download.path()), bytes, theme + ' download must equal the stored edited revision')
    const history = await context.request.get(`${f.origin}/api/v1/files/${fileId}/revisions`)
    assert.equal(history.status(), 200)
    assert.equal((await history.json()).revisions.length, 2)
    await page.reload()
    await expect(page.locator('.tiptap.doc-page')).toContainText(editedText[0], {timeout: 45_000})
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await mkdir('test-results', {recursive: true})
    await page.screenshot({path: `test-results/t12-native-docx-${theme}.png`, fullPage: true})
    saved.set(theme, {xml, semantics: after})
    await context.close()
  }
  assert.notDeepEqual(paint.get('light'), paint.get('dark'), 'the two runs must exercise different rendered page colors')
  // This controlled fixture has no time/random metadata. Compare the entire
  // saved document XML byte-for-byte: no color, attribute or ID filtering.
  assert.equal(saved.get('light').xml, saved.get('dark').xml)
  assert.deepEqual(saved.get('light').semantics, saved.get('dark').semantics)
  assert.deepEqual(errors, [])
})

