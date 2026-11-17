import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inventoryInstalledPackages, rustInventory } from '../gen-third-party-notices.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'saas-notices-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, lock: { lockfileVersion: 3, packages: {} } }
}
function add(f, path, name, version, extra = {}) {
  f.lock.packages[path] = { version, ...extra }
  mkdirSync(join(f.root, path), { recursive: true })
  writeFileSync(join(f.root, path, 'package.json'), JSON.stringify({ name, version }))
  writeFileSync(join(f.root, path, 'LICENSE'), `license ${name} ${version}`)
}
test('inventory preserves every installed nested version instead of resolving by name', (t) => {
  const f = fixture(t)
  add(f, 'node_modules/a', 'a', '1.0.0')
  add(f, 'node_modules/owner/node_modules/a', 'a', '2.0.0')
  const result = inventoryInstalledPackages(f.root, f.lock)
  assert.deepEqual(
    result.packages.map((p) => p.version),
    ['1.0.0', '2.0.0'],
  )
  assert.equal(result.errors.length, 0)
})
test('required missing packages and stale versions are errors, optional missing is explicit', (t) => {
  const f = fixture(t)
  f.lock.packages['node_modules/required'] = { version: '1' }
  f.lock.packages['node_modules/optional'] = { version: '1', optional: true }
  add(f, 'node_modules/stale', 'stale', '2')
  f.lock.packages['node_modules/stale'].version = '1'
  const result = inventoryInstalledPackages(f.root, f.lock)
  assert.equal(result.errors.length, 2)
  assert.deepEqual(result.omittedOptional, ['node_modules/optional'])
})
test('missing license text cannot become a successful silent skip', (t) => {
  const f = fixture(t)
  add(f, 'node_modules/a', 'a', '1')
  rmSync(join(f.root, 'node_modules/a/LICENSE'))
  assert.match(inventoryInstalledPackages(f.root, f.lock).errors.join('\n'), /license text/)
})
test('cargo metadata is offline and locked and absence stays incomplete', () => {
  let args
  const result = rustInventory('/tmp/notices-fixture', (_command, passed) => {
    args = passed
    throw new Error('cache unavailable')
  })
  assert.ok(args.includes('--offline'))
  assert.ok(args.includes('--locked'))
  assert.equal(result.status, 'incomplete')
})
test('preserves hyphenated license files instead of falling back to SPDX summaries', (t) => {
  const f = fixture(t)
  add(f, 'node_modules/a', 'a', '1')
  rmSync(join(f.root, 'node_modules/a/LICENSE'))
  writeFileSync(join(f.root, 'node_modules/a/LICENSE-MIT.txt'), 'Complete published license text')
  const result = inventoryInstalledPackages(f.root, f.lock)
  assert.equal(result.errors.length, 0)
  assert.equal(result.packages[0].text, 'Complete published license text')
})
test('PDFium inventory retains wrapper MIT and binary redistribution terms', async () => {
  const { licenseText } = await import('../license-text.mjs')
  const root = new URL('../../', import.meta.url)
  const text = licenseText(
    '@embedpdf/pdfium',
    new URL('node_modules/@embedpdf/pdfium/', root).pathname,
  )
  assert.match(text, /MIT License/)
  assert.match(text, /Copyright 2014 PDFium Authors/)
  assert.match(text, /Apache License/)
})

test('incomplete native inventory cannot return a success status after JS gaps are filled', async () => {
  const { inventoryExitCode } = await import('../gen-third-party-notices.mjs')
  assert.equal(inventoryExitCode({ errors: [], native: { status: 'incomplete' } }), 1)
  assert.equal(inventoryExitCode({ errors: ['missing text'], native: { status: 'metadata-only' } }), 1)
  assert.equal(inventoryExitCode({ errors: [], native: { status: 'metadata-only' } }), 0)
})
