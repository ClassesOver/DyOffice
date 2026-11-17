/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AssistantParticipants, DelegatedAgentResultCard, delegatedAgentResult, compactDelegatedTranscript } from '../src/assistant-participants'
import { ASSISTANT_PARTICIPANT_LABELS } from '../src/strings-assistant-participants'
import { LANGS } from '@genoffice/i18n'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })
const agents = [
  { id: 'codex', name: 'Codex', origin: 'builtin' as const },
  { id: 'custom', name: 'Custom <Agent>', origin: 'external' as const },
]

describe('assistant participants', () => {
  it('gives Office, built-in Codex and external harnesses separate local avatars and names', () => {
    act(() => root.render(createElement(AssistantParticipants, { agents, lang: 'en' })))
    expect([...host.querySelectorAll('.assistant-participant-name')].map(n => n.textContent)).toEqual(['Office assistant', 'Codex', 'Custom <Agent>'])
    expect([...host.querySelectorAll('.assistant-avatar')].map(n => n.textContent)).toEqual(['O', 'C', 'C'])
    expect(host.querySelectorAll('img').length).toBe(0)
    expect(host.querySelector('button')).toBeNull()
    expect(host.textContent).not.toContain('Online')
  })
  it('preserves the built-in entry with no external harness and exposes management only when provided', () => {
    const onManageAgents = vi.fn()
    act(() => root.render(createElement(AssistantParticipants, { agents: agents.slice(0, 1), lang: 'zh', onManageAgents })))
    expect(host.querySelectorAll('.assistant-avatar').length).toBe(2)
    act(() => host.querySelector('button')!.click())
    expect(onManageAgents).toHaveBeenCalledOnce()
  })
  it('keeps long names as text and supports both themes without fetching remote avatars', () => {
    for (const theme of ['light', 'dark']) {
      document.documentElement.dataset.theme = theme
      act(() => root.render(createElement(AssistantParticipants, { agents: [{ id: 'long', name: 'X'.repeat(500), origin: 'external' }], lang: 'en' })))
      expect(host.querySelector('.assistant-participant-name:last-child')).toBeDefined()
      expect(host.textContent).toContain('X'.repeat(500))
      expect(host.querySelector('img')).toBeNull()
    }
    delete document.documentElement.dataset.theme
  })
  it('provides labels for every supported locale', () => {
    for (const lang of LANGS) expect(Object.values(ASSISTANT_PARTICIPANT_LABELS[lang]).every(Boolean)).toBe(true)
  })
})

describe('delegated tool results', () => {
  it('extracts identity and committed artifact metadata before long output is shortened', () => {
    const output = JSON.stringify({ agent: agents[0], output: 'x'.repeat(5000), delivery: { artifacts: [{ artifactId: 'a/../b', name: '<report>.csv' }] } })
    const result = delegatedAgentResult('delegate_agent_task', output)!
    act(() => root.render(createElement(DelegatedAgentResultCard, { result, lang: 'en' })))
    expect(host.textContent).toContain('Codex')
    const link = host.querySelector('a')!
    expect(link.getAttribute('href')).toBe('/api/v1/agents/artifacts/a%2F..%2Fb/content')
    expect(link.textContent).toBe('<report>.csv')
  })
  it('does not turn plain text, partial JSON, or other tools into agent messages', () => {
    expect(delegatedAgentResult('delegate_agent_task', 'Codex completed')).toBeUndefined()
    expect(delegatedAgentResult('delegate_agent_task', '{"agent":')).toBeUndefined()
    expect(delegatedAgentResult('read_blocks', JSON.stringify({ agent: agents[0] }))).toBeUndefined()
    expect(delegatedAgentResult('delegate_agent_task', JSON.stringify({ agent: { ...agents[0], origin: 'office' } }))).toBeUndefined()
  })
})

it('preserves agent and artifact identity when saving a large tool result', () => {
  const output = JSON.stringify({ agent: agents[0], summary: 'Done', output: 'x'.repeat(30000), delivery: { artifacts: [{ artifactId: 'report-1', name: 'report.csv' }] } })
  const saved = compactDelegatedTranscript('delegate_agent_task', output, 16000)
  expect(saved.length).toBeLessThanOrEqual(16000)
  expect(delegatedAgentResult('delegate_agent_task', saved)?.artifacts[0]?.artifactId).toBe('report-1')
  expect(delegatedAgentResult('delegate_agent_task', saved)?.agent.name).toBe('Codex')
  expect(compactDelegatedTranscript('read_blocks', 'ordinary output', 5)).toBe('ordin')
})
