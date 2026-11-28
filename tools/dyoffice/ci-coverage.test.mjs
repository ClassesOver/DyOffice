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
  for (const command of ['npm ci --ignore-scripts --include=dev','npm run build:web:native -- --with-probe','npm run typecheck:web:worker','sudo --preserve-env=PATH,DYOFFICE_TEST_HOST_MANIFEST npm run test:web:sandbox','sudo --preserve-env=PATH,DYOFFICE_TEST_HOST_MANIFEST,DYOFFICE_TEST_DATABASE_URL,DYOFFICE_TEST_REDIS_URL,DYOFFICE_TEST_S3_ENDPOINT,DYOFFICE_TEST_S3_ACCESS_KEY,DYOFFICE_TEST_S3_SECRET_KEY npm run test:web:native-jobs']) assert.ok(job.includes('run: ' + command),command)
  assert.match(job,/node-version: '22\.23\.5'/)
  assert.doesNotMatch(job,/services:|image:|docker/i)
  assert.match(job,/sudo --preserve-env=GITHUB_ACTIONS bash tools\/dyoffice\/ci-host-services.sh/)
  assert.match(job,/rustup toolchain install 1\.93\.0/)
  assert.match(job,/DYOFFICE_TEST_DATABASE_URL:/)
  assert.match(job,/DYOFFICE_TEST_REDIS_URL:/)
})

test('native Sheets gate builds original renderer and Rust and runs real edit-save-reopen acceptance', () => {
 const job=workflow.split('\n  native-sheets:')[1]
 assert.ok(job,'native Sheets job required')
 for(const command of ['npm ci --ignore-scripts --include=dev','npm run build:web:native -- --with-probe','npm run build:sheets --workspace=@dyoffice/web','npx tsc -p apps/web/tsconfig.sheets.json','sudo --preserve-env=PATH,DYOFFICE_TEST_HOST_MANIFEST,DYOFFICE_TEST_DATABASE_URL,PLAYWRIGHT_BROWSERS_PATH npm run test:native-sheets --workspace=@dyoffice/web','npx vitest run --root packages/xlsx-gateway --maxWorkers=1','npx vitest run --root apps/sheets --maxWorkers=1 tests/defined-name-recalculation.test.ts']) assert.ok(job.includes('run: '+command),command)
 assert.match(job,/node-version: '22\.23\.5'/)
 assert.match(job,/playwright install chromium --with-deps/)
 assert.match(job,/PLAYWRIGHT_BROWSERS_PATH:.*github.workspace/)
 assert.match(job,/run: npm run build:web:shell\n\s+- name: Test real native editor and authorized save-reopen path/)
 assert.match(job,/sudo --preserve-env=PATH,DYOFFICE_TEST_HOST_MANIFEST,DYOFFICE_TEST_DATABASE_URL,PLAYWRIGHT_BROWSERS_PATH/)
 assert.match(job,/ci-host-services\.sh/)
 assert.match(job,/rustup toolchain install 1\.93\.0/)
 assert.doesNotMatch(job,/services:|image:|docker/i)
})

test('T00 tool placements are checked and inventory-only changes trigger both events', () => {
  assert.match(workflow, /run: node tools\/dyoffice\/agent-tool-inventory\.mjs --check/)
  assert.equal((workflow.match(/'docs\/dyoffice\/inventory\/agent-tools\*'/g) ?? []).length, 2)
})

test('T01 CI executes the documented selectable unit command and watches its runner', () => {
  assert.match(workflow, /run: npm run test:web:unit -- host-contract\.test\.mjs/)
  assert.equal((workflow.match(/'tools\/run-web-unit\.mjs'/g) ?? []).length, 2)
})

test('Chromium source analysis starts an already installed DBHub entry', () => {
  const dbhub = readFileSync(new URL('../../apps/web/server/src/modules/sources/dbhub.ts', import.meta.url), 'utf8')
  const pin = /const DEFAULT_PACKAGE = '([^']+)'/.exec(dbhub)?.[1]
  assert.ok(pin, 'DBHub must have a pinned package version')
  const browser = workflow.indexOf('Verify the local workspace and four native editors in Chromium')
  const provision = workflow.indexOf('Install pinned DBHub for Chromium source tests')
  assert.ok(provision >= 0 && provision < browser)
  assert.ok(workflow.slice(provision, browser).includes(pin))
  assert.match(workflow.slice(browser), /DYOFFICE_DBHUB_ENTRY: .*dyoffice-dbhub\/node_modules\/@bytebase\/dbhub\/dist\/index\.js/)
})

test('Office tool coverage checks a fresh trace after the Chromium suite, including Word writing', () => {
  const office = workflow.match(/Verify the local workspace and four native editors in Chromium\n([\s\S]*?)(?=^ {6}- name:)/m)?.[1]
  assert.ok(office, 'the Chromium job must collect the tool trace')
  assert.match(office, /DYOFFICE_TEST_AI_TOOL_TRACE: \$\{\{ runner\.temp \}\}/)
  assert.match(office, /: > "\$DYOFFICE_TEST_AI_TOOL_TRACE"\n.*node --import tsx --test.*writer-draft-save.*\n.*node --import tsx apps\/web\/test\/helpers\/office-tool-coverage\.mjs "\$DYOFFICE_TEST_AI_TOOL_TRACE"/)
  assert.match(office, /set -o pipefail/)
  assert.match(office, /office-tool-coverage\.mjs "\$DYOFFICE_TEST_AI_TOOL_TRACE" 2>&1 \| tee "\$RUNNER_TEMP\/dyoffice-office-tool-coverage\.txt"/)
  const artifact = workflow.match(/Retain Office AI tool coverage evidence\n([\s\S]*?)(?=^ {6}- name:)/m)?.[1]
  assert.ok(artifact, 'tool effects must be auditable after the runner exits')
  assert.match(artifact, /if: always\(\)/)
  assert.match(artifact, /uses: actions\/upload-artifact@/)
  assert.match(artifact, /name: office-ai-tool-coverage/)
  assert.match(artifact, /path: \|\n {12}\$\{\{ runner\.temp \}\}\/dyoffice-office-tool-trace\.jsonl\n {12}\$\{\{ runner\.temp \}\}\/dyoffice-office-tool-coverage\.txt/)
})
