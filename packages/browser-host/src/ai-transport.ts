import type { AgentTransport, AgentStreamRequest, AgentStreamCallbacks, AgentToolCall, AgentPhase, AgentTokenUsage } from '@genoffice/agent-core'

const MAX_SSE_EVENT_BYTES = 256 * 1024

export interface SseTransportOptions {
  endpoint?: string
  fetchImpl?: typeof fetch
  createTurnId?: () => string
}

/** Browser-side adapter for server-mediated model streams; never holds provider secrets. */
export function createSseAgentTransport(options: SseTransportOptions = {}): AgentTransport {
  const endpoint = options.endpoint ?? '/api/v1/ai/turns'
  if (!endpoint.startsWith('/') || endpoint.startsWith('//') || endpoint.includes('\\')) {
    throw new Error('AI stream endpoint must be an origin-relative path')
  }
  const fetchImpl = options.fetchImpl ?? fetch
  const createTurnId = options.createTurnId ?? (() => crypto.randomUUID())
  return {
    stream(request: AgentStreamRequest, callbacks: AgentStreamCallbacks) {
      const turnId = createTurnId()
      const controller = new AbortController()
      let finished = false
      let cancelled = false
      const finish = (error?: string) => {
        if (finished) return
        finished = true
        if (error && !cancelled) callbacks.onError(error)
        callbacks.onDone()
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
          callbacks.onToolCall(data as unknown as AgentToolCall)
        } else if (event === 'phase' && typeof data.kind === 'string') callbacks.onPhase?.(data as unknown as AgentPhase)
        else if (event === 'usage') callbacks.onUsage?.(data as AgentTokenUsage)
        else if (event === 'stop_reason' && typeof data.reason === 'string') callbacks.onStopReason?.(data.reason)
        else if (event === 'error') finish(typeof data.message === 'string' ? data.message : 'AI stream failed')
        else if (event === 'done') finish()
      }
      void (async () => {
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
        try {
          const response = await fetchImpl(endpoint, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
            body: JSON.stringify({ turnId, request }),
            signal: controller.signal,
          })
          if (!response.ok) throw new Error('AI stream HTTP ' + response.status)
          if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') || !response.body) throw new Error('AI stream response is not SSE')
          reader = response.body.getReader()
          const decoder = new TextDecoder()
          let pending = ''
          let event = 'message'
          let dataLines: string[] = []
          const acceptLine = (line: string) => {
            if (line === '') {
              if (dataLines.length) emit(event, dataLines.join('\n'))
              event = 'message'
              dataLines = []
            } else if (line.startsWith('event:')) event = line.slice(6).trimStart()
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
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
          void fetchImpl(endpoint + '/' + encodeURIComponent(turnId) + '/cancel', {
            method: 'POST', credentials: 'same-origin',
          }).catch(() => {})
        },
      }
    },
  }
}
