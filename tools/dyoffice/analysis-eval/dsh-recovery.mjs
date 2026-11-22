import { reportBrowserScenario } from './browser-report.mjs'
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

await reportBrowserScenario({ testFile, pattern: new RegExp('^' + values.format + ' '), out: values.out,
  metadata: { format: values.format, executor: 'external-fixture' } })
