import type { QueryColumn, QueryCell } from './sources.ts'
import type { WorkspaceSourceResultArtifact } from './source-results.ts'
export interface SourceAgentToolDefinition { name: string; description: string; inputSchema: Record<string, unknown> }

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required })
const sourceId = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$' }
const uuid = { type: 'string', format: 'uuid' }
export const SOURCE_TOOL_NAMES = ['sources.list', 'sources.describe', 'sources.query', 'sources.save_result', 'sources.read_result'] as const
export type SourceToolName = typeof SOURCE_TOOL_NAMES[number]

/** Tool definitions contain neither a credential nor a caller-selectable owner.
 * Scope always comes from the authenticated tool execution context. */
export const SOURCE_AGENT_TOOLS: readonly SourceAgentToolDefinition[] = Object.freeze([
  { name: 'sources.list', description: 'List only data sources assigned to the current personal workspace. No credentials are returned.', inputSchema: object({ after: sourceId }, []) },
  { name: 'sources.describe', description: 'Read bounded table/column metadata for an assigned saved source. HTTP sources return their configured extraction metadata; credentials are never exposed.', inputSchema: object({ sourceId, table: { type: 'string', maxLength: 257 } }, ['sourceId']) },
  { name: 'sources.query', description: 'Execute one bounded read-only query on a saved assigned source. Returns a frozen result reference and a preview, with units, timezone, row count, hash and explicit truncation. This is not a full-dataset export.', inputSchema: object({ sourceId, sql: { type: 'string', maxLength: 32768 } }, ['sourceId']) },
  { name: 'sources.save_result', description: 'Save an existing frozen query result to the current personal workspace without re-executing SQL. Reuse the same commandId after an uncertain response. Preserves data types, units, provenance and truncation.', inputSchema: object({ resultId: uuid, name: { type: 'string', minLength: 1, maxLength: 200 }, commandId: uuid }) },
  { name: 'sources.read_result', description: 'Read a bounded page from an authorized frozen query result. Default 1000 rows; this pages the captured result and never re-runs the source query.', inputSchema: object({ resultId: uuid, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 1000 } }, ['resultId']) },
])

export interface SourceToolQueryOutcome {
  artifact: WorkspaceSourceResultArtifact
  schema: readonly QueryColumn[]
  timezone: string
  preview: readonly Readonly<Record<string, QueryCell>>[]
  totalRows: number
  sourceTruncated: boolean
  sha256: string
  nextOffset: number | null
  notice: string
}
