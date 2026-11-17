import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { BusinessPrincipal, PrincipalTransactions } from '../../db/context.ts'
import type { SourceConfig, SourceDescriptor, SourceDetail, SourceExecution, SourceKind, SourceList, PublishedSourceVersion, QuerySnapshot, QueryColumn, QueryCell } from '../../../../../../packages/web-contracts/src/sources.ts'
import { createSourceEgressPolicy, parseSourceDsn, type SourceEgressTarget } from '../../security/egress.ts'
import { createCredentialVault } from './vault.ts'
import { contentHash, executionFor, object, positiveVersion, secretHash, sourceConfig, sourceError, sourceId, sourceName, validateSourceSecret } from './config.ts'
import { queryHttpSource } from './http.ts'
import { querySqlSource, type SqlRows } from './sql.ts'
import { createQuerySnapshot } from './provenance.ts'

type Row = Record<string, any>
const scope = (p: BusinessPrincipal, id: string) => [p.deploymentId, p.userId, id]
const joined = `SELECT s.*,d.version,d.kind,d.name,d.config,d.credential_ref,d.credential_revision,d.content_hash,v.content_hash AS published_hash FROM data_sources s JOIN data_source_drafts d USING(deployment_id,owner_id,source_id) LEFT JOIN data_source_versions v ON v.deployment_id=s.deployment_id AND v.owner_id=s.owner_id AND v.source_id=s.source_id AND v.revision=s.published_revision`
const descriptor = (row: Row): SourceDescriptor => ({ sourceId: row.source_id, name: row.name, kind: row.kind, version: row.version, enabled: row.enabled, publishedRevision: row.published_revision, hasCredential: row.credential_ref !== null, hasUnpublishedChanges: row.published_hash != null && row.published_hash !== row.content_hash, updatedAt: new Date(row.updated_at).toISOString() })
const published = (row: Row): PublishedSourceVersion => ({ sourceId: row.source_id, revision: row.revision, contentHash: row.content_hash, publishedAt: new Date(row.published_at).toISOString(), name: row.name, kind: row.kind, config: row.config, execution: row.execution })

