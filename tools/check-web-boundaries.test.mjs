import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
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

test('can be imported by a stdin-driven diagnostic without executing the CLI', async () => {
  const { spawnSync } = await import('node:child_process')
  const moduleUrl = new URL('./check-web-boundaries.mjs', import.meta.url).href
  const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
    input: `const { forbiddenSpecifier } = await import(${JSON.stringify(moduleUrl)}); console.log(forbiddenSpecifier('node:fs'));`,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'true')
})

test('runs the CLI from a checkout path containing URL-reserved characters', async t => {
  const { spawnSync } = await import('node:child_process')
  const { readFile } = await import('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'dyoffice #boundary-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'tools'), { recursive: true })
  await mkdir(join(root, 'apps/web/src'), { recursive: true })
  const { createRequire } = await import('node:module')
  const { dirname } = await import('node:path')
  const require = createRequire(new URL('../apps/web/package.json',import.meta.url))
  await mkdir(join(root,'apps/web/node_modules'),{ recursive: true })
  await symlink(dirname(require.resolve('typescript/package.json')),join(root,'apps/web/node_modules/typescript'),'dir')
  const script = join(root, 'tools/check-web-boundaries.mjs')
  await writeFile(script, await readFile(new URL('./check-web-boundaries.mjs', import.meta.url)))
  await writeFile(join(root, 'apps/web/src/app.ts'), "import fs from 'node:fs'\n")
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' })
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stdout, /scanned 1 files, 1 violations/)
  assert.match(result.stderr, /browser code imports forbidden module node:fs/)
})

test('ignores import-looking comments and ordinary strings but finds real imports', () => {
  const source = `// import fs from 'node:fs'
/* export { shell } from 'electron' */
const example = "import fs from 'node:fs'";
const template = \`require('electron')\`;
import /* explanation */ fs from 'node:fs';
const module = import(/* lazy */ 'electron');`
  const issues = inspectSource(source, 'entry.ts')
  assert.equal(issues.length, 2)
  assert.ok(issues.some(x => x.includes(':5:')))
  assert.ok(issues.some(x => x.includes(':6:')))
})

test('follows local and workspace re-exports, including JS-to-TS resolution and cycles', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dyoffice-graph-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const files = {
    'apps/web/src/main.ts': "import { x } from './bridge.js'",
    'apps/web/src/bridge.ts': "export { x } from '@genoffice/shared'",
    'packages/shared/package.json': JSON.stringify({name:'@genoffice/shared',exports:{'.':'./src/index.ts'}}),
    'packages/shared/src/index.ts': "export { x } from './native.js'; export * from './cycle.js'",
    'packages/shared/src/cycle.ts': "export * from './index.js'",
    'packages/shared/src/native.ts': "import fs from 'node:fs'; export const x = fs",
  }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), content)
  }
  const result = await checkWebBoundaries(root)
  assert.equal(result.scanned, 5)
  assert.equal(result.violations.length, 1)
  assert.match(result.violations[0], /packages\/shared\/src\/native.ts:1:.*node:fs/)
})

test('follows literal dynamic imports and workspace subpath exports', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dyoffice-subpath-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const files = {
    'apps/web/src/main.ts': "const lazy = import('@genoffice/shared/native');",
    'packages/shared/package.json': JSON.stringify({name:'@genoffice/shared',exports:{'./native':{browser:'./src/browser.ts',default:'./src/node.ts'}}}),
    'packages/shared/src/browser.ts': "import 'electron'",
    'packages/shared/src/node.ts': "import 'node:path'",
  }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), content)
  }
  const result = await checkWebBoundaries(root)
  assert.equal(result.scanned, 2)
  assert.equal(result.violations.length, 1)
  assert.match(result.violations[0], /browser.ts:1:.*electron/)
})

test('fails closed for unresolved local code instead of returning a clean scan', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dyoffice-missing-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'apps/web/src'), { recursive: true })
  await writeFile(join(root, 'apps/web/src/main.ts'), "import './missing.js'")
  await assert.rejects(checkWebBoundaries(root), /Unresolved local browser dependency/)
})

