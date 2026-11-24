import type {CodingProgress} from '../../agent-core/src/coding-skill.ts'
import type {HarnessCheckpoint} from '../../agent-core/src/loop.ts'
import type { AgentStreamRequest, AgentStreamCallbacks, AgentToolCall, AgentTokenUsage } from '@genoffice/agent-core'
import {MODEL_CONNECTION_FAILURES,type ModelConnectionFailure} from '../../web-contracts/src/settings.ts'
import {AI_TURN_TIMED_OUT,ASSISTANT_MODEL_DEADLINE_MS} from '../../web-contracts/src/assistant.ts'

const MAX_SSE_EVENT_BYTES = 256 * 1024
const OFFICE_TURNS_ENDPOINT = '/api/v1/ai/turns'
const RATE_LIMIT_RETRY_DELAYS_MS = [1000, 2000, 4000] as const
const MAX_RATE_LIMIT_WAIT_MS = 60_000
const modelTimeoutZh = '等待模型回复超时。请重试、缩短请求，或切换模型。'
const isChinese = () => globalThis.document?.documentElement.lang.toLowerCase().startsWith('zh')
const providerFailureZh: Record<ModelConnectionFailure,string> = {
  PROVIDER_AUTH_REJECTED: '模型供应商拒绝了访问，请联系管理员检查模型配置。',
  PROVIDER_RATE_LIMITED: '模型供应商限流或额度不足，请稍后重试或切换模型。',
  PROVIDER_TEMPORARILY_UNAVAILABLE: '模型供应商服务暂时不可用，请稍后重试或切换模型。',
}

function rateLimitDelay(retryAfter: string | null, fallback: number): number {
  if (!retryAfter) return fallback
  if (/^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000
  const date = Date.parse(retryAfter)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : fallback
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, delayMs)
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) finish()
  })
}

export interface SseTransportOptions {
  /** Origin-relative path only: no query, fragment, controls or redirects. */
  endpoint?: string
  /** Server configuration identifier only, never a provider URL or secret. */
  modelId?: string
  format?: 'docx' | 'xlsx' | 'pptx' | 'pdf'
  documentId?:string
  continuation?:{revision:string;checkpoint:HarnessCheckpoint}
  harnessResume?:{taskId:string;documentId:string;revision:string}
  /** Session CSRF proof from the same-origin authenticated session. */
  getCsrfToken?: () => Promise<string>
  /** Absolute turn deadline, including headers and body. */
  timeoutMs?: number
  onProgress?:(event:CodingProgress)=>void
  onConfirmedFailure?:()=>void
  fetchImpl?: typeof fetch
  createTurnId?: () => string
}

/** Shared wire encoding keeps client-side admission aligned with the sent envelope. */
export function serializeTurnRequest(turnId:string,modelId:string|undefined,request:AgentStreamRequest,format?:SseTransportOptions['format'],documentId?:string,continuation?:SseTransportOptions['continuation'],harnessResume?:SseTransportOptions['harnessResume']){
  return JSON.stringify({turnId,...(modelId===undefined?{}:{modelId}),...(documentId?{documentId}:{}),...(continuation?{continuation}:{}),...(harnessResume?{harnessResume}:{}),request:{...(format?{format}:{}),system:request.system,messages:request.messages,tools:request.tools}})
}