export function createSourceService({ transactions, credentialKeys = '', egressTargets = [] }: { transactions: PrincipalTransactions; credentialKeys?: string; egressTargets?: readonly SourceEgressTarget[] }) {
  const vault = createCredentialVault(credentialKeys), policy = createSourceEgressPolicy(egressTargets)
  async function access<T>(token: string, operation: (connection: PoolClient, principal: BusinessPrincipal) => Promise<T>): Promise<T> {
    return transactions.withPrincipalTransaction({ kind: 'session', token }, async (connection, principal) => {
      if (!principal.roles.includes('personal') || principal.job) throw sourceError(404)
      return operation(connection, principal)
    })
  }
  async function audit(c: PoolClient, p: BusinessPrincipal, id: string, action: string, detail: Row = {}) {
    await c.query('INSERT INTO data_source_audit(id,deployment_id,owner_id,source_id,actor_id,session_id,action,detail) VALUES($1,$2,$3,$4,$3,$5,$6,$7::jsonb)', [randomUUID(), ...scope(p, id), p.sessionId, action, JSON.stringify(detail)])
  }
  async function get(c: PoolClient, p: BusinessPrincipal, id: string, lock = false): Promise<Row> {
    const row = (await c.query(joined + ' WHERE s.deployment_id=$1 AND s.owner_id=$2 AND s.source_id=$3 AND s.deleted_at IS NULL' + (lock ? ' FOR UPDATE OF s,d' : ''), scope(p, id))).rows[0]
    if (!row) throw sourceError(404)
    return row
  }
  async function readCredential(c: PoolClient, p: BusinessPrincipal, id: string, row: Row): Promise<string> {
    if (!row.credential_ref) throw sourceError(503)
    const credential = (await c.query('SELECT key_id,ciphertext,secret_hash FROM data_source_credentials WHERE deployment_id=$1 AND owner_id=$2 AND source_id=$3 AND credential_ref=$4 AND revision=$5', [...scope(p, id), row.credential_ref, row.credential_revision])).rows[0]
    if (!credential || credential.key_id !== credential.ciphertext.keyId) throw sourceError(503)
    const secret = vault.open(credential.ciphertext, { deploymentId: p.deploymentId, ownerId: p.userId, sourceId: id, reference: row.credential_ref, revision: row.credential_revision })
    if (secretHash(secret) !== credential.secret_hash) throw sourceError(503)
    return validateSourceSecret(row.kind, secret, row.config)
  }
  async function storeCredential(c: PoolClient, p: BusinessPrincipal, id: string, secret: string) {
    const revision = Number((await c.query('SELECT COALESCE(max(revision),0)+1 AS revision FROM data_source_credentials WHERE deployment_id=$1 AND owner_id=$2 AND source_id=$3', scope(p, id))).rows[0].revision)
    const reference = randomUUID(), envelope = vault.seal(secret, { deploymentId: p.deploymentId, ownerId: p.userId, sourceId: id, reference, revision })
    await c.query('INSERT INTO data_source_credentials(deployment_id,owner_id,source_id,credential_ref,revision,key_id,ciphertext,secret_hash) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)', [...scope(p, id), reference, revision, envelope.keyId, JSON.stringify(envelope), secretHash(secret)])
    return { reference, revision }
  }
  function digest(name: string, kind: SourceKind, config: SourceConfig, reference: string | null, revision: number | null) {
    return contentHash({ name, kind, config, credentialRef: reference, credentialRevision: revision, execution: executionFor(kind, config) })
  }
  async function execute(row: Row, secret: string, query: Record<string, any>) {
    const execution: SourceExecution = row.execution ?? executionFor(row.kind, row.config)
    if (row.kind === 'http') {
      if (query.sql !== undefined) throw sourceError()
      return { rows: await queryHttpSource(policy, secret, row.config, execution), execution }
    }
    return { sql: await querySqlSource(policy, row.kind, secret, query.sql, execution), execution }
  }
  return Object.freeze({
    async list(token: string, input: unknown = {}): Promise<SourceList> {
      const query = object(input, ['limit','after'])
      const limit = query.limit === undefined ? 50 : Number(query.limit)
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || query.after !== undefined && typeof query.after !== 'string') throw sourceError()
      const after = query.after === undefined ? '' : sourceId(query.after)
      return access(token, async (c, p) => {
        const rows = (await c.query(joined + ' WHERE s.deployment_id=$1 AND s.owner_id=$2 AND s.source_id>$3 AND s.deleted_at IS NULL ORDER BY s.source_id LIMIT $4', [p.deploymentId, p.userId, after, limit + 1])).rows
        return { items: rows.slice(0, limit).map(descriptor), nextCursor: rows.length > limit ? rows[limit - 1].source_id : null }
      })
    },
    async detail(token: string, input: unknown): Promise<SourceDetail> {
      const id = sourceId(input)
      return access(token, async (c, p) => {
        const row = await get(c, p, id)
        const version = row.published_revision === null ? null : (await c.query('SELECT * FROM data_source_versions WHERE deployment_id=$1 AND owner_id=$2 AND source_id=$3 AND revision=$4', [...scope(p, id), row.published_revision])).rows[0]
        return { source: descriptor(row), config: row.config, published: version ? published(version) : null }
      })
    },
    async create(token: string, input: unknown): Promise<SourceDescriptor> {
      const value = object(input, ['sourceId','name','kind','config','secret'])
      const id = sourceId(value.sourceId), name = sourceName(value.name), kind = value.kind as SourceKind
      if (!['http','postgres','mysql','starrocks'].includes(kind)) throw sourceError()
      const config = sourceConfig(kind, value.config ?? {}), secret = validateSourceSecret(kind, value.secret, config)
      return access(token, async (c, p) => {
        if (!vault.available) throw sourceError(503)
        const inserted = await c.query('INSERT INTO data_sources(deployment_id,owner_id,source_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING source_id', scope(p, id))
        if (!inserted.rowCount) throw sourceError(409)
        const credential = await storeCredential(c, p, id, secret)
        await c.query('INSERT INTO data_source_drafts(deployment_id,owner_id,source_id,version,kind,name,config,credential_ref,credential_revision,content_hash) VALUES($1,$2,$3,1,$4,$5,$6::jsonb,$7,$8,$9)', [...scope(p, id), kind, name, JSON.stringify(config), credential.reference, credential.revision, digest(name, kind, config, credential.reference, credential.revision)])
        await audit(c, p, id, 'source_created')
        return descriptor(await get(c, p, id))
      })
    },
    async save(token: string, input: unknown, payload: unknown): Promise<SourceDescriptor> {
      const id = sourceId(input), value = object(payload, ['expectedVersion','name','config','secret','enabled']), expected = positiveVersion(value.expectedVersion)
      if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw sourceError()
      return access(token, async (c, p) => {
        const row = await get(c, p, id, true)
        if (row.version !== expected) throw sourceError(409)
        const name = value.name === undefined ? row.name : sourceName(value.name), config = value.config === undefined ? row.config : sourceConfig(row.kind, value.config)
        let reference: string | null = row.credential_ref, revision: number | null = row.credential_revision
        if (Object.hasOwn(value, 'secret')) {
          if (value.secret === null) { reference = null; revision = null }
          else { const next = await storeCredential(c, p, id, validateSourceSecret(row.kind, value.secret, config)); reference = next.reference; revision = next.revision }
        } else if (reference) {
          // Retaining a credential may not silently change its declared database.
          const secret = await readCredential(c, p, id, row)
          validateSourceSecret(row.kind, secret, config)
        }
        const updated = await c.query('UPDATE data_source_drafts SET version=version+1,name=$4,config=$5::jsonb,credential_ref=$6,credential_revision=$7,content_hash=$8,updated_at=clock_timestamp() WHERE deployment_id=$1 AND owner_id=$2 AND source_id=$3 AND version=$9 RETURNING version', [...scope(p, id), name, JSON.stringify(config), reference, revision, digest(name, row.kind, config, reference, revision), expected])
        if (!updated.rowCount) throw sourceError(409)
        await c.query('UPDATE data_sources SET draft_version=$4,enabled=$5,updated_at=clock_timestamp() WHERE deployment_id=$1 AND owner_id=$2 AND source_id=$3', [...scope(p, id), expected + 1, value.enabled ?? row.enabled])
        await audit(c, p, id, value.enabled !== undefined && value.enabled !== row.enabled ? value.enabled ? 'source_enabled' : 'source_disabled' : 'source_saved', { version: expected + 1 })
        return descriptor(await get(c, p, id))
      })
    },
    async publish(token: string, input: unknown, payload: unknown): Promise<PublishedSourceVersion> {
      const id = sourceId(input), value = object(payload, ['expectedVersion']), expected = positiveVersion(value.expectedVersion)
      return access(token, async (c, p) => {
        const row = await get(c, p, id, true)
        if (row.version !== expected) throw sourceError(409)
        if (!row.credential_ref) throw sourceError(409)
        await readCredential(c, p, id, row)
        if (row.published_revision !== null && row.content_hash === row.published_hash) return published((await c.query('SELECT * FROM data_source_versions WHERE deployment_id=$1 AND owner_id=$2 AND source_id=$3 AND revision=$4', [...scope(p, id), row.published_revision])).rows[0])
        const revision = (row.published_revision ?? 0) + 1
        const version = (await c.query('INSERT INTO data_source_versions(deployment_id,owner_id,source_id,revision,content_hash,kind,name,config,execution,credential_ref,credential_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11) RETURNING *', [...scope(p, id), revision, row.content_hash, row.kind, row.name, JSON.stringify(row.config), JSON.stringify(executionFor(row.kind, row.config)), row.credential_ref, row.credential_revision])).rows[0]
        await c.query('UPDATE data_sources SET published_revision=$4,updated_at=clock_timestamp() WHERE deployment_id=$1 AND owner_id=$2 AND source_id=$3', [...scope(p, id), revision])
        await audit(c, p, id, 'source_published', { revision })
        return published(version)
      })
    },
    async remove(token: string, input: unknown, payload: unknown): Promise<void> {
      const id = sourceId(input), value = object(payload, ['expectedVersion']), expected = positiveVersion(value.expectedVersion)
      await access(token, async (c, p) => {
        const row = await get(c, p, id, true)
        if (row.version !== expected) throw sourceError(409)
        await c.query('UPDATE data_sources SET deleted_at=clock_timestamp(),enabled=false,updated_at=clock_timestamp() WHERE deployment_id=$1 AND owner_id=$2 AND source_id=$3', scope(p, id))
        await audit(c, p, id, 'source_deleted', { version: expected })
      })
    },
    async test(token: string, input: unknown) {
      const id = sourceId(input)
      const prepared = await access(token, async (c, p) => {
        const row = await get(c, p, id)
        if (!row.enabled) throw sourceError(409)
        try { return { row, secret: await readCredential(c, p, id, row) } } catch { return { row, secret: null } }
      })
      let ok = false, code = 'SOURCE_UNAVAILABLE'
      if (prepared.secret) try { await execute(prepared.row, prepared.secret, prepared.row.kind === 'http' ? {} : { sql: 'SELECT 1 AS connection_ok' }); ok = true } catch (error) { const status = (error as { statusCode?: number }).statusCode; code = status === 400 ? 'TARGET_NOT_APPROVED' : status === 403 ? 'READONLY_ROLE_REQUIRED' : status === 504 ? 'SOURCE_TIMEOUT' : 'SOURCE_UNAVAILABLE' }
      return access(token, async (c, p) => {
        // Lock the permanent root through the final authorization/audit commit.
        // A deleted scoped ID cannot be recreated, so this is the same instance.
        const current = await get(c, p, id, true)
        if (!current.enabled || current.version !== prepared.row.version) throw sourceError(409)
        await audit(c, p, id, 'source_tested', { ok, version: current.version })
        return { ok, kind: prepared.row.kind as SourceKind, ...(ok ? {} : { code }) }
      })
    },
    async describe(token: string, input: unknown, payload: unknown = {}) {
      const id = sourceId(input), request = object(payload, ['table'])
      if (request.table !== undefined && (typeof request.table !== 'string' || !/^[A-Za-z_][A-Za-z0-9_$]{0,127}$/.test(request.table))) throw sourceError()
      const prepared = await access(token, async (c, p) => {
        const source = await get(c, p, id)
        if (!source.enabled || source.published_revision === null) throw sourceError(409)
        const row = (await c.query('SELECT * FROM data_source_versions WHERE deployment_id=$1 AND owner_id=$2 AND source_id=$3 AND revision=$4', [...scope(p, id), source.published_revision])).rows[0]
        if (!row) throw sourceError(404)
        return { row, secret: await readCredential(c, p, id, row) }
      })
      let metadata: QuerySnapshot | null = null
      if (prepared.row.kind !== 'http') {
        // Identifiers are selected from a fixed information_schema projection;
        // the only optional caller value is a strictly validated table name.
        const database = prepared.row.kind === 'postgres' ? 'public' : parseSourceDsn(prepared.row.kind, prepared.secret).database
        const schema = database.replaceAll("'", "''")
        const sql = request.table === undefined
          ? `SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = '${schema}' ORDER BY table_name`
          : `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = '${request.table}' ORDER BY ordinal_position`
        const row = { ...prepared.row, config: { ...prepared.row.config, units: {} }, execution: { ...prepared.row.execution, maxRows: 1000 } }
        const result = await execute(row, prepared.secret, { sql })
        metadata = snapshotFor(row, result.execution, result.sql, result.rows)
      }
      return access(token, async (c, p) => {
        const current = await get(c, p, id, true)
        if (!current.enabled) throw sourceError(409)
        return { sourceId: id, sourceVersion: prepared.row.revision as number, kind: prepared.row.kind as SourceKind, config: prepared.row.config as SourceConfig, metadata }
      })
    },
    async querySource(token: string, input: unknown, payload: unknown = {}): Promise<QuerySnapshot> {
      const id = sourceId(input), query = object(payload, ['sql','sourceVersion'])
      if (query.sourceVersion !== undefined) positiveVersion(query.sourceVersion)
      const prepared = await access(token, async (c, p) => {
        const source = await get(c, p, id)
        if (!source.enabled) throw sourceError(409)
        const revision = query.sourceVersion ?? source.published_revision
        if (revision === null) throw sourceError(409)
        const row = (await c.query('SELECT * FROM data_source_versions WHERE deployment_id=$1 AND owner_id=$2 AND source_id=$3 AND revision=$4', [...scope(p, id), revision])).rows[0]
        if (!row) throw sourceError(404)
        return { row, secret: await readCredential(c, p, id, row) }
      })
      const result = await execute(prepared.row, prepared.secret, query)
      const snapshot = snapshotFor(prepared.row, result.execution, result.sql, result.rows)
      // No identity transaction is held over network I/O. Recheck revocation and
      // source state before releasing any data or writing a success audit.
      return access(token, async (c, p) => {
        // Lock the permanent root through the final authorization/audit commit.
        // A deleted scoped ID cannot be recreated, so this is the same instance.
        const current = await get(c, p, id, true)
        if (!current.enabled) throw sourceError(409)
        await audit(c, p, id, 'source_queried', { revision: prepared.row.revision, rows: snapshot.rows.length, truncated: snapshot.truncated, sha256: snapshot.sha256 })
        return snapshot
      })
    },
  })
}

