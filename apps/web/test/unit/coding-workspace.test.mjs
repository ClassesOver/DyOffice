import test from 'node:test'
import assert from 'node:assert/strict'
import { createCodingClient } from '../../../../packages/browser-host/src/coding.ts'

test('direct tasks reuse coding SSE, bind the model and expose confirmed results', async () => {
  const sent = []
  let model = 'first'
  const client = createCodingClient({
    agents: [{ id: 'codex', name: 'Codex', origin: 'builtin', capabilities: ['coding'] }],
    defaultId: 'codex',
    csrfToken: 'p'.repeat(43),
    getModelId: () => model,
    fetchImpl: async (url, init) => {
      sent.push(JSON.parse(init.body))
      const value = JSON.stringify({ summary: 'Calculated', output: '42' })
      return new Response(
        `event: delta\ndata: ${JSON.stringify({ text: value })}\n\nevent: done\ndata: {}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
  assert.equal(typeof client.run, 'function')
  const pending = client.run({ instruction: 'Calculate', agentId: 'codex' })
  model = 'second'
  const result = await pending
  assert.equal(sent[0].modelId, 'codex')
  assert.equal(JSON.parse(sent[0].request.messages[0].text).officeModelId, 'first')
  assert.equal(result.output, '42')
  assert.equal(client.snapshot()[0].state, 'succeeded')
  assert.equal(client.snapshot()[0].summary, 'Calculated')
  client.dispose()
})
test('cancelling the local stream does not claim a confirmed remote cancellation', async () => {
  let started
  const ready = new Promise((resolve) => {
    started = resolve
  })
  const client = createCodingClient({
    agents: [{ id: 'codex', name: 'Codex', origin: 'builtin', capabilities: ['coding'] }],
    defaultId: 'codex',
    csrfToken: 'p'.repeat(43),
    getModelId: () => 'first',
    fetchImpl: async (url) => {
      if (url.endsWith('/cancel')) return new Response(null, { status: 204 })
      started()
      return new Response(new ReadableStream({ start() {} }), {
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
  assert.equal(typeof client.run, 'function')
  const pending = client.run({ instruction: 'Long task' })
  await ready
  const id = client.snapshot()[0].id
  client.cancel(id)
  await assert.rejects(pending)
  assert.equal(client.snapshot()[0].state, 'unknown_outcome')
  client.dispose()
})

test('an interrupted result is unknown; an HTTP rejection is a failed task', async () => {
  for (const [response, state] of [
    [
      () =>
        new Response('event: delta\ndata: {"text":"partial"}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
      'unknown_outcome',
    ],
    [() => new Response(null, { status: 403 }), 'failed'],
  ]) {
    const client = createCodingClient({
      agents: [{ id: 'codex', name: 'Codex', origin: 'builtin', capabilities: ['coding'] }],
      defaultId: 'codex',
      csrfToken: 'p'.repeat(43),
      getModelId: () => 'first',
      fetchImpl: async () => response(),
    })
    await assert.rejects(client.run({ instruction: 'Analyze' }))
    assert.equal(client.snapshot()[0].state, state)
    client.dispose()
  }
})

test('publishes live progress before the final receipt without parsing progress as the result', async (t) => {
  let stream, ready
  const started = new Promise((resolve) => {
    ready = resolve
  })
  const client = createCodingClient({
    agents: [{ id: 'codex', name: 'Codex', origin: 'builtin', capabilities: ['coding'] }],
    defaultId: 'codex',
    csrfToken: 'p'.repeat(43),
    getModelId: () => 'office',
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            stream = controller
            ready()
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  })
  t.after(() => client.dispose())
  const updates = []
  client.subscribe(() => updates.push(client.snapshot()[0]))
  const pending = client.run({ instruction: 'Compute' })
  void pending.catch(() => {})
  await started
  const emit = (event, value) =>
    stream.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`))
  emit('progress', { kind: 'status', text: 'Executing command' })
  emit('progress', { kind: 'output', text: 'Checking ' })
  emit('progress', { kind: 'output', text: 'the numbers' })
  for (let i = 0; i < 10 && !client.snapshot()[0].progress; i++)
    await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(client.snapshot()[0].state, 'running')
  assert.equal(client.snapshot()[0].activity, 'Executing command')
  assert.equal(client.snapshot()[0].progress, 'Checking the numbers')
  assert.ok(updates.length >= 4)
  emit('delta', { text: JSON.stringify({ summary: 'Checked', output: '42' }) })
  emit('done', {})
  stream.close()
  assert.equal((await pending).output, '42')
  assert.equal(client.snapshot()[0].state, 'succeeded')
  client.dispose()
})
