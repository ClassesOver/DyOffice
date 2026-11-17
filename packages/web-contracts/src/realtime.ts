import type { CommandEnvelope } from './tools.ts'
// T17 notification/recovery and trusted durable command delivery. Saves and
// applied/committed receipts remain HTTP. Reconnect never replays a writer.
export const REALTIME_PATH = '/realtime'
export const REALTIME_MAX_MESSAGE_BYTES = 16 * 1024
export const REALTIME_MAX_EVENT_BYTES = REALTIME_MAX_MESSAGE_BYTES
export const REALTIME_MAX_RECONCILE_COMMANDS = 16
export const REALTIME_TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/
export const REALTIME_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Session attribution alone is NOT editor authority. The precise holder is
 * active && heldByCurrentSession && editorId === the connection's bound editorId.
 * A null connection editorId is always read-only. */
export type RealtimeLeaseState = Readonly<{
  leaseEpoch: number
  editorId: string | null
  expiresAt: string | null
  active: boolean
  heldByCurrentSession: boolean
}>

/** A database snapshot, read with the lease in one authorized transaction.
 * UUID heads are identities, never numerically or lexically ordered.
 * generation starts at 1 for the initial state and increases for each subsequent
 * state/file-event on THIS connection. Reset the cursor on every reconnect. */
export type RealtimeFileEvent = Readonly<{
  headRevision: string
  generation: number
  lease: RealtimeLeaseState
}>
export type RealtimeCommandState =
  | 'pending_approval'
  | 'approved'
  | 'unknown_outcome'
  | 'applied_uncommitted'
  | 'committed'
  | 'cancelled'
  | 'abandoned_uncommitted'
export type RealtimeCommandStatus = Readonly<{
  commandId: string
  /** null means no record in this owner + session + file scope. */
  state: RealtimeCommandState | null
}>

export type RealtimeRegistration = Readonly<{
  requestId: string
  baseRevision: string
  /** Document/editor generation, independent of notification generation. */
  editorGeneration: number
  leaseEpoch: number
  capabilities: readonly string[]
}>
export type RealtimeRegistered = RealtimeRegistration & Readonly<{ type: 'registered'; connectionId: string; epoch: string }>
export type RealtimeCommandDelivery = Readonly<{
  type: 'command'
  connectionId: string
  epoch: string
  editorId: string
  deliveryId: string
  claimId: string
  digest: string
  envelope: CommandEnvelope
}>
export type RealtimeDeliveryAck = Readonly<{
  type: 'ack'
  connectionId: string
  epoch: string
  deliveryId: string
  commandId: string
  claimId: string
  /** Transport acceptance only. Never an applied/committed receipt. */
  status: 'delivered'
}>
export type RealtimeClientMessage =
  | Readonly<{ type: 'ping' }>
  | Readonly<{ type: 'sync' }>
  | Readonly<{ type: 'reconcile'; requestId: string; commandIds: readonly string[] }>
  | (Readonly<{ type: 'register' }> & RealtimeRegistration)
  | RealtimeDeliveryAck
export type RealtimeErrorCode = 'unauthorized' | 'permission-denied' | 'invalid-message'
export type RealtimeServerMessage =
  | (Readonly<{ type: 'state' }> & RealtimeFileEvent)
  | Readonly<{ type: 'file-event'; fileEvent: RealtimeFileEvent }>
  | Readonly<{ type: 'pong' }>
  | Readonly<{ type: 'assistant-channels'; channels: readonly {conversationId:string;sequence:number}[] }>
  | RealtimeRegistered
  | RealtimeCommandDelivery
  | Readonly<{ type: 'command-state'; requestId: string; commands: readonly RealtimeCommandStatus[] }>
  | Readonly<{ type: 'error'; code: RealtimeErrorCode }>

