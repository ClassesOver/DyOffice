import { createHash } from 'node:crypto'
import type {
  CommandEnvelope,
  ToolDescriptor,
} from '../../../../../../packages/web-contracts/src/tools.ts'

export function commandError(reason: string): Error {
  return Object.assign(new Error(reason), { statusCode: 409 })
}
/** JSON only; no getters/toJSON, silent undefined elision or lossy non-finite numbers. */
export function canonicalCommandJson(value: unknown): string {
  let nodes = 0
  function visit(v: unknown, depth: number): string {
    if (++nodes > 10000 || depth > 32)
      throw commandError('Command exceeds bounds')
    if (v === null || typeof v === 'boolean' || typeof v === 'string')
      return JSON.stringify(v)
    if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v)
    if (!v || typeof v !== 'object') throw commandError('Command must be JSON')
    if (
      !Array.isArray(v) &&
      Object.getPrototypeOf(v) !== Object.prototype &&
      Object.getPrototypeOf(v) !== null
    )
      throw commandError('Command must be plain JSON')
    if (Object.getOwnPropertySymbols(v).length)
      throw commandError('Command must be JSON')
    const descriptors = Object.getOwnPropertyDescriptors(v)
    for (const [key, d] of Object.entries(descriptors))
      if (key !== 'length' && (!('value' in d) || !d.enumerable))
        throw commandError('Command accessors are forbidden')
    if (Array.isArray(v)) {
      if (Object.keys(v).length !== v.length)
        throw commandError('Sparse or decorated arrays are forbidden')
      return (
        '[' +
        Array.from({ length: v.length }, (_, i) =>
          visit(descriptors[String(i)].value, depth + 1),
        ).join(',') +
        ']'
      )
    }
    return (
      '{' +
      Object.keys(descriptors)
        .sort()
        .map(
          (k) =>
            JSON.stringify(k) + ':' + visit(descriptors[k].value, depth + 1),
        )
        .join(',') +
      '}'
    )
  }
  const result = visit(value, 0)
  if (Buffer.byteLength(result) > 65536)
    throw commandError('Command exceeds bounds')
  return result
}
export const commandHash = (value: unknown) =>
  createHash('sha256').update(canonicalCommandJson(value)).digest('hex')
export function snapshotCommand(input: CommandEnvelope): CommandEnvelope {
  const e = JSON.parse(canonicalCommandJson(input)) as CommandEnvelope
  const keys = [
    'commandId',
    'fileId',
    'baseRevision',
    'editorGeneration',
    'leaseEpoch',
    'argsHash',
    'payload',
  ]
  if (
    Object.keys(e).length !== keys.length ||
    Object.keys(e).some((k) => !keys.includes(k)) ||
    ['commandId', 'fileId', 'baseRevision'].some(
      (k) =>
        typeof e[k as keyof CommandEnvelope] !== 'string' ||
        !(e[k as keyof CommandEnvelope] as string).length ||
        (e[k as keyof CommandEnvelope] as string).length > 128,
    ) ||
    !Number.isSafeInteger(e.editorGeneration) ||
    e.editorGeneration < 0 ||
    !Number.isSafeInteger(e.leaseEpoch) ||
    e.leaseEpoch < 1
  )
    throw commandError('Invalid command envelope')
  if (
    !e.payload ||
    Array.isArray(e.payload) ||
    Object.keys(e.payload).sort().join(',') !== 'arguments,toolName' ||
    typeof e.payload.toolName !== 'string' ||
    !e.payload.arguments ||
    Array.isArray(e.payload.arguments) ||
    typeof e.payload.arguments !== 'object'
  )
    throw commandError('Invalid command payload')
  if (e.argsHash !== commandHash(e.payload.arguments))
    throw commandError('Arguments hash mismatch')
  return e
}
export function snapshotTool(
  tool: ToolDescriptor | undefined,
  name: string,
): ToolDescriptor {
  if (!tool) throw commandError('Unregistered tool')
  const t = JSON.parse(canonicalCommandJson(tool)) as ToolDescriptor
  if (
    t.name !== name ||
    t.effect !== 'document_write' ||
    t.executionMode !== 'live_editor' ||
    t.requiresActiveEditor !== true ||
    !Number.isSafeInteger(t.schemaVersion) ||
    t.schemaVersion < 1 ||
    !Number.isSafeInteger(t.maxDurationMs) ||
    t.maxDurationMs < 1 ||
    t.maxDurationMs > 60000 ||
    !Array.isArray(t.requiredScopes) ||
    !t.requiredScopes.includes('files:write') ||
    t.requiredScopes.some((s) => typeof s !== 'string')
  )
    throw commandError('Tool is not an approved live document writer')
  return t
}
