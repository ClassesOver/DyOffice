import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { reportBrowserScenario } from './browser-report.mjs'

const { values } = parseArgs({ options: {
  live: { type: 'boolean' }, out: { type: 'string', default: 'test-results/codex-chart' },
} })
const testFile = fileURLToPath(new URL('../../../apps/web/test/native-slides/analysis-live.test.mjs', import.meta.url))
await reportBrowserScenario({ testFile, out: values.out,
  pattern: values.live ? /^PPTX saves real Codex artifacts/ : /^PPTX cancels a real Codex task/,
  metadata: { format: 'pptx', executor: 'codex', model: values.live ? 'live' : 'fixture' } })
