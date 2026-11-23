/**
 * Real-model evaluation of the Office data-analysis loop.
 *
 * Drives the production AgentLoop with the production workspace source skill
 * and analysis insert skill. Queries run through the production read-only SQL
 * path (querySqlSource + snapshotFor + the tool notices) against a disposable
 * PostgreSQL seeded by seed.sql; documents are in-memory targets that record
 * what would be inserted. Only the model is real. See README.md.
 *
 *   node --import tsx tools/dyoffice/analysis-eval/run.ts --model <id> [--trials 3] [--only id,id]
 */
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import pg from 'pg'

import { AgentLoop } from '../../../packages/agent-core/src/loop.ts'
import { composeSkills } from '../../../packages/agent-core/src/skill.ts'
import type { AgentStreamCallbacks, AgentStreamRequest, AgentTransport } from '../../../packages/agent-core/src/types.ts'
import { streamOpenAiCompatible } from '../../../packages/ai-provider/src/protocols/openai-compatible.ts'
import { createAnalysisInsertSkill } from '../../../packages/browser-host/src/analysis-insert-skill.ts'
import { createWorkspaceSourceSkill } from '../../../packages/browser-host/src/source-skill.ts'
import { assistantSourceTools } from '../../../packages/web-contracts/src/assistant.ts'
import type { AnalysisDocumentTarget } from '../../../packages/web-contracts/src/analysis-document.ts'
import { createEvaluationSourceBackend } from './source-backend.ts'
import { SCENARIOS, recordTrialCall, trialSql, type Check, type Scenario, type TrialEvidence } from './scenarios.ts'

const { values } = parseArgs({ options: {
  model: { type: 'string' },
  'base-url': { type: 'string', default: process.env.DYOFFICE_EVAL_BASE_URL },
  'api-key': { type: 'string', default: process.env.DYOFFICE_EVAL_API_KEY ?? 'proxy-injected' },
  trials: { type: 'string', default: '3' },
  only: { type: 'string' },
  'source-dsn': { type: 'string', default: process.env.DYOFFICE_EVAL_SOURCE_DSN ?? 'postgresql://eval_analyst:eval-only-not-secret@127.0.0.1:55432/sales_eval' },
  'truth-dsn': { type: 'string', default: process.env.DYOFFICE_EVAL_TRUTH_DSN ?? 'postgresql://postgres:dyoffice-ci-test-only@127.0.0.1:55432/sales_eval' },
  out: { type: 'string', default: 'test-results/analysis-eval' },
} })
if (!values.model) throw new Error('--model is required')
if (!values['base-url']) throw new Error('--base-url (or DYOFFICE_EVAL_BASE_URL) is required: the OpenAI-compatible endpoint that receives the prompts')
const MODEL = values.model, TRIALS = Number(values.trials)

// ---- in-memory document target recording what would be inserted ----
function createDocument(fileId: string, format: 'docx' | 'xlsx' | 'pptx', inserted: TrialEvidence['inserted']) {
  const target: AnalysisDocumentTarget = {
    fileId, format,
    capture: () => ({ token: randomUUID(), fileId, format, baseRevision: 'r1', leaseEpoch: 1 }),
    async apply(_capture, content, _artifact, authorized) {
      if (!authorized()) throw new Error('Evaluation document is unavailable')
      if (content.kind === 'table') inserted.push({ rows: content.rows })
      return { status: 'applied_uncommitted', applicationId: randomUUID() }
    },
    async save() { return { status: 'not_confirmed', reason: 'unavailable' } },
    dispose() {},
  }
  return { current: () => target }
}

// ---- real model through an OpenAI-compatible endpoint ----
function createTransport(usage: { input: number; output: number; retries: number }): AgentTransport {
  return {
    stream(request: AgentStreamRequest, callbacks: AgentStreamCallbacks) {
      const controller = new AbortController()
      let emitted = false
      const attempt = (tries: number): Promise<void> => streamOpenAiCompatible(values['base-url']!, { apiKey: values['api-key']!, model: MODEL }, request.system, request.messages, request.tools, 8192, {
        onDelta: text => { emitted = true; callbacks.onDelta(text) },
        onToolCall: call => { emitted = true; callbacks.onToolCall(call) },
        onReasoningDelta: text => callbacks.onReasoning?.(text),
        onStopReason: reason => callbacks.onStopReason?.(reason),
        onUsage: u => { usage.input += u.inputTokens ?? 0; usage.output += u.outputTokens ?? 0 },
        signal: controller.signal,
      }).catch(async error => {
        // Gateway rate limits are not model behaviour: back off and retry the
        // same request, but only while nothing of this turn has been emitted.
        const message = error instanceof Error ? error.message : String(error)
        if (emitted || controller.signal.aborted || tries >= 6 || !/HTTP (429|502|503)|rate.?limit/i.test(message)) throw error
        usage.retries++
        await new Promise(resolve => setTimeout(resolve, Math.min(60_000, 5_000 * 2 ** tries)))
        return attempt(tries + 1)
      })
      void attempt(0).then(() => callbacks.onDone(), error => callbacks.onError(error instanceof Error ? error.message : String(error)))
      return { cancel: () => controller.abort() }
    },
  }
}

