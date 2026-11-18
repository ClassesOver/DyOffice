import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { createAssistantWorkspace } from '../../../../packages/browser-host/src/assistant-workspace'
import {
  AssistantWorkspacePanel,
  AssistantRecipient,
  AssistantTeamConversation,
  handleTeamMentionKey,
} from '../../src/editors/assistant-workspace-panel'
import { createEditorAssistant } from '../../src/editors/assistant'

test('assistant views and recipient use real targets without unmounting the native draft', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const client = createAssistantWorkspace({
    agents: [{ id: 'codex', name: 'Codex', origin: 'builtin', capabilities: ['coding'] }],
    coding: { run: vi.fn(), snapshot: () => [], subscribe: () => () => {}, cancel: vi.fn() },
  })
  try {
    await act(async () =>
      root.render(
        h(
          'div',
          {},
          h(AssistantWorkspacePanel, { client, lang: 'en' }),
          h('textarea', { defaultValue: 'Keep draft' }),
          h(AssistantRecipient, { client, lang: 'en' }),
        ),
      ),
    )
    const draft = host.querySelector('textarea')!
    const button = (text: string) =>
      [...host.querySelectorAll('button')].find((node) => node.textContent?.includes(text))!
    await act(async () => button('Assistants').click())
    expect(host.textContent).toContain('Built-in')
    expect(host.textContent).toContain('Runtime not verified')
    expect(host.querySelector('.assistant-mention-trigger')).toBeNull()
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('.assistant-member button')]
        .find((node) => node.textContent?.includes('Codex'))!
        .click(),
    )
    expect(client.isOffice()).toBe(false)
    expect(host.querySelector('textarea')).toBe(draft)
    expect(draft.value).toBe('Keep draft')
    await act(async () => button('Tasks').click())
    expect(host.textContent).toContain('No tasks')
    expect(host.querySelector('textarea')).toBe(draft)
  } finally {
    await act(async () => root.unmount())
    client.dispose()
    host.remove()
  }
})

