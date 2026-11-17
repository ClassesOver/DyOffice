import React from 'react'
import type { Lang } from '@genoffice/i18n'
import { ASSISTANT_PARTICIPANT_LABELS } from './strings-assistant-participants'
import './assistant-participants.css'

export interface AssistantParticipant {
  id: string
  name: string
  origin: 'office' | 'builtin' | 'external'
}

export function AssistantAvatar({ name, origin }: Pick<AssistantParticipant, 'name' | 'origin'>) {
  return <span className={`assistant-avatar assistant-avatar-${origin}`} aria-hidden="true">
    {origin === 'office' ? 'O' : Array.from(name.trim())[0]?.toLocaleUpperCase() || '?'}
  </span>
}

export function AssistantParticipants({ agents, lang, onManageAgents }: {
  agents: readonly AssistantParticipant[]
  lang: Lang
  onManageAgents?: (() => void) | undefined
}) {
  const labels = ASSISTANT_PARTICIPANT_LABELS[lang]
  const participants: readonly AssistantParticipant[] = [{ id: 'office', name: labels.office, origin: 'office' }, ...agents]
  return <div className="assistant-participants" role="group" aria-label={labels.participants}>
    {participants.map(agent => <span className="assistant-participant" key={`${agent.origin}:${agent.id}`} title={`${agent.name} · ${labels[agent.origin]}`}>
      <AssistantAvatar name={agent.name} origin={agent.origin} />
      <span className="assistant-participant-name" dir="auto">{agent.name}</span>
      {agent.origin !== 'office' && <span className="assistant-participant-origin">{labels[agent.origin]}</span>}
    </span>)}
    {onManageAgents && <button className="assistant-manage" type="button" onClick={onManageAgents}>{labels.manage}</button>}
  </div>
}

export interface DelegatedAgentResult {
  agent: AssistantParticipant
  artifacts: { artifactId: string; name: string }[]
}

/** Extract display metadata before the ordinary tool output is shortened. */
export function delegatedAgentResult(name: string | undefined, output: string | undefined): DelegatedAgentResult | undefined {
  if (name !== 'delegate_agent_task' || !output) return undefined
  try {
    const result = JSON.parse(output)
    const agent = result?.agent
    if (!agent || typeof agent.id !== 'string' || typeof agent.name !== 'string' || !['builtin', 'external'].includes(agent.origin)) return undefined
    const artifacts = Array.isArray(result.delivery?.artifacts) ? result.delivery.artifacts
      .filter((a: unknown): a is { artifactId: string; name: string } => !!a && typeof a === 'object' &&
        typeof (a as Record<string, unknown>).artifactId === 'string' && typeof (a as Record<string, unknown>).name === 'string')
      .map((a: { artifactId: string; name: string }) => ({ artifactId: a.artifactId, name: a.name })) : []
    return { agent: { id: agent.id, name: agent.name, origin: agent.origin }, artifacts }
  } catch { return undefined }
}

export function DelegatedAgentResultCard({ result, lang }: { result: DelegatedAgentResult; lang: Lang }) {
  const labels = ASSISTANT_PARTICIPANT_LABELS[lang]
  return <div className="assistant-delegated-result">
    <span className="assistant-participant">
      <AssistantAvatar {...result.agent} />
      <span className="assistant-participant-name" dir="auto">{result.agent.name}</span>
      <span className="assistant-participant-origin">{labels[result.agent.origin]}</span>
    </span>
    {result.artifacts.map(a => <a key={a.artifactId} href={`/api/v1/agents/artifacts/${encodeURIComponent(a.artifactId)}/content`} download={a.name} className="assistant-artifact" dir="auto">{a.name}</a>)}
  </div>
}

/** The saved transcript is a display record, separate from the model's full tool result. */
export function compactDelegatedTranscript(name: string, output: string, maxChars: number): string {
  const display = delegatedAgentResult(name, output)
  if (!display) return output.slice(0, maxChars)
  const parsed = JSON.parse(output)
  const saved = {
    agent: display.agent,
    summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 500) : '',
    delivery: { artifacts: [...display.artifacts] },
    output: typeof parsed.output === 'string' ? parsed.output.slice(0, 2000) : '',
    omittedArtifacts: 0,
  }
  let serialized = JSON.stringify(saved)
  if (serialized.length > maxChars) { saved.output = ''; serialized = JSON.stringify(saved) }
  while (serialized.length > maxChars && saved.delivery.artifacts.length) {
    saved.delivery.artifacts.pop()
    saved.omittedArtifacts++
    serialized = JSON.stringify(saved)
  }
  // Descriptor names come from the bounded catalog; exceptionally large legacy metadata uses the normal fallback.
  return serialized.length <= maxChars ? serialized : output.slice(0, maxChars)
}
