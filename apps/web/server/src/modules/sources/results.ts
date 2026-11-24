import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { BusinessPrincipal, PrincipalTransactions } from '../../db/context.ts'
import { isSourceResultName } from '../../../../../../packages/web-contracts/src/source-results.ts'
import type { QuerySnapshot } from '../../../../../../packages/web-contracts/src/sources.ts'
import type {
  WorkspaceSourceResultArtifact, WorkspaceSourceResultCapture, WorkspaceSourceResultList,
  WorkspaceSourceResultPage, WorkspaceSourceResultDownload,
} from '../../../../../../packages/web-contracts/src/source-results.ts'
import { createQuerySnapshot } from './provenance.ts'
import { SQL_RESULT_MAX_BYTES } from './config.ts'

const error = (statusCode = 400) => Object.assign(new Error('Workspace source result unavailable'), { statusCode })
const hardLimits = Object.freeze({ maxSnapshotBytes: SQL_RESULT_MAX_BYTES, pendingTtlMs: 15 * 60_000 })
export interface WorkspaceSourceResultsOptions {
  transactions: PrincipalTransactions
  maxSnapshotBytes?: number
  pendingTtlMs?: number
}

type Row = {
  result_id: string; workspace_id: string; source_id: string; source_version: number
  query_hash: string; sha256: string; row_count: number; truncated: boolean; size_bytes: number
  state: 'pending' | 'saved'; session_id: string | null; name: string | null
  save_command_id: string | null; save_params_hash: string | null
  created_at: Date; saved_at: Date | null; expires_at: Date | null; snapshot: unknown
}
const metadata = 'result_id,workspace_id,source_id,source_version,query_hash,sha256,row_count,truncated,size_bytes,state,session_id,name,save_command_id,save_params_hash,created_at,saved_at,expires_at'
const scope = (p: BusinessPrincipal, workspaceId: string) => [p.deploymentId, p.userId, workspaceId]
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(input) || Object.keys(input).some(key => !keys.includes(key))) throw error()
  return input
}
function uuid(input: unknown): string {
  if (typeof input !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input)) throw error()
  return input.toLowerCase()
}
function filename(input: unknown): string {
  // JSON literals need no formula escaping. The filename itself must be a
  // portable leaf, safe even if a later HTTP facade uses Content-Disposition.
  if (!isSourceResultName(input)) throw error()
  return input
}
function integer(input: unknown, fallback: number, min: number, max: number): number {
  const value = input === undefined ? fallback : input
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw error()
  return value as number
}
function artifact(row: Row): WorkspaceSourceResultArtifact {
  return { resultId: row.result_id, workspaceId: row.workspace_id, sourceId: row.source_id, sourceVersion: row.source_version,
    queryHash: row.query_hash, sha256: row.sha256, rowCount: row.row_count, truncated: row.truncated, sizeBytes: row.size_bytes,
    state: row.state, name: row.name, createdAt: row.created_at.toISOString(), savedAt: row.saved_at?.toISOString() ?? null, expiresAt: row.expires_at?.toISOString() ?? null }
}

/** Rebuild from typed columns/row order, never JSONB object-key order or a claimed
 * sha256. The returned snapshot is detached/frozen before the first async gap.
 */
function verifiedSnapshot(input: unknown, maxBytes: number): { snapshot: QuerySnapshot; bytes: Buffer } {
  const value = object(input, ['version','sourceId','sourceVersion','schema','timezone','rows','truncated','sha256'])
  if (value.version !== 1 || typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)
    || typeof value.sourceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value.sourceId)
    || !Number.isSafeInteger(value.sourceVersion) || (value.sourceVersion as number) > 2_000_000_000
    || !Array.isArray(value.rows) || value.rows.length > 10_000) throw error()
  let snapshot: QuerySnapshot
  try {
    snapshot = createQuerySnapshot({ sourceId: value.sourceId, sourceVersion: value.sourceVersion, schema: value.schema, timezone: value.timezone, rows: value.rows, sourceTruncated: value.truncated }, { maxRows: 10_000, maxBytes: 8_000_000 })
  } catch { throw error() }
  const bytes = Buffer.from(JSON.stringify(snapshot), 'utf8')
  if (bytes.length > maxBytes) throw error(413)
  if (snapshot.sha256 !== value.sha256) throw error()
  return { snapshot, bytes }
}
function storedSnapshot(row: Row) {
  try {
    const verified = verifiedSnapshot(row.snapshot, hardLimits.maxSnapshotBytes), s = verified.snapshot
    if (s.sourceId !== row.source_id || s.sourceVersion !== row.source_version || s.sha256 !== row.sha256 || s.rows.length !== row.row_count || s.truncated !== row.truncated || verified.bytes.length !== row.size_bytes) throw error()
    return verified
  } catch { throw error(500) }
}

