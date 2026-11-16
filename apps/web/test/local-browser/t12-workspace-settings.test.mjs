import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {mkdir, readFile} from 'node:fs/promises'
import {randomBytes} from 'node:crypto'
import {expect} from '@playwright/test'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture, docxBytes, importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {buildLocalApp} from '../../server/src/app.ts'

const login = async (page, username) => {
  await page.getByLabel('用户名', {exact: true}).fill(username)
  await page.getByLabel('密码', {exact: true}).fill(password)
  await page.getByRole('button', {name: '登录', exact: true}).click()
  await expect(page.locator('.home')).toBeVisible()
}
const account = async (page, name) => {
  await page.locator('.account-btn').click()
  await page.getByRole('button', {name, exact: true}).click()
}
const row = (page, name) => page.locator('.recent-row').filter({has: page.locator('.recent-name').filter({hasText: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$')})})
const panel = page => page.getByRole('dialog', {name: '全局配置', exact: true})
async function serve(t, port, keyring) {
  const origin = `http://localhost:${port}`, f = await fileFixture(t, {origin})
  const app = await buildLocalApp({db: f.db, businessPool: f.businessPool, passwords: f.passwords, deploymentId: f.deploymentId, origin, csrfKey: f.csrfKey, objectStore: f.objects, globalConfigKeyring: keyring, localShellDirectory: fileURLToPath(new URL('../../dist-local-shell', import.meta.url))})
  f.cleanup.push(() => app.close()); await app.listen({port, host: '127.0.0.1'})
  const browser = await launchTestBrowser()
  const errors = []
  const context = await browser.newContext({viewport: {width: 1440, height: 1100}})
  context.setDefaultTimeout(15_000)
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
  const page = await context.newPage()
  t.after(async () => {await mkdir('test-results', {recursive: true}); await page.screenshot({path: `test-results/t12-final-${port}.png`, fullPage: true}).catch(() => {}); if(errors.length) t.diagnostic(JSON.stringify(errors)); await browser.close()})
  await page.goto(origin)
  return {f, app, browser, context, page, origin, errors}
}

// Actual Cookie/CSRF, PostgreSQL, local object store and Chromium. No API mocks.
test('T12 original Home persists folders stars recents and trash while themes preserve four original files', {timeout: 180_000}, async t => {
  const {f, context, page, origin, errors} = await serve(t, 4204)
  await login(page, 'alice')
  const fixtures = [
    ['packages/docx-engine/tests/fixtures/truths/render-sectafter-no-blank/probe.docx', 'workspace.docx'],
    ['apps/shell/build/shell-new/blank.xlsx', 'workspace.xlsx'],
    ['packages/pptx-engine/tests/fixtures/01_standard_business.pptx', 'workspace.pptx'],
    ['apps/pdf/tests/fixtures/plain-sample.pdf', 'workspace.pdf'],
  ]
  const originals = new Map()
  for (const [path, name] of fixtures) {
    t.diagnostic('Importing ' + name + ' through the original Home picker')
    const bytes = await readFile(new URL('../../../../' + path, import.meta.url)); originals.set(name, bytes)
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', {name: /^打开本地文件/}).click()
    const finished = page.waitForResponse(response => response.url().endsWith('/finish'))
    await (await chooser).setFiles({name, mimeType: 'application/octet-stream', buffer: bytes})
    assert.equal((await finished).status(), 200)
    await expect(row(page, name)).toBeVisible()
    await page.locator('.web-notice').getByRole('button', {name: '关闭', exact: true}).click()
  }
  const files = (await f.files.listFiles(f.alice.token)).files
  assert.equal(files.length, 4)
  const revisions = new Map(await Promise.all(files.map(async file => [file.id, (await f.files.openFile(f.alice.token, file.id)).file.revision])))
  await row(page, 'workspace.docx').getByRole('button', {name: '收藏', exact: true}).click()
  await expect(row(page, 'workspace.docx').getByRole('button', {name: '取消收藏', exact: true})).toBeVisible()
  await page.locator('.folder-new-btn').click()
  const folderInput = page.locator('.folder-rename-input.inline')
  await folderInput.fill('T12 Projects'); await folderInput.press('Enter')
  await expect(page.locator('.tree-name').filter({hasText: /^T12 Projects$/})).toBeVisible()
  await row(page, 'workspace.docx').getByRole('button', {name: '更多操作', exact: true}).click()
  await page.getByRole('menuitem', {name: /移动到文件夹/}).click()
  const picker = page.locator('.picker-modal')
  await picker.locator('.picker-search').fill('T12 Projects')
  await picker.locator('.picker-name').filter({hasText: /^T12 Projects$/}).click()
  await picker.locator('.btn-primary').click()
  await expect(picker).toHaveCount(0)
  const persisted = await (await context.request.get(origin + '/api/v1/workspace/files?view=all')).json()
  assert.ok(persisted.files.find(file => file.name === 'workspace.docx').folderId)
  await page.reload(); await expect(page.locator('.home')).toBeVisible()
  await expect(row(page, 'workspace.docx').getByRole('button', {name: '取消收藏', exact: true})).toBeVisible()
  await row(page, 'workspace.docx').getByRole('button', {name: '更多操作', exact: true}).click()
  await page.getByRole('menuitem', {name: '删除文件', exact: true}).click()
  await page.locator('.modal').getByRole('button', {name: '删除', exact: true}).click()
  await expect(row(page, 'workspace.docx')).toHaveCount(0)
  await account(page, '回收站')
  const trash = page.getByRole('dialog', {name: '回收站', exact: true})
  await expect(trash).toContainText('workspace.docx')
  await trash.getByRole('button', {name: '恢复', exact: true}).click()
  await expect(trash).toContainText('回收站为空')
  await trash.getByRole('button', {name: '关闭', exact: true}).click()
  await expect(row(page, 'workspace.docx').getByRole('button', {name: '取消收藏', exact: true})).toBeVisible()
  for (const [theme, title] of [['light', '浅色'], ['dark', '深色']]) {
    await account(page, '个人设置')
    const settings = page.getByRole('dialog')
    await settings.getByRole('button', {name: '通用', exact: true}).click()
    await settings.getByLabel('主题', {exact: true}).click()
    const saved = page.waitForResponse(response => response.url().endsWith('/preferences') && response.request().method() === 'PUT')
    await page.getByRole('option', {name: title, exact: true}).click(); assert.equal((await saved).status(), 200)
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await settings.locator('.set-close').click()
    for (const [name, bytes] of originals) {
      const downloading = page.waitForEvent('download')
      await row(page, name).locator('.recent-item').click()
      const download = await downloading, chunks = []
      assert.equal(download.suggestedFilename(), name)
      for await (const chunk of await download.createReadStream()) chunks.push(chunk)
      assert.deepEqual(Buffer.concat(chunks), bytes)
    }
    await mkdir('test-results', {recursive: true})
    await page.screenshot({path: `test-results/t12-workspace-${theme}.png`, fullPage: true})
  }
  for (const file of files) assert.equal((await f.files.openFile(f.alice.token, file.id)).file.revision, revisions.get(file.id))
  await account(page, '退出登录'); await expect(page.getByLabel('用户名', {exact: true})).toBeVisible()
  await login(page, 'bob')
  await expect(page.locator('.recent-name')).toHaveCount(0)
  await expect(page.locator('.tree-name').filter({hasText: /^T12 Projects$/})).toHaveCount(0)
  await page.locator('.account-btn').click(); await expect(page.getByRole('button', {name: '全局配置', exact: true})).toHaveCount(0)
  assert.equal((await context.request.get(origin + '/api/v1/admin/config')).status(), 403)
  assert.equal((await context.request.get(origin + '/api/v1/files/' + files[0].id)).status(), 404)
  await page.locator('.account-btn').click()
  await account(page, '退出登录'); await login(page, 'alice')
  await expect(row(page, 'workspace.docx').getByRole('button', {name: '取消收藏', exact: true})).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  assert.deepEqual(errors, [])
})

test('T12 global settings UI keeps secrets private and reconciles real revision conflicts disable clear and rotation', {timeout: 180_000}, async t => {
  const sentinel = 't12-browser-key-' + randomBytes(18).toString('hex')
  const {f, context, page, origin, errors} = await serve(t, 4205, {activeKeyId: 'test-v1', keys: {'test-v1': randomBytes(32)}})
  const responses = []
  context.on('response', response => {if (/\/api\/v1\/(admin\/config|settings\/public)/.test(response.url())) responses.push(response.text().then(text => text.includes(sentinel)).catch(() => false))})
  await login(page, 'owner'); await account(page, '全局配置')
  await expect(panel(page)).toContainText('已保存版本 0')
  const second = await context.newPage(); await second.goto(origin); await expect(second.locator('.home')).toBeVisible(); await account(second, '全局配置')
  await expect(panel(second)).toContainText('已保存版本 0')
  const add = async (target, name, key) => {
    const form = panel(target)
    await form.getByRole('button', {name: '添加配置', exact: true}).click()
    await form.getByLabel('配置名称', {exact: true}).fill(name)
    await form.getByLabel('服务商', {exact: true}).selectOption('openai')
    await form.getByLabel('模型标识', {exact: true}).fill('gpt-6-luna')
    await form.getByLabel('服务地址', {exact: true}).fill('https://provider.example/v1')
    await form.getByLabel('启用配置', {exact: true}).check()
    if (key) await form.getByLabel('API 密钥', {exact: true}).fill(key)
  }
  const save = async (target, status = 200) => {
    const response = target.waitForResponse(r => r.url().endsWith('/admin/config') && r.request().method() === 'PUT')
    await panel(target).getByRole('button', {name: '保存配置', exact: true}).click()
    const result = await response; assert.equal(result.status(), status); return result.json()
  }
  await add(page, 'Primary T12', sentinel)
  assert.ok((await panel(page).locator('.global-settings-editor').boundingBox()).width > 400, 'desktop editor must use the available dialog width')
  await panel(page).getByLabel('默认对话配置', {exact: true}).selectOption({label: 'Primary T12'})
  const v1 = await save(page); assert.equal(v1.revision, 1); assert.equal(v1.entries[0].hasKey, true)
  await expect(panel(page).getByLabel('API 密钥', {exact: true})).toHaveValue('')
  await add(second, 'Retained draft T12')
  await save(second, 409)
  await expect(panel(second).getByLabel('配置名称', {exact: true})).toHaveValue('Retained draft T12')
  await expect(panel(second).getByRole('alert')).toContainText('草稿已保留')
  await panel(second).getByRole('button', {name: '读取最新配置', exact: true}).click()
  await expect(panel(second)).toContainText('已读取版本 1')
  const v2 = await save(second); assert.equal(v2.entries.length, 2); assert.equal(v2.revision, 2)
  await panel(page).getByRole('button', {name: '读取最新配置', exact: true}).click()
  await expect(panel(page)).toContainText('已读取版本 2')
  await panel(page).getByLabel('启用配置', {exact: true}).uncheck()
  const v3 = await save(page); assert.equal(v3.revision, 3)
  assert.equal(v3.entries.find(entry => entry.label === 'Primary T12').hasKey, true)
  const visible = await (await context.request.get(origin + '/api/v1/settings/public')).json()
  assert.equal(visible.catalog.some(entry => entry.label === 'Primary T12'), false)
  assert.equal(visible.defaults.chat, undefined)
  assert.equal(JSON.stringify(visible).includes('baseUrl'), false)
  const checked = page.waitForResponse(r => r.url().endsWith('/config/check'))
  await panel(page).getByRole('button', {name: '检查已保存配置', exact: true}).click()
  assert.equal((await (await checked).json()).connection, 'not_run')
  await expect(panel(page).getByRole('status')).toContainText('未进行模型或服务连通测试')
  await panel(page).getByRole('button', {name: '轮换加密密钥', exact: true}).click()
  const rotated = page.waitForResponse(r => r.url().endsWith('/rotate-key'))
  await panel(page).getByRole('button', {name: '确认重新加密', exact: true}).click()
  assert.equal((await rotated).status(), 200)
  await expect(panel(page)).toContainText('当前版本 4')
  await panel(page).getByRole('button', {name: '清空密钥', exact: true}).click()
  await panel(page).getByRole('button', {name: '确认清空密钥', exact: true}).click()
  const cleared = await save(page)
  assert.equal(cleared.entries.find(entry => entry.label === 'Primary T12').hasKey, false)
  const privateFile = await importFile(f, f.alice.token, await docxBytes(), 'alice-private.docx')
  assert.equal((await context.request.get(origin + '/api/v1/files/' + privateFile.file.fileId)).status(), 404)
  for (const target of [page, second]) {
    assert.equal(await target.evaluate(value => JSON.stringify([location.href, {...localStorage}, {...sessionStorage}]).includes(value), sentinel), false)
    await expect(panel(target).getByLabel('API 密钥', {exact: true})).toHaveValue('')
  }
  assert.ok((await Promise.all(responses)).every(leaked => !leaked))
  await mkdir('test-results', {recursive: true}); await page.screenshot({path: 'test-results/t12-global-settings.png', fullPage: true})
  await page.setViewportSize({width: 390, height: 844})
  assert.equal(await panel(page).evaluate(element => element.scrollWidth <= element.clientWidth && document.documentElement.scrollWidth <= innerWidth), true, 'mobile configuration must not overflow horizontally')
  await panel(page).getByLabel('配置名称', {exact: true}).scrollIntoViewIfNeeded()
  await page.screenshot({path: 'test-results/t12-global-settings-mobile.png', fullPage: true})
  assert.deepEqual(errors, [])
})

