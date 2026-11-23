import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkspaceSourceSkill } from '../../../../packages/browser-host/src/source-skill.ts'

test('personal source skill exposes provider-compatible public tools and delegates through a session-bound request', async () => {
  const calls = []
  const skill = createWorkspaceSourceSkill(async (path, method, body) => { calls.push({ path, method, body }); return { items: [] } })
  assert.ok(skill.tools.every(tool => /^[a-zA-Z0-9_-]+$/.test(tool.name)))
  assert.ok(skill.systemPrompt.includes('sourceTruncated'))
  const result = await skill.executeTool({ id: 'call-1', name: 'sources_list', input: {} })
  assert.equal(result.isError, false)
  assert.deepEqual(calls, [{ path: '/api/v1/workspace/source-tools/execute', method: 'POST', body: { name: 'sources.list', arguments: {} } }])
  assert.equal(JSON.stringify(skill.tools).includes('password'), false)
})

test('model-provided owner, credential or path arguments never reach the server', async () => {
  let calls = 0
  const skill = createWorkspaceSourceSkill(async () => { calls++; return {} })
  for (const field of ['ownerId','userId','workspaceId','token','secret','dsn','url','path']) {
    const result = await skill.executeTool({ id: 'x', name: 'sources_query', input: { sourceId: 'assigned', [field]: 'injected' } })
    assert.equal(result.isError, true)
  }
  assert.equal(calls, 0)
})

test('uncertain save reports ambiguity and never repeats a write automatically', async () => {
  let calls = 0
  const skill = createWorkspaceSourceSkill(async () => { calls++; throw Error('sensitive internal database URI') })
  const result = await skill.executeTool({ id: 'x', name: 'sources_save_result', input: { resultId: 'r', commandId: 'c', name: 'frozen' } })
  assert.equal(calls, 1)
  assert.equal(result.isError, true)
  assert.ok(result.output.includes('not confirmed'))
  assert.equal(result.output.includes('sensitive'), false)
})

test('aborted or malformed model calls cannot start a source operation', async () => {
  let calls = 0
  const skill = createWorkspaceSourceSkill(async () => { calls++; return {} })
  const controller = new AbortController(); controller.abort()
  await skill.executeTool({ id: 'x', name: 'sources_query', input: {} }, controller.signal)
  await skill.executeTool({ id: 'x', name: 'sources_query', input: {}, truncated: true })
  await skill.executeTool({ id: 'x', name: 'sources_query', input: {}, inputError: 'bad' })
  assert.equal(calls, 0)
})

test('a failed query returns status-specific rewrite advice and truncated results steer back to SQL aggregation', async () => {
  const { sourceFailure } = await import('../../../../packages/browser-host/src/source-skill.ts')
  const { truncatedNotice } = await import('../../server/src/modules/sources/tools.ts')
  const fail = status => async () => { throw Object.assign(new Error('x'), { status }) }
  const output = async status => (await createWorkspaceSourceSkill(fail(status), { tools: ['sources_query'], disposed: () => false }).executeTool({ id: '1', name: 'sources_query', input: { sourceId: 's', sql: 'select 1' } })).output
  assert.match(await output(504), /statement timeout.*Do not retry the same SQL.*GROUP BY/s)
  assert.match(await output(400), /SQL was rejected.*column alias lists.*sources_describe/s)
  assert.match(await output(403), /allowed scope/)
  assert.match(await output(500), /did not complete/)
  assert.equal(sourceFailure('sources.read_result', 504), sourceFailure('sources.list', undefined))
  assert.match(truncatedNotice(1000), /first 1000 rows.*Do not compute totals.*GROUP BY.*LIMIT/s)
  const prompt = createWorkspaceSourceSkill(async () => ({}), { tools: ['sources_query'], disposed: () => false }).systemPrompt
  assert.match(prompt, /When sourceTruncated is true, re-query with aggregation/)
})

