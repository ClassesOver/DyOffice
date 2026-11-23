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
import { createHash, randomUUID } from 'node:crypto'
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
import type { AnalysisDocumentTarget, PreparedAnalysisContent } from '../../../packages/web-contracts/src/analysis-document.ts'
import type { QuerySnapshot } from '../../../packages/web-contracts/src/sources.ts'
import { executionFor } from '../../../apps/web/server/src/modules/sources/config.ts'
import { snapshotFor } from '../../../apps/web/server/src/modules/sources/service.ts'
import { querySqlSource } from '../../../apps/web/server/src/modules/sources/sql.ts'
import { truncatedNotice } from '../../../apps/web/server/src/modules/sources/tools.ts'
import { createSourceEgressPolicy } from '../../../apps/web/server/src/security/egress.ts'
import { SCENARIOS, type Check, type Scenario, type TrialEvidence } from './scenarios.ts'

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

// ---- source backend: production query path against the disposable database ----
const dsn = new URL(values['source-dsn']!)
const policy = createSourceEgressPolicy([{ kind: 'postgres', endpoint: `postgresql://${dsn.host}`, addresses: [dsn.hostname], username: decodeURIComponent(dsn.username), database: dsn.pathname.slice(1), allowInsecure: true } as never])
const config = { timezone: 'Asia/Shanghai', maxRows: 1000, units: { order_amount: 'CNY', paid_amount: 'CNY', unit_price: 'CNY' }, statementTimeoutMs: 5000 }
const row = { source_id: 'sales', name: '销售库', kind: 'postgres', version: 1, config }
const httpError = (status: number) => Object.assign(new Error('Source tool failed'), { status })

function createBackend() {
  const results = new Map<string, { snapshot: QuerySnapshot; queryHash: string }>()
  const run = async (sql: string, scope: { defaultSchema: string; allowedTables?: string[] }, units = true) => {
    const execution = executionFor('postgres', config as never)
    try {
      const rows = await querySqlSource(policy, 'postgres', values['source-dsn']!, sql, execution, scope)
      return snapshotFor({ ...row, config: units ? config : { ...config, units: {} } }, execution, rows)
    } catch (error) { throw httpError((error as { statusCode?: number }).statusCode ?? 502) }
  }
  const artifact = (id: string, entry: { snapshot: QuerySnapshot; queryHash: string }) => ({
    resultId: id, state: 'pending', sourceId: 'sales', sourceVersion: 1, queryHash: entry.queryHash, sha256: entry.snapshot.sha256,
    rowCount: entry.snapshot.rows.length, truncated: entry.snapshot.truncated, name: null, savedAt: null,
  })
  const page = (id: string, offset = 0, limit = 1000) => {
    const entry = results.get(id.toLowerCase())
    if (!entry) throw httpError(404)
    const rows = entry.snapshot.rows.slice(offset, offset + limit), next = offset + rows.length
    return { artifact: artifact(id.toLowerCase(), entry), schema: entry.snapshot.schema, timezone: entry.snapshot.timezone, rows, offset, nextOffset: next < entry.snapshot.rows.length ? next : null, totalRows: entry.snapshot.rows.length, sourceTruncated: entry.snapshot.truncated, sha256: entry.snapshot.sha256 }
  }
  async function execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name === 'sources.list') return { items: [{ sourceId: 'sales', name: '销售库', kind: 'postgres', sourceVersion: 1 }], nextCursor: null }
    if (args.sourceId !== undefined && args.sourceId !== 'sales') throw httpError(404)
    if (name === 'sources.describe') {
      // Same rules as SourceService.describe: an unqualified name means public.<name>.
      const table = args.table as string | undefined
      if (table !== undefined && (typeof table !== 'string' || !/^[A-Za-z_][A-Za-z0-9_$]{0,127}(?:\.[A-Za-z_][A-Za-z0-9_$]{0,127})?$/.test(table))) throw httpError(400)
      const requested = table === undefined ? undefined : table.includes('.') ? table : `public.${table}`
      const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'"
      const sql = requested === undefined
        ? `SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_name, table_schema`
        : `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE (table_schema = ${literal(requested.slice(0, requested.indexOf('.')))} AND table_name = ${literal(requested.slice(requested.indexOf('.') + 1))}) ORDER BY ordinal_position`
      const metadata = await run(sql, { defaultSchema: 'sales_eval', allowedTables: [table === undefined ? 'information_schema.tables' : 'information_schema.columns'] }, false)
      return { sourceId: 'sales', sourceVersion: 1, kind: 'postgres', config, metadata }
    }
    if (name === 'sources.query') {
      const snapshot = await run(String(args.sql ?? ''), { defaultSchema: 'sales_eval' })
      const id = randomUUID(), queryHash = createHash('sha256').update(String(args.sql)).digest('hex')
      results.set(id, { snapshot, queryHash })
      return { artifact: artifact(id, { snapshot, queryHash }), schema: snapshot.schema, timezone: snapshot.timezone, preview: snapshot.rows.slice(0, 100),
        totalRows: snapshot.rows.length, sourceTruncated: snapshot.truncated, sha256: snapshot.sha256, nextOffset: snapshot.rows.length > 100 ? 100 : null,
        notice: snapshot.truncated ? truncatedNotice(snapshot.rows.length) : 'Frozen query result; later reads and saving do not execute SQL again.' }
    }
    if (name === 'sources.read_result') return page(String(args.resultId), Number(args.offset ?? 0), Number(args.limit ?? 1000))
    throw httpError(403)
  }
  async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    if (path === '/api/v1/ai/sources/execute' && method === 'POST') {
      const call = body as { name: string; arguments: Record<string, unknown> }
      return execute(call.name, call.arguments ?? {}) as Promise<T>
    }
    const match = /^\/api\/v1\/workspace\/data-results\/([^?]+)\?offset=(\d+)&limit=(\d+)$/.exec(path)
    if (match) return page(decodeURIComponent(match[1]!), Number(match[2]), Number(match[3])) as T
    throw httpError(404)
  }
  return { request }
}

