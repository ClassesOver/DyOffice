import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const workflow = readFileSync(new URL('../../.github/workflows/dyoffice-web-boundaries.yml', import.meta.url), 'utf8')

test('Web CI runs compatibility regressions and read-only baseline validation', () => {
  assert.match(workflow, /run: node --test tools\/dyoffice\/\*\.test\.mjs/)
  assert.match(workflow, /run: node tools\/dyoffice\/compatibility-baseline\.mjs --check/)
  assert.doesNotMatch(workflow, /run:.*compatibility-baseline\.mjs --write/)
})

test('push and pull-request filters include standalone baseline inputs and checker changes', () => {
  for (const event of ['push', 'pull_request']) {
    const block = workflow.match(new RegExp(`^  ${event}:\\n([\\s\\S]*?)(?=^  [a-z_]+:|^permissions:)`, 'm'))?.[1]
    assert.ok(block, `missing ${event} configuration`)
    for (const path of ['package-lock.json', 'LICENSE', 'NOTICE', 'apps/**', 'packages/**', 'tools/dyoffice/**', 'docs/dyoffice/inventory/compatibility*']) {
      assert.ok(block.includes(`- '${path}'`), `${event} must run for ${path}`)
    }
  }
})
