import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkspaceSourceSkill } from '../../../../packages/browser-host/src/source-skill.ts'
import { createWorkspaceSourceTools } from '../../server/src/modules/sources/tools.ts'
import { readFrozenPages } from '../../server/src/modules/sources/results.ts'
import { randomUUID } from 'node:crypto'

test('frozen pages load distinct results concurrently and reuse each verified snapshot', async () => {
  const ids = [randomUUID(), randomUUID(), randomUUID()]
  const pending = new Map(), calls = []
  const pages = [0, 1, 2, 0].map((i, offset) => ({ resultId: ids[i], offset, limit: 1 }))
  const batch = readFrozenPages(pages, id => {
    calls.push(id)
    return new Promise(resolve => pending.set(id, resolve))
  })
  assert.deepEqual(calls, ids)
  for (const id of [...ids].reverse()) pending.get(id)({ rows: [0,1,2,3].map(n => ({ id, n })), schema: [] })
  const { items } = await batch
  assert.deepEqual(items.map(p => p.rows[0]), pages.map(p => ({ id: p.resultId, n: p.offset })))
  assert.deepEqual(items.map(p => p.nextOffset), [1,2,3,null])
})

test('batch previews fit the UTF-8 budget without skipping an oversized first row', async () => {
  const resultId = randomUUID()
  const snapshot = { rows: [{ v: '界'.repeat(2000) }, ...Array(30).fill({ v: '界'.repeat(100) })], schema: [{ name: '界'.repeat(1000) }] }
  const batch = await readFrozenPages([0,1,2,40].map(offset => ({ resultId, offset })), async () => snapshot)
  assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= 8192)
  assert.equal(batch.items[0].schemaOmitted, true)
  assert.equal(batch.items[0].readSingly, true)
  assert.equal(batch.items[0].nextOffset, 0)
  assert.ok(batch.items[1].rows.length > 0)
  assert.equal(batch.items[1].nextOffset, 1 + batch.items[1].rows.length)
  assert.equal(batch.items[3].nextOffset, null)
})

