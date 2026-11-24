import type { QueryColumn, QueryCell } from './sources.ts'
import type { WorkspaceSourceResultArtifact } from './source-results.ts'
export interface SourceAgentToolDefinition { name: string; description: string; inputSchema: Record<string, unknown> }

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required })
const sourceId = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$' }
export const MAX_DESCRIBE_TABLES = 16
export const MAX_BATCH_QUERIES = 4
const tableName = { type: 'string', maxLength: 257 }
const statement = { type: 'string', minLength: 1, maxLength: 32768 }
const uuid = { type: 'string', format: 'uuid' }
export const MAX_RESULT_PAGES = 4
const page = { resultId: uuid, offset: { type: 'integer', minimum: 0, maximum: 10000 }, limit: { type: 'integer', minimum: 1, maximum: 1000 } }
export const SOURCE_TOOL_NAMES = ['list_connections', 'search_objects', 'execute_sql', 'save_query_result', 'read_query_result'] as const
export type SourceToolName = typeof SOURCE_TOOL_NAMES[number]

/** Tool definitions contain neither a credential nor a caller-selectable owner.
 * Scope always comes from the authenticated tool execution context. */
export const SOURCE_AGENT_TOOLS: readonly SourceAgentToolDefinition[] = Object.freeze([
  { name: 'list_connections', description: 'List only data sources assigned to the current personal workspace. No credentials are returned.', inputSchema: object({ after: sourceId }, []) },
  { name: 'search_objects', description: 'List SQL tables in scope with optional schema or literal tablePrefix filters. Use table or tables to inspect ordered column metadata. To continue, pass metadata.nextOffset as columnOffset with the same selection. HTTP sources return extraction metadata.', inputSchema: object({
    sourceId, table: tableName, tables: { type: 'array', minItems: 1, maxItems: MAX_DESCRIBE_TABLES, items: tableName },
    columnOffset: { type: 'integer', minimum: 0, description: 'Zero-based offset in the combined column list, only for SQL table or tables. Defaults to 0.' },
    schema: { type: 'string', maxLength: 128 }, tablePrefix: { type: 'string', maxLength: 128 },
  }, ['sourceId']) },
  { name: 'execute_sql', description: 'Use sql for one read-only query or queries for independent SQL on the same source. Batch items follow input order and report individual outcomes. Returns a frozen result reference and a preview, with units, timezone, row count, hash and explicit truncation. This is not a full-dataset export.', inputSchema: object({ sourceId, sql: statement, queries: { type: 'array', minItems: 1, maxItems: MAX_BATCH_QUERIES, items: statement } }, ['sourceId']) },
  { name: 'save_query_result', description: 'Save an existing frozen query result to the current personal workspace without re-executing SQL. Reuse the same commandId after an uncertain response. Preserves data types, units, provenance and truncation.', inputSchema: object({ resultId: uuid, name: { type: 'string', minLength: 1, maxLength: 200 }, commandId: uuid }) },
  { name: 'read_query_result', description: 'Read a frozen result with resultId, offset and limit, or pass pages alone for up to four independent pages. Batch items follow input order and share an 8 KiB preview budget. Continue each result with its nextOffset; use a single-page read when readSingly or schemaOmitted is true. Never re-runs SQL.', inputSchema: object({ ...page, pages: { type: 'array', minItems: 1, maxItems: MAX_RESULT_PAGES, items: object(page, ['resultId']) } }, []) },
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