// ---- in-memory document target recording what would be inserted ----
function createDocument(format: 'docx' | 'xlsx' | 'pptx', inserted: TrialEvidence['inserted']) {
  const target: AnalysisDocumentTarget = {
    fileId: 'eval', format,
    capture: () => ({ token: randomUUID(), fileId: 'eval', format, baseRevision: 'r1', leaseEpoch: 1 }),
    async apply(_capture, content: PreparedAnalysisContent, _artifact, authorized) {
      if (!authorized()) return { status: 'not_confirmed', reason: 'unavailable' }
      if (content.kind === 'table') inserted.push({ rows: content.rows })
      return { status: 'applied_uncommitted', applicationId: randomUUID() }
    },
  } as unknown as AnalysisDocumentTarget
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
  const backend = createBackend()
  let disposed = false
  const sources = createWorkspaceSourceSkill(backend.request as never, { tools: assistantSourceTools('read-only-analysis'), disposed: () => disposed })
  const insert = createAnalysisInsertSkill({ format: scenario.format, request: backend.request as never, documents: createDocument(scenario.format, evidence.inserted), disposed: () => disposed, dataResults: () => true, images: () => false })
  let turn = 0, errors = ''
  let settle: ((outcome: { text: string; error?: string }) => void) | undefined
  const loop = new AgentLoop({
    transport: createTransport(usage),
    skill: composeSkills('office-analysis-eval', OFFICE_INTRO, [sources, insert]),
    maxTurns: 16,
    events: {
      onToolExecuted: ({ call, execution }) => evidence.calls.push({ turn, name: call.name, input: (call.input ?? {}) as Record<string, unknown>, isError: !!execution.isError, output: String(execution.output ?? '').slice(0, 600) }),
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
    report.push({ scenario: scenario.id, title: scenario.title, trial: index + 1, passed, checks, toolErrors: evidence.calls.filter(c => c.isError).length, calls: evidence.calls.length, ms, usage, errors, answers: evidence.answers, sql: evidence.calls.filter(c => c.name === 'sources_query').map(c => String(c.input.sql)), tools: evidence.calls.map(c => ({ turn: c.turn, name: c.name, input: c.input, isError: c.isError, ...(c.isError ? { output: c.output } : {}) })) })
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
