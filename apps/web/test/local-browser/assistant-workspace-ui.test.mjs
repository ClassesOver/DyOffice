import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { chromium } from 'playwright-core'
import { workspaceAliases } from '../../workspace-aliases.mjs'

test('assistant workspace layouts and explicit delegation in a real browser', async (t) => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url))
  const output = await mkdtemp(join(tmpdir(), 'dyoffice-assistant-ui-'))
  await build({
    configFile: false,
    root,
    define: { 'process.env.NODE_ENV': '"production"' },
    esbuild: { jsx: 'automatic' },
    resolve: { alias: workspaceAliases(), dedupe: ['react', 'react-dom'] },
    build: {
      outDir: output,
      emptyOutDir: true,
      lib: {
        entry: join(root, 'apps/web/test/fixtures/assistant-workspace-preview.tsx'),
        name: 'Preview',
        formats: ['iife'],
        fileName: () => 'preview.js',
      },
      cssCodeSplit: false,
    },
    logLevel: 'error',
  })
  const css = (await readdir(output)).find((name) => name.endsWith('.css'))
  const server = createServer(async (req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html')
      res.end(
        `<html lang="zh"><meta charset="utf-8"><link rel="stylesheet" href="/${css}"><style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}</style><div id="root"></div><script src="/preview.js"></script></html>`,
      )
      return
    }
    try {
      const name = req.url.slice(1)
      if (name.includes('..')) throw Error()
      res.setHeader(
        'content-type',
        name.endsWith('.js')
          ? 'text/javascript'
          : name.endsWith('.css')
            ? 'text/css'
            : 'application/octet-stream',
      )
      res.end(await readFile(join(output, name)))
    } catch {
      res.statusCode = 404
      res.end()
    }
  })
  let browser
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage(),
      errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    for (const width of [320, 360, 400])
      for (const theme of ['light', 'dark'])
        await t.test(`${width}px ${theme}`, async () => {
          await page.setViewportSize({ width, height: 780 })
          await page.goto('http://127.0.0.1:' + server.address().port)
          await page.getByRole('tab', { name: /助手/ }).waitFor()
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme
          }, theme)
          await page.getByRole('tab', { name: /助手/ }).click()
          assert.equal(await page.locator('.ai-chat').isVisible(), false)
          await page.screenshot({ path: join(output, `team-${width}-${theme}.png`) })
          await page.getByRole('tab', { name: '对话', exact: true }).click()
          assert.equal(await page.locator('.ai-chat').isVisible(), true)
          assert.equal(await page.locator('.assistant-team-roster').count(), 0)
          await page.getByRole('tab', { name: /助手/ }).click()
          await page
            .locator('.assistant-member')
            .getByRole('button', { name: '@ Codex', exact: true })
            .click()
          await page.getByRole('button', { name: '发送', exact: true }).click()
          await page
            .locator('.assistant-team-feed')
            .getByText('Checking the calculation…', { exact: true })
            .waitFor()
          await page
            .locator('.assistant-team-feed')
            .getByText('正在执行命令', { exact: true })
            .waitFor()
          const card = page.locator('.assistant-team-feed .assistant-task')
          const runningBox = await card.boundingBox()
          assert.equal(Math.round(runningBox.height), 280)
          const positions = await page.evaluate(() => {
            const user = document.querySelector('.assistant-chat-row-user'),
              assistant = document.querySelector('.assistant-chat-row-assistant')
            const portrait = user.querySelector('.assistant-user-avatar').getBoundingClientRect(),
              bubble = user.querySelector('.ai-msg-user').getBoundingClientRect()
            const assistantPortrait = assistant
                .querySelector('.assistant-avatar')
                .getBoundingClientRect(),
              assistantMessage = assistant
                .querySelector('.ai-msg-assistant')
                .getBoundingClientRect()
            return {
              userRight: portrait.left >= bubble.right,
              assistantLeft: assistantPortrait.right <= assistantMessage.left,
            }
          })
          assert.equal(positions.userRight, true)
          assert.equal(positions.assistantLeft, true)
          await page.screenshot({ path: join(output, `streaming-${width}-${theme}.png`) })
          await page.locator('.assistant-team-feed').getByText('已完成', { exact: true }).waitFor()
          assert.equal(
            await page
              .getByRole('tab', { name: '对话', exact: true })
              .getAttribute('aria-selected'),
            'true',
          )
          await page
            .locator('.assistant-team-feed .assistant-task details')
            .filter({ has: page.locator('summary').filter({ hasText: /^结果$/ }) })
            .locator('summary')
            .click()
          await page
            .locator('.assistant-team-feed')
            .getByText('Computed: 42', { exact: false })
            .waitFor()
          const completedBox = await card.boundingBox()
          assert.equal(completedBox.height, runningBox.height)
          assert.equal(completedBox.width, runningBox.width)
          await page.getByRole('button', { name: '查看任务', exact: true }).click()
          assert.equal(await page.locator('.ai-chat').isVisible(), false)
          await page.getByRole('button', { name: '定位对话', exact: true }).click()
          assert.equal(await page.locator('.ai-chat').isVisible(), true)
          assert.equal(
            await page.getByRole('textbox', { name: '草稿' }).inputValue(),
            '分析当前巡检记录',
          )
          const label = await page.locator('.ai-model-chip-text').boundingBox()
          assert.ok(label && label.height <= 20, 'model label must remain on one line')
          await page.locator('.ai-model-chip').click()
          await page
            .getByRole('option', {
              name: 'Very long model name for overflow verification',
              exact: true,
            })
            .click()
          const overflow = await page.evaluate(
            () =>
              document.documentElement.scrollWidth > innerWidth ||
              [...document.querySelectorAll('.assistant-workspace-content,.ai-input-footer')].some(
                (el) => el.scrollWidth > el.clientWidth + 1,
              ),
          )
          assert.equal(overflow, false, 'narrow layouts and long model names must not overflow')
          await page.screenshot({ path: join(output, `workspace-${width}-${theme}.png`) })
        })
    assert.deepEqual(errors, [])
    t.diagnostic('Browser screenshots: ' + output)
  } finally {
    await browser?.close()
    if (server.listening) await new Promise((resolve) => server.close(resolve))
  }
})