test('team conversation interleaves members with Office messages and never switches to Tasks on send', async () => {
  let task:
    | {
        id: string
        agent: { id: string; name: string; origin: 'builtin'; capabilities: string[] }
        instruction: string
        state: 'running' | 'succeeded'
        initiator: 'office'
        summary?: string
        output?: string
        progress?: string
        activity?: string
      }
    | undefined
  const listeners = new Set<() => void>()
  const client = createAssistantWorkspace({
    agents: [],
    coding: {
      run: vi.fn(),
      cancel: vi.fn(),
      snapshot: () => (task ? [task] : []),
      subscribe(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const render = (texts: string[]) =>
    root.render(
      h(
        'div',
        {},
        h(AssistantWorkspacePanel, { client, lang: 'en' }),
        h(
          AssistantTeamConversation,
          { client, lang: 'en' },
          texts.map((text, index) =>
            h('div', { key: index, className: 'ai-msg ai-msg-assistant' }, text),
          ),
        ),
      ),
    )
  try {
    await act(async () => render(['I will delegate the calculation.']))
    task = {
      id: 't1',
      agent: { id: 'codex', name: 'Codex', origin: 'builtin', capabilities: ['coding'] },
      instruction: 'Calculate',
      state: 'running',
      initiator: 'office',
    }
    await act(async () => listeners.forEach((listener) => listener()))
    expect(client.snapshot().view).toBe('chat')
    expect(host.querySelector('.assistant-team-feed')?.textContent).toContain('Office assistant')
    expect(host.querySelector('.assistant-team-feed')?.textContent).toContain('Codex')
    task = { ...task, progress: 'Checking the numbers', activity: 'Executing command' }
    await act(async () => listeners.forEach((listener) => listener()))
    expect(host.querySelector('.assistant-team-feed [aria-label="Live output"]')?.textContent).toBe(
      'Checking the numbers',
    )
    expect(host.querySelector('.assistant-team-feed [role=status]')?.textContent).toBe(
      'Executing command',
    )
    task = { ...task, state: 'succeeded', summary: 'Calculated', output: '42' }
    await act(async () => listeners.forEach((listener) => listener()))
    await act(async () => render(['I will delegate the calculation.', 'The answer is ready.']))
    const feed = host.querySelector('.assistant-team-feed')!
    expect(feed.textContent!.indexOf('I will delegate')).toBeLessThan(
      feed.textContent!.indexOf('Calculated'),
    )
    expect(feed.textContent!.indexOf('Calculated')).toBeLessThan(
      feed.textContent!.indexOf('The answer'),
    )
    const viewTask = [...feed.querySelectorAll('button')].find(
      (button) => button.textContent === 'View task',
    )!
    await act(async () => viewTask.click())
    expect(client.snapshot().view).toBe('tasks')
    const attention = [
      ...host.querySelectorAll<HTMLButtonElement>('.assistant-task-filters button'),
    ].find((node) => node.textContent?.includes('Needs attention'))!
    await act(async () => attention.click())
    expect(attention.getAttribute('aria-pressed')).toBe('true')
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('.assistant-task-filters button')]
        .find((node) => node.textContent?.startsWith('All'))!
        .click(),
    )
    const back = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'View in conversation',
    )!
    await act(async () => back.click())
    expect(client.snapshot().view).toBe('chat')
  } finally {
    await act(async () => root.unmount())
    client.dispose()
    host.remove()
  }
})

test('real editor factory routes to Codex with the selected model and renders the returned result', async () => {
  const sent: Record<string, unknown>[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/v1/auth/session-proof') return Response.json({ csrfToken: 'p'.repeat(43) })
      if (path === '/api/v1/ai/catalog')
        return Response.json({
          entries: [
            { id: 'one', label: 'ds' },
            { id: 'two', label: 'Next' },
          ],
          defaultId: 'one',
          agents: [{ id: 'codex', name: 'Codex', origin: 'builtin', capabilities: ['coding'] }],
          defaultAgentId: 'codex',
        })
      if (path === '/api/v1/agents/tasks') {
        sent.push(JSON.parse(init!.body as string))
        return new Response(
          `event: delta\ndata: ${JSON.stringify({ text: JSON.stringify({ summary: 'Analysis ready', output: 'Computed: 42' }) })}\n\nevent: done\ndata: {}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        )
      }
      throw Error('Unexpected request: ' + path)
    }),
  )
  const assistant = await createEditorAssistant(),
    host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        h(
          'div',
          {},
          assistant.workspace.panel,
          assistant.workspace.recipient,
          assistant.workspace.conversation(null),
          assistant.modelPicker,
        ),
      ),
    )
    expect(host.querySelector('.assistant-team-roster')).toBeNull()
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('[role=tab]')]
        .find((node) => node.textContent?.includes('助手'))!
        .click(),
    )
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('.assistant-member button')]
        .find((node) => node.textContent?.includes('Codex'))!
        .click(),
    )
    assistant.select('two')
    let result: unknown
    await act(async () => {
      result = await assistant.workspace.submit('Calculate 6 * 7', false)
    })
    expect(result).toBe('sent')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.modelId).toBe('codex')
    expect(
      JSON.parse((sent[0]!.request as { messages: { text: string }[] }).messages[0]!.text),
    ).toEqual({ officeModelId: 'two', instruction: 'Calculate 6 * 7' })
    expect(host.textContent).toContain('Analysis ready')
    expect(host.textContent).toContain('Computed: 42')
  } finally {
    await act(async () => root.unmount())
    assistant.dispose()
    host.remove()
    vi.unstubAllGlobals()
  }
})

test('mention Enter only intercepts the text input, leaving member buttons activatable', () => {
  const client = createAssistantWorkspace({ agents: [] })
  const preventDefault = vi.fn(),
    stopPropagation = vi.fn(),
    onChange = vi.fn()
  const event = {
    nativeEvent: { isComposing: false },
    key: 'Enter',
    shiftKey: false,
    target: document.createElement('button'),
    preventDefault,
    stopPropagation,
  }
  handleTeamMentionKey(client, event as never, '@', onChange)
  expect(preventDefault).not.toHaveBeenCalled()
  expect(onChange).not.toHaveBeenCalled()
  event.target = document.createElement('textarea') as never
  handleTeamMentionKey(client, event as never, '@Office', onChange)
  expect(preventDefault).toHaveBeenCalled()
  expect(onChange).toHaveBeenCalledWith('')
  client.dispose()
})
