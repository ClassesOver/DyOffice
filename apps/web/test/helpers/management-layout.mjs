import {expect} from '@playwright/test'

/** Uses the actual mounted management panel, not a reconstructed HTML fixture. */
export async function expectManagementLayout(page, panel, heading, pagerLabel) {
  const previous = page.viewportSize()
  try {
    for (const width of [1440, 390]) {
      await page.setViewportSize({width, height: 850})
      const title = panel.getByRole('heading', {name: heading, exact: true})
      const pager = panel.getByRole('navigation', {name: `${pagerLabel}分页`, exact: true})
      await expect(title).toBeInViewport()
      await expect(pager).toBeInViewport()
      await expect(pager.getByRole('button', {name: `上一页${pagerLabel}`, exact: true})).toBeInViewport()
      await expect(pager.getByRole('button', {name: `下一页${pagerLabel}`, exact: true})).toBeInViewport()
      const box = await panel.boundingBox()
      expect(box).not.toBeNull()
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
      // Data can scroll horizontally inside its region without widening the dialog.
      const region = panel.getByRole('region', {name: heading, exact: true})
      await expect(region).toBeVisible()
      expect(await region.evaluate(element => element.contains(document.querySelector('.management-list-footer')))).toBe(false)
    }
  } finally {
    if (previous) await page.setViewportSize(previous)
  }
}