/** Browser-side adapter for server-mediated model streams; never holds provider secrets. */
export function createSseAgentTransport(options: SseTransportOptions = {}) {
  const endpoint = options.endpoint ?? OFFICE_TURNS_ENDPOINT
  if (!endpoint.startsWith('/') || endpoint.startsWith('//') || endpoint.includes('\\') || /[\u0000-\u0020\u007f?#]/.test(endpoint) ||
      new URL(endpoint, 'https://dyoffice.invalid').origin !== 'https://dyoffice.invalid') {
    throw new Error('AI stream endpoint must be an origin-relative path')
  }
  const timeoutMs = options.timeoutMs ?? ASSISTANT_MODEL_DEADLINE_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error('Invalid AI stream timeout')
  if (options.modelId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(options.modelId)) throw new Error('Invalid model identifier')
  const fetchImpl = options.fetchImpl ?? fetch
  const createTurnId = options.createTurnId ?? (() => crypto.randomUUID())
  return {
    stream(request: AgentStreamRequest, callbacks: AgentStreamCallbacks) {
      const turnId = createTurnId()
      const controller = new AbortController()
      const expiresAt = performance.now() + timeoutMs
      let finished = false
      let cancelled = false
      let deadline: ReturnType<typeof setTimeout> | undefined
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      let cancellationSent = false
      let csrfProof: string | undefined
      let dispatched = false
      let accepted = false
      const requestCancellation = () => {
        if (cancellationSent || !dispatched) return
        cancellationSent = true
        // Best effort only; the server must also impose its own deadline.
        try { void fetchImpl(endpoint + '/' + encodeURIComponent(turnId) + '/cancel', {
          method: 'POST', credentials: 'same-origin', mode: 'same-origin', referrerPolicy: 'same-origin', redirect: 'error',
          ...(csrfProof ? {headers: { 'x-csrf-token': csrfProof }} : {}),
        }).catch(() => {}) } catch { /* cancellation remains best effort */ }
      }
      const finish = (error?: string) => {
        if (finished) return
        finished = true
        clearTimeout(deadline)
        const disposition = options.harnessResume && !accepted ? 'harness-admission-unconfirmed' : undefined
        // Observer failures cannot suppress terminal delivery or stream cleanup.
        try { if (error && !cancelled) callbacks.onError(error, disposition) } catch { /* UI observer */ }
        try { callbacks.onDone(disposition) } catch { /* UI observer */ }
      }
      const emit = (event: string, raw: string) => {
        if (finished) return
        if (new TextEncoder().encode(raw).byteLength > MAX_SSE_EVENT_BYTES) throw new Error('AI stream event too large')
        const value = raw.length ? JSON.parse(raw) as unknown : {}
        const data = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
        if (event === 'delta' && typeof data.text === 'string') callbacks.onDelta(data.text)
        else if(event==='progress' && (data.kind==='status'||data.kind==='output') && typeof data.text==='string') options.onProgress?.({kind:data.kind,text:data.text})
        else if (event === 'reasoning' && typeof data.text === 'string') callbacks.onReasoning?.(data.text)
        else if (event === 'tool_call') {
          if (typeof data.id !== 'string' || typeof data.name !== 'string' || !data.input || typeof data.input !== 'object' || Array.isArray(data.input)) throw new Error('Invalid complete tool call')
          callbacks.onToolCall({ id: data.id, name: data.name, input: data.input, ...(typeof data.signature==='string'?{signature:data.signature}:{}) } as AgentToolCall)
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
        else if (event === 'error') {
          if(data.outcome==='failed')try{options.onConfirmedFailure?.()}catch{/* UI observer */}
          const reason=MODEL_CONNECTION_FAILURES.find(code=>code===data.reason)
          const localized = isChinese()
            ? data.reason === AI_TURN_TIMED_OUT ? modelTimeoutZh : reason && providerFailureZh[reason]
            : undefined
          finish(localized ?? (typeof data.message === 'string' && data.message.trim() ? data.message : 'AI stream failed'))
        }
        else if (event === 'done') finish()
      }
      deadline = setTimeout(() => {
        if (finished) return
        controller.abort()
        void reader?.cancel().catch(() => {})
        requestCancellation()
        finish(endpoint === OFFICE_TURNS_ENDPOINT && isChinese() ? modelTimeoutZh : 'AI stream timed out')
      }, timeoutMs)
      void (async () => {
        try {
          if (options.getCsrfToken) {
            csrfProof = await options.getCsrfToken()
            if (typeof csrfProof !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(csrfProof)) throw new Error('Invalid CSRF proof')
          }
          const init = {
            method: 'POST',
            credentials: 'same-origin', mode: 'same-origin', referrerPolicy: 'same-origin', redirect: 'error',
            headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json', ...(csrfProof ? { 'x-csrf-token': csrfProof } : {}) },
            body: serializeTurnRequest(turnId, options.modelId, request, options.format, options.documentId,options.continuation,options.harnessResume),
            signal: controller.signal,
          } satisfies RequestInit
          let response: Response
          for (let attempt = 0; ; attempt++) {
            if (finished || controller.signal.aborted) return
            dispatched = true
            response = await fetchImpl(endpoint, init)
            // A pre-stream rejection can be retried. Never replay a Harness
            // admission or an accepted SSE stream.
            if (endpoint !== OFFICE_TURNS_ENDPOINT || options.harnessResume || response.status !== 429) break
            dispatched = false
            void response.body?.cancel().catch(() => {})
            const fallback = RATE_LIMIT_RETRY_DELAYS_MS[attempt]
            if (finished || fallback === undefined) break
            const delayMs = rateLimitDelay(response.headers.get('Retry-After'), fallback)
            if (delayMs > MAX_RATE_LIMIT_WAIT_MS || delayMs >= expiresAt - performance.now()) break
            await waitForRetry(delayMs, controller.signal)
          }
          if (!response.ok) throw new Error('AI stream HTTP ' + response.status)
          if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') || !response.body) throw new Error('AI stream response is not SSE')
          accepted = true
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
      function stop(remote:boolean) {
          if (finished) return
          cancelled = true
          controller.abort()
          finish()
          // Aborting the response alone does not guarantee the server stopped the model.
          void reader?.cancel().catch(() => {})
          if(remote)requestCancellation()
      }
      return {cancel:()=>stop(true),detach:()=>stop(false)}
    },
  }
}
