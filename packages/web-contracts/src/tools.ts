export type ToolEffect = 'read' | 'document_write' | 'external_write'
export type ToolExecutionMode = 'live_editor' | 'headless'
export interface ToolDescriptor {
  name: string
  schemaVersion: number
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  effect: ToolEffect
  executionMode: ToolExecutionMode
  requiresActiveEditor: boolean
  requiredScopes: readonly string[]
  maxDurationMs: number
}
export interface ToolCall { commandId: string; toolName: string; fileId?: string; baseRevision?: string; arguments: Record<string, unknown> }
export type ToolOutcome =
  | { status: 'rejected' | 'conflict' | 'unknown_outcome'; reason: string }
  | { status: 'applied_uncommitted'; commandId: string }
  | { status: 'committed'; revision: import('./api.ts').RevisionRef }

/** Approval/execution identity; server still authenticates and checks authority. */
export interface CommandEnvelope {
  readonly commandId: string
  readonly fileId: string
  readonly baseRevision: string
  readonly editorGeneration: number
  readonly leaseEpoch: number
  readonly argsHash: string
  readonly payload: Record<string, unknown>
}

/** Validates metadata only: it does not compute the hash or authorize a command. */
export function isCommandEnvelope(value: unknown): value is CommandEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return ['commandId', 'fileId', 'baseRevision'].every(k => typeof v[k] === 'string' && v[k].length > 0) &&
    typeof v.editorGeneration === 'number' && Number.isSafeInteger(v.editorGeneration) && v.editorGeneration >= 0 &&
    typeof v.leaseEpoch === 'number' && Number.isSafeInteger(v.leaseEpoch) && v.leaseEpoch >= 0 &&
    typeof v.argsHash === 'string' && /^[a-f0-9]{64}$/i.test(v.argsHash) &&
    !!v.payload && typeof v.payload === 'object' && !Array.isArray(v.payload)
}
