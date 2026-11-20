import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import postcss from 'postcss'

const stylesheet = readFileSync(new URL('../../src/shell/home-entry-b.css', import.meta.url), 'utf8')
const root = postcss.parse(stylesheet)

test('entry appearance is scoped to Web Home, not editors or desktop', () => {
  root.walkRules(rule => {
    // File and folder menus use a dedicated Web Home class because they are portaled.
    for (const selector of rule.selectors) assert.match(selector, /^\.home-web(?:-menu)?(?:\s|$)/)
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
  const narrowRules = root.nodes.filter(node => node.type === 'atrule' && node.name === 'media' && node.params === '(max-width: 680px)').flatMap(node => node.nodes)
  const declarations = (rules, selector) => Object.fromEntries(rules.filter(rule => rule.selectors?.includes(selector)).flatMap(rule => rule.nodes.filter(node => node.type === 'decl').map(node => [node.prop, node.value])))
  assert.equal(declarations(narrowRules, '.home-web .quick-cards')['overflow-x'], 'auto')
  assert.equal(declarations(narrowRules, '.home-web .filter-pills')['overflow-x'], 'auto')
  assert.equal(declarations(narrowRules, '.home-web .file-search')['min-width'], '0')
  assert.equal(declarations(narrowRules, '.home-web .file-search-group')['min-width'], '0')
  assert.equal(declarations(root.nodes, '.home-web .recent-table').overflow, 'auto')
  for (const selector of ['.home-web-menu', '.home-web .recent-table', '.home-web .search-results']) {
    const style = declarations([...root.nodes, ...narrowRules], selector)
    assert.notEqual(style.display, 'none', selector)
    for (const property of ['overflow', 'overflow-y']) assert.doesNotMatch(style[property] ?? '', /\b(?:hidden|clip)\b/, selector)
  }
})

test('entry layout regression is included in the browser-layout CI configuration', () => {
  const config = readFileSync(new URL('../../../../e2e/playwright.config.ts', import.meta.url), 'utf8')
  assert.match(config, /testMatch:\s*\[[\s\S]*?['"]home-entry-b-layout\.spec\.ts['"]/)
})
