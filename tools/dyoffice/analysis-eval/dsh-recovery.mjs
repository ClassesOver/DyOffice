import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { run } from 'node:test'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

const { values } = parseArgs({ options: {
  format: { type: 'string', default: 'docx' },
  out: { type: 'string', default: 'test-results/dsh-recovery' },
} })
if (!['docx', 'xlsx', 'pptx', 'pdf'].includes(values.format)) {
  throw Error('Choose docx, xlsx, pptx or pdf')
}
if (values.format === 'pdf' && !process.env.DYOFFICE_TEST_OFFICE_ASSETS && !process.env.DYOFFICE_DSH_NATIVE_PDF_DIR) {
  process.env.DYOFFICE_TEST_NATIVE_PDF_DIST ??= fileURLToPath(new URL('../../../apps/web/dist-pdf', import.meta.url))
}
const testFile = fileURLToPath(new URL('../../../apps/web/test/local-browser/assistant-dsh-delegation.test.mjs', import.meta.url))
process.env.DYOFFICE_REAL_DSH = 'off'
process.env.DYOFFICE_DSH_FIXTURE = 'on'
process.env.DYOFFICE_DSH_FORMAT = values.format

const report = { format: values.format, executor: 'external-fixture', checks: [] }
const stream = run({ files: [testFile], execArgv: ['--import', 'tsx'], concurrency: 1 })
for await (const {type, data} of stream) {
  if (type !== 'test:pass' && type !== 'test:fail') continue
  if (data.skip && !data.name.startsWith(values.format + ' ')) continue
  const error = data.details.error
  report.checks.push({ name: data.name, passed: type === 'test:pass' && !data.skip,
    durationMs: data.details.duration_ms, ...(data.skip && { skipped: true }),
    ...(error && { error: error.cause?.message ?? error.message }) })
}
await mkdir(values.out, { recursive: true })
const path = join(values.out, 'report.json')
await writeFile(path, JSON.stringify(report, null, 2) + '\n')
console.log(path, report.checks)
if (!report.checks.some(check => check.name.startsWith(values.format + ' ')) ||
    report.checks.some(check => !check.passed)) process.exitCode = 1
