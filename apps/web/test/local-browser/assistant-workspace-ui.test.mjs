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
    esbuild: { jsx: 'automatic', jsxDev: false },
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
    if (req.url.split('?')[0] === '/') {
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
    page.setDefaultTimeout(8000)
    page.on('pageerror', (error) => errors.push(error.message))
    for (const width of [320, 360, 400])
      for (const theme of ['light', 'dark'])
        await t.test(`${width}px ${theme}`, async () => {
          await page.setViewportSize({ width, height: 780 })
          await page.goto(`http://localhost:${server.address().port}`)
          await page.getByRole('tab', { name: /任务/ }).waitFor()
          assert.deepEqual(await page.getByRole('tab').allTextContents(), ['对话', '任务'])
          const [chatTab, tasksTab] = await page.getByRole('tab').all()
          const tablist = await page.getByRole('tablist').boundingBox()
          const chat = await chatTab.boundingBox(), tasks = await tasksTab.boundingBox()
          assert.ok(Math.abs(chat.width - tasks.width) < 1, 'both tabs have equal width')
          assert.ok(Math.abs(chat.x - tablist.x - (tablist.x + tablist.width - tasks.x - tasks.width)) < 2,
            'the two tabs fill the switcher with balanced side padding')
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme
          }, theme)
          await page.getByRole('tab', { name: /任务/ }).click()
          assert.equal(await page.locator('.ai-chat').isVisible(), false)
          await page.screenshot({ path: join(output, `team-${width}-${theme}.png`) })
          await page.getByRole('tab', { name: '对话', exact: true }).click()
          assert.equal(await page.locator('.ai-chat').isVisible(), true)
          assert.equal(await page.locator('.assistant-team-roster').count(), 0)
          assert.equal(await page.locator('.assistant-execution-picker,.assistant-execution-menu').count(), 0)
          await page.getByRole('tab', { name: /任务/ }).click()
          await page.getByRole('tab', { name: '对话', exact: true }).click()
          await page.evaluate(() => window.runPreviewHarness())
          await page
            .locator('.assistant-team-feed')
            .getByText('正在执行命令', { exact: true })
            .waitFor()
          const card = page.locator('.assistant-team-feed .assistant-task-message')
          const liveOutput = card.getByLabel('实时输出', { exact: true })
          await liveOutput.getByText('Checking the calculation…', { exact: true }).waitFor()
          const runningBox = await card.boundingBox()
          const outputBox = await liveOutput.boundingBox()
          assert.equal(await page.locator('.assistant-team-feed .assistant-task').count(), 0, 'no standalone task card')
          assert.equal(await card.locator('.assistant-team-author strong').innerText(), 'Codex')
          assert.equal(await card.locator('.ai-msg-assistant').evaluate(el => getComputedStyle(el).borderTopWidth), '0px')
          assert.equal(await card.locator('.assistant-task-title').innerText(), '分析当前巡检记录')
          await page.emulateMedia({ reducedMotion: 'reduce' })
          assert.equal(await card.locator('.assistant-task-pulse').evaluate(el => getComputedStyle(el).animationName), 'none')
          await page.emulateMedia({ reducedMotion: 'no-preference' })
          const userRow = page.locator('.assistant-chat-row-user')
          assert.equal(await userRow.locator('.assistant-team-author').count(), 0)
          assert.equal(await userRow.getByRole('img', { name: 'lin' }).innerText(), 'L')
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
          assert.equal(await page.locator('.assistant-avatar-office').first().evaluate(el => getComputedStyle(el).borderRadius), '50%')
          await page.evaluate(() => window.advancePreviewOutput())
          await liveOutput.getByText('Verified the result.', { exact: false }).waitFor()
          assert.match(await liveOutput.innerText(), /Checking the calculation…\s+Verified the result\./)
          assert.equal((await liveOutput.boundingBox()).height, outputBox.height)
          assert.equal((await card.boundingBox()).height, runningBox.height)
          await page.screenshot({ path: join(output, `streaming-${width}-${theme}.png`) })
          await page.evaluate(() => window.finishPreviewOutput())
          await page.locator('.assistant-team-feed').getByText('已完成', { exact: true }).waitFor()
          assert.equal(
            await page
              .getByRole('tab', { name: '对话', exact: true })
              .getAttribute('aria-selected'),
            'true',
          )
          await page
            .locator('.assistant-team-feed .assistant-task-message details')
            .filter({ has: page.locator('summary').filter({ hasText: /^完整结果$/ }) })
            .locator('summary')
            .click()
          await page
            .locator('.assistant-team-feed')
            .getByText('Computed: 42', { exact: false })
            .waitFor()
          const completedBox = await card.boundingBox()
          assert.ok(completedBox.height > runningBox.height, 'expanded result should use natural height')
          assert.equal(completedBox.width, runningBox.width)
          await page.getByRole('tab', { name: '任务', exact: true }).click()
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
    await t.test('a short user message fits on one line beside its avatar', async () => {
      await page.setViewportSize({ width: 320, height: 780 })
      await page.goto(`http://localhost:${server.address().port}/?short`)
      const row = page.locator('.assistant-chat-row-user')
      await row.getByRole('img', { name: 'lin' }).waitFor()
      const dimensions = await row.locator('.ai-msg-user').evaluate(el => {
        const style = getComputedStyle(el)
        return {
          height: el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
          lineHeight: parseFloat(style.lineHeight),
          width: el.offsetWidth,
          available: el.parentElement.offsetWidth,
          maxWidth: style.maxWidth,
        }
      })
      assert.ok(Math.abs(dimensions.height - dimensions.lineHeight) < 1, JSON.stringify(dimensions))
    })
    await t.test('multiline user message keeps the attachment and avatar inside a narrow panel', async () => {
      await page.setViewportSize({ width: 320, height: 780 })
      await page.goto(`http://localhost:${server.address().port}/?attachment`)
      const row = page.locator('.assistant-chat-row-user')
      await row.getByRole('img', { name: 'lin' }).waitFor()
      const attachment = row.locator('.ai-attachment-card')
      assert.match(await attachment.getAttribute('title'), /regional_summary_.*2026\.xlsx$/)
      const bubble = row.locator('.ai-msg-user')
      assert.ok(await bubble.evaluate(el => el.scrollWidth <= el.clientWidth + 1))
      const avatarBox = await row.locator('.assistant-user-avatar').boundingBox()
      const bubbleBox = await bubble.boundingBox()
      assert.ok(Math.abs(avatarBox.y - bubbleBox.y) <= 4)
      assert.ok(avatarBox.x >= bubbleBox.x + bubbleBox.width)
      await page.screenshot({ path: join(output, 'user-attachment-320.png') })
    })
    for (const outcome of ['failed', 'unknown_outcome']) {
      await t.test(`${outcome} retains diagnostics and Office draft`, async () => {
        await page.setViewportSize({ width: 320, height: 780 })
        await page.goto(`http://localhost:${server.address().port}`)
        await page.getByRole('tab', { name: '对话', exact: true }).waitFor()
        await page.evaluate(outcome => window.runPreviewHarness(outcome, '核对本季度所有部门的收入与费用并整理异常项目及后续处理建议\n按月份汇总，保留原始文档。'), outcome)
        const card = page.locator('.assistant-team-feed .assistant-task-message')
        await card.locator(`.assistant-task-state[data-state="${outcome}"]`).waitFor()
        assert.equal(await card.locator('.assistant-task-output').count(), 0)
        assert.equal(await card.getByRole('button', { name: /重试|重新执行/ }).count(), 0)
        await card.locator('.assistant-task-details > summary').focus()
        await page.keyboard.press('Enter')
        await card.locator('.assistant-task-failure').waitFor()
        assert.match(await card.locator('.assistant-task-failure').innerText(), outcome === 'failed' ? /HTTP 403/ : /Harness task failed/)
        assert.equal(await card.evaluate(el => el.scrollWidth > el.clientWidth + 1), false)
        await page.screenshot({ path: join(output, `${outcome}-320.png`) })
        await page.getByRole('tab', { name: /任务/ }).click()
        await page.locator('.assistant-workspace-content .assistant-task-message').waitFor()
        await page.getByRole('tab', { name: '对话', exact: true }).click()
        assert.equal(await page.getByRole('textbox', { name: '草稿' }).inputValue(), '分析当前巡检记录')
      })
    }
    assert.deepEqual(errors, [])
    t.diagnostic('Browser screenshots: ' + output)
  } finally {
    await browser?.close()
    if (server.listening) await new Promise((resolve) => server.close(resolve))
  }
})
