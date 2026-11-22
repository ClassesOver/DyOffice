import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { run } from 'node:test'
export async function reportBrowserScenario({ testFile, pattern, out, metadata }) {
  const report = { ...metadata, checks: [] }
  // Native PowerPoint's isolated fixture process requires the test environment.
  process.env.NODE_ENV = 'test'
  const stream = run({ files: [testFile], execArgv: ['--import', 'tsx'], concurrency: 1, testNamePatterns: pattern })
  for await (const {type, data} of stream) {
    if (type !== 'test:pass' && type !== 'test:fail') continue
    if (data.skip && !pattern.test(data.name)) continue
    const error = data.details.error
    report.checks.push({ name: data.name, passed: type === 'test:pass' && !data.skip,
      durationMs: data.details.duration_ms, ...(data.skip && { skipped: true }),
      ...(error && { error: error.cause?.message ?? error.message }) })
  }
  await mkdir(out, { recursive: true })
  const path = join(out, 'report.json')
  await writeFile(path, JSON.stringify(report, null, 2) + '\n')
  console.log(path, report.checks)
  if (!report.checks.some(check => pattern.test(check.name)) ||
      report.checks.some(check => !check.passed)) process.exitCode = 1
}
