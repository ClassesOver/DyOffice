import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkWebBoundaries, forbiddenSpecifier, inspectSource } from './check-web-boundaries.mjs'

test('disallows Node builtins and Electron in browser source', () => {
  for (const name of ['node:fs/promises', 'fs', 'node:path', 'electron', '@genoffice/electron-utils']) {
    assert.equal(forbiddenSpecifier(name), true, name)
  }
  for (const name of ['react', '@genoffice/agent-core', './host.js', 'https://example.org/lib.js']) {
    assert.equal(forbiddenSpecifier(name), false, name)
  }
  const source = [
    "import { readFile } from 'node:fs/promises'",
    "export { shell } from 'electron'",
    "const mod = await import('node:crypto')",
    "const old = require('@genoffice/electron-utils')",
  ].join('\n')
  const issues = inspectSource(source, 'src/editor.ts')
  assert.equal(issues.length, 4)
  for (const line of [1, 2, 3, 4]) assert.ok(issues.some(x => x.includes(`:${line}:`)))
})

test('scans browser entry points but excludes the Node server and desktop apps', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dyoffice-boundary-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const dir of ['apps/web/src', 'apps/web/server', 'packages/browser-host/src']) {
    await mkdir(join(root, dir), { recursive: true })
  }
  await writeFile(join(root, 'apps/web/src/app.ts'), "import { x } from 'node:fs'\n")
  await writeFile(join(root, 'apps/web/server/index.ts'), "import { x } from 'node:fs'\n")
  await writeFile(join(root, 'packages/browser-host/src/index.ts'), "import { y } from '@genoffice/agent-core'\n")
  const result = await checkWebBoundaries(root)
  assert.equal(result.scanned, 2)
  assert.equal(result.violations.length, 1)
  assert.ok(result.violations[0].includes('apps/web/src/app.ts:1:'))
})