test('all four independent SQL statements can run together and return in input order', async () => {
  const queries = ['SELECT 1', 'SELECT 2', 'SELECT 3', 'SELECT 4']
  const waiting = new Map()
  const tools = createWorkspaceSourceTools({
    sources: {
      detail: async () => ({ source: { version: 1, enabled: true, hasCredential: true } }),
      async querySource(_token, sourceId, { sql }) {
        await new Promise(resolve => waiting.set(sql, resolve))
        return { sourceId, sourceVersion: 1, schema: [], rows: [{ sql }] }
      },
    },
    results: { capture: async () => ({}) },
  })
  const batch = tools.execute('session', { name: 'execute_sql', arguments: { sourceId: 'sales', queries } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(waiting.size, 4)
  for (const sql of [...queries].reverse()) waiting.get(sql)()
  assert.deepEqual((await batch).items.map(item => item.result.preview[0].sql), queries)
})

test('a revoked batch drains in-flight queries before rejecting without results', async () => {
  const slow = Promise.withResolvers()
  let revoked = false, finished = false
  const tools = createWorkspaceSourceTools({
    sources: {
      detail: async () => ({ source: { version: 1, enabled: true, hasCredential: true } }),
      async querySource(_token, sourceId, { sql }) {
        if (sql === 'SELECT 1') await slow.promise
        else revoked = true
        return { sourceId, sourceVersion: 1, schema: [], rows: [] }
      },
    },
    results: { capture: async () => ({}) },
  })
  const batch = tools.execute('session', { name: 'execute_sql', arguments: { sourceId: 'sales', queries: ['SELECT 1', 'SELECT 2'] } },
    undefined, async () => { if (revoked) throw Object.assign(new Error(), { statusCode: 403 }) })
  const rejected = assert.rejects(batch.finally(() => { finished = true }), { statusCode: 403 })
  await new Promise(resolve => setImmediate(resolve))
  try {
    assert.equal(revoked, true)
    assert.equal(finished, false)
  } finally { slow.resolve() }
  await rejected
})

test('batch source queries capture every result in the requesting document', async () => {
  const documentId = '11111111-1111-4111-8111-111111111111', captured = []
  const tools = createWorkspaceSourceTools({
    sources: {
      detail: async () => ({ source: { version: 1, enabled: true, hasCredential: true } }),
      querySource: async (_token, sourceId) => ({ sourceId, sourceVersion: 1, schema: [], timezone: 'UTC', rows: [{ n: 1 }], truncated: false, sha256: 'a'.repeat(64) }),
    },
    results: {
      requireDocument: async (token, id) => assert.deepEqual([token, id], ['session', documentId]),
      capture: async (token, _snapshot, _hash, id) => { captured.push([token, id]); return { resultId: String(captured.length) } },
    },
  })
  const result = await tools.execute('session', { name: 'execute_sql', arguments: { sourceId: 'reporting', queries: ['SELECT 1', 'SELECT 2'] } }, documentId)
  assert.deepEqual(result.items.map(item => item.ok), [true, true])
  assert.deepEqual(captured, [['session', documentId], ['session', documentId]])
})

test('personal source skill exposes provider-compatible public tools and delegates through a session-bound request', async () => {
  const calls = []
  const skill = createWorkspaceSourceSkill(async (path, method, body) => { calls.push({ path, method, body }); return { items: [] } })
  assert.ok(skill.tools.every(tool => /^[a-zA-Z0-9_-]+$/.test(tool.name)))
  assert.ok(skill.systemPrompt.includes('sourceTruncated'))
  const result = await skill.executeTool({ id: 'call-1', name: 'list_connections', input: {} })
  assert.equal(result.isError, false)
  assert.deepEqual(calls, [{ path: '/api/v1/workspace/source-tools/execute', method: 'POST', body: { name: 'list_connections', arguments: {} } }])
  assert.equal(JSON.stringify(skill.tools).includes('password'), false)
})

test('model-provided owner, credential or path arguments never reach the server', async () => {
  let calls = 0
  const skill = createWorkspaceSourceSkill(async () => { calls++; return {} })
  for (const field of ['ownerId','userId','workspaceId','token','secret','dsn','url','path']) {
    const result = await skill.executeTool({ id: 'x', name: 'execute_sql', input: { sourceId: 'assigned', [field]: 'injected' } })
    assert.equal(result.isError, true)
  }
  assert.equal(calls, 0)
})

test('uncertain save reports ambiguity and never repeats a write automatically', async () => {
  let calls = 0
  const skill = createWorkspaceSourceSkill(async () => { calls++; throw Error('sensitive internal database URI') })
  const result = await skill.executeTool({ id: 'x', name: 'save_query_result', input: { resultId: 'r', commandId: 'c', name: 'frozen' } })
  assert.equal(calls, 1)
  assert.equal(result.isError, true)
  assert.ok(result.output.includes('not confirmed'))
  assert.equal(result.output.includes('sensitive'), false)
})

test('aborted or malformed model calls cannot start a source operation', async () => {
  let calls = 0
  const skill = createWorkspaceSourceSkill(async () => { calls++; return {} })
  const controller = new AbortController(); controller.abort()
  await skill.executeTool({ id: 'x', name: 'execute_sql', input: {} }, controller.signal)
  await skill.executeTool({ id: 'x', name: 'execute_sql', input: {}, truncated: true })
  await skill.executeTool({ id: 'x', name: 'execute_sql', input: {}, inputError: 'bad' })
  assert.equal(calls, 0)
})

test('a failed query returns status-specific rewrite advice and truncated results steer back to SQL aggregation', async () => {
  const { sourceFailure } = await import('../../../../packages/browser-host/src/source-skill.ts')
  const { truncatedNotice } = await import('../../server/src/modules/sources/tools.ts')
  const fail = status => async () => { throw Object.assign(new Error('x'), { status }) }
  const output = async status => (await createWorkspaceSourceSkill(fail(status), { tools: ['execute_sql'], disposed: () => false }).executeTool({ id: '1', name: 'execute_sql', input: { sourceId: 's', sql: 'select 1' } })).output
  assert.match(await output(504), /statement timeout.*Do not retry the same SQL.*GROUP BY/s)
  assert.match(await output(400), /SQL was rejected.*Window functions.*search_objects/s)
  assert.match(await output(403), /allowed scope/)
  assert.match(await output(500), /did not complete/)
  assert.equal(sourceFailure('read_query_result', 504), sourceFailure('list_connections', undefined))
  assert.match(truncatedNotice(1000), /first 1000 rows.*Do not compute totals.*GROUP BY.*LIMIT/s)
  const prompt = createWorkspaceSourceSkill(async () => ({}), { tools: ['execute_sql'], disposed: () => false }).systemPrompt
  assert.match(prompt, /When sourceTruncated is true, re-query with aggregation/)
})

test('catalog failures give search-specific recovery without exposing database errors', async () => {
  for (const [status, advice] of [[400, /tablePrefix/], [401, /sign in/i], [404, /list_connections/], [504, /timed out/i]]) {
    const skill = createWorkspaceSourceSkill(async () => { throw Object.assign(Error('private database details'), { status }) })
    const result = await skill.executeTool({ name: 'search_objects', input: { sourceId: 'sales' } })
    assert.equal(result.isError, true)
    assert.match(result.output, advice)
    assert.doesNotMatch(result.output, /private database details/)
  }
})

test('an empty describe of an unqualified table tells the model to use the schema-qualified name', async () => {
  const { withDescribeHint } = await import('../../../../packages/browser-host/src/source-skill.ts')
  const empty = { sourceId: 's', metadata: { rows: [] } }
  assert.match(withDescribeHint('search_objects', { sourceId: 's', table: 'orders' }, empty).hint, /schema-qualified.*sales\.orders/)
  assert.equal(withDescribeHint('search_objects', { sourceId: 's', table: 'sales.orders' }, empty), empty)
  assert.equal(withDescribeHint('search_objects', { sourceId: 's', table: 'orders', columnOffset: 160 }, empty), empty)
  const found = { metadata: { rows: [{ column_name: 'id' }] } }
  assert.equal(withDescribeHint('search_objects', { sourceId: 's', table: 'orders' }, found), found)
  const skill = createWorkspaceSourceSkill(async () => empty, { tools: ['search_objects'], disposed: () => false })
  const out = await skill.executeTool({ id: '1', name: 'search_objects', input: { sourceId: 's', table: 'orders' } })
  assert.match(out.output, /"hint":"No columns were found for \\"orders\\"/)
})

test('error codes select precise advice; status remains the fallback for older servers', async () => {
  const { sourceFailure } = await import('../../../../packages/browser-host/src/source-skill.ts')
  assert.match(sourceFailure('execute_sql', 400, 'SQL_DATABASE_ERROR'), /database rejected the statement/)
  assert.match(sourceFailure('execute_sql', 400, 'SQL_POLICY_REJECTED'), /read-only policy rejected/)
  assert.match(sourceFailure('search_objects', 403, 'SOURCE_SCOPE_DENIED'), /outside the connection's allowed scope/)
  assert.match(sourceFailure('execute_sql', 400, 'SOURCE_TARGET_NOT_APPROVED'), /administrator must approve/)
  assert.match(sourceFailure('execute_sql', 413, 'RESULT_QUOTA_EXCEEDED'), /temporary query results/i)
  assert.match(sourceFailure('save_query_result', 413, 'RESULT_QUOTA_EXCEEDED'), /Home.*Data results.*delete/i)
  assert.match(sourceFailure('execute_sql', 504), /statement timeout/)
  assert.match(sourceFailure('execute_sql', 500, 'NOT_A_PUBLIC_CODE'), /did not complete/)
  const skill = createWorkspaceSourceSkill(async () => { throw Object.assign(new Error('x'), { status: 400, code: 'SQL_DATABASE_ERROR' }) }, { tools: ['execute_sql'], disposed: () => false })
  assert.match((await skill.executeTool({ id: '1', name: 'execute_sql', input: { sourceId: 's', sql: 'select x' } })).output, /database rejected the statement/)
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
  const result = await skill.executeTool({ id: '1', name: 'save_query_result', input: {} })
  assert.equal(result.isError, true)
  assert.match(result.output, /Data results.*delete/i)
  assert.doesNotMatch(result.output, /Tell the user|private/)
})

test('model preview stays small without changing frozen result evidence or skipping rows', async () => {
  const rows = Array.from({ length: 100 }, (_, id) => ({ id, value: '数据'.repeat(100) }))
  const artifact = { resultId: 'frozen', rowCount: 200, truncated: false }
  const data = { artifact, schema: [{ name: 'id', type: 'number' }], timezone: 'UTC', totalRows: 200, sourceTruncated: false, sha256: 'original' }
  const skill = createWorkspaceSourceSkill(async (_path, _method, call) => call.name === 'execute_sql'
    ? { ...data, preview: rows, nextOffset: 100 }
    : { ...data, rows, offset: 100, nextOffset: null })
  const query = JSON.parse((await skill.executeTool({ id: 'q', name: 'execute_sql', input: { sourceId: 'sales' } })).output)
  assert.ok(query.preview.length > 0 && query.preview.length < rows.length)
  assert.equal(query.nextOffset, query.preview.length)
  assert.deepEqual(query.artifact, artifact)
  assert.equal(query.sha256, 'original')
  assert.equal(query.sourceTruncated, false)
  const page = JSON.parse((await skill.executeTool({ id: 'r', name: 'read_query_result', input: { resultId: 'frozen', offset: 100 } })).output)
  assert.deepEqual(page.rows, rows.slice(0, page.rows.length))
  assert.ok(page.rows.length > 0)
  assert.equal(page.nextOffset, 100 + page.rows.length)
})

test('oversized rows are identified explicitly and are never presented as complete values', async () => {
  const row = { text: 'x'.repeat(20_000) }
  const skill = createWorkspaceSourceSkill(async () => ({ rows: [row, { text: 'next' }], offset: 4, nextOffset: null }))
  const output = JSON.parse((await skill.executeTool({ id: 'r', name: 'read_query_result', input: {} })).output)
  assert.deepEqual(output.rows, [])
  assert.equal(output.omittedOversizedRowOffset, 4)
  assert.equal(output.nextOffset, 5)
})

test('large catalog responses use compact metadata with an explicit scope refinement hint', async () => {
  const rows = Array.from({ length: 1000 }, (_, id) => ({ table_schema: 'sales', table_name: 'orders_' + id }))
  const skill = createWorkspaceSourceSkill(async () => ({ sourceId: 'sales', kind: 'postgres', config: { allowedTables: ['private_config'], timezone: 'UTC', units: { amount: 'EUR' } }, metadata: { rows, truncated: true, sha256: 'catalog-hash' } }))
  const output = JSON.parse((await skill.executeTool({ id: 'd', name: 'search_objects', input: { sourceId: 'sales' } })).output)
  assert.ok(output.metadata.rows.length > 0 && output.metadata.rows.length < rows.length)
  assert.equal(output.metadata.truncated, true)
  assert.match(output.metadata.notice, /tablePrefix/)
  assert.equal(output.config.allowedTables, undefined)
  assert.equal(output.config.units, undefined)
  assert.equal(output.metadata.nextOffset, undefined)
  assert.equal(output.metadata.sha256, undefined)
})

test('Office column pages expose every field of a wide table and only its visible units', async () => {
  const columns = Array.from({ length: 160 }, (_, i) => ({ column_name: 'metric_' + i, data_type: 'numeric', is_nullable: 'YES' }))
  const units = Object.fromEntries(columns.filter((_, i) => i % 2 === 0).map(row => [row.column_name, '人民币'.repeat(30)]))
  units.metric_159 = 'USD'
  units.private_metric = 'hidden'
  for (const selection of [{ table: 'sales.wide' }, { tables: ['sales.wide'] }]) {
    const rows = columns.map(row => selection.tables ? { table_schema: 'sales', table_name: 'wide', ...row } : row)
    const skill = createWorkspaceSourceSkill(async (_path, _method, call) => {
      const offset = call.arguments.columnOffset ?? 0, page = rows.slice(offset, offset + 130)
      const nextOffset = offset + page.length < rows.length ? offset + page.length : null
      return { sourceId: 'sales', sourceVersion: 1, kind: 'postgres', config: { timezone: 'UTC', units, allowedTables: ['sales.wide'] },
        metadata: { rows: page, truncated: nextOffset !== null, nextOffset } }
    }, { tools: ['search_objects'], disposed: () => false })
    const seen = []
    let offset = 0
    do {
      const args = { sourceId: 'sales', ...selection, ...(offset ? { columnOffset: offset } : {}) }
      const reply = await skill.executeTool({ id: 'd', name: 'search_objects', input: args })
      const { config, metadata } = JSON.parse(reply.output)
      assert.ok(metadata.rows.length > 0)
      seen.push(...metadata.rows)
      assert.equal(metadata.nextOffset, seen.length < rows.length ? seen.length : null)
      assert.equal(metadata.truncated, metadata.nextOffset !== null)
      assert.ok(Buffer.byteLength(reply.output) < 9_000)
      const visibleUnits = Object.fromEntries(metadata.rows.filter(row => Object.hasOwn(units, row.column_name)).map(row => [row.column_name, units[row.column_name]]))
      assert.deepEqual(config, { timezone: 'UTC', units: visibleUnits })
      offset = metadata.nextOffset
    } while (offset !== null)
    assert.deepEqual(seen, rows)
  }
})

test('an oversized catalog entry identifies the omitted column and preserves access to later columns', async () => {
  const row = { column_name: 'field', data_type: 'x'.repeat(10_000), is_nullable: 'YES' }
  const skill = createWorkspaceSourceSkill(async () => ({ config: { timezone: 'UTC' }, metadata: { rows: [row, { column_name: 'next' }], truncated: false, nextOffset: null } }))
  const reply = await skill.executeTool({ id: 'd', name: 'search_objects', input: { sourceId: 's', table: 'wide', columnOffset: 12 } })
  const { metadata } = JSON.parse(reply.output)
  assert.deepEqual(metadata.rows, [])
  assert.equal(metadata.truncated, true)
  assert.equal(metadata.omittedOversizedColumnOffset, 12)
  assert.equal(metadata.nextOffset, 13)
})
