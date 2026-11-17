import type {AgentTransport} from '@genoffice/agent-core'
import {createSseAgentTransport} from './ai-transport.ts'
import type {SettingsRequest} from './preferences.ts'
import {ASSISTANT_READ_TOOLS, type AssistantCatalog} from '../../web-contracts/src/assistant.ts'

export async function createAssistantClient({request, fetchImpl, csrfToken}: {request: SettingsRequest; fetchImpl?: typeof fetch; csrfToken?: string}) {
  const catalog = await request<AssistantCatalog>('/api/v1/ai/catalog')
  let selected = catalog.defaultId, runModel = selected, disposed = false
  // Keep the original session proof. A replacement login in another tab cannot
  // dispatch this document/chat using the new account's cookie.
  const csrf = csrfToken ?? (catalog.entries.length ? (await request<{csrfToken: string}>('/api/v1/auth/csrf')).csrfToken : '')
  const encoder = new TextEncoder()
  const active = new Set<{cancel(): void}>()
  const transport: AgentTransport = {
    beginRun() {
      const changed = runModel !== selected
      runModel = selected
      return changed
    },
    stream(input, callbacks) {
      if (disposed || !catalog.entries.some(e => e.id === runModel)) {
        callbacks.onError('助手当前不可用。'); callbacks.onDone(); return {cancel() {}}
      }
      const tools = input.tools.filter(t => ASSISTANT_READ_TOOLS.has(t.name))
      const messages = input.messages.map(message => message.role === 'assistant'
        ? {role: message.role, text: message.text, toolCalls: message.toolCalls}
        : message)
      if (messages.some(message => message.role === 'user' && encoder.encode(message.text).length > 256 * 1024)) {
        callbacks.onError('消息、文档上下文和附加 Skills 超出模型请求上限。请缩短消息或减少附加 Skills。')
        callbacks.onDone()
        return {cancel() {}}
      }
      let handle: {cancel(): void}
      handle = createSseAgentTransport({modelId: runModel!, getCsrfToken: async () => csrf, ...(fetchImpl ? {fetchImpl} : {})}).stream({
        ...input, messages, tools, system: input.system + '\nThis assistant can read and explain. Document mutation and CLI execution are unavailable.',
      }, {...callbacks, onToolCall(call) {
        if (!tools.some(t => t.name === call.name)) throw new Error('助手返回了未授权的工具。')
        callbacks.onToolCall(call)
      }, onDone() {active.delete(handle); callbacks.onDone()}})
      active.add(handle)
      return handle
    },
  }
  return {
    catalog, transport,
    selected: () => selected,
    select(id: string) {if (disposed || !catalog.entries.some(e => e.id === id)) throw new Error('模型不可用。'); selected = id},
    available: catalog.entries.length > 0,
    dispose() {disposed = true; for (const handle of active) handle.cancel(); active.clear()},
  }
}
