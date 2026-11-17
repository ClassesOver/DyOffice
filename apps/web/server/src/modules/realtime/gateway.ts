import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { FastifyRequest } from 'fastify'
import { WebSocketServer, type WebSocket } from 'ws'
import { cookies, type createCsrfService } from '../auth/csrf.ts'
import type { SessionService } from '../auth/sessions.ts'
import type { TicketService } from './tickets.ts'
import { REALTIME_MAX_MESSAGE_BYTES, REALTIME_PATH, decodeRealtimeClientMessage } from '../../../../../../packages/web-contracts/src/realtime.ts'
import type { ConnectionReservation, RealtimeRegistry } from './sessions.ts'
import type { RealtimeIdentity } from './state.ts'
import type { RealtimeDispatcher } from './dispatch.ts'

export const REALTIME_MAX_PENDING_UPGRADES = 8
export const REALTIME_UPGRADE_TIMEOUT_MS = 5000
export const REALTIME_POLL_INTERVAL_MS = 2000
export interface RealtimeOptions { pollIntervalMs?: number; heartbeatIntervalMs?: number; ticketTtlMs?: number; ackTimeoutMs?: number }
type GatewayDeps = {
  server: import('node:http').Server; origin: string; sessions: SessionService
  csrf: ReturnType<typeof createCsrfService>; tickets: TicketService; registry: RealtimeRegistry; dispatcher: RealtimeDispatcher
  pollIntervalMs?: number
}
const rejectUpgrade = (socket: Duplex, status: number) => {
  if (socket.destroyed) return
  if (!socket.writable) { socket.destroy(); return }
  const reason = ({ 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests', 503: 'Service Unavailable' } as Record<number, string>)[status] ?? 'Unauthorized'
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy())
}
export function createRealtimeGateway({ server, origin, sessions, csrf, tickets, registry, dispatcher, pollIntervalMs = REALTIME_POLL_INTERVAL_MS }: GatewayDeps) {
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 60_000) throw new Error('Invalid realtime poll interval')
  const wss = new WebSocketServer({ noServer: true, maxPayload: REALTIME_MAX_MESSAGE_BYTES })
  const pending = new Set<Duplex>()
  const upgrades = new Set<Promise<void>>()
  let closed = false
  function onConnection(socket: WebSocket, identity: RealtimeIdentity, reservation: ConnectionReservation) {
    const connection = registry.registerEditor(identity, socket, reservation)
    // Seed before any received messages/poll: state is always the first frame.
    connection.chain = registry.track(dispatcher.initialize(connection).catch(() => { socket.terminate() }))
    socket.on('message', (data, isBinary) => {
      const buffer = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
      registry.enqueue(connection, buffer.byteLength, () => dispatcher.receive(connection, isBinary ? undefined : decodeRealtimeClientMessage(buffer.toString('utf8'))))
    })
  }
  async function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    let reservation: ConnectionReservation | undefined
    let transferred = false
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // Malformed raw URLs belong inside the rejection path, not outside try.
      const url = new URL(request.url ?? '/', origin)
      if (url.pathname !== REALTIME_PATH) return rejectUpgrade(socket, 404)
      if (closed || pending.size >= REALTIME_MAX_PENDING_UPGRADES) return rejectUpgrade(socket, 503)
      if (url.searchParams.getAll('ticket').length !== 1 || [...url.searchParams.keys()].some(key => key !== 'ticket')) return rejectUpgrade(socket, 400)
      pending.add(socket)
      timer = setTimeout(() => { socket.destroy() }, REALTIME_UPGRADE_TIMEOUT_MS); timer.unref()
      socket.on('error', () => { socket.destroy() })
      const asRequest = { raw: request, headers: request.headers } as unknown as FastifyRequest
      csrf.originCheck(asRequest, true)
      const token = cookies(asRequest).session ?? ''
      const principal = await sessions.authenticate(token)
      if (closed || socket.destroyed) return
      reservation = registry.reserve(principal)
      if (!reservation) return rejectUpgrade(socket, 429)
      const consumed = await tickets.consume(token, principal, url.searchParams.get('ticket') ?? '')
      if (!consumed) return rejectUpgrade(socket, 401)
      if (closed || socket.destroyed) return
      wss.handleUpgrade(request, socket, head, ws => {
        transferred = true
        onConnection(ws, { ...consumed, token }, reservation!)
      })
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode
      rejectUpgrade(socket, status === 403 || status === 404 ? status : error instanceof TypeError ? 400 : 401)
    } finally {
      if (timer) clearTimeout(timer)
      pending.delete(socket)
      if (!transferred) reservation?.release()
    }
  }
  function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const task = upgrade(request, socket, head)
    upgrades.add(task)
    void task.finally(() => upgrades.delete(task)).catch(() => { socket.destroy() })
  }
  // One bounded poll per active connection, serialized with its inbound frames.
  // Each recipient independently authenticates; no unauthorized file broadcast.
  const poll = setInterval(() => {
    for (const connection of registry.all()) {
      if (connection.pollPending || connection.closed) continue
      connection.pollPending = true
      const queued = registry.enqueue(connection, 0, async () => {
        try { await dispatcher.poll(connection) } finally { connection.pollPending = false }
      })
      if (!queued) connection.pollPending = false
    }
  }, pollIntervalMs)
  poll.unref()
  server.on('upgrade', handleUpgrade)
  return {
    handleUpgrade,
    /** Must run in Fastify preClose, BEFORE HTTP close waits on upgraded sockets. */
    close() {
      if (closed) return
      closed = true; clearInterval(poll); server.removeListener('upgrade', handleUpgrade)
      for (const socket of pending) socket.destroy()
      registry.close(); wss.close()
    },
    async drain() { await Promise.allSettled([...upgrades]); await registry.drain() },
  }
}
export type RealtimeGateway = ReturnType<typeof createRealtimeGateway>