test('recognizes literal require and TypeScript import-equals syntax', () => {
  const source = "import fs = require('node:fs');\nconst shell = require(`electron`);"
  assert.equal(inspectSource(source, 'entry.ts').length, 2)
})

test('uses require export conditions for CommonJS dependencies', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dyoffice-require-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const files = {
    'apps/web/src/main.cjs': "const lib = require('@genoffice/shared')",
    'packages/shared/package.json': JSON.stringify({name:'@genoffice/shared',exports:{'.':{import:'./safe.js',require:'./unsafe.js'}}}),
    'packages/shared/safe.js': 'export const x = 1',
    'packages/shared/unsafe.js': "const fs = require('node:fs')",
  }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), content)
  }
  const result = await checkWebBoundaries(root)
  assert.equal(result.violations.length, 1)
  assert.match(result.violations[0], /unsafe.js:1:.*node:fs/)
})

test('runtime graph omits erased type imports and exports but keeps mixed and side effect imports', () => {
  const erased = `import type { PathLike } from 'node:fs';
export type { PathLike } from 'node:fs';
import { type PathLike } from 'node:fs';
export { type PathLike } from 'node:fs';`
  assert.deepEqual(inspectSource(erased,'types.ts'),[])
  assert.equal(inspectSource("import { type PathLike,readFile } from 'node:fs'; import 'node:path'",'runtime.ts').length,2)
})
test('two pure renderer utility subpaths remain traversable while Electron runtime exports are rejected', () => {
  assert.equal(forbiddenSpecifier('@genoffice/electron-utils/safe-external-url'),false)
  assert.equal(forbiddenSpecifier('@genoffice/electron-utils/headless-export'),false)
  assert.equal(forbiddenSpecifier('@genoffice/electron-utils/atomic-write'),true)
})

 test('pure helper exceptions are followed and cannot hide a Node dependency', async t => {
  const root = await mkdtemp(join(tmpdir(),'dyoffice-pure-helper-'))
  t.after(() => rm(root,{ recursive: true,force: true }))
  const files = {
    'apps/web/src/app.ts': "import { x } from '@genoffice/electron-utils/safe-external-url'",
    'packages/electron-utils/package.json': JSON.stringify({ name: '@genoffice/electron-utils',exports: { './safe-external-url': './src/safe.ts' } }),
    'packages/electron-utils/src/safe.ts': "import fs from 'node:fs'; export const x = fs",
  }
  for (const [path,source] of Object.entries(files)) { await mkdir(join(root,path,'..'),{ recursive: true }); await writeFile(join(root,path),source) }
  const result = await checkWebBoundaries(root)
  assert.equal(result.scanned,2)
  assert.equal(result.violations.length,1)
  assert.match(result.violations[0],/safe.ts:1:.*node:fs/)
})


test('follows wildcard workspace exports and gives exact and more specific exports priority', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dyoffice-wildcard-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const files = {
    'apps/web/src/main.ts': "import '@genoffice/shared/gateway/native'; import '@genoffice/shared/exact'; import '@genoffice/shared/safe/module'",
    'packages/shared/package.json': JSON.stringify({name:'@genoffice/shared',exports:{'./*':'./src/*.ts','./exact':'./exact.ts','./safe/*':{browser:'./browser/*.ts',default:'./node/*.ts'}}}),
    'packages/shared/src/gateway/native.ts': "import 'node:fs'",
    'packages/shared/exact.ts': 'export const x = 1',
    'packages/shared/browser/module.ts': 'export const x = 1',
    'packages/shared/node/module.ts': "import 'node:path'",
  }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), content)
  }
  const result = await checkWebBoundaries(root)
  assert.equal(result.scanned, 4)
  assert.equal(result.violations.length, 1)
  assert.match(result.violations[0], /gateway\/native.ts:1:.*node:fs/)
  await writeFile(join(root, 'apps/web/src/main.ts'), "import '@genoffice/shared/blocked'")
  await writeFile(join(root, 'packages/shared/package.json'), JSON.stringify({name:'@genoffice/shared',exports:{'./*':'./src/*.ts','./blocked':null}}))
  await assert.rejects(checkWebBoundaries(root), /Unsupported workspace export/)
})
