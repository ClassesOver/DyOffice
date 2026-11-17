import { randomUUID } from 'node:crypto'
import type { RealtimeRegistration, RealtimeServerMessage } from '../../../../../../packages/web-contracts/src/realtime.ts'
import type { WebSocket } from 'ws'
import type { RealtimeIdentity, RealtimeSnapshot } from './state.ts'

export const REALTIME_MAX_CONNECTIONS = 64
export const REALTIME_MAX_OWNER_CONNECTIONS = 8
export const REALTIME_MAX_PENDING_MESSAGES = 64
export const REALTIME_MAX_PENDING_BYTES = 128 * 1024
export const REALTIME_MAX_INBOUND_MESSAGES = 16
export const REALTIME_MAX_INBOUND_BYTES = 128 * 1024
export const REALTIME_HEARTBEAT_INTERVAL_MS = 30_000
export const REALTIME_MISSED_PONG_LIMIT = 2
export interface RealtimeConnection extends RealtimeIdentity {
  readonly connectionId: string
  /** Private connection epoch, never a client-supplied command capability. */
  readonly epoch: string
  readonly socket: WebSocket
  generation: number
  snapshot?: RealtimeSnapshot
  registration?: RealtimeRegistration
  pendingDelivery?: { deliveryId: string; commandId: string; claimId: string; settle: (delivered: boolean) => void }
  /** Serializes server dispatch requests without blocking inbound ack handling. */
  dispatching?: boolean
  pendingMessages: number
  pendingBytes: number
  inboundMessages: number
  inboundBytes: number
  missedPongs: number
  closed: boolean
  pollPending: boolean
  chain: Promise<unknown>
}
export type ConnectionReservation = { release(): void }
export type RealtimeRegistry = ReturnType<typeof createRealtimeRegistry>
export function createRealtimeRegistry(options: { heartbeatIntervalMs?: number } = {}) {
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? REALTIME_HEARTBEAT_INTERVAL_MS
  if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1) throw new Error('Invalid realtime heartbeat configuration')
  const connections = new Set<RealtimeConnection>()
  const work = new Set<Promise<unknown>>()
  const track = <T>(promise: Promise<T>): Promise<T> => {
    work.add(promise)
    void promise.finally(() => work.delete(promise)).catch(() => {})
    return promise
  }
  const ownerCounts = new Map<string, number>()
  let reserved = 0, closed = false
  const heartbeat = setInterval(() => {
    for (const connection of connections) {
      if (connection.missedPongs >= REALTIME_MISSED_PONG_LIMIT) { connection.socket.terminate(); continue }
      connection.missedPongs++
      try { connection.socket.ping() } catch { connection.socket.terminate() }
    }
  }, heartbeatIntervalMs)
  heartbeat.unref()
  const registry = {
    all: () => [...connections],
    find: (connectionId: string) => [...connections].find(connection => connection.connectionId === connectionId),
    track,
    get size() { return connections.size },
    get reserved() { return reserved },
    reserve(identity: Pick<RealtimeIdentity, 'deploymentId' | 'userId'>): ConnectionReservation | undefined {
      const key = identity.deploymentId + ':' + identity.userId, count = ownerCounts.get(key) ?? 0
      if (closed || reserved >= REALTIME_MAX_CONNECTIONS || count >= REALTIME_MAX_OWNER_CONNECTIONS) return undefined
      reserved++; ownerCounts.set(key, count + 1)
      let released = false
      return { release() {
        if (released) return
        released = true; reserved--
        const current = ownerCounts.get(key) ?? 0
        if (current <= 1) ownerCounts.delete(key); else ownerCounts.set(key, current - 1)
      } }
    },
    registerEditor(identity: RealtimeIdentity, socket: WebSocket, reservation: ConnectionReservation): RealtimeConnection {
      const connection: RealtimeConnection = { ...identity, socket, connectionId: randomUUID(), epoch: randomUUID(), generation: 0,
        pendingMessages: 0, pendingBytes: 0, inboundMessages: 0, inboundBytes: 0, missedPongs: 0, closed: false, pollPending: false, chain: Promise.resolve() }
      connections.add(connection)
      socket.on('pong', () => { connection.missedPongs = 0 })
      socket.on('error', () => { socket.terminate() })
      socket.once('close', () => { connection.closed = true; connection.pendingDelivery?.settle(false); connections.delete(connection); reservation.release() })
      return connection
    },
    /** Invoke only synchronously inside withSnapshot's authorized effect. */
    send(connection: RealtimeConnection, message: RealtimeServerMessage): boolean {
      if (closed || connection.closed || connection.socket.readyState !== 1) return false
      const text = JSON.stringify(message), size = Buffer.byteLength(text)
      if (connection.pendingMessages + 1 > REALTIME_MAX_PENDING_MESSAGES ||
        connection.pendingBytes + size > REALTIME_MAX_PENDING_BYTES ||
        connection.socket.bufferedAmount + size > REALTIME_MAX_PENDING_BYTES) { connection.socket.terminate(); return false }
      connection.pendingMessages++; connection.pendingBytes += size
      try {
        connection.socket.send(text, error => {
          connection.pendingMessages--; connection.pendingBytes -= size
          if (error) connection.socket.terminate()
        })
        return true
      } catch { connection.pendingMessages--; connection.pendingBytes -= size; connection.socket.terminate(); return false }
    },
    sendSnapshot(connection: RealtimeConnection, snapshot: RealtimeSnapshot, type: 'state' | 'file-event'): boolean {
      if (!Number.isSafeInteger(connection.generation + 1)) { connection.socket.terminate(); return false }
      const event = { ...snapshot, generation: connection.generation + 1 }
      const sent = registry.send(connection, type === 'state' ? { type, ...event } : { type, fileEvent: event })
      if (sent) { connection.generation = event.generation; connection.snapshot = snapshot }
      return sent
    },
    expectDelivery(connection: RealtimeConnection, delivery: { deliveryId: string; commandId: string; claimId: string }, timeoutMs: number): Promise<boolean> {
      if (connection.pendingDelivery || closed || connection.closed || connection.socket.readyState !== 1) return Promise.resolve(false)
      return new Promise(resolve => {
        const timer = setTimeout(() => settle(false), timeoutMs); timer.unref()
        const settle = (delivered: boolean) => {
          clearTimeout(timer)
          if (connection.pendingDelivery?.deliveryId === delivery.deliveryId) connection.pendingDelivery = undefined
          resolve(delivered)
        }
        connection.pendingDelivery = { ...delivery, settle }
      })
    },
    /** Admission happens at receipt, not when an unbounded promise chain runs. */
    enqueue(connection: RealtimeConnection, bytes: number, operation: () => Promise<unknown>): boolean {
      if (closed || connection.closed || connection.socket.readyState !== 1) return false
      if (connection.inboundMessages + 1 > REALTIME_MAX_INBOUND_MESSAGES || connection.inboundBytes + bytes > REALTIME_MAX_INBOUND_BYTES) {
        connection.socket.terminate(); return false
      }
      connection.inboundMessages++; connection.inboundBytes += bytes
      connection.chain = track(connection.chain.then(async () => {
        if (!closed && !connection.closed && connection.socket.readyState === 1) await operation()
      }).catch(() => { connection.socket.terminate() }).finally(() => { connection.inboundMessages--; connection.inboundBytes -= bytes }))
      return true
    },
    close() {
      if (closed) return
      closed = true; clearInterval(heartbeat)
      for (const connection of connections) { connection.closed = true; connection.pendingDelivery?.settle(false); connection.socket.terminate() }
    },
    async drain() { await Promise.allSettled([...work]) },
  }
  return registry
}
