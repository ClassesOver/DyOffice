import { describe, expect, it } from 'vitest'
import { AgentLoop, getHarnessCheckpoint, type AgentLoopOptions, type AgentStreamRequest } from '../src'

const delegated = { id: 'delegate-1', name: 'delegate_agent_task', input: { instruction: 'Add the two values' }, signature: 'signature' }
const result = { id: delegated.id, name: delegated.name, output: '{"total":42}' }
const read = { id: 'read-1', name: 'read_document', input: {} }
const edit = { id: 'edit-1', name: 'edit_document', input: { text: 'Total: 42' } }
const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const tools = [read, delegated, edit].map(({ name }) => ({ name, description: name, inputSchema: { type: 'object' } }))

async function interrupt({ mutated = false, batch = false, localInput = false } = {}) {
  let checkpointAllowed = true
  let checkpoint: ReturnType<typeof getHarnessCheckpoint>
  const loop = new AgentLoop({
    allowHarnessResume: true,
    canCheckpointHarness: () => checkpointAllowed,
    transport: { stream(request, callbacks) {
      queueMicrotask(() => {
        if (request.messages.at(-1)?.role === 'user') callbacks.onToolCall(read)
        else {
          callbacks.onToolCall(delegated)
          if (batch) callbacks.onToolCall({ ...read, id: 'read-2' })
        }
        callbacks.onDone()
      })
      return { cancel() {} }
    } },
    skill: { id: 'fixture', systemPrompt: '', tools, executeTool(call, signal) {
      if (call.name === read.name) {
        checkpointAllowed = !localInput
        return { output: 'Values: 17 and 25', summary: 'Read', mutated }
      }
      checkpoint = getHarnessCheckpoint(signal)
      return new Promise(() => {})
    } },
  })
  loop.run('Read, calculate, and explain')
  await wait()
  loop.reset()
  return checkpoint
}

describe('AgentLoop Harness continuation', () => {
  it('uses the original tool exchange and does not execute the same delegation again', async () => {
    const checkpoint = await interrupt()
    expect(checkpoint).toBeDefined()
    const requests: AgentStreamRequest[] = [], executed: string[] = []
    const options: AgentLoopOptions = {
      allowHarnessResume: true,
      transport: { stream(request, callbacks) {
        requests.push(request)
        queueMicrotask(() => {
          if (requests.length === 1) callbacks.onToolCall(delegated)
          else if (requests.length === 2) callbacks.onToolCall(edit)
          else callbacks.onDelta('The total is 42.')
          callbacks.onDone()
        })
        return { cancel() {} }
      } },
      skill: { id: 'fixture', systemPrompt: '', tools, executeTool(call) {
        executed.push(call.name)
        return { output: 'Draft updated', summary: 'Edited', mutated: true }
      } },
    }
    const loop = new AgentLoop(options)
    expect(loop.resumeHarness(checkpoint!, { ...result, id: 'unrelated' })).toBe(false)
    expect(requests).toHaveLength(0)
    expect(loop.resumeHarness(checkpoint!, result)).toBe(true)
    expect(loop.resumeHarness(checkpoint!, result)).toBe(false)
    await wait()
    expect(requests).toHaveLength(3)
    expect(requests[0]!.tools.map((tool) => tool.name)).toEqual([read.name, edit.name])
    expect(requests[0]!.messages).toMatchObject([
      { role: 'user', text: 'Read, calculate, and explain' },
      { role: 'assistant', toolCalls: [read] },
      { role: 'tool', results: [{ id: read.id, output: 'Values: 17 and 25' }] },
      { role: 'assistant', toolCalls: [delegated] },
      { role: 'tool', results: [result] },
    ])
    expect(requests[1]!.messages.at(-1)).toMatchObject({ role: 'tool', results: [{ id: delegated.id, isError: true }] })
    expect(executed).toEqual([edit.name])
    expect(loop.messages.at(-1)).toEqual({ role: 'assistant', text: 'The total is 42.' })
    expect(loop.resumeHarness(checkpoint!, result)).toBe(false)
  })

  it('does not capture a checkpoint after an edit or inside a mixed tool batch', async () => {
    expect(await interrupt({ mutated: true })).toBeUndefined()
    expect(await interrupt({ batch: true })).toBeUndefined()
  })

  it('does not checkpoint when the host marks inputs as local to the current run', async () => {
    expect(await interrupt({ localInput: true })).toBeUndefined()
  })

  it('does not finish the shared chat when another window acquired the continuation', async () => {
    const checkpoint = await interrupt()
    const events: string[] = [], persisted: string[] = []
    const loop = new AgentLoop({
      allowHarnessResume: true,
      transport: { stream(_request, callbacks) {
        queueMicrotask(() => { callbacks.onError('AI stream HTTP 409', 'harness-admission-unconfirmed'); callbacks.onDone() })
        return { cancel() {} }
      } },
      skill: { id: 'fixture', systemPrompt: '', tools, executeTool() { throw Error('Unexpected tool') } },
      events: { onError(error) { events.push(error) } },
    })
    const chat = { async history() { return [] }, text() {}, finish(text: string) { persisted.push(text) } }
    expect(loop.resumeHarness(checkpoint!, result, { chat, modelId: 'fixture' })).toBe(true)
    await wait()
    expect(events).toEqual(['AI stream HTTP 409'])
    expect(persisted).toEqual([])
    expect(loop.busy).toBe(false)
  })

  it('stops before tools when the user changes the document while the resumed model is replying', async () => {
    const checkpoint = await interrupt()
    let unchanged = true, error = ''
    const executed: string[] = []
    const persisted: Array<{text: string; failed: boolean | undefined}> = []
    const loop = new AgentLoop({
      allowHarnessResume: true,
      transport: { stream(_request, callbacks) {
        queueMicrotask(() => { unchanged = false; callbacks.onToolCall(edit); callbacks.onDone() })
        return { cancel() {} }
      } },
      skill: { id:'fixture', systemPrompt:'', tools, executeTool(call) {
        executed.push(call.name)
        return { output:'Edited', summary:'Edited', mutated:true }
      } },
      events: { onError(reason) { error = reason } },
    })
    const chat = { async history() { return [] }, text() {}, finish(text: string, failed?: boolean) { persisted.push({text, failed}) } }
    expect(loop.resumeHarness(checkpoint!, result, { chat, modelId:'fixture', canContinue:()=>unchanged })).toBe(true)
    await wait()
    expect(executed).toEqual([])
    expect(error).toMatch(/document changed/i)
    expect(persisted).toEqual([{text: error, failed: true}])
    expect(loop.busy).toBe(false)
  })
})
