import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { createAssistantWorkspace } from '../../../../packages/browser-host/src/assistant-workspace'
import {
  AssistantWorkspacePanel,
  AssistantTeamConversation,
} from '../../src/editors/assistant-workspace-panel'
import { createEditorAssistant } from '../../src/editors/assistant'

test('workspace keeps only the chat and tasks tabs without a manual routing menu', async () => {
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
        ),
      ),
    )
    const draft = host.querySelector('textarea')!
    const button = (text: string) =>
      [...host.querySelectorAll('button')].find((node) => node.textContent?.includes(text))!
    expect([...host.querySelectorAll('[role=tab]')].map(node=>node.textContent)).toEqual(['Chat','Tasks'])
    expect(host.querySelector('.assistant-member button')).toBeNull()
    expect(host.querySelector('.assistant-execution-picker,.assistant-execution-menu')).toBeNull()
    expect(client.isOffice()).toBe(true)
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
    const memberMessage = host.querySelector('.assistant-team-feed .assistant-task-message')
    task = { ...task, progress: 'Checking the numbers', activity: 'Executing command' }
    await act(async () => listeners.forEach((listener) => listener()))
    expect(host.querySelector('.assistant-team-feed [aria-label="Live output"]')?.textContent).toBe(
      'Checking the numbers',
    )
    const log=memberMessage!.querySelector<HTMLDetailsElement>('.assistant-task-log')!
    expect(log.open).toBe(true)
    await act(async()=>log.querySelector('summary')!.click())
    expect(log.open).toBe(false)
    task={...task,progress:'Checking the numbers\nStill running'}
    await act(async()=>listeners.forEach(listener=>listener()))
    expect(log.open).toBe(false)
    await act(async()=>log.querySelector('summary')!.click())
    expect(log.open).toBe(true)
    expect(log.querySelector('pre')?.textContent).toContain('Still running')
    expect(host.querySelector('.assistant-team-feed [role=status]')?.textContent).toBe(
      'Executing command',
    )
    task = { ...task, state: 'succeeded', summary: 'Calculated', output: '42' }
    await act(async () => listeners.forEach((listener) => listener()))
    await act(async () => render(['I will delegate the calculation.', 'The answer is ready.']))
    const feed = host.querySelector('.assistant-team-feed')!
    expect(feed.querySelector('.assistant-task-message')).toBe(memberMessage)
    expect(feed.textContent!.indexOf('I will delegate')).toBeLessThan(
      feed.textContent!.indexOf('Calculated'),
    )
    expect(feed.textContent!.indexOf('Calculated')).toBeLessThan(
      feed.textContent!.indexOf('The answer'),
    )
    expect(feed.querySelector('.assistant-task-details')).not.toBeNull()
    const viewTask = [...host.querySelectorAll<HTMLButtonElement>('[role=tab]')].find(
      (button) => button.textContent?.startsWith('Tasks'),
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

test('real editor factory keeps Office as the default and removes executor routing controls', async () => {
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
          assistant.workspace.conversation(null),
          assistant.modelPicker,
        ),
      ),
    )
    expect(host.querySelector('.assistant-team-roster')).toBeNull()
    expect(host.querySelector('.assistant-execution-picker,.assistant-execution-menu')).toBeNull()
    expect(assistant.workspace.isOffice()).toBe(true)
    expect([...host.querySelectorAll('[role=tab]')].map(node=>node.textContent)).toEqual(['对话','任务'])
    expect(host.querySelector('.assistant-member button')).toBeNull()
  } finally {
    await act(async () => root.unmount())
    assistant.dispose()
    host.remove()
    vi.unstubAllGlobals()
  }
})

test.each(['running','succeeded','failed','unknown_outcome'] as const)('channel member message uses the existing assistant UI in %s state',async state=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 const run=vi.fn(),cancel=vi.fn()
 const client=createAssistantWorkspace({agents:[],coding:{run,cancel,subscribe:()=>()=>{},snapshot:()=>[{
  id:'task',agent:{id:'codex',name:'Codex',origin:'builtin',capabilities:['coding']},instruction:'查询 2025 年收入\n按月份汇总，单位为元。',initiator:'office',state,
  ...(['running','succeeded'].includes(state)?{progress:'正在汇总收入'}:{}),
  ...(state==='succeeded'?{summary:'2025 年收入为 42 万元',output:'详细数据：420000'}:{}),
  ...(['failed','unknown_outcome'].includes(state)?{failure:'AI stream HTTP 403'}:{}),
 }]}})
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 try{
  await act(async()=>root.render(h(AssistantTeamConversation,{client,lang:'zh'},h('textarea',{defaultValue:'保留 Office 草稿'}))))
  const card=host.querySelector('.assistant-task-message')!
  expect(host.querySelector('.assistant-task')).toBeNull()
  expect(card.querySelector('.assistant-team-author strong')?.textContent).toBe('Codex')
  expect(card.querySelector('.ai-msg-assistant')).not.toBeNull()
  expect(card.querySelector('.assistant-member-heading')).toBeNull()
  expect(card.querySelector('.assistant-task-title')?.textContent).toBe('查询 2025 年收入')
  const request=card.querySelector<HTMLDetailsElement>('.assistant-task-details')!
  expect(request.querySelector('summary')?.textContent).toBe('任务详情');expect(request.open).toBe(false)
  expect(request.textContent).toContain('按月份汇总')
  const log=card.querySelector<HTMLDetailsElement>('.assistant-task-log')
  if(state==='running'||state==='succeeded'){
   expect(log?.open).toBe(state==='running')
   expect(log?.querySelector('pre')?.textContent).toContain('正在汇总收入')
  }
  if(state==='succeeded'){
   expect(card.querySelector('.assistant-task-result')?.textContent).toContain('42 万元')
   expect(card.querySelector('.assistant-task-output')?.textContent).toContain('420000')
  }else expect(card.querySelector('.assistant-task-output')).toBeNull()
  if(state==='failed'||state==='unknown_outcome'){
   expect(card.querySelector('.assistant-task-failure')?.textContent).toContain('AI stream HTTP 403')
   await act(async()=>request.querySelector('summary')!.click())
   expect(request.open).toBe(true)
   expect(client.snapshot().view).toBe('chat')
   expect(card.textContent).not.toContain('重新执行')
  }
  expect(host.querySelector('textarea')?.value).toBe('保留 Office 草稿')
  expect(run).not.toHaveBeenCalled();expect(cancel).not.toHaveBeenCalled();expect(client.isOffice()).toBe(true)
  if(state==='running'){
   const stop=[...card.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='请求取消')!
   await act(async()=>stop.click())
   expect(cancel).toHaveBeenCalledExactlyOnceWith('task')
   expect(run).not.toHaveBeenCalled()
  }
 }finally{await act(async()=>root.unmount());client.dispose();host.remove();vi.unstubAllGlobals()}
})
