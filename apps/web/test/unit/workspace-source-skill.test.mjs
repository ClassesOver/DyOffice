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