const OFFICE_INTRO = 'You are the Office assistant inside a document editor. Answer in the user\'s language. Use the workspace data source tools for any data question and state measures with units and time ranges.'

async function trial(scenario: Scenario) {
  const evidence: TrialEvidence = { answers: [], calls: [], inserted: [] }
  const usage = { input: 0, output: 0, retries: 0 }
  const documentId = randomUUID()
  const backend = createEvaluationSourceBackend(values['source-dsn']!, documentId)
  let disposed = false
  const sources = createWorkspaceSourceSkill(backend.request, { documentId, tools: assistantSourceTools('read-only-analysis'), disposed: () => disposed })
  const insert = createAnalysisInsertSkill({ format: scenario.format, request: backend.request, documents: createDocument(documentId, scenario.format, evidence.inserted), disposed: () => disposed, dataResults: () => true, images: () => false })
  let turn = 0, errors = ''
  let settle: ((outcome: { text: string; error?: string }) => void) | undefined
  const loop = new AgentLoop({
    transport: createTransport(usage),
    skill: composeSkills('office-analysis-eval', OFFICE_INTRO, [sources, insert]),
    maxTurns: 16,
    events: {
      onToolExecuted: ({ call, execution }) => evidence.calls.push(recordTrialCall(turn, call.name, call.input ?? {}, !!execution.isError, execution.output)),
      onDone: result => settle?.({ text: result.text }),
      onError: error => settle?.({ text: '', error }),
    },
  })
  const started = Date.now()
  for (const step of scenario.turns) {
    const result = await new Promise<{ text: string; error?: string }>(resolve => { settle = resolve; loop.run(step.prompt) })
    if (result.error) errors += `turn ${turn}: ${result.error}\n`
    evidence.answers.push(result.text)
    turn++
  }
  disposed = true
  return { evidence, usage, ms: Date.now() - started, errors }
}

const truthPool = new pg.Pool({ connectionString: values['truth-dsn'] })
const selected = SCENARIOS.filter(s => !values.only || values.only.split(',').includes(s.id))
const report: { scenario: string; title: string; trial: number; passed: boolean; checks: Check[]; toolErrors: number; calls: number; ms: number; usage: { input: number; output: number; retries: number }; errors: string; answers: string[]; sql: string[]; tools: unknown[] }[] = []
for (const scenario of selected) {
  const truth: Record<string, Record<string, unknown>[]> = {}
  for (const [key, sql] of Object.entries(scenario.truth)) truth[key] = (await truthPool.query(sql)).rows
  for (let index = 0; index < TRIALS; index++) {
    const { evidence, usage, ms, errors } = await trial(scenario)
    const checks = scenario.grade(evidence, truth)
    const passed = !errors && checks.every(c => c.pass)
    const tools = evidence.calls.map(({ output, ...call }) => call.isError ? { ...call, output } : call)
    const toolErrors = tools.filter(call => call.isError || call.queryOutcomes?.includes(false)).length
    report.push({ scenario: scenario.id, title: scenario.title, trial: index + 1, passed, checks, toolErrors, calls: tools.length, ms, usage, errors, answers: evidence.answers, sql: trialSql(evidence), tools })
    console.log(`${passed ? 'PASS' : 'FAIL'} ${scenario.id} #${index + 1} ${(ms / 1000).toFixed(1)}s calls=${evidence.calls.length} toolErrors=${report.at(-1)!.toolErrors}${passed ? '' : ' :: ' + checks.filter(c => !c.pass).map(c => c.name).join('; ') + (errors ? ' :: ' + errors.trim() : '')}`)
  }
}
await truthPool.end()

const lines = [`# Office analysis evaluation`, '', `Model: \`${MODEL}\` · trials per scenario: ${TRIALS} · ${new Date().toISOString()}`, '', '| Scenario | Passed | Avg tool calls | Tool errors | Avg time |', '|---|---|---|---|---|']
for (const scenario of selected) {
  const rows = report.filter(r => r.scenario === scenario.id)
  const avg = (f: (r: typeof rows[number]) => number) => rows.reduce((n, r) => n + f(r), 0) / rows.length
  lines.push(`| ${scenario.title} (\`${scenario.id}\`) | ${rows.filter(r => r.passed).length}/${rows.length} | ${avg(r => r.calls).toFixed(1)} | ${rows.reduce((n, r) => n + r.toolErrors, 0)} | ${(avg(r => r.ms) / 1000).toFixed(1)}s |`)
}
const total = report.filter(r => r.passed).length
lines.push('', `Overall: ${total}/${report.length} trials passed.`, '', '## Failed checks', '')
for (const r of report.filter(r => !r.passed)) lines.push(`- \`${r.scenario}\` #${r.trial}: ${r.checks.filter(c => !c.pass).map(c => `${c.name}${c.detail ? ` (${c.detail.replaceAll('\n', ' ').slice(0, 160)})` : ''}`).join('; ')}${r.errors ? ` — ${r.errors.trim()}` : ''}`)
await mkdir(values.out!, { recursive: true })
await writeFile(`${values.out}/report.json`, JSON.stringify(report, null, 2))
await writeFile(`${values.out}/report.md`, lines.join('\n') + '\n')
console.log('\n' + lines.join('\n'))
