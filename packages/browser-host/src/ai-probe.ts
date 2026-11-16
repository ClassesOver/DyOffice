import { createSseAgentTransport } from './ai-transport.ts'
import type { AgentStreamCallbacks } from '@genoffice/agent-core'

const endpoint = '/api/v1/admin/ai-probe'
const modelIdentifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/
const identifier = /^[A-Za-z0-9_-]{1,128}$/
export interface AdminAiProbeOptions {
  getCsrfToken: () => Promise<string>
  fetchImpl?: typeof fetch
  createTurnId?: () => string
  timeoutMs?: number
}
export interface AdminAiProbeStatus {
  experimental: true
  entries: Array<{ id: string; label: string }>
}
export type AdminAiProbeCallbacks = Pick<AgentStreamCallbacks, 'onDelta' | 'onError' | 'onDone'>

/** Count bytes before decoding/concatenating, including invalid UTF-8. */
async function boundedStatus(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) throw new Error('Missing probe body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let text = ''
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      if (signal.aborted) throw new Error('Probe aborted')
      const next = await reader.read()
      if (signal.aborted) throw new Error('Probe aborted')
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > 65536) throw new Error('Probe status too large')
      text += decoder.decode(next.value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    signal.removeEventListener('abort', abort)
    void reader.cancel().catch(() => {})
  }
}

/** The probe accepts only the server's small explicit event vocabulary. */
function strictProbeResponse(response: Response): Response {
  if (!response.ok || !response.body) return response
  let pending = ''
  let bytes = 0
  let terminal = false
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const encoder = new TextEncoder()
  const validate = (frame: string) => {
    const lines = frame.split('\n')
    if (lines.length !== 2 || !lines[0].startsWith('event: ') || !lines[1].startsWith('data: ')) throw new Error('Invalid probe frame')
    const event = lines[0].slice(7)
    const data: unknown = JSON.parse(lines[1].slice(6))
    if (!data || typeof data !== 'object' || Array.isArray(data) || terminal) throw new Error('Invalid probe event')
    const value = data as Record<string, unknown>
    const keys = Object.keys(value).sort().join(',')
    if (event === 'delta' || event === 'reasoning') {
      if (keys !== 'text' || typeof value.text !== 'string') throw new Error('Invalid probe delta')
    } else if (event === 'stop_reason') {
      if (keys !== 'reason' || typeof value.reason !== 'string') throw new Error('Invalid probe stop')
    } else if (event === 'usage') {
      if (Object.keys(value).some(k => !['inputTokens', 'outputTokens'].includes(k)) || Object.values(value).some(n => typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)) throw new Error('Invalid probe usage')
    } else if (event === 'error') {
      if (keys !== 'message' || typeof value.message !== 'string') throw new Error('Invalid probe error')
    } else if (event === 'done') {
      if (keys !== '') throw new Error('Invalid probe done')
      terminal = true
    } else throw new Error('Unexpected probe event')
  }
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength
      if (bytes > 1024 * 1024) throw new Error('Probe stream too large')
      pending += decoder.decode(chunk, { stream: true })
      let cut: number
      while ((cut = pending.indexOf('\n\n')) !== -1) {
        const frame = pending.slice(0, cut)
        pending = pending.slice(cut + 2)
        if (encoder.encode(frame).byteLength > 256 * 1024) throw new Error('Probe event too large')
        validate(frame)
        controller.enqueue(encoder.encode(frame + '\n\n'))
      }
      if (encoder.encode(pending).byteLength > 256 * 1024) throw new Error('Probe event too large')
    },
    flush() {
      pending += decoder.decode()
      if (pending || !terminal) throw new Error('Truncated probe stream')
    },
  })
  return new Response(response.body.pipeThrough(transform), { status: response.status, headers: response.headers })
}

/** Explicit fixed-text, network-capable probe. Real providers may charge. No document, arbitrary prompt or tool capability. */
export function createAdminAiProbeController(options: AdminAiProbeOptions) {
  if (typeof options.getCsrfToken !== 'function') throw new Error('CSRF provider required')
  const fetchImpl = options.fetchImpl ?? fetch
  const getCsrfToken = options.getCsrfToken
  const createTurnId = options.createTurnId ?? (() => crypto.randomUUID())
  const timeoutMs = options.timeoutMs ?? 30_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) throw new Error('Invalid probe timeout')
  let disposed = false
  let active: { cancel(): void } | undefined
  const statusControllers = new Set<AbortController>()
  const check = () => { if (disposed) throw new Error('Probe disposed') }
  return {
    async status(): Promise<AdminAiProbeStatus> {
      check()
      const controller = new AbortController()
      statusControllers.add(controller)
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetchImpl(endpoint + '/configuration', { method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal })
        if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('Probe status unavailable')
        const text = await boundedStatus(response, controller.signal)
        check()
        if (controller.signal.aborted || text.length > 65536) throw new Error('Invalid probe status')
        const data: unknown = JSON.parse(text)
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid probe status')
        const value = data as Record<string, unknown>
        if (Object.keys(value).sort().join(',') !== 'entries,experimental' || value.experimental !== true || !Array.isArray(value.entries) || value.entries.length > 128) throw new Error('Invalid probe status')
        const entries = value.entries.map((entry: unknown) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid probe entry')
          const item = entry as Record<string, unknown>
          if (Object.keys(item).sort().join(',') !== 'id,label' || typeof item.id !== 'string' || !modelIdentifier.test(item.id) || typeof item.label !== 'string' || item.label.length > 128 || /[\u0000-\u001f\u007f]/.test(item.label)) throw new Error('Invalid probe entry')
          return { id: item.id, label: item.label }
        })
        return { experimental: true, entries }
      } catch { throw new Error('Probe status unavailable') }
      finally { clearTimeout(timer); statusControllers.delete(controller) }
    },
    run(modelId: string, callbacks: AdminAiProbeCallbacks) {
      check()
      if (active) throw new Error('Probe already running')
      if (typeof modelId !== 'string' || !modelIdentifier.test(modelId)) throw new Error('Invalid model identifier')
      const turnId = createTurnId()
      if (typeof turnId !== 'string' || !identifier.test(turnId)) throw new Error('Invalid turn identifier')
      let ended = false
      let handle: { cancel(): void } | undefined
      const slot = { cancel: () => handle?.cancel() }
      active = slot
      const transport = createSseAgentTransport({
        endpoint: endpoint + '/turns', getCsrfToken, timeoutMs, createTurnId: () => turnId,
        fetchImpl: (input, init) => {
          if (input === endpoint + '/turns') {
            return fetchImpl(input, { ...init, body: JSON.stringify({ modelId, turnId, scenario: 'hello' }) }).then(strictProbeResponse)
          }
          return fetchImpl(input, init)
        },
      })
      handle = transport.stream({ system: '', messages: [], tools: [] }, {
        onDelta(text) { if (!ended && !disposed) callbacks.onDelta(text) },
        onToolCall() { throw new Error('Probe tool event rejected') },
        onError() { if (!ended && !disposed) callbacks.onError('Probe failed') },
        onDone() {
          if (ended) return
          ended = true
          if (active === slot) active = undefined
          callbacks.onDone()
        },
      })
      return slot
    },
    cancel() { active?.cancel() },
    dispose() {
      if (disposed) return
      disposed = true
      active?.cancel()
      for (const controller of statusControllers) controller.abort()
    },
  }
}