const byteLength = (value: string) => new TextEncoder().encode(value).byteLength
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const hasKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const uuid = (value: unknown): value is string => typeof value === 'string' && REALTIME_UUID_PATTERN.test(value)
const safeInt = (value: unknown, minimum: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
const commandStates: readonly string[] = ['pending_approval', 'approved', 'unknown_outcome', 'applied_uncommitted', 'committed', 'cancelled', 'abandoned_uncommitted']
function parse(raw: string): Record<string, unknown> | undefined {
  if (byteLength(raw) > REALTIME_MAX_MESSAGE_BYTES) return undefined
  try { const value: unknown = JSON.parse(raw); return isObject(value) ? value : undefined } catch { return undefined }
}
function decodeLease(value: unknown): RealtimeLeaseState | undefined {
  if (!isObject(value) || !hasKeys(value, ['leaseEpoch', 'editorId', 'expiresAt', 'active', 'heldByCurrentSession']) ||
    !safeInt(value.leaseEpoch, 0) || !(value.editorId === null || uuid(value.editorId)) ||
    !(value.expiresAt === null || (typeof value.expiresAt === 'string' && Number.isFinite(Date.parse(value.expiresAt)))) ||
    typeof value.active !== 'boolean' || typeof value.heldByCurrentSession !== 'boolean') return undefined
  return { leaseEpoch: value.leaseEpoch, editorId: value.editorId, expiresAt: value.expiresAt, active: value.active, heldByCurrentSession: value.heldByCurrentSession }
}
function decodeSnapshot(value: unknown, state = false): RealtimeFileEvent | undefined {
  if (!isObject(value) || !hasKeys(value, state ? ['type', 'headRevision', 'generation', 'lease'] : ['headRevision', 'generation', 'lease']) ||
    !uuid(value.headRevision) || !safeInt(value.generation, 1)) return undefined
  const lease = decodeLease(value.lease)
  return lease ? { headRevision: value.headRevision, generation: value.generation, lease } : undefined
}

const capabilities = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 16 &&
  value.every(name => typeof name === 'string' && /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(name)) && new Set(value).size === value.length
function decodeRegistration(data: Record<string, unknown>): RealtimeRegistration | undefined {
  if (!uuid(data.requestId) || !uuid(data.baseRevision) || !safeInt(data.editorGeneration, 0) || !safeInt(data.leaseEpoch, 1) || !capabilities(data.capabilities)) return undefined
  return { requestId: data.requestId, baseRevision: data.baseRevision, editorGeneration: data.editorGeneration, leaseEpoch: data.leaseEpoch, capabilities: [...data.capabilities] }
}
function decodeEnvelope(value: unknown): CommandEnvelope | undefined {
  if (!isObject(value) || !hasKeys(value, ['commandId', 'fileId', 'baseRevision', 'editorGeneration', 'leaseEpoch', 'argsHash', 'payload']) ||
    !uuid(value.commandId) || !uuid(value.fileId) || !uuid(value.baseRevision) || !safeInt(value.editorGeneration, 0) || !safeInt(value.leaseEpoch, 1) ||
    typeof value.argsHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.argsHash) || !isObject(value.payload) ||
    !hasKeys(value.payload, ['toolName', 'arguments']) || typeof value.payload.toolName !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(value.payload.toolName) || !isObject(value.payload.arguments)) return undefined
  return { commandId: value.commandId, fileId: value.fileId, baseRevision: value.baseRevision, editorGeneration: value.editorGeneration,
    leaseEpoch: value.leaseEpoch, argsHash: value.argsHash, payload: { toolName: value.payload.toolName, arguments: value.payload.arguments } }
}

/** Closed allowlist: browsers cannot announce heads, supply commands, approve or
 * claim writers. Registration is only a hint rechecked by trusted server policy. */
