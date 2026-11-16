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

test('native DOCX gate builds the real renderer and tests it on Node 22 with PostgreSQL and Chromium', () => {
  const native = workflow.split('\n  native-docx:')[1]
  assert.ok(native,'native DOCX job required')
  for (const command of ['npm ci --ignore-scripts --include=dev','npm run typecheck:web:docs','npm run test:web:docs','npm test --workspace @genoffice/docs','npm test --workspace @genoffice/docx-engine']) assert.ok(native.includes('run: ' + command),command)
  assert.match(native,/node-version: '22\.23\.5'/)
  assert.match(native,/playwright install chromium --with-deps/)
  assert.match(native,/DYOFFICE_TEST_DATABASE_URL:/)
  assert.match(native,/ci-host-services\.sh/)
  assert.doesNotMatch(workflow,/services:|image:/)
})

test('durable job gate uses real host Redis and runs PostgreSQL/BullMQ recovery tests', () => {
  assert.match(workflow,/ci-host-services\.sh --objectstore/)
  assert.match(workflow,/DYOFFICE_TEST_REDIS_URL: redis:\/\/127\.0\.0\.1:16379\/15/)
  assert.match(workflow,/run: npm run test:web:jobs/)
})

 test('native sandbox gate builds the locked Rust engine and verifies real kernel resource limits', () => {
  const job = workflow.split('\n  native-worker:')[1]
  assert.ok(job,'native worker job required')
  for (const command of ['npm ci --prefix apps/web --workspaces=false --ignore-scripts --include=dev','npm run build:web:native -- --with-probe','npm run typecheck:web:worker','sudo --preserve-env=PATH,DYOFFICE_TEST_HOST_MANIFEST npm run test:web:sandbox','sudo --preserve-env=PATH,DYOFFICE_TEST_HOST_MANIFEST,DYOFFICE_TEST_DATABASE_URL,DYOFFICE_TEST_REDIS_URL,DYOFFICE_TEST_S3_ENDPOINT,DYOFFICE_TEST_S3_ACCESS_KEY,DYOFFICE_TEST_S3_SECRET_KEY npm run test:web:native-jobs']) assert.ok(job.includes('run: ' + command),command)
  assert.match(job,/node-version: '22\.23\.5'/)
  assert.doesNotMatch(job,/services:|image:|docker/i)
  assert.match(job,/sudo --preserve-env=GITHUB_ACTIONS bash tools\/dyoffice\/ci-host-services.sh/)
  assert.match(job,/rustup toolchain install 1\.93\.0/)
  assert.match(job,/DYOFFICE_TEST_DATABASE_URL:/)
  assert.match(job,/DYOFFICE_TEST_REDIS_URL:/)
})

test('T00 tool placements are checked and inventory-only changes trigger both events', () => {
  assert.match(workflow, /run: node tools\/dyoffice\/agent-tool-inventory\.mjs --check/)
  assert.equal((workflow.match(/'docs\/dyoffice\/inventory\/agent-tools\*'/g) ?? []).length, 2)
})
