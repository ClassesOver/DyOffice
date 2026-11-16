import type { AgentTransport, AgentStreamRequest, AgentStreamCallbacks, AgentToolCall, AgentTokenUsage } from '@genoffice/agent-core'

const MAX_SSE_EVENT_BYTES = 256 * 1024

export interface SseTransportOptions {
  /** Origin-relative path only: no query, fragment, controls or redirects. */
  endpoint?: string
  /** Server configuration identifier only, never a provider URL or secret. */
  modelId?: string
  /** Session CSRF proof from the same-origin authenticated session. */
  getCsrfToken?: () => Promise<string>
  /** Absolute turn deadline, including headers and body. */
  timeoutMs?: number
  fetchImpl?: typeof fetch
  createTurnId?: () => string
}

/** Browser-side adapter for server-mediated model streams; never holds provider secrets. */
export function createSseAgentTransport(options: SseTransportOptions = {}): AgentTransport {
  const endpoint = options.endpoint ?? '/api/v1/ai/turns'
  if (!endpoint.startsWith('/') || endpoint.startsWith('//') || endpoint.includes('\\') || /[\u0000-\u0020\u007f?#]/.test(endpoint) ||
      new URL(endpoint, 'https://dyoffice.invalid').origin !== 'https://dyoffice.invalid') {
    throw new Error('AI stream endpoint must be an origin-relative path')
  }
  const timeoutMs = options.timeoutMs ?? 120_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error('Invalid AI stream timeout')
  if (options.modelId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(options.modelId)) throw new Error('Invalid model identifier')
  const fetchImpl = options.fetchImpl ?? fetch
  const createTurnId = options.createTurnId ?? (() => crypto.randomUUID())
  return {
    stream(request: AgentStreamRequest, callbacks: AgentStreamCallbacks) {
      const turnId = createTurnId()
      const controller = new AbortController()
      let finished = false
      let cancelled = false
      let deadline: ReturnType<typeof setTimeout> | undefined
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      let cancellationSent = false
      let csrfProof: string | undefined
      let dispatched = false
      const requestCancellation = () => {
        if (cancellationSent || !dispatched) return
        cancellationSent = true
        // Best effort only; the server must also impose its own deadline.
        try { void fetchImpl(endpoint + '/' + encodeURIComponent(turnId) + '/cancel', {
          method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
          headers: csrfProof ? { 'x-csrf-token': csrfProof } : undefined,
        }).catch(() => {}) } catch { /* cancellation remains best effort */ }
      }
      const finish = (error?: string) => {
        if (finished) return
        finished = true
        clearTimeout(deadline)
        // Observer failures cannot suppress terminal delivery or stream cleanup.
        try { if (error && !cancelled) callbacks.onError(error) } catch { /* UI observer */ }
        try { callbacks.onDone() } catch { /* UI observer */ }
      }
      const emit = (event: string, raw: string) => {
        if (finished) return
        if (new TextEncoder().encode(raw).byteLength > MAX_SSE_EVENT_BYTES) throw new Error('AI stream event too large')
        const value = raw.length ? JSON.parse(raw) as unknown : {}
        const data = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
        if (event === 'delta' && typeof data.text === 'string') callbacks.onDelta(data.text)
        else if (event === 'reasoning' && typeof data.text === 'string') callbacks.onReasoning?.(data.text)
        else if (event === 'tool_call') {
          if (typeof data.id !== 'string' || typeof data.name !== 'string' || !data.input || typeof data.input !== 'object' || Array.isArray(data.input)) throw new Error('Invalid complete tool call')
          callbacks.onToolCall({ id: data.id, name: data.name, input: data.input } as AgentToolCall)
        } else if (event === 'phase' && typeof data.kind === 'string') callbacks.onPhase?.(data as unknown as Parameters<NonNullable<AgentStreamCallbacks['onPhase']>>[0])
        else if (event === 'usage') {
          const usage: AgentTokenUsage = {}
          for (const key of ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'] as const) {
            const value = data[key]
            if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) throw new Error('Invalid token usage')
            if (value !== undefined) usage[key] = value as number
          }
          callbacks.onUsage?.(usage)
        }
        else if (event === 'stop_reason' && typeof data.reason === 'string') callbacks.onStopReason?.(data.reason)
        else if (event === 'error') finish(typeof data.message === 'string' ? data.message : 'AI stream failed')
        else if (event === 'done') finish()
      }
      deadline = setTimeout(() => {
        if (finished) return
        controller.abort()
        void reader?.cancel().catch(() => {})
        requestCancellation()
        finish('AI stream timed out')
      }, timeoutMs)
      void (async () => {
        try {
          if (options.getCsrfToken) {
            csrfProof = await options.getCsrfToken()
            if (typeof csrfProof !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(csrfProof)) throw new Error('Invalid CSRF proof')
          }
          if (finished || controller.signal.aborted) return
          dispatched = true
          const response = await fetchImpl(endpoint, {
            method: 'POST',
            credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
            headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json', ...(csrfProof ? { 'x-csrf-token': csrfProof } : {}) },
            body: JSON.stringify({ turnId, ...(options.modelId === undefined ? {} : { modelId: options.modelId }), request: { system: request.system, messages: request.messages, tools: request.tools } }),
            signal: controller.signal,
          })
          if (!response.ok) throw new Error('AI stream HTTP ' + response.status)
          if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') || !response.body) throw new Error('AI stream response is not SSE')
          reader = response.body.getReader()
          const decoder = new TextDecoder()
          let pending = ''
          let event = 'message'
          let dataLines: string[] = []
          let dataBytes = 0
          const encoder = new TextEncoder()
          const acceptLine = (line: string) => {
            if (encoder.encode(line).byteLength > MAX_SSE_EVENT_BYTES) throw new Error('AI stream event too large')
            if (line === '') {
              if (dataLines.length) emit(event, dataLines.join('\n'))
              event = 'message'
              dataLines = []
              dataBytes = 0
            } else if (line.startsWith('event:')) event = line.slice(6).trimStart()
            else if (line.startsWith('data:')) {
              const data = line.slice(5).trimStart()
              dataBytes += encoder.encode(data).byteLength + (dataLines.length ? 1 : 0)
              if (dataBytes > MAX_SSE_EVENT_BYTES) throw new Error('AI stream event too large')
              dataLines.push(data)
            }
          }
          while (!finished) {
            const { done, value } = await reader.read()
            if (done) break
            pending += decoder.decode(value, { stream: true })
            let cut: number
            while (!finished && (cut = pending.indexOf('\n')) !== -1) {
              const line = pending.slice(0, cut).replace(/\r$/, '')
              pending = pending.slice(cut + 1)
              acceptLine(line)
            }
            if (new TextEncoder().encode(pending).byteLength > MAX_SSE_EVENT_BYTES) throw new Error('AI stream event too large')
          }
          if (!finished && !cancelled) finish('AI stream ended without done event')
        } catch (error) {
          if (!finished) finish(cancelled ? undefined : error instanceof Error ? error.message : 'AI stream failed')
        } finally {
          if (reader) await reader.cancel().catch(() => {})
        }
      })()
      return {
        cancel() {
          if (finished) return
          cancelled = true
          controller.abort()
          finish()
          // Aborting the response alone does not guarantee the server stopped the model.
          void reader?.cancel().catch(() => {})
          requestCancellation()
        },
      }
    },
  }
}
