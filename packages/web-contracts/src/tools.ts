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
