import {expect} from '@playwright/test'

// Use the same visible menu, tabs and explicit actions as a person. API reads in
// acceptance tests verify outcomes; they must not replace these UI mutations.
export async function accountAction(page, name) {
  await page.locator('.account-btn').click()
  await page.getByRole('menuitem', {name, exact: true}).click()
  if (name !== '退出登录') await expect(page.getByRole('dialog', {name, exact: true})).toBeVisible()
}
export async function settingsTab(dialog, name) {
  const tab = dialog.getByRole('tab', {name, exact: true})
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
}
export async function closeWorkspaceDialog(dialog) {
  await dialog.locator('.ant-modal-close').click()
  await expect(dialog).not.toBeVisible()
}
export async function selectOption(page, scope, label, name) {
  const combo = scope.getByRole('combobox', {name: label, exact: true})
  const select = scope.locator('.ant-select').filter({has: page.getByRole('combobox', {name: label, exact: true})})
  await combo.click()
  await expect(combo).toHaveAttribute('aria-expanded', 'true')
  await expect(combo).toHaveAttribute('aria-activedescendant', /.+/)
  // AntD's virtual role=option nodes are for accessibility, not click targets.
  // Navigate like a keyboard user, including options outside the rendered window.
  const visited = new Set()
  for (let count = 0; count < 102; count++) {
    const id = await combo.getAttribute('aria-activedescendant')
    if (visited.has(id)) break
    visited.add(id)
    const active = page.locator(`[id=${JSON.stringify(id)}]`)
    if (await active.getAttribute('aria-label') === name) {
      await combo.press('Enter')
      await expect(combo).toHaveAttribute('aria-expanded', 'false')
      await expect(select.locator('.ant-select-content')).toHaveText(name)
      return
    }
    await combo.press('ArrowDown')
    await expect(combo).not.toHaveAttribute('aria-activedescendant', id)
  }
  throw new Error(`Select ${label} has no enabled option named ${name}`)
}
