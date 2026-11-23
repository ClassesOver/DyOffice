import { randomUUID } from 'node:crypto'
import { sourceResultBase, type WorkspaceSourceResultCapture } from '../../../packages/web-contracts/src/source-results.ts'
import type { QuerySnapshot } from '../../../packages/web-contracts/src/sources.ts'
import { createSourceEgressPolicy } from '../../../apps/web/server/src/security/egress.ts'
import { executionFor, object, sourceError, sourceId } from '../../../apps/web/server/src/modules/sources/config.ts'
import { describeSourceMetadata, snapshotFor } from '../../../apps/web/server/src/modules/sources/service.ts'
import { querySqlSource } from '../../../apps/web/server/src/modules/sources/sql.ts'
import { createWorkspaceSourceTools } from '../../../apps/web/server/src/modules/sources/tools.ts'

/** The trial owns one PostgreSQL connection and an in-memory store for its frozen evidence. */
export function createEvaluationSourceBackend(sourceDsn: string, documentId: string) {
  const base = sourceResultBase(documentId)
  const dsn = new URL(sourceDsn)
  const policy = createSourceEgressPolicy([{ kind: 'postgres', endpoint: `postgresql://${dsn.host}`, addresses: [dsn.hostname], username: decodeURIComponent(dsn.username), database: dsn.pathname.slice(1), allowInsecure: true }])
  const config = { timezone: 'Asia/Shanghai', maxRows: 1000, units: { order_amount: 'CNY', paid_amount: 'CNY', unit_price: 'CNY' }, statementTimeoutMs: 5000 }
  const source = { sourceId: 'sales', name: '销售库', kind: 'postgres' as const, version: 1, enabled: true, hasCredential: true, updatedAt: new Date().toISOString() }
  const row = { source_id: source.sourceId, kind: source.kind, version: source.version, config }
  const execution = executionFor(source.kind, config)
  const workspaceId = randomUUID()
  const frozen = new Map<string, { artifact: WorkspaceSourceResultCapture; snapshot: QuerySnapshot }>()
  const checkSource = (id: unknown) => { if (sourceId(id) !== source.sourceId) throw sourceError(404) }
  const checkDocument = (id: string | undefined) => { if (id !== documentId) throw sourceError(404) }
  const sources = {
    async listSavedMetadata(_token: string, input: unknown = {}) {
      const { after } = object(input, ['after'])
      const items = after === undefined || sourceId(after) < source.sourceId
        ? [{ sourceId: source.sourceId, name: source.name, kind: source.kind, sourceVersion: source.version }] : []
      return { items, nextCursor: null }
    },
    async detail(_token: string, id: unknown) { checkSource(id); return { source, config } },
    async describe(_token: string, id: unknown, filters: unknown = {}) {
      checkSource(id)
      const metadata = await describeSourceMetadata({ row, policy, secret: sourceDsn }, filters)
      return { sourceId: source.sourceId, kind: source.kind, sourceVersion: source.version, config, metadata }
    },
    async querySource(_token: string, id: unknown, input: unknown = {}, expectedVersion?: number) {
      checkSource(id)
      if (expectedVersion !== undefined && expectedVersion !== source.version) throw sourceError(409)
      const { sql } = object(input, ['sql'])
      const rows = await querySqlSource(policy, source.kind, sourceDsn, sql, execution, { defaultSchema: 'public' })
      return snapshotFor(row, execution, rows)
    },
  }
  const results = {
    async requireDocument(_token: string, id: string) { checkDocument(id) },
    async capture(_token: string, snapshot: QuerySnapshot, queryHash: string, id?: string) {
      checkDocument(id)
      const resultId = randomUUID(), now = Date.now()
      const artifact: WorkspaceSourceResultCapture = { resultId, workspaceId, sourceId: snapshot.sourceId, sourceVersion: snapshot.sourceVersion,
        queryHash, sha256: snapshot.sha256, rowCount: snapshot.rows.length, truncated: snapshot.truncated, sizeBytes: Buffer.byteLength(JSON.stringify(snapshot)),
        state: 'pending', name: null, savedAt: null, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 15 * 60_000).toISOString() }
      frozen.set(resultId, { artifact, snapshot })
      return artifact
    },
    async read(_token: string, input: unknown, id?: string) {
      checkDocument(id)
      const { resultId, offset = 0, limit = 1000 } = object(input, ['resultId', 'offset', 'limit'])
      const entry = frozen.get(resultId)
      if (!entry || Date.parse(entry.artifact.expiresAt) <= Date.now()) throw sourceError(404)
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw sourceError()
      const { artifact, snapshot } = entry
      const rows = snapshot.rows.slice(offset, offset + limit), next = offset + rows.length
      return { artifact, schema: snapshot.schema, timezone: snapshot.timezone, rows, offset, nextOffset: next < snapshot.rows.length ? next : null, totalRows: snapshot.rows.length, sourceTruncated: snapshot.truncated, sha256: snapshot.sha256 }
    },
    async save() { throw sourceError(403) },
  }
  const tools = createWorkspaceSourceTools({ sources, results })
  return {
    async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
      try {
        if (path === base + '/ai/sources/execute' && method === 'POST') return await tools.execute('eval', body, documentId) as T
        const page = method === 'GET' && path.startsWith(base + '/') && /^\/data-results\/([^?]+)\?offset=(\d+)&limit=(\d+)$/.exec(path.slice(base.length))
        if (page) return await tools.execute('eval', { name: 'sources.read_result', arguments: { resultId: decodeURIComponent(page[1]!), offset: Number(page[2]), limit: Number(page[3]) } }, documentId) as T
        throw sourceError(404)
      } catch (cause) {
        const { statusCode = 502, code } = cause as { statusCode?: number; code?: string }
        throw Object.assign(new Error('Source tool failed'), { status: statusCode, code })
      }
    },
  }
}