export function decodeRealtimeClientMessage(raw: string): RealtimeClientMessage | undefined {
  const data = parse(raw)
  if (!data) return undefined
  if (data.type === 'ping' || data.type === 'sync') return hasKeys(data, ['type']) ? { type: data.type } : undefined
  if (data.type === 'register' && hasKeys(data, ['type', 'requestId', 'baseRevision', 'editorGeneration', 'leaseEpoch', 'capabilities'])) {
    const registration = decodeRegistration(data)
    return registration ? { type: 'register', ...registration } : undefined
  }
  if (data.type === 'ack' && hasKeys(data, ['type', 'connectionId', 'epoch', 'deliveryId', 'commandId', 'claimId', 'status']) &&
    uuid(data.connectionId) && uuid(data.epoch) && uuid(data.deliveryId) && uuid(data.commandId) && uuid(data.claimId) && data.status === 'delivered') {
    return { type: 'ack', connectionId: data.connectionId, epoch: data.epoch, deliveryId: data.deliveryId, commandId: data.commandId, claimId: data.claimId, status: 'delivered' }
  }
  if (data.type === 'reconcile' && hasKeys(data, ['type', 'requestId', 'commandIds']) && uuid(data.requestId) &&
    Array.isArray(data.commandIds) && data.commandIds.length <= REALTIME_MAX_RECONCILE_COMMANDS && data.commandIds.every(uuid) &&
    new Set(data.commandIds.map(id => id.toLowerCase())).size === data.commandIds.length) {
    return { type: 'reconcile', requestId: data.requestId, commandIds: data.commandIds }
  }
  return undefined
}
export function decodeRealtimeServerMessage(raw: string): RealtimeServerMessage | undefined {
  const data = parse(raw)
  if (!data) return undefined
  if (data.type === 'pong') return hasKeys(data, ['type']) ? { type: 'pong' } : undefined
  if (data.type === 'registered' && hasKeys(data, ['type', 'requestId', 'connectionId', 'epoch', 'baseRevision', 'editorGeneration', 'leaseEpoch', 'capabilities']) && uuid(data.connectionId) && uuid(data.epoch)) {
    const registration = decodeRegistration(data)
    return registration ? { type: 'registered', ...registration, connectionId: data.connectionId, epoch: data.epoch } : undefined
  }
  if (data.type === 'command' && hasKeys(data, ['type', 'connectionId', 'epoch', 'editorId', 'deliveryId', 'claimId', 'digest', 'envelope']) &&
    uuid(data.connectionId) && uuid(data.epoch) && uuid(data.editorId) && uuid(data.deliveryId) && uuid(data.claimId) &&
    typeof data.digest === 'string' && /^[a-f0-9]{64}$/.test(data.digest)) {
    const envelope = decodeEnvelope(data.envelope)
    return envelope ? { type: 'command', connectionId: data.connectionId, epoch: data.epoch, editorId: data.editorId, deliveryId: data.deliveryId,
      claimId: data.claimId, digest: data.digest, envelope } : undefined
  }
  if(data.type==='assistant-channels'&&hasKeys(data,['type','channels'])&&Array.isArray(data.channels)&&data.channels.length<=32) {
    const channels:{conversationId:string;sequence:number}[]=[]
    for(const item of data.channels){if(!isObject(item)||!hasKeys(item,['conversationId','sequence'])||!uuid(item.conversationId)||!safeInt(item.sequence,0))return undefined;channels.push({conversationId:item.conversationId,sequence:item.sequence})}
    return {type:'assistant-channels',channels}
  }
  if (data.type === 'state') {
    const state = decodeSnapshot(data, true)
    return state ? { type: 'state', ...state } : undefined
  }
  if (data.type === 'file-event' && hasKeys(data, ['type', 'fileEvent'])) {
    const fileEvent = decodeSnapshot(data.fileEvent)
    return fileEvent ? { type: 'file-event', fileEvent } : undefined
  }
  if (data.type === 'command-state' && hasKeys(data, ['type', 'requestId', 'commands']) && uuid(data.requestId) &&
    Array.isArray(data.commands) && data.commands.length <= REALTIME_MAX_RECONCILE_COMMANDS) {
    const commands: RealtimeCommandStatus[] = []
    for (const value of data.commands) {
      if (!isObject(value) || !hasKeys(value, ['commandId', 'state']) || !uuid(value.commandId) ||
        !(value.state === null || (typeof value.state === 'string' && commandStates.includes(value.state)))) return undefined
      commands.push({ commandId: value.commandId, state: value.state as RealtimeCommandState | null })
    }
    if (new Set(commands.map(command => command.commandId.toLowerCase())).size !== commands.length) return undefined
    return { type: 'command-state', requestId: data.requestId, commands }
  }
  if (data.type === 'error' && hasKeys(data, ['type', 'code']) &&
    (data.code === 'unauthorized' || data.code === 'permission-denied' || data.code === 'invalid-message')) return { type: 'error', code: data.code }
  return undefined
}
