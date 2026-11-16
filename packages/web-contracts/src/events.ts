import { HostError } from './errors.ts'

export const MAX_HOST_EVENT_BYTES = 256 * 1024
export const HOST_PROTOCOL_VERSION = 1
export type HostEventType = 'editor.register' | 'editor.ready' | 'command.request' | 'command.ack' | 'command.result' | 'sync.required'
export interface HostEvent {
  protocolVersion: number
  messageId: string
  sessionId: string
  fileId: string
  type: HostEventType
  payload: Record<string, unknown>
}

export function decodeHostEvent(raw: string): HostEvent {
  if (new TextEncoder().encode(raw).byteLength > MAX_HOST_EVENT_BYTES) throw new HostError('PAYLOAD_TOO_LARGE', 'Host event exceeds byte limit')
  let data: unknown
  try { data = JSON.parse(raw) } catch { throw new HostError('INVALID_RESPONSE', 'Invalid host event JSON') }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HostError('INVALID_RESPONSE', 'Invalid host event envelope')
  const v = data as Record<string, unknown>
  if (v.protocolVersion !== HOST_PROTOCOL_VERSION || typeof v.type !== 'string' || !['editor.register', 'editor.ready', 'command.request', 'command.ack', 'command.result', 'sync.required'].includes(v.type) ||
      !['messageId','sessionId','fileId'].every(k => typeof v[k] === 'string' && (v[k] as string).length > 0) ||
      !v.payload || typeof v.payload !== 'object' || Array.isArray(v.payload)) {
    throw new HostError('INVALID_RESPONSE', 'Host event has missing or invalid fields')
  }
  // Only the documented transport envelope crosses this boundary. Payload
  // semantics/redaction belong to the per-event producer/consumer (T17).
  return {
    protocolVersion: HOST_PROTOCOL_VERSION,
    messageId: v.messageId as string,
    sessionId: v.sessionId as string,
    fileId: v.fileId as string,
    type: v.type as HostEventType,
    payload: v.payload as Record<string, unknown>,
  }
}