function normalizedDecimal(value: string): string {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(value)
  if (!match) throw sourceError(502)
  let digits = (match[2] + (match[3] ?? '')).replace(/^0+/, ''), exponent = Number(match[4] ?? 0) - (match[3]?.length ?? 0)
  if (!digits) return '0'
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1_000_000) throw sourceError(502)
  while (digits.endsWith('0')) { digits = digits.slice(0, -1); exponent++ }
  return (match[1] === '-' ? '-' : '') + digits + 'e' + exponent
}
function exactNumber(input: unknown): number {
  const value = Number(input)
  if (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)) throw sourceError(502)
  // Numeric/DECIMAL are text until this boundary; reject silent precision loss.
  if (typeof input === 'string' && normalizedDecimal(input) !== normalizedDecimal(String(value))) throw sourceError(502)
  return value
}
function snapshotFor(row: Row, execution: SourceExecution, sql?: SqlRows, http?: unknown[]): QuerySnapshot {
  let schema: QueryColumn[], rows: Record<string, QueryCell>[]
  const units = row.config.units ?? {}, maxRows = execution.maxRows
  if (sql) {
    if (!sql.names.length || sql.names.length > 256 || new Set(sql.names).size !== sql.names.length) throw sourceError(502)
    schema = sql.names.map((name, i) => ({ name, type: sql.types[i], ...(Object.hasOwn(units, name) ? { unit: units[name] } : {}) }))
    rows = sql.rows.map(raw => Object.fromEntries(schema.map((column, i) => {
      let value: any = raw[i]
      if (value !== null) {
        if (column.type === 'number') { value = exactNumber(value); if (Object.is(value, -0)) value = 0 }
        else if (column.type === 'string') { if (value instanceof Date) value = value.toISOString(); else if (typeof value !== 'string') throw sourceError(502) }
        else if (typeof value !== 'boolean') throw sourceError(502)
      }
      return [column.name, value]
    })))
  } else {
    const rawRows = http ?? [], first = rawRows[0]
    if (!first || typeof first !== 'object' || Array.isArray(first)) throw sourceError(502)
    const names = Object.keys(first)
    if (!names.length || names.length > 256) throw sourceError(502)
    const bounded = rawRows.slice(0, maxRows + 1)
    schema = names.map(name => {
      const sample = bounded.map(raw => raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[name] : undefined).find(value => value !== null)
      const type = sample === undefined ? 'string' : typeof sample
      if (!['string','number','boolean'].includes(type)) throw sourceError(502)
      return { name, type: type as QueryColumn['type'], ...(Object.hasOwn(units, name) ? { unit: units[name] } : {}) }
    })
    rows = bounded.map(raw => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== names.length || names.some(name => !Object.hasOwn(raw, name))) throw sourceError(502)
      return raw as Record<string, QueryCell>
    })
  }
  try { return createQuerySnapshot({ sourceId: row.source_id, sourceVersion: row.revision, schema, timezone: row.config.timezone, rows, sourceTruncated: (sql?.rows.length ?? http?.length ?? 0) > maxRows }, { maxRows, maxBytes: execution.maxResponseBytes ?? 1_000_000 }) } catch { throw sourceError(502) }
}
export type SourceService = ReturnType<typeof createSourceService>
