import test from 'node:test'
import assert from 'node:assert/strict'
import {createAssistantClient} from '../../../../packages/browser-host/src/assistant.ts'

const encode = new TextEncoder()
test('assistant uses server model ID and CSRF, excludes unapproved mutation tools, and retains unknown usage', async () => {
  const sent = [], events = []
  const client = await createAssistantClient({request: async path => path.endsWith('/catalog') ? {entries: [{id: 'user-chat', label: 'Company Chat', model: 'synthetic'}], defaultId: 'user-chat'} : {csrfToken: 'c'.repeat(43)},
    fetchImpl: async (url, init) => {sent.push({url, init}); return new Response(new ReadableStream({start(c) {c.enqueue(encode.encode('event: delta\ndata: {"text":"Answer"}\n\nevent: done\ndata: {}\n\n')); c.close()}}), {headers: {'content-type': 'text/event-stream'}})}
  })
  await new Promise(resolve => client.transport.stream({system: '', messages: [{role: 'user', text: 'hello'}], tools: [{name: 'read_blocks', description: 'Read', inputSchema: {}}, {name: 'apply_ops', description: 'Write', inputSchema: {}}]}, {onDelta: x => events.push(x), onError: x => events.push(x), onToolCall: x => events.push(x), onUsage: x => events.push(x), onDone: resolve}))
  assert.equal(sent[0].init.headers['x-csrf-token'], 'c'.repeat(43))
  const body = JSON.parse(sent[0].init.body)
  assert.equal(body.modelId, 'user-chat')
  assert.deepEqual(body.request.tools.map(t => t.name), ['read_blocks'])
  assert.deepEqual(events, ['Answer'])
  client.dispose()
})

test('assistant rejects a model trying an unoffered tool before AgentLoop can execute it', async () => {
  const calls = []
  const client = await createAssistantClient({request: async path => path.endsWith('/catalog') ? {entries: [{id: 'chat', label: 'Chat', model: 'synthetic'}], defaultId: 'chat'} : {csrfToken: 'c'.repeat(43)}, fetchImpl: async () => new Response('event: tool_call\ndata: {"id":"call1","name":"apply_ops","input":{}}\n\nevent: done\ndata: {}\n\n', {headers: {'content-type': 'text/event-stream'}})})
  await new Promise(resolve => client.transport.stream({system: '', messages: [{role: 'user', text: 'hello'}], tools: []}, {onDelta() {}, onToolCall: x => calls.push(x), onError: x => calls.push('error'), onDone: resolve}))
  assert.deepEqual(calls, ['error'])
  client.dispose()
})

test('changing the picker only switches endpoints when the next agent run begins', async () => {
  const models = []
  const client = await createAssistantClient({request: async () => ({entries: [{id: 'first'}, {id: 'second'}], defaultId: 'first'}), csrfToken: 'c'.repeat(43),
    fetchImpl: async (_url, init) => {
      models.push(JSON.parse(init.body).modelId)
      return new Response('event: done\ndata: {}\n\n', {headers: {'content-type': 'text/event-stream'}})
    },
  })
  const stream = () => new Promise(resolve => client.transport.stream({system: '', messages: [{role: 'user', text: 'hello'}], tools: []}, {onDelta() {}, onToolCall() {}, onError: assert.fail, onDone: resolve}))
  assert.equal(client.transport.beginRun(), false)
  await stream()
  client.select('second')
  await stream()
  assert.equal(client.transport.beginRun(), true, 'AgentLoop must start with empty history on a provider change')
  await stream()
  assert.deepEqual(models, ['first', 'first', 'second'])
})
