/** T15 evidence DTO. This is not an authorization capability. */
export type QueryCell = string | number | boolean | null
export type QueryColumn = Readonly<{ name: string; type: 'string' | 'number' | 'boolean'; unit?: string }>
export type QuerySnapshot = Readonly<{
  version: 1
  sourceId: string
  sourceVersion: number
  schema: readonly QueryColumn[]
  timezone: string
  rows: readonly Readonly<Record<string, QueryCell>>[]
  truncated: boolean
  sha256: string
}>

/** Column unit metadata is supplied by the source configuration, never inferred from values. */
export type SourceUnitMap = Readonly<Record<string, string>>

export type SourceKind = 'postgres' | 'mysql' | 'starrocks' | 'http'

/** Public postgres connector settings. The DSN is a credential and never appears here. */
export interface PostgresSourceConfig {
  database?: string
  /** Omitted: all readable tables; empty: none; otherwise schema.table or default-schema table names. */
  allowedTables?: readonly string[]
  /** When present, only these schemas/databases are visible; intersects allowedTables. */
  allowedSchemas?: readonly string[]
  timezone?: string
  /** Read-only execution limits; invalid/excessive values are rejected server-side. */
  statementTimeoutMs?: number
  maxRows?: number
  units?: SourceUnitMap
}

/** Public HTTP connector settings. The endpoint URL is a credential and never appears here. */
export interface HttpSourceConfig {
  timezone?: string
  /** Dot path to the row array inside the JSON document (default: top-level array or body.rows). */
  rowPath?: string
  maxRows?: number
  units?: SourceUnitMap
}

export type SourceConfig = PostgresSourceConfig | HttpSourceConfig

/** Bounded execution parameters derived from the current saved configuration. */
export interface SourceExecution {
  readonly maxRows: number
  readonly statementTimeoutMs?: number
  readonly requestTimeoutMs?: number
  readonly maxResponseBytes?: number
}

export interface SourceDescriptor {
  sourceId: string
  name: string
  kind: SourceKind
  /** Internal optimistic concurrency token; not a selectable configuration version. */
  version: number
  enabled: boolean
  hasCredential: boolean
  updatedAt: string
}

export interface SourceList { items: SourceDescriptor[]; nextCursor: string | null }

export interface SourceDetail {
  source: SourceDescriptor
  /** Full configuration is owner-visible but never includes credentials or DSNs. */
  config: SourceConfig
}

export interface CreateSourceRequest {
  sourceId: string
  name: string
  kind: SourceKind
  config: SourceConfig
  /** DSN (postgres) or endpoint URL (http). Stored encrypted; omitted from every response. */
  secret: string
  enabled?: boolean
}

export interface SaveSourceRequest {
  expectedVersion: number
  name?: string
  config?: SourceConfig
  /** Omit to retain, null to clear, string to replace the current credential. */
  secret?: string | null
  enabled?: boolean
}

export interface SourceQueryRequest { sql?: string }

/** MySQL wire protocol; StarRocks uses its own server timeout dialect. */
export type MySqlSourceConfig = PostgresSourceConfig

export interface SourceConnectionCheck { ok: boolean; kind: SourceKind; code?: string }

/** Available to the connection editor; independent of the saved assistant scope. */
export interface SourceDiscovery { page?: number; items: string[]; truncated: boolean }
