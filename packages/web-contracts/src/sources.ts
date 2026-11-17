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

/** Frozen execution parameters recorded with each published version. */
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
  version: number
  enabled: boolean
  publishedRevision: number | null
  hasCredential: boolean
  hasUnpublishedChanges: boolean
  updatedAt: string
}

export interface SourceList { items: SourceDescriptor[]; nextCursor: string | null }

export interface PublishedSourceVersion {
  sourceId: string
  revision: number
  contentHash: string
  publishedAt: string
  name: string
  kind: SourceKind
  config: SourceConfig
  execution: SourceExecution
}

export interface SourceDetail {
  source: SourceDescriptor
  /** Full configuration is owner-visible but never includes credentials or DSNs. */
  config: SourceConfig
  published: PublishedSourceVersion | null
}

export interface CreateSourceRequest {
  sourceId: string
  name: string
  kind: SourceKind
  config: SourceConfig
  /** DSN (postgres) or endpoint URL (http). Stored encrypted; omitted from every response. */
  secret: string
}

export interface SaveSourceRequest {
  expectedVersion: number
  name?: string
  config?: SourceConfig
  /** Omit to retain, null to clear this draft, string to append a rotated credential. Published history retains its original credential. */
  secret?: string | null
  enabled?: boolean
}

export interface PublishSourceRequest { expectedVersion: number }

export interface SourceQueryRequest { sql?: string; sourceVersion?: number }

/** MySQL wire protocol; StarRocks uses its own server timeout dialect. */
export type MySqlSourceConfig = PostgresSourceConfig

export interface SourceConnectionCheck { ok: boolean; kind: SourceKind; code?: string }
