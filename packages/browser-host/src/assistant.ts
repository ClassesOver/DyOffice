import type {AgentTransport,AgentStreamRequest} from '@genoffice/agent-core'
import {createSseAgentTransport,serializeTurnRequest} from './ai-transport.ts'
import type {SettingsRequest} from './preferences.ts'
import {createSourceCatalogSkill} from './source-catalog-skill.ts'
import {createCodingClient} from './coding.ts'
import {assistantReadTools, ASSISTANT_DELEGATION_TOOLS, type AssistantCatalog} from '../../web-contracts/src/assistant.ts'

export async function createAssistantClient({request, fetchImpl, csrfToken, onDelivery}: {request: SettingsRequest; fetchImpl?: typeof fetch; csrfToken?: string;onDelivery?:(hint:unknown,agent:{id:string;name:string;origin:'builtin'|'external'})=>void|Promise<void>}) {
  const catalog = await request<AssistantCatalog>('/api/v1/ai/catalog')
  let selected = catalog.defaultId, runModel = selected, disposed = false
  // Keep the original session proof. A replacement login in another tab cannot
  // dispatch this document/chat using the new account's cookie.
  const csrf = csrfToken ?? (catalog.entries.length ? (await request<{csrfToken: string}>('/api/v1/auth/csrf')).csrfToken : '')
  const allowedTools = assistantReadTools(catalog.sourceCatalog === true)
  const coding = catalog.agents?.length && catalog.defaultAgentId
    ? createCodingClient({agents: catalog.agents, defaultId: catalog.defaultAgentId, csrfToken: csrf, getModelId: () => runModel, ...(onDelivery ? {onDelivery} : {}), dataCatalog:async input=>{
      const [sources,results]=await Promise.all([
        request('/api/v1/workspace/source-tools/execute','POST',{name:'sources.list',arguments:input.sourcesAfter?{after:input.sourcesAfter}:{}}),
        request('/api/v1/workspace/data-results'+(input.resultsAfter?'?after='+encodeURIComponent(input.resultsAfter):'')),
      ])
      return {sources,results}
    }, ...(fetchImpl ? {fetchImpl} : {})}) : undefined
  const encoder = new TextEncoder()
  const prepare=(input:AgentStreamRequest):AgentStreamRequest=>{
      const tools = input.tools.filter(t => (allowedTools.has(t.name) || ((coding||input.tools.some(tool=>tool.name==='list_channel_agents')) && ASSISTANT_DELEGATION_TOOLS.has(t.name))))
      const messages = input.messages.map(message => message.role === 'assistant'
        ? {role: message.role, text: message.text, toolCalls: message.toolCalls}
        : message)
    return {...input,messages,tools,system:input.system+(coding?'\nThis assistant can read and explain. Document mutation and direct CLI execution are unavailable. You may delegate coding using the offered agent tools.':'\nThis assistant can read and explain. Document mutation and CLI execution are unavailable.')}
  }
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
      const prepared=prepare(input), {tools,messages}=prepared
      if (messages.some(message => message.role === 'user' && encoder.encode(message.text).length > 256 * 1024)) {
        callbacks.onError('消息、文档上下文和附加 Skills 超出模型请求上限。请缩短消息或减少附加 Skills。')
        callbacks.onDone()
        return {cancel() {}}
      }
      let handle: {cancel(): void}
      handle = createSseAgentTransport({modelId: runModel!, getCsrfToken: async () => csrf, ...(fetchImpl ? {fetchImpl} : {})}).stream(prepared, {...callbacks, onToolCall(call) {
        if (!tools.some(t => t.name === call.name)) throw new Error('助手返回了未授权的工具。')
        callbacks.onToolCall(call)
      }, onDone() {active.delete(handle); callbacks.onDone()}})
      active.add(handle)
      return handle
    },
  }
  return {
    // Default transport turn IDs are UUIDs (36 ASCII bytes). All other bytes
    // use the identical normalized request and serializer as dispatch.
    requestBytes(input:AgentStreamRequest){return encoder.encode(serializeTurnRequest('00000000-0000-0000-0000-000000000000',selected??undefined,prepare(input))).length},
    catalog, transport, extraSkills: coding ? [coding.skill] : [],
    ...(catalog.sourceCatalog === true ? {sourceSkill: createSourceCatalogSkill(request, () => disposed)} : {}),
    selected: () => selected,
    select(id: string) {if (disposed || !catalog.entries.some(e => e.id === id)) throw new Error('模型不可用。'); selected = id},
    available: catalog.entries.length > 0,
    dispose() {coding?.dispose(); disposed = true; for (const handle of active) handle.cancel(); active.clear()},
  }
}
