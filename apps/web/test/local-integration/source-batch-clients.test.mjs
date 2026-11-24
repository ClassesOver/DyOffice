import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { restrictedFixture } from '../helpers/restricted.mjs'
import { postgresTargets } from '../helpers/postgres-source.mjs'
import { createSourceService } from '../../server/src/modules/sources/service.ts'
import { createWorkspaceSourceResults } from '../../server/src/modules/sources/results.ts'
import { createWorkspaceSourceTools } from '../../server/src/modules/sources/tools.ts'
import { createHarnessDataAccess } from '../../server/src/modules/coding/data-access.ts'
import { registerHarnessDataRoutes } from '../../server/src/modules/coding/data-routes.ts'
import { createHarnessDataMailbox } from '../../server/src/modules/coding/data-mailbox.ts'
import { runHarnessDataCommand } from '../../../../packages/cli/src/harness-data-command.ts'
import { parseArgs } from '../../../../packages/cli/src/args.ts'
import { sourceResultBase } from '../../../../packages/web-contracts/src/source-results.ts'

test('Codex can read the authorized SQL catalog and continue a batch of columns over its mailbox', async t => {
  const f = await restrictedFixture(t), target = await postgresTargets(t, f)
  const sources = createSourceService({ transactions: f.transactions, credentialKeys: 'k:' + randomBytes(32).toString('base64'), egressTargets: target.approvals })
  const results = createWorkspaceSourceResults({ transactions: f.transactions })
  const tools = createWorkspaceSourceTools({ sources, results })
  const reader = new URL(target.readerDsn).username
  await target.admin.query(`CREATE TABLE public.measurements ("rows" integer); GRANT SELECT ON public.measurements TO "${reader}"`)
  f.cleanup.unshift(() => target.admin.query('DROP TABLE public.measurements'))
  const tables = ['public.measurements', 'public.' + target.probeTable]
  await sources.create(f.alice.token, { sourceId: 'metrics', name: 'Metrics', kind: 'postgres', secret: target.readerDsn, config: { allowedTables: tables, units: { rows: 'items', i: 'count' } } })
  const access = createHarnessDataAccess({ sessions: f.sessions, tools, results })
  const grant = await access.issue({ token: f.alice.token, agentId: 'codex', inputs: { sourceIds: ['metrics'], resultIds: [] }, signal: new AbortController().signal })
  const app = Fastify()
  registerHarnessDataRoutes(app, access)
  const mailbox = await createHarnessDataMailbox(app, grant.taskId, 'http://127.0.0.1')
  t.after(async () => { await mailbox.close(); await app.close() })
  const env = { OFFICE_HARNESS_DATA_MAILBOX: mailbox.directory, OFFICE_HARNESS_DATA_URL: 'http://127.0.0.1/api/v1/agents', OFFICE_HARNESS_TASK_ID: grant.taskId, OFFICE_HARNESS_DATA_CREDENTIAL: grant.credential }
  const describe = async args => (await runHarnessDataCommand(parseArgs(['execute', 'search_objects', '--args', JSON.stringify({ sourceId: 'metrics', ...args })]), { cwd: process.cwd(), env })).detail

  const batch = await describe({ tables })
  assert.deepEqual(batch.tables.map(table => table.name), ['measurements', target.probeTable])
  assert.deepEqual(batch.tables[0], { schema: 'public', name: 'measurements', columns: [{ name: 'rows', dataType: 'integer', nullable: true, unit: 'items' }] })
  assert.equal(batch.tables[1].columns.length, 5)
  assert.equal(batch.nextOffset, null)
  assert.deepEqual((await describe({ tables, columnOffset: 1 })).tables, batch.tables.slice(1))
  assert.deepEqual((await describe({ table: 'public.measurements' })).tables, batch.tables.slice(0, 1))
  assert.deepEqual((await describe({ tablePrefix: 'meas' })).tables, [{ schema: 'public', name: 'measurements', type: 'BASE TABLE' }])
})

test('analysis evaluation uses production batched catalog, query outcomes and frozen result paging', async t => {
  const { createEvaluationSourceBackend } = await import('../../../../tools/dyoffice/analysis-eval/source-backend.ts')
  const f = await restrictedFixture(t), target = await postgresTargets(t, f)
  const documentId = randomUUID(), base = sourceResultBase(documentId)
  const backend = createEvaluationSourceBackend(target.readerDsn, documentId)
  const execute = (name, args) => backend.request(base + '/ai/sources/execute', 'POST', { name, arguments: args })
  const qualified = 'public.' + target.probeTable
  const list = await execute('search_objects', { sourceId: 'sales', schema: 'public', tablePrefix: target.probeTable })
  assert.deepEqual(list.metadata.rows.map(row => row.table_name), [target.probeTable])
  const columns = await execute('search_objects', { sourceId: 'sales', tables: [qualified], columnOffset: 1 })
  assert.deepEqual(columns.metadata.rows.map(row => row.column_name), ['label', 'ratio', 'active', 'note'])
  const batch = await execute('execute_sql', { sourceId: 'sales', queries: [`SELECT i FROM ${qualified} ORDER BY i`, `SELECT missing_field FROM ${qualified}`, 'SELECT 42 AS answer'] })
  assert.deepEqual(batch.items.map(item => item.ok), [true, false, true])
  assert.equal(batch.items[1].code, 'SQL_DATABASE_ERROR')
  const first = batch.items[0].result
  const page = await execute('read_query_result', { resultId: first.artifact.resultId, offset: first.nextOffset })
  assert.deepEqual([...first.preview, ...page.rows].map(row => row.i), [1, 2, 3, 4])
  assert.equal(page.sha256, first.sha256)
  const path = '/data-results/' + first.artifact.resultId + '?offset=0&limit=1'
  assert.deepEqual((await backend.request(base + path)).rows, first.preview.slice(0, 1))
  for (const other of [sourceResultBase(randomUUID()), sourceResultBase()]) {
    await assert.rejects(backend.request(other + path), { status: 404 })
  }
  const clock = t.mock.method(Date, 'now', () => Date.parse(first.artifact.expiresAt))
  try {
    await assert.rejects(execute('read_query_result', { resultId: first.artifact.resultId }), { status: 404 })
  } finally { clock.mock.restore() }
})

test('analysis evaluation scores successful statements and reports all attempted SQL in order', async () => {
  const { SCENARIOS, recordTrialCall, trialSql } = await import('../../../../tools/dyoffice/analysis-eval/scenarios.ts')
  const queries = ['SELECT 1', 'SELECT sum(missing) FROM orders', 'SELECT 2']
  const outcome = JSON.stringify({ items: [{ ok: true, result: { notice: 'x'.repeat(650) } }, { ok: false, code: 'SQL_DATABASE_ERROR' }, { ok: true }] })
  const call = recordTrialCall(0, 'execute_sql', { queries }, false, outcome)
  const trial = { calls: [call], answers: ['10, 3'], inserted: [] }
  const scenario = SCENARIOS.find(item => item.id === 'detail-request-truncated')
  const grade = () => scenario.grade(trial, { east: [{ paid: 10, orders: 3, paid_orders: 3 }] })[0].pass
  assert.deepEqual(trialSql(trial), queries)
  assert.deepEqual(call.queryOutcomes, [true, false, true])
  assert.equal(grade(), false)
  trial.calls.push(recordTrialCall(0, 'execute_sql', { queries: ['SELECT sum(paid_amount) FROM orders'] }, false, '{"items":[{"ok":true}]}'))
  assert.equal(grade(), true)
})
