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
  await scope.getByRole('combobox', {name: label, exact: true}).click()
  await page.getByRole('option', {name, exact: true}).click()
}
