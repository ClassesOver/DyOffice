import test from 'node:test'
import assert from 'node:assert/strict'
import { createAssistantWorkspace } from '../../../../packages/browser-host/src/assistant-workspace.ts'

function fixture() {
  const calls = []
  let channelSnapshot = {
    paused: false,
    members: [{ membershipId: 'peer', displayName: 'Peer', online: true, revoked: false }],
    tasks: [],
  }
  const coding = {
    snapshot: () => [],
    subscribe: () => () => {},
    run: async (input) => {
      calls.push(input)
      return { summary: 'Done', output: 'Result' }
    },
    cancel() {},
  }
  const channel = {
    snapshot: () => channelSnapshot,
    subscribe: () => () => {},
    error: () => '',
    send: async (...args) => {
      calls.push(args)
    },
  }
  const workspace = createAssistantWorkspace({
    agents: [{ id: 'codex', name: 'Codex', origin: 'builtin', capabilities: ['coding'] }],
    coding,
    channel,
  })
  return {
    workspace,
    calls,
    coding,
    channel,
    patch(value) {
      channelSnapshot = { ...channelSnapshot, ...value }
    },
  }
}
test('Office remains the default; explicit harness submission binds the target and sends only the instruction', async () => {
  const f = fixture()
  assert.equal(await f.workspace.submit('Hello', false), 'office')
  f.workspace.select('harness:codex')
  assert.equal(await f.workspace.submit('Analyze', false), 'sent')
  assert.deepEqual(f.calls, [{ agentId: 'codex', instruction: 'Analyze' }])
})
test('offline, revoked or paused peers never fall back to Office', async () => {
  const f = fixture()
  f.workspace.select('channel:peer')
  f.patch({ paused: true })
  assert.equal(await f.workspace.submit('Private', false), 'failed')
  assert.equal(f.calls.length, 0)
  assert.equal(f.workspace.snapshot().selected.id, 'channel:peer')
  f.patch({ paused: false, members: [] })
  assert.equal(await f.workspace.submit('Private', false), 'failed')
})
test('explicit targets cannot silently consume attachments, skills or selected document context', async () => {
  const f = fixture()
  f.workspace.select('harness:codex')
  assert.equal(await f.workspace.submit('Hello', true), 'failed')
  assert.equal(f.calls.length, 0)
})
test('failed peer send reports failure without claiming success or changing target', async () => {
  const f = fixture()
  f.workspace.select('channel:peer')
  f.channel.send = async () => {
    throw Error('SECRET')
  }
  assert.equal(await f.workspace.submit('Hello', false), 'failed')
  assert.equal(f.workspace.snapshot().selected.id, 'channel:peer')
  assert.doesNotMatch(f.workspace.snapshot().notice, /SECRET/)
})
test('parallel submissions are rejected while an explicit send is pending', async () => {
  const f = fixture()
  let complete
  f.coding.run = () =>
    new Promise((resolve) => {
      complete = resolve
    })
  f.workspace.select('harness:codex')
  const first = f.workspace.submit('One', false)
  assert.equal(await f.workspace.submit('Two', false), 'failed')
  complete({ summary: 'Done', output: '' })
  assert.equal(await first, 'sent')
})

test('a team starts in chat with Office coordinating; submitting to a member keeps the channel open', async () => {
  const f = fixture()
  assert.equal(f.workspace.snapshot().view, 'chat')
  f.workspace.select('harness:codex')
  await f.workspace.submit('Code', false)
  assert.equal(f.workspace.snapshot().view, 'chat')
  f.workspace.openTask('harness:task')
  assert.equal(f.workspace.snapshot().view, 'tasks')
  assert.equal(f.workspace.snapshot().focusedTask, 'harness:task')
  f.workspace.openConversation('harness:task')
  assert.equal(f.workspace.snapshot().view, 'chat')
})
test('team tasks preserve executor, initiator and durable channel states', () => {
  const f = fixture()
  f.coding.snapshot = () => [
    {
      id: 'local',
      agent: { id: 'codex', name: 'Codex', origin: 'builtin', capabilities: ['coding'] },
      instruction: 'Code',
      state: 'running',
      initiator: 'office',
    },
  ]
  f.patch({
    tasks: [
      {
        taskId: 'external',
        from: 'office',
        to: 'peer',
        instruction: 'Research',
        state: 'waiting_peer',
        summary: null,
      },
    ],
  })
  const tasks = f.workspace.snapshot().teamTasks
  assert.equal(tasks[0].id, 'harness:local')
  assert.equal(tasks[0].agent.name, 'Codex')
  assert.equal(tasks[0].initiator, 'office')
  assert.equal(tasks[1].id, 'channel:external')
  assert.equal(tasks[1].agent.name, 'Peer')
  assert.equal(tasks[1].state, 'waiting_peer')
})

test('unified cancellation routes by stable identity and exposes channel rejection', async () => {
  const f = fixture()
  let cancelled = ''
  f.coding.cancel = (id) => {
    cancelled = id
  }
  await f.workspace.cancelTask('harness:local')
  assert.equal(cancelled, 'local')
  f.channel.cancel = async (id) => {
    cancelled = id
  }
  await f.workspace.cancelTask('channel:remote')
  assert.equal(cancelled, 'remote')
  f.channel.cancel = async () => {
    throw Error('private')
  }
  await f.workspace.cancelTask('channel:remote')
  assert.equal(f.workspace.snapshot().notice, 'cancelFailed')
})
test('a direct external task is attributed to the user', async () => {
  const f = fixture()
  f.channel.send = async () => ({ taskId: 'direct' })
  f.workspace.select('channel:peer')
  await f.workspace.submit('Research', false)
  f.patch({
    tasks: [
      { taskId: 'direct', from: 'office', to: 'peer', instruction: 'Research', state: 'queued' },
    ],
  })
  assert.equal(f.workspace.snapshot().teamTasks[0].initiator, 'user')
})

test('successful explicit delegation returns to automatic Office routing', async () => {
  const f = fixture()
  f.workspace.select('harness:codex')
  await f.workspace.submit('Code', false)
  assert.equal(f.workspace.isOffice(), true)
  assert.equal(await f.workspace.submit('Summarize', false), 'office')
  assert.equal(f.calls.length, 1)
})
test('completion does not overwrite a new target selected while a task runs', async () => {
  const f = fixture()
  let finish
  f.coding.run = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  f.workspace.select('harness:codex')
  const pending = f.workspace.submit('Code', false)
  f.workspace.select('channel:peer')
  finish({ summary: 'Done', output: '' })
  await pending
  assert.equal(f.workspace.snapshot().selected.id, 'channel:peer')
})
