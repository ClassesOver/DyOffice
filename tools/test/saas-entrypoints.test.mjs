import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const root = new URL('../../', import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('package.json', root)))
test('default product commands enter the SaaS application only', () => {
  assert.equal(pkg.scripts.dev, 'npm run dev:web')
  assert.equal(pkg.scripts.start, 'npm run start:web')
  assert.equal(pkg.scripts.build, 'npm run build:saas')
  assert.equal(pkg.scripts['build:all'], 'npm run build:saas')
  assert.equal(pkg.scripts.predev, undefined)
  assert.equal(pkg.scripts.postinstall, undefined)
})
test('root product commands cannot launch or package the retired desktop shell', () => {
  for (const key of ['shell', 'dev:docs', 'dist:mac', 'dist:win', 'dist:linux']) assert.equal(pkg.scripts[key], undefined, key)
  for (const key of ['dev', 'start', 'build', 'build:all', 'build:saas']) assert.doesNotMatch(pkg.scripts[key], /electron|preload|@genoffice\/shell/)
})
test('SaaS build includes all reused Office browser renderers without desktop builds', () => {
  assert.equal(pkg.scripts['build:saas'], 'npm run build:saas:assets && npm run build:web:sheets:wasi')
  assert.equal(pkg.scripts['build:saas:assets'], [
    'build:harness-data-helper', 'build:web', 'build:web:docs', 'build:web:sheets',
    'build:web:slides', 'build:web:pdf',
  ].map(script => 'npm run '+script).join(' && '))
  assert.equal(pkg.scripts['build:web:sheets'], 'npm run build:sheets --prefix apps/web --workspaces=false')
  assert.equal(pkg.scripts['build:web:slides'], 'npm run build:slides --prefix apps/web --workspaces=false')
  assert.equal(pkg.scripts['build:web:pdf'], 'npm run build:pdf --prefix apps/web --workspaces=false')
})
test('active workspaces and resolved lock graph do not contain desktop runtimes', () => {
  assert.deepEqual(pkg.workspaces, ['apps/web', 'apps/docs', 'apps/sheets', 'apps/slides', 'apps/shell', 'apps/markdown', 'packages/*'])
  const lock = JSON.parse(readFileSync(new URL('package-lock.json', root)))
  const forbidden = /(?:^|node_modules\/)(?:electron|electron-builder|electron-updater|electron-vite|app-builder-bin|app-builder-lib)$/
  assert.deepEqual(Object.keys(lock.packages).filter(path => forbidden.test(path)), [])
  for (const app of ['docs', 'sheets', 'slides', 'shell', 'markdown']) {
    const manifest = JSON.parse(readFileSync(new URL(`apps/${app}/package.json`, root)))
    assert.equal(manifest.main, undefined)
    assert.equal(manifest.build, undefined)
    assert.ok(Object.values(manifest.scripts).every(command => !/electron/.test(command)))
  }
})

test('workspace lock metadata matches manifests rather than reactivating retired dependencies', () => {
  const lock = JSON.parse(readFileSync(new URL('package-lock.json', root)))
  for (const app of ['web', 'docs', 'sheets', 'slides', 'shell', 'markdown']) {
    const manifest = JSON.parse(readFileSync(new URL(`apps/${app}/package.json`, root)))
    for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      assert.deepEqual(lock.packages[`apps/${app}`][group] ?? {}, manifest[group] ?? {}, `${app} ${group}`)
    }
  }
})
test('installed dependency graph cannot resolve the retired Electron runtime', () => {
  const require = createRequire(new URL('package.json', root))
  assert.throws(() => require.resolve('electron'), { code: 'MODULE_NOT_FOUND' })
})
