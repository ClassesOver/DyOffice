import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import postcss from 'postcss'

const stylesheet = readFileSync(new URL('../../src/shell/home-entry-b.css', import.meta.url), 'utf8')
const root = postcss.parse(stylesheet)

test('entry appearance is scoped to Web Home, not editors or desktop', () => {
  root.walkRules(rule => {
    for (const selector of rule.selectors) assert.ok(selector.startsWith('.home-web '), selector)
  })
  const entry = readFileSync(new URL('../../src/shell/local-main.tsx', import.meta.url), 'utf8')
  assert.ok(entry.includes("import './home-entry-b.css'"))
})

test('entry reuses theme tokens and preserves focus indicators', () => {
  assert.doesNotMatch(stylesheet, /#[0-9a-f]{3,8}\b|\brgba?\(/i)
  assert.match(stylesheet, /:focus-visible[\s\S]*?outline: 2px solid var\(--accent\)/)
  assert.doesNotMatch(stylesheet, /outline:\s*(none|0)/)
})

test('narrow entry keeps formats and filters scrollable and search shrinkable', () => {
  const mobile = root.nodes.find(node => node.type === 'atrule' && node.params === '(max-width: 680px)')
  assert.ok(mobile)
  const declarations = selector => Object.fromEntries(mobile.nodes.find(rule => rule.selector === selector).nodes.map(node => [node.prop, node.value]))
  assert.equal(declarations('.home-web .quick-cards')['overflow-x'], 'auto')
  assert.equal(declarations('.home-web .filter-pills')['overflow-x'], 'auto')
  assert.equal(declarations('.home-web .file-search')['min-width'], '0')
  assert.equal(declarations('.home-web .file-search-group')['min-width'], '0')
  // Do not clip menu portals or long file lists to achieve a tidy screenshot.
  assert.doesNotMatch(stylesheet, /overflow(?:-y)?:\s*hidden|display:\s*none/)
})

test('entry layout regression is included in the browser-layout CI configuration', () => {
  const config = readFileSync(new URL('../../../../e2e/playwright.config.ts', import.meta.url), 'utf8')
  assert.match(config, /testMatch:\s*\[[\s\S]*?['"]home-entry-b-layout\.spec\.ts['"]/)
})