test('an empty describe of an unqualified table tells the model to use the schema-qualified name', async () => {
  const { withDescribeHint } = await import('../../../../packages/browser-host/src/source-skill.ts')
  const empty = { sourceId: 's', metadata: { rows: [] } }
  assert.match(withDescribeHint('sources.describe', { sourceId: 's', table: 'orders' }, empty).hint, /schema-qualified.*sales\.orders/)
  assert.equal(withDescribeHint('sources.describe', { sourceId: 's', table: 'sales.orders' }, empty), empty)
  const found = { metadata: { rows: [{ column_name: 'id' }] } }
  assert.equal(withDescribeHint('sources.describe', { sourceId: 's', table: 'orders' }, found), found)
  const skill = createWorkspaceSourceSkill(async () => empty, { tools: ['sources_describe'], disposed: () => false })
  const out = await skill.executeTool({ id: '1', name: 'sources_describe', input: { sourceId: 's', table: 'orders' } })
  assert.match(out.output, /"hint":"No columns were found for \\"orders\\"/)
})

test('error codes select precise advice; status remains the fallback for older servers', async () => {
  const { sourceFailure } = await import('../../../../packages/browser-host/src/source-skill.ts')
  assert.match(sourceFailure('sources.query', 400, 'SQL_DATABASE_ERROR'), /database rejected the statement/)
  assert.match(sourceFailure('sources.query', 400, 'SQL_POLICY_REJECTED'), /read-only policy rejected/)
  assert.match(sourceFailure('sources.describe', 403, 'SOURCE_SCOPE_DENIED'), /outside the connection's allowed scope/)
  assert.match(sourceFailure('sources.query', 400, 'SOURCE_TARGET_NOT_APPROVED'), /administrator must approve/)
  assert.match(sourceFailure('sources.query', 413, 'RESULT_QUOTA_EXCEEDED'), /temporary query results/i)
  assert.match(sourceFailure('sources.save_result', 413, 'RESULT_QUOTA_EXCEEDED'), /Home.*Data results.*delete/i)
  assert.match(sourceFailure('sources.query', 504), /statement timeout/)
  assert.match(sourceFailure('sources.query', 500, 'NOT_A_PUBLIC_CODE'), /did not complete/)
  const skill = createWorkspaceSourceSkill(async () => { throw Object.assign(new Error('x'), { status: 400, code: 'SQL_DATABASE_ERROR' }) }, { tools: ['sources_query'], disposed: () => false })
  assert.match((await skill.executeTool({ id: '1', name: 'sources_query', input: { sourceId: 's', sql: 'select x' } })).output, /database rejected the statement/)
})

test('the shared error handler forwards only public error codes, never messages', async () => {
  const { createApiShell } = await import('../../server/src/framework.ts')
  const app = await createApiShell()
  app.get('/coded', async () => { throw Object.assign(new Error('relation "secret" does not exist'), { statusCode: 400, code: 'SQL_DATABASE_ERROR' }) })
  app.get('/private', async () => { throw Object.assign(new Error('password=hunter2'), { statusCode: 400, code: 'ECONNREFUSED' }) })
  const coded = await app.inject('/coded'), hidden = await app.inject('/private')
  assert.equal(coded.json().code, 'SQL_DATABASE_ERROR')
  assert.doesNotMatch(coded.body, /secret/)
  assert.equal('code' in hidden.json(), false)
  assert.doesNotMatch(hidden.body, /hunter2|ECONNREFUSED/)
  await app.close()
})


test('a saved-result quota failure from an older server gives recovery guidance through the save tool', async () => {
  const skill = createWorkspaceSourceSkill(async () => { throw Object.assign(new Error('private'), { status: 413, code: 'RESULT_QUOTA_EXCEEDED' }) })
  const result = await skill.executeTool({ id: '1', name: 'sources_save_result', input: {} })
  assert.equal(result.isError, true)
  assert.match(result.output, /Data results.*delete/i)
  assert.doesNotMatch(result.output, /Tell the user|private/)
})

test('model preview stays small without changing frozen result evidence or skipping rows', async () => {
  const rows = Array.from({ length: 100 }, (_, id) => ({ id, value: '数据'.repeat(100) }))
  const artifact = { resultId: 'frozen', rowCount: 200, truncated: false }
  const data = { artifact, schema: [{ name: 'id', type: 'number' }], timezone: 'UTC', totalRows: 200, sourceTruncated: false, sha256: 'original' }
  const skill = createWorkspaceSourceSkill(async (_path, _method, call) => call.name === 'sources.query'
    ? { ...data, preview: rows, nextOffset: 100 }
    : { ...data, rows, offset: 100, nextOffset: null })
  const query = JSON.parse((await skill.executeTool({ id: 'q', name: 'sources_query', input: { sourceId: 'sales' } })).output)
  assert.ok(query.preview.length > 0 && query.preview.length < rows.length)
  assert.equal(query.nextOffset, query.preview.length)
  assert.deepEqual(query.artifact, artifact)
  assert.equal(query.sha256, 'original')
  assert.equal(query.sourceTruncated, false)
  const page = JSON.parse((await skill.executeTool({ id: 'r', name: 'sources_read_result', input: { resultId: 'frozen', offset: 100 } })).output)
  assert.deepEqual(page.rows, rows.slice(0, page.rows.length))
  assert.ok(page.rows.length > 0)
  assert.equal(page.nextOffset, 100 + page.rows.length)
})

test('oversized rows are identified explicitly and are never presented as complete values', async () => {
  const row = { text: 'x'.repeat(20_000) }
  const skill = createWorkspaceSourceSkill(async () => ({ rows: [row, { text: 'next' }], offset: 4, nextOffset: null }))
  const output = JSON.parse((await skill.executeTool({ id: 'r', name: 'sources_read_result', input: {} })).output)
  assert.deepEqual(output.rows, [])
  assert.equal(output.omittedOversizedRowOffset, 4)
  assert.equal(output.nextOffset, 5)
})

test('large catalog responses use compact metadata with an explicit scope refinement hint', async () => {
  const rows = Array.from({ length: 1000 }, (_, id) => ({ table_schema: 'sales', table_name: 'orders_' + id }))
  const skill = createWorkspaceSourceSkill(async () => ({ sourceId: 'sales', kind: 'postgres', config: { allowedTables: ['private_config'], timezone: 'UTC' }, metadata: { rows, truncated: true, sha256: 'catalog-hash' } }))
  const output = JSON.parse((await skill.executeTool({ id: 'd', name: 'sources_describe', input: { sourceId: 'sales' } })).output)
  assert.ok(output.metadata.rows.length > 0 && output.metadata.rows.length < rows.length)
  assert.equal(output.metadata.truncated, true)
  assert.match(output.metadata.notice, /tablePrefix/)
  assert.equal(output.config.allowedTables, undefined)
  assert.equal(output.metadata.sha256, undefined)
})
