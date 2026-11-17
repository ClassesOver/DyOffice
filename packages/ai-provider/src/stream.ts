import type { AgentMessage, AgentToolDef } from '@genoffice/agent-core'
import { withOutputCapFallback } from './output-cap.ts'
import { streamAnthropic } from './protocols/anthropic.ts'
import { streamGemini } from './protocols/gemini.ts'
import { streamOpenAiCompatible } from './protocols/openai-compatible.ts'
import { streamOpenAiResponses } from './protocols/openai-responses.ts'
import { streamCodexAppServer } from './codex-app-server.ts'
import type { StreamCallbacks } from './protocols/shared.ts'
import { getProviderAdapter, type AiProtocol } from './registry.ts'
import {
  anthropicThinkingFields,
  geminiThinkingLevelFor,
  openAiEffortFor,
  toggleThinkingBodyFor,
} from './thinking-effort.ts'
import type { AiProviderConfig, AiProviderId } from './types.ts'

export { streamAnthropic } from './protocols/anthropic.ts'
export { streamGemini } from './protocols/gemini.ts'
export { streamOpenAiCompatible } from './protocols/openai-compatible.ts'
export { streamOpenAiResponses } from './protocols/openai-responses.ts'
export { AiCreditsError, sseLines } from './protocols/shared.ts'
export type { StreamCallbacks } from './protocols/shared.ts'

/** route a streaming, tool-calling-capable turn by provider id */
export async function streamForProvider(
  provider: AiProviderId,
  config: AiProviderConfig,
  system: string,
  messages: AgentMessage[],
  tools: AgentToolDef[],
  maxTokens: number,
  cb: StreamCallbacks,
): Promise<void> {
  const endpoint = getProviderAdapter(provider).resolveEndpoint(config)
  const { baseUrl } = endpoint
  if (endpoint.model) config = { ...config, model: endpoint.model }
  if (endpoint.protocol === 'codex-app-server') {
    return streamCodexAppServer(config, system, messages, tools, maxTokens, cb)
  }
  // A model the user declared a ceiling for outranks the caller's budget; the
  // endpoint's own 400 would otherwise cost a billed round trip.
  const cap = endpoint.maxTokens !== undefined ? Math.min(maxTokens, endpoint.maxTokens) : maxTokens
  const protocol: Exclude<AiProtocol, 'codex-app-server'> = endpoint.protocol
  return withOutputCapFallback(baseUrl, config.model, cap, (tokens) => {
    switch (protocol) {
      case 'anthropic':
        return streamAnthropic(config, system, messages, tools, tokens, cb, baseUrl, {
          headers: endpoint.headers,
          idleTimeoutMs: endpoint.idleTimeoutMs,
          ...anthropicThinkingFields(config),
        })
      case 'gemini':
        return streamGemini(config, system, messages, tools, tokens, cb, baseUrl, {
          omitTemperature: endpoint.omitTemperature,
          headers: endpoint.headers,
          idleTimeoutMs: endpoint.idleTimeoutMs,
          thinkingLevel: geminiThinkingLevelFor(config),
        })
      case 'openai-compatible':
        return streamOpenAiCompatible(baseUrl, config, system, messages, tools, tokens, cb, {
          omitTemperature: endpoint.omitTemperature,
          useMaxCompletionTokens: endpoint.useMaxCompletionTokens,
          // a stored pick outranks the profile's own body extras
          bodyExtras: { ...endpoint.bodyExtras, ...toggleThinkingBodyFor(config) },
          echoReasoning: endpoint.echoReasoning,
          headers: endpoint.headers,
          idleTimeoutMs: endpoint.idleTimeoutMs,
          reasoningEffort: openAiEffortFor(config, endpoint.protocol),
        })
      case 'openai-responses':
        return streamOpenAiResponses(baseUrl, config, system, messages, tools, tokens, cb, {
          bodyExtras: endpoint.bodyExtras,
          headers: endpoint.headers,
          idleTimeoutMs: endpoint.idleTimeoutMs,
          reasoningEffort: openAiEffortFor(config, endpoint.protocol),
        })
    }
  })
}