/** A minimal TS service for small materialized JSONB results, not full spooling
 * or a file engine. capture is INTERNAL: call only after an authorized bounded
 * source query; do not expose it as a route accepting user-supplied rows.
 *
 * Explicit save freezes one command receipt permanently. Saved evidence is
 * personal workspace data even after the source is disabled/logically deleted;
 * every operation still requires a live owner session. Pending evidence also
 * requires its original session and an enabled, nondeleted saved source.
 * This service never calls a connector, executes SQL from input, or charges T05
 * object storage bytes. Owners can remove saved results. Result IDs are random
 * UUIDs, so replaying a save command for a removed result returns 404.
 */
export function createWorkspaceSourceResults(options: WorkspaceSourceResultsOptions) {
  const { transactions } = options
  const limits: { -readonly [K in keyof typeof hardLimits]: number } = { ...hardLimits }
  for (const key of Object.keys(hardLimits) as (keyof typeof hardLimits)[]) {
    const value = options[key] ?? hardLimits[key]
    if (!Number.isSafeInteger(value) || value < 1 || value > hardLimits[key]) throw new Error('Invalid workspace source result limit')
    limits[key] = value
  }
  async function access<T>(token: string, documentId: string | undefined, operation: (c: PoolClient, p: BusinessPrincipal, workspaceId: string) => Promise<T>): Promise<T> {
    return transactions.withPrincipalTransaction({ kind: 'session', token }, async (c, p) => {
      if (!p.roles.includes('personal') || p.job) throw error(404)
      // Never accept a caller-selected owner/workspace, even from an internal DTO.
      const workspace = (await c.query('SELECT id FROM workspaces WHERE deployment_id=$1 AND owner_id=$2', [p.deploymentId, p.userId])).rows[0]
      if (!workspace) throw error(404)
      if (documentId !== undefined) {
        const file = await c.query('SELECT id FROM files WHERE deployment_id=$1 AND owner_id=$2 AND workspace_id=$3 AND id=$4 AND deleted_at IS NULL AND purge_started_at IS NULL FOR SHARE', [...scope(p,workspace.id),uuid(documentId)])
        if (!file.rowCount) throw error(404)
      }
      return operation(c, p, workspace.id)
    })
  }
  async function lockWorkspace(c: PoolClient, p: BusinessPrincipal, workspaceId: string) {
    // Serialize pending cleanup, save receipts, and deletion across all sessions and service objects.
    // Hash collisions only serialize unrelated work; they cannot grant access.
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['workspace-source-results:' + scope(p, workspaceId).join(':')])
  }
  async function sourceEnabled(c: PoolClient, p: BusinessPrincipal, sourceId: string, sourceVersion: number) {
    const keys = [p.deploymentId, p.userId, sourceId]
    // Source mutations take UPDATE on this permanent root. Hold SHARE through
    // commit so disabled/deleted state cannot race capture/save/pending access.
    const source = (await c.query('SELECT enabled,draft_version FROM data_sources WHERE deployment_id=$1 AND owner_id=$2 AND source_id=$3 AND deleted_at IS NULL FOR SHARE', keys)).rows[0]
    if (!source) throw error(404)
    if (!source.enabled) throw error(409)
    if (sourceVersion > source.draft_version) throw error(404)
    // A pending snapshot is tied to the connection scope at query time.
    // Saved materializations have their own owner authorization.
    if (sourceVersion !== source.draft_version) throw error(409)
  }
  async function readable(c: PoolClient, p: BusinessPrincipal, workspaceId: string, id: string, documentId?: string): Promise<Row> {
    const row = (await c.query<Row>(`SELECT ${metadata},snapshot FROM workspace_source_results WHERE deployment_id=$1 AND owner_id=$2 AND workspace_id=$3 AND result_id=$4 AND document_id IS NOT DISTINCT FROM $6::uuid AND (state='saved' OR (state='pending' AND session_id=$5 AND expires_at>clock_timestamp()))`, [...scope(p, workspaceId), id, p.sessionId, documentId??null])).rows[0]
    if (!row) throw error(404)
    if (row.state === 'pending') {
      await sourceEnabled(c, p, row.source_id, row.source_version)
      // Source locking above may have waited past a pending deadline.
      if (!(await c.query('SELECT $1::timestamptz>clock_timestamp() AS live', [row.expires_at])).rows[0].live) throw error(404)
    }
    return row
  }
  return Object.freeze({
    async requireDocument(token: string, documentId: string): Promise<void> {
      await access(token, documentId, async () => {})
    },
    async capture(token: string, input: QuerySnapshot, queryHash: string, documentId?: string): Promise<WorkspaceSourceResultCapture> {
      const { snapshot, bytes } = verifiedSnapshot(input, limits.maxSnapshotBytes)
      if (typeof queryHash !== 'string' || !/^[0-9a-f]{64}$/.test(queryHash)) throw error()
      return access(token, documentId, async (c, p, workspaceId) => {
        await lockWorkspace(c, p, workspaceId)
        await sourceEnabled(c, p, snapshot.sourceId, snapshot.sourceVersion)
        await c.query(`DELETE FROM workspace_source_results WHERE deployment_id=$1 AND owner_id=$2 AND workspace_id=$3 AND state='pending' AND result_id IN (
          SELECT result_id FROM workspace_source_results WHERE deployment_id=$1 AND owner_id=$2 AND workspace_id=$3 AND state='pending' AND expires_at<=clock_timestamp() ORDER BY expires_at,result_id LIMIT 16
        )`, scope(p, workspaceId))
        const row = (await c.query<Row>(`INSERT INTO workspace_source_results(result_id,deployment_id,owner_id,workspace_id,source_id,source_version,query_hash,sha256,row_count,truncated,size_bytes,snapshot,state,session_id,expires_at,document_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,'pending',$13,clock_timestamp()+$14*interval '1 millisecond',$15) RETURNING ${metadata}`,
        [randomUUID(), ...scope(p, workspaceId), snapshot.sourceId, snapshot.sourceVersion, queryHash, snapshot.sha256, snapshot.rows.length, snapshot.truncated, bytes.length, bytes.toString('utf8'), p.sessionId, limits.pendingTtlMs, documentId??null])).rows[0]
        return artifact(row) as WorkspaceSourceResultCapture
      })
    },
    async save(token: string, input: unknown, documentId?: string): Promise<WorkspaceSourceResultArtifact> {
      const value = object(input, ['resultId','name','commandId']), id = uuid(value.resultId), name = filename(value.name), commandId = uuid(value.commandId)
      const paramsHash = hash(JSON.stringify({ resultId: id, name }))
      return access(token, documentId, async (c, p, workspaceId) => {
        await lockWorkspace(c, p, workspaceId)
        const keys = scope(p, workspaceId)
        // Resolve the scoped target first: a foreign/expired/session-bound handle
        // is always 404, regardless of any command ID supplied alongside it.
        const row = await readable(c, p, workspaceId, id, documentId)
        const receipt = (await c.query<Row>(`SELECT ${metadata} FROM workspace_source_results WHERE deployment_id=$1 AND owner_id=$2 AND workspace_id=$3 AND save_command_id=$4 AND document_id IS NOT DISTINCT FROM $5::uuid`, [...keys, commandId, documentId??null])).rows[0]
        if (receipt) {
          if (receipt.save_params_hash !== paramsHash || receipt.result_id !== id) throw error(409)
          return artifact(receipt)
        }
        if (row.state === 'saved') throw error(409)
        storedSnapshot(row)
        const updated = (await c.query<Row>(`UPDATE workspace_source_results SET state='saved',session_id=NULL,expires_at=NULL,name=$5,save_command_id=$6,save_params_hash=$7,saved_at=clock_timestamp()
          WHERE deployment_id=$1 AND owner_id=$2 AND workspace_id=$3 AND result_id=$4 AND state='pending' AND session_id=$8 AND expires_at>clock_timestamp() RETURNING ${metadata}`, [...keys, id, name, commandId, paramsHash, p.sessionId])).rows[0]
        if (!updated) throw error(404)
        return artifact(updated)
      })
    },
    /** Delete one saved result of the caller's workspace. */
    async remove(token: string, input: unknown, documentId?: string): Promise<void> {
      const value = object(input, ['resultId']), id = uuid(value.resultId)
      return access(token, documentId, async (c, p, workspaceId) => {
        await lockWorkspace(c, p, workspaceId)
        const removed = await c.query(`DELETE FROM workspace_source_results WHERE deployment_id=$1 AND owner_id=$2 AND workspace_id=$3 AND result_id=$4 AND state='saved' AND document_id IS NOT DISTINCT FROM $5::uuid`, [...scope(p, workspaceId), id, documentId??null])
        if (!removed.rowCount) throw error(404)
      })
    },
    async list(token: string, input: unknown = {}, documentId?: string, includePending = false): Promise<WorkspaceSourceResultList> {
      const value = object(input, ['limit','after']), limit = integer(value.limit, 50, 1, 100), after = value.after === undefined ? null : uuid(value.after)
      return access(token, documentId, async (c, p, workspaceId) => {
        const rows = (await c.query<Row>(`SELECT ${metadata} FROM workspace_source_results r
          WHERE deployment_id=$1 AND owner_id=$2 AND workspace_id=$3 AND document_id IS NOT DISTINCT FROM $6::uuid
            AND ($4::uuid IS NULL OR result_id>$4)
            AND (state='saved' OR (state='pending' AND session_id=$7 AND expires_at>clock_timestamp()
              AND EXISTS (SELECT 1 FROM data_sources s WHERE s.deployment_id=r.deployment_id AND s.owner_id=r.owner_id
                AND s.source_id=r.source_id AND s.enabled AND s.deleted_at IS NULL AND s.draft_version=r.source_version)))
          ORDER BY result_id LIMIT $5`, [...scope(p, workspaceId), after, limit + 1, documentId??null,
          documentId && includePending ? p.sessionId : null])).rows
        return { items: rows.slice(0, limit).map(artifact), nextCursor: rows.length > limit ? rows[limit - 1].result_id : null }
      })
    },
    async read(token: string, input: unknown, documentId?: string): Promise<WorkspaceSourceResultPage> {
      const value = object(input, ['resultId','offset','limit']), id = uuid(value.resultId), offset = integer(value.offset, 0, 0, 10_000), limit = integer(value.limit, 1000, 1, 1000)
      return access(token, documentId, async (c, p, workspaceId) => {
        const row = await readable(c, p, workspaceId, id, documentId), { snapshot } = storedSnapshot(row)
        const rows = snapshot.rows.slice(offset, offset + limit), next = offset + rows.length
        return { artifact: artifact(row), schema: snapshot.schema, timezone: snapshot.timezone, rows, offset, nextOffset: next < snapshot.rows.length ? next : null, totalRows: snapshot.rows.length, sourceTruncated: snapshot.truncated, sha256: snapshot.sha256 }
      })
    },
    async download(token: string, input: unknown, documentId?: string): Promise<WorkspaceSourceResultDownload & { bytes: Buffer }> {
      const id = uuid(input)
      return access(token, documentId, async (c, p, workspaceId) => {
        const row = await readable(c, p, workspaceId, id, documentId), { snapshot, bytes } = storedSnapshot(row)
        const name = filename(row.name ?? 'result-' + row.result_id)
        return { name: /\.json$/i.test(name) ? name : name + '.json', bytes, sha256: snapshot.sha256 }
      })
    },
  })
}
export type WorkspaceSourceResults = ReturnType<typeof createWorkspaceSourceResults>
