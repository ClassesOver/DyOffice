import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
const root = new URL('../../', import.meta.url)
const retained = ['ai-panel-side.spec.ts', 'docs-header-markup-layout.spec.ts', 'home-entry-b-layout.spec.ts', 'home-row-menu-layout.spec.ts', 'pdf-outline-layout.spec.ts', 'slides-selection-image.spec.ts']
test('root e2e suite retains shared browser checks and no desktop launcher', () => {
  assert.deepEqual(readdirSync(new URL('e2e/', root)).filter(x => x.endsWith('.spec.ts')).sort(), retained)
  assert.equal(existsSync(new URL('e2e/helpers.ts', root)), false)
  for (const name of retained) assert.doesNotMatch(readFileSync(new URL('e2e/' + name, root), 'utf8'), /_electron|launchShell|from ['"]\.\/helpers['"]/)
})
test('CI no longer downloads or launches the retired desktop product or weakens host settings', () => {
  const ci = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8')
  assert.doesNotMatch(ci, /electron-bin-|\.cache\/electron|sysctl|xvfb-run|E2E \(Electron shell\)/)
  assert.match(ci, /Browser layout tests/)
  assert.match(ci, /npm run test:e2e/)
})
test('SaaS shared renderer and workbook adapter are preserved', () => {
  for (const file of ['apps/shell/src/renderer/src/AppFrame.tsx','apps/docs/src/renderer/editor/approved-text-command.ts','apps/sheets/src/main/workbook-redactions.ts','apps/web/server/sheets/gateway.ts']) {
    assert.ok(existsSync(new URL(file, root)), file)
  }
})

test('Docs SaaS suite retires only OS dialog/updater tests and retains native save safety', () => {
  for (const file of ['apps/docs/tests/save-as-default-dir.test.ts','apps/docs/tests/updater.test.ts']) assert.equal(existsSync(new URL(file,root)),false,file)
  for (const file of ['apps/docs/tests/save-metadata-race.test.ts','apps/docs/tests/web-bridge-save-state.test.ts','apps/web/test/pr24-safety.test.mjs','apps/web/test/native-docs/roundtrip.test.mjs']) assert.ok(existsSync(new URL(file,root)),file)
})
