import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Layout fixtures use the production styles. Home interaction coverage remains in
// apps/web/test/shell/home-workspace.test.ts; this is not a backend acceptance test.
const css = [
  'packages/ui/src/tokens.css',
  'apps/shell/src/renderer/src/home.css',
  'apps/web/src/shell/web-shell.css',
  'apps/web/src/shell/home-entry-b.css',
].map(path => readFileSync(resolve(path), 'utf8')).join('\n')

for (const width of [1440, 390]) {
  for (const theme of ['light', 'dark']) {
    test(`entry keeps long lists and controls reachable at ${width}px ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 850 })
      await page.setContent(`<html data-theme="${theme}"><style>${css}</style>
        <div class="home home-web">
          <aside class="sidebar"><nav class="sidebar-nav"><button class="nav-item active">最近</button></nav></aside>
          <main class="content"><div class="section-head"><span class="section-label">快速开始</span></div>
            <div class="quick-cards">${['Word', 'Excel', 'PowerPoint', 'PDF', '打开本地文件'].map(label => `<button class="quick-card">${label}</button>`).join('')}</div>
            <section class="recents"><div class="recents-toolbar">
              <div class="toolbar-filters"><div class="filter-pills">${['全部', '文档', '表格', '演示', 'PDF'].map((label, index) => `<button class="filter-pill ${index ? '' : 'active'}">${label}</button>`).join('')}</div></div>
              <div class="file-search-group"><label class="file-search"><input aria-label="搜索文件" placeholder="搜索文件名和内容"></label></div>
            </div><div class="recent-table"><ul class="recent-list">
            ${Array.from({ length: 40 }, (_, i) => `<li class="recent-row"><div class="recent-item" tabindex="0"><input class="row-check" type="checkbox"><span class="recent-icon">W</span><span class="recent-name">${i + 1}-很长的文件名称用于验证截断而不会撑宽整个工作区.docx</span><span class="recent-path">个人文件</span><span class="recent-time">今天</span><span class="recent-size">4 KB</span><button class="star-btn">☆</button><span class="recent-actions"><button class="more-btn">…</button></span></div></li>`).join('')}
            </ul></div><button id="next-page">下一页</button></section>
          </main>
        </div></html>`)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
      await page.getByRole('textbox', { name: '搜索文件' }).fill('测试')
      await page.getByRole('button', { name: '打开本地文件', exact: true }).focus()
      await expect(page.getByRole('button', { name: '打开本地文件', exact: true })).toBeInViewport()
      await page.locator('#next-page').scrollIntoViewIfNeeded()
      await expect(page.locator('#next-page')).toBeInViewport()
      await page.locator('.content').evaluate(el => { el.scrollTop = 0 })
      await page.screenshot({ path: `test-results/home-entry-b-${width}-${theme}.png` })
    })
  }
}
