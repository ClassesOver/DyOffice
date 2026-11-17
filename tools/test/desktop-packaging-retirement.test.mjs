import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
const root = new URL('../../', import.meta.url)
const apps = ['docs', 'sheets', 'slides', 'shell', 'markdown', 'pdf', 'html']
test('desktop standalone bootstraps and bundler configurations are retired', () => {
  for (const app of apps) {
    assert.equal(existsSync(new URL(`apps/${app}/src/main/index.ts`, root)), false, app)
    assert.equal(existsSync(new URL(`apps/${app}/electron.vite.config.ts`, root)), false, app)
    const manifest = JSON.parse(readFileSync(new URL(`apps/${app}/package.json`, root)))
    assert.equal(manifest.main, undefined, app)
    assert.ok(Object.values(manifest.scripts).every(command => !/electron/.test(command)), app)
  }
  assert.equal(existsSync(new URL('tools/build-stale-preloads.mjs', root)), false)
})
test('desktop binary wrapping recipes are not a SaaS deployment path', () => {
  for (const platform of ['flatpak', 'nix', 'docker']) assert.equal(existsSync(new URL(`packaging/${platform}`, root)), false)
})
test('shared XLSX main modules and renderer contracts remain available', () => {
  for (const file of ['apps/sheets/src/main/atomic-write.ts','apps/sheets/src/main/xlsx-sidecar-client.ts','apps/sheets/src/main/workbook-redactions.ts','apps/sheets/src/shared/desktop-api.ts','apps/shell/build/shell-new/blank.xlsx']) assert.ok(existsSync(new URL(file, root)), file)
})
test('installer and signing hooks are not product entrypoints', () => {
  for (const path of ['apps/shell/electron-builder.cjs','apps/shell/build/installer.nsh','apps/shell/build/notarize-dmg.js','apps/shell/build/linux-after-install.sh','apps/shell/build/linux-after-remove.sh']) assert.equal(existsSync(new URL(path, root)), false, path)
  assert.doesNotMatch(readFileSync(new URL('tools/gen-third-party-notices.mjs', root), 'utf8'), /require\([^\n]*electron-builder/)
})
