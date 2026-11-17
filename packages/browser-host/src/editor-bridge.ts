import {
  REALTIME_PATH,
  REALTIME_TICKET_PATTERN,
  decodeRealtimeServerMessage,
  type RealtimeServerMessage,
  type RealtimeRegistration,
  type RealtimeRegistered,
  type RealtimeCommandDelivery,
} from '../../web-contracts/src/realtime.ts'

export type { RealtimeServerMessage, RealtimeLeaseState, RealtimeFileEvent, RealtimeErrorCode } from '../../web-contracts/src/realtime.ts'
export type EditorBridgeStatus = 'connecting' | 'open' | 'backoff' | 'unauthorized' | 'unavailable' | 'disposed'

type Socket = Pick<WebSocket, 'readyState' | 'bufferedAmount' | 'send' | 'close' | 'onopen' | 'onmessage' | 'onerror' | 'onclose'>
type SocketConstructor = new (url: string) => Socket
type ReconciledCommands = Extract<RealtimeServerMessage, { type: 'command-state' }>
export interface EditorBridgeOptions {
  fetchImpl?: typeof fetch
  origin: string
  fileId: string
  editorId?: string | null
  WebSocketImpl?: SocketConstructor
  onEvent: (event: RealtimeServerMessage) => void
  onStatus?: (status: EditorBridgeStatus) => void
  pendingCommandIds?: () => readonly string[] | Promise<readonly string[]>
  onReconcile?: (event: ReconciledCommands) => void
  commandTarget?: {
    registration: () => Omit<RealtimeRegistration, 'requestId'> | null
    /** A trusted executor must fence document state again before applying.
     * true acknowledges transport acceptance only, never applied or saved. */
    onCommand: (command: RealtimeCommandDelivery, signal: AbortSignal) => boolean | Promise<boolean>
  }
  heartbeatMs?: number
  initialBackoffMs?: number
  maxBackoffMs?: number
  connectTimeoutMs?: number
  random?: () => number
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
class ConnectionError extends Error {
  constructor(readonlyStatus: 'unauthorized' | 'unavailable') { super(readonlyStatus); this.status = readonlyStatus }
  readonly status: 'unauthorized' | 'unavailable'
}

/** Transport only: notifications never adopt a head or replay a document write.
 * Each reconnect obtains a fresh ticket, then asks the existing T14 journal
 * about pending IDs. The caller owns recovery and any explicit head refresh. */
export function createEditorBridge({ fetchImpl = fetch, origin, fileId, editorId = null,
  WebSocketImpl = WebSocket, onEvent, onStatus, pendingCommandIds, onReconcile, commandTarget,
  heartbeatMs = 30_000, initialBackoffMs = 1000, maxBackoffMs = 30_000,
  connectTimeoutMs = 10_000, random = Math.random }: EditorBridgeOptions) {
  const base = new URL(origin)
  if (!['https:', 'http:'].includes(base.protocol) || base.origin !== origin || base.username || base.password || !UUID.test(fileId) || (editorId !== null && !UUID.test(editorId))) throw new Error('Invalid bridge identity')
  if ([heartbeatMs, initialBackoffMs, maxBackoffMs, connectTimeoutMs].some(value => !Number.isSafeInteger(value) || value < 1) || maxBackoffMs < initialBackoffMs) throw new Error('Invalid bridge timing configuration')
  let status: EditorBridgeStatus = 'connecting', headRevision: string | null = null
  let socket: Socket | undefined, controller: AbortController | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined, handshakeTimer: ReturnType<typeof setTimeout> | undefined
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  let epoch = 0, generation = -1, failures = 0, lastPongAt = 0, disposed = false, initialized = false
  let reconciliation: { requestId: string; commandIds: Set<string> } | undefined
  let registration: RealtimeRegistered | undefined, proposed: RealtimeRegistration | undefined
  let commandAbort = new AbortController(), commandPending = false
  const delivered = new Set<string>()

  function setStatus(next: EditorBridgeStatus) {
    status = next
    try { onStatus?.(next) } catch { /* A view callback cannot control transport state. */ }
  }
  function stopSocket() {
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer)
    if (handshakeTimer !== undefined) clearTimeout(handshakeTimer)
    heartbeatTimer = undefined; handshakeTimer = undefined; reconciliation = undefined
    registration = undefined; proposed = undefined
    commandAbort.abort(); commandAbort = new AbortController(); commandPending = false; delivered.clear()
    const old = socket; socket = undefined
    if (old) {
      old.onopen = old.onmessage = old.onclose = old.onerror = null
      try { old.close() } catch { /* Already disconnected. */ }
    }
  }
  function reconnect() {
    if (disposed || status === 'unauthorized' || status === 'unavailable' || reconnectTimer !== undefined) return
    setStatus('backoff')
    const cap = Math.min(initialBackoffMs * 2 ** Math.min(failures++, 16), maxBackoffMs)
    const jitter = Math.max(0, Math.min(1, random()))
    reconnectTimer = setTimeout(() => { reconnectTimer = undefined; void connect() }, Math.max(1, Math.round(cap * (0.75 + jitter * 0.25))))
  }
  function halt(next: 'unauthorized' | 'unavailable') {
    epoch++; controller?.abort(); stopSocket()
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer)
    reconnectTimer = undefined
    setStatus(next)
  }
  function checkResponse(response: Response) {
    if (response.status === 401 || response.status === 403) throw new ConnectionError('unauthorized')
    if ([404, 501].includes(response.status)) throw new ConnectionError('unavailable')
    if (!response.ok) throw new Error('Connection unavailable')
  }
  async function requestTicket(signal: AbortSignal) {
    const csrfReply = await fetchImpl(origin + '/api/v1/auth/csrf', { credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', signal })
    checkResponse(csrfReply)
    const csrf = await csrfReply.json() as { csrfToken?: string }
    if (typeof csrf.csrfToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(csrf.csrfToken)) throw new Error('Invalid CSRF response')
    const reply = await fetchImpl(origin + '/api/v1/realtime/ticket', {
      method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', signal,
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf.csrfToken }, body: JSON.stringify({ fileId, editorId }),
    })
    checkResponse(reply)
    const issued = await reply.json() as { ticket?: string }
    if (typeof issued.ticket !== 'string' || !REALTIME_TICKET_PATTERN.test(issued.ticket)) throw new Error('Invalid ticket response')
    return issued.ticket
  }
  function send(ws: Socket, value: object) {
    if (socket !== ws || ws.readyState !== 1 || ws.bufferedAmount > 64 * 1024) return false
    try { ws.send(JSON.stringify(value)); return true } catch { return false }
  }
  async function reconcile(ws: Socket, attempt: number) {
    if (!pendingCommandIds) return
    try {
      const ids = await pendingCommandIds()
      if (epoch !== attempt || socket !== ws || disposed || ids.length > 16 || ids.some(id => !UUID.test(id))) return
      const commandIds = [...new Set(ids)]
      if (!commandIds.length) return
      const requestId = crypto.randomUUID()
      reconciliation = { requestId, commandIds: new Set(commandIds) }
      send(ws, { type: 'reconcile', requestId, commandIds })
    } catch { /* Recovery is retried after the next connection; writes are never replayed. */ }
  }
  function register(ws: Socket) {
    registration = undefined; proposed = undefined
    if (!commandTarget || !editorId || !initialized) return
    try {
      const next = commandTarget.registration()
      if (!next || next.baseRevision !== headRevision || !UUID.test(next.baseRevision) || !Number.isSafeInteger(next.editorGeneration) || next.editorGeneration < 0 ||
        !Number.isSafeInteger(next.leaseEpoch) || next.leaseEpoch < 1 || next.capabilities.length > 16 || new Set(next.capabilities).size !== next.capabilities.length ||
        next.capabilities.some(name => !/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(name))) return
      proposed = { ...next, capabilities: [...next.capabilities], requestId: crypto.randomUUID() }
      send(ws, { type: 'register', ...proposed })
    } catch { /* Registration never grants authority locally. */ }
  }
  async function receiveCommand(ws: Socket, attempt: number, message: RealtimeCommandDelivery) {
    const registered = registration, signal = commandAbort.signal
    if (delivered.size >= 64) { if (socket === ws) { epoch++; stopSocket(); reconnect() }; return }
    if (!commandTarget || !registered || commandPending || delivered.has(message.envelope.commandId) ||
      message.connectionId !== registered.connectionId || message.epoch !== registered.epoch || message.editorId !== editorId ||
      message.envelope.fileId !== fileId || message.envelope.baseRevision !== headRevision || message.envelope.baseRevision !== registered.baseRevision ||
      message.envelope.editorGeneration !== registered.editorGeneration || message.envelope.leaseEpoch !== registered.leaseEpoch ||
      typeof message.envelope.payload.toolName !== 'string' || !registered.capabilities.includes(message.envelope.payload.toolName)) return
    let current: ReturnType<typeof commandTarget.registration>
    try { current = commandTarget.registration() } catch { return }
    if (!current || current.baseRevision !== registered.baseRevision || current.editorGeneration !== registered.editorGeneration || current.leaseEpoch !== registered.leaseEpoch ||
      !current.capabilities.includes(message.envelope.payload.toolName)) return
    delivered.add(message.envelope.commandId); commandPending = true
    const timeout = setTimeout(() => { if (socket === ws && attempt === epoch) { epoch++; stopSocket(); reconnect() } }, connectTimeoutMs)
    try {
      const accepted = await commandTarget.onCommand(message, signal)
      if (accepted && !signal.aborted && socket === ws && attempt === epoch && !disposed) send(ws, {
        type: 'ack', connectionId: registered.connectionId, epoch: registered.epoch, deliveryId: message.deliveryId,
        commandId: message.envelope.commandId, claimId: message.claimId, status: 'delivered',
      })
    } catch { /* Unknown outcome is resolved from the durable journal, never replayed. */ }
    finally { clearTimeout(timeout); if (socket === ws && attempt === epoch) commandPending = false }
  }
  async function connect() {
    if (disposed || status === 'unauthorized' || status === 'unavailable') return
    const attempt = ++epoch
    controller?.abort(); stopSocket(); setStatus('connecting'); initialized = false; generation = -1
    const pending = new AbortController(); controller = pending
    const timeout = setTimeout(() => pending.abort(), connectTimeoutMs)
    try {
      const ticket = await requestTicket(pending.signal)
      if (disposed || attempt !== epoch) return
      const target = new URL(REALTIME_PATH, origin)
      target.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
      target.searchParams.set('ticket', ticket)
      const ws = new WebSocketImpl(target.href); socket = ws
      const retry = () => { if (socket !== ws || disposed) return; epoch++; stopSocket(); reconnect() }
      handshakeTimer = setTimeout(retry, connectTimeoutMs)
      ws.onopen = () => {
        if (socket !== ws || disposed) return
        lastPongAt = Date.now()
        heartbeatTimer = setInterval(() => {
          if (socket !== ws || disposed) return
          if (Date.now() - lastPongAt > heartbeatMs * 2 || !send(ws, { type: 'ping' })) retry()
        }, heartbeatMs)
      }
      ws.onmessage = event => {
        if (socket !== ws || attempt !== epoch || disposed || typeof event.data !== 'string') return
        const message = decodeRealtimeServerMessage(event.data)
        if (!message) { retry(); return }
        if (message.type === 'error' && message.code === 'unauthorized') { halt('unauthorized'); return }
        if (message.type === 'pong') { lastPongAt = Date.now(); return }
        if (message.type === 'state' || message.type === 'file-event') {
          const state = message.type === 'state' ? message : message.fileEvent
          if (!initialized && message.type !== 'state') { retry(); return }
          if (state.generation <= generation) return
          generation = state.generation; headRevision = state.headRevision
          if (registration && (registration.baseRevision !== state.headRevision || registration.leaseEpoch !== state.lease.leaseEpoch ||
            !state.lease.active || !state.lease.heldByCurrentSession || state.lease.editorId !== editorId)) {
            registration = undefined; proposed = undefined; commandAbort.abort(); commandAbort = new AbortController()
          }
          if (!initialized) {
            initialized = true; failures = 0
            if (handshakeTimer !== undefined) clearTimeout(handshakeTimer)
            handshakeTimer = undefined; setStatus('open'); void reconcile(ws, attempt); register(ws)
          }
        }
        if (message.type === 'registered') {
          if (!proposed || message.requestId !== proposed.requestId || message.baseRevision !== proposed.baseRevision ||
            message.editorGeneration !== proposed.editorGeneration || message.leaseEpoch !== proposed.leaseEpoch ||
            JSON.stringify(message.capabilities) !== JSON.stringify(proposed.capabilities)) return
          registration = message; proposed = undefined
          return
        }
        if (message.type === 'command') { void receiveCommand(ws, attempt, message); return }
        if (message.type === 'command-state') {
          const active = reconciliation
          if (!active || message.requestId !== active.requestId || message.commands.some(command => !active.commandIds.has(command.commandId))) return
          reconciliation = undefined
          try { onReconcile?.(message) } catch { /* Keep receiving authoritative state. */ }
          return
        }
        try { onEvent(message) } catch { /* Keep receiving even if a view fails. */ }
      }
      ws.onclose = event => {
        if (socket !== ws || disposed) return
        if (event.code === 4401 || event.code === 4403) { halt('unauthorized'); return }
        retry()
      }
      ws.onerror = retry
    } catch (error) {
      if (disposed || attempt !== epoch) return
      if (error instanceof ConnectionError) halt(error.status)
      else reconnect()
    } finally {
      clearTimeout(timeout)
      if (controller === pending) controller = undefined
    }
  }
  void connect()
  return {
    getHeadRevision: () => headRevision,
    getStatus: () => status,
    sync() { if (socket && initialized) send(socket, { type: 'sync' }) },
    registerCurrentEditor() { if (socket) register(socket) },
    dispose() {
      if (disposed) return
      disposed = true; epoch++; controller?.abort(); stopSocket()
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer)
      reconnectTimer = undefined; setStatus('disposed')
    },
  }
}
export type EditorBridge = ReturnType<typeof createEditorBridge>
