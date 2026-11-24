import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { BusinessPrincipal, PrincipalTransactions } from '../../db/context.ts'
import type { SourceConfig, SourceDescriptor, SourceDetail, SourceDiscovery, SourceExecution, SourceKind, SourceList, QuerySnapshot, QueryColumn, QueryCell } from '../../../../../../packages/web-contracts/src/sources.ts'
import { createSourceEgressPolicy, parseSourceDsn, type SourceEgressPolicy, type SourceEgressTarget } from '../../security/egress.ts'
import { readSourceEgressTargets } from '../admin/service.ts'
import { tokenHash } from '../auth/sessions.ts'
import { createCredentialVault } from './vault.ts'
import { contentHash, executionFor, object, positiveVersion, secretHash, sourceConfig, sourceError, sourceId, sourceName, validateSourceSecret } from './config.ts'
import { createDbhubRuntime, searchDbhubObjects } from './dbhub.ts'
import { queryHttpSource } from './http.ts'
import { querySqlSource, type SqlRows } from './sql.ts'
import { createQuerySnapshot, fitSnapshotRows } from './provenance.ts'
import { withAssistantErrorCode } from '../../../../../../packages/web-contracts/src/assistant-errors.ts'

import { MAX_DESCRIBE_TABLES } from '../../../../../../packages/web-contracts/src/source-tools.ts'

type Row = Record<string, any>
const userSchemaFilter = "LOWER(table_schema) NOT IN ('information_schema','mysql','sys','performance_schema') AND SUBSTRING(LOWER(table_schema), 1, 3) <> 'pg_'"
const scope = (p: BusinessPrincipal, id: string) => [p.deploymentId, p.userId, id]
const joined = `SELECT s.*,d.version,d.kind,d.name,d.config,d.credential_ref,d.credential_revision,d.content_hash FROM data_sources s JOIN data_source_drafts d USING(deployment_id,owner_id,source_id)`
const descriptor = (row: Row): SourceDescriptor => ({ sourceId: row.source_id, name: row.name, kind: row.kind, version: row.version, enabled: row.enabled, hasCredential: row.credential_ref !== null, updatedAt: new Date(row.updated_at).toISOString() })

/** Read catalog metadata for an already authorized source. */
export async function describeSourceMetadata(
  { row, secret, policy }: { row: Row; secret: string; policy: SourceEgressPolicy },
  payload: unknown = {},
): Promise<(QuerySnapshot & { readonly nextOffset?: number | null }) | null> {
  const request = object(payload, ['table','tables','schema','tablePrefix','columnOffset'])
  const batch = request.tables !== undefined
  if (batch && (request.table !== undefined || !Array.isArray(request.tables) || !request.tables.length || request.tables.length > MAX_DESCRIBE_TABLES)) throw sourceError()
  const names: string[] = batch ? request.tables : request.table === undefined ? [] : [request.table]
  if (names.some(table => typeof table !== 'string' || !/^[A-Za-z_][A-Za-z0-9_$]{0,127}(?:\.[A-Za-z_][A-Za-z0-9_$]{0,127})?$/.test(table))) throw sourceError()
  const { schema, tablePrefix, columnOffset = 0 } = request
  for (const filter of [schema, tablePrefix]) {
    if (filter !== undefined && (typeof filter !== 'string' || !/^[A-Za-z_][A-Za-z0-9_$]{0,127}$/.test(filter))) throw sourceError()
  }
  if (names.length && (schema !== undefined || tablePrefix !== undefined)) throw sourceError()
  if (request.columnOffset !== undefined && (!names.length || !Number.isSafeInteger(columnOffset) || columnOffset < 0)) throw sourceError()
  if (row.kind === 'http') {
    if (batch || request.columnOffset !== undefined) throw sourceError()
    return null
  }
  const database = row.kind === 'postgres' ? 'public' : parseSourceDsn(row.kind, secret).database
  const schemas: string[] | undefined = row.config.allowedSchemas
  const schemaAllowed = (table: string) => !schemas || schemas.includes(table.slice(0, table.indexOf('.')))
  const allowed: string[] | undefined = row.config.allowedTables
    ?.map((table: string) => table.includes('.') ? table : `${database}.${table}`).filter(schemaAllowed)
  const requested = [...new Set(names.map(table => table.includes('.') ? table : `${database}.${table}`))]
  for (const table of requested) {
    if (!schemaAllowed(table) || (allowed ? !allowed.includes(table) : /^(?:pg_|information_schema\.|mysql\.|sys\.|performance_schema\.)/i.test(table))) throw withAssistantErrorCode(sourceError(403), 'SOURCE_SCOPE_DENIED')
  }
  // 单表使用原生搜索；宽表和批量查询沿用支持偏移量的 DBHub 目录查询。
  if (!batch && requested.length === 1 && columnOffset === 0) {
    const [schema, table] = requested[0]!.split('.')
    const execution = { ...executionFor(row.kind, row.config), maxRows: 1000 }
    const page = await searchDbhubObjects(policy, row.kind, secret, { object_type: 'column', schema, table, detail_level: 'summary', limit: 1000 }, execution)
    if (!Array.isArray(page.results)) throw sourceError(502)
    if (page.truncated === false && page.results.length) {
      const rows = page.results.map(column => {
        if (column?.schema !== schema || column.table !== table || typeof column.name !== 'string' || typeof column.type !== 'string' || typeof column.nullable !== 'boolean') throw sourceError(502)
        return [column.name, column.type, column.nullable ? 'YES' : 'NO']
      })
      const snapshot = snapshotFor({ ...row, config: { ...row.config, units: {} } }, execution, { names: ['column_name','data_type','is_nullable'], types: ['string','string','string'], rows })
      return { ...snapshot, nextOffset: snapshot.truncated ? snapshot.rows.length : null }
    }
  }
  const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'"
  const predicate = (table: string) => {
    const dot = table.indexOf('.')
    return `(table_schema = ${literal(table.slice(0, dot))} AND table_name = ${literal(table.slice(dot + 1))})`
  }
  // Apply scope inside the fixed catalog query so unrelated names never leave the target.
  const where = requested.length ? requested.map(predicate).join(' OR ')
    : allowed ? allowed.length ? allowed.map(predicate).join(' OR ') : '1 = 0'
    : schemas ? schemas.length ? `table_schema IN (${schemas.map(literal).join(', ')})` : '1 = 0'
    : row.kind === 'postgres' ? userSchemaFilter : `table_schema = ${literal(database)}`
  const filters = [
    schema === undefined ? '' : ` AND table_schema = ${literal(schema)}`,
    tablePrefix === undefined ? '' : ` AND SUBSTRING(LOWER(table_name), 1, ${tablePrefix.length}) = ${literal(tablePrefix.toLowerCase())}`,
  ].join('')
  const maxRows = 1000
  const execution = { ...executionFor(row.kind, row.config), maxRows }
  const tableKeys = batch ? 'table_schema, table_name, ' : ''
  const sql = requested.length
    ? `SELECT ${tableKeys}column_name, data_type, is_nullable FROM information_schema.columns WHERE ${where} ORDER BY ${tableKeys}ordinal_position LIMIT ${maxRows + 1} OFFSET ${columnOffset}`
    : `SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE (${where})${filters} ORDER BY table_name, table_schema`
  const allowedTables = [requested.length ? 'information_schema.columns' : 'information_schema.tables']
  const result = await querySqlSource(policy, row.kind, secret, sql, execution, { defaultSchema: database, allowedTables })
  const snapshot = snapshotFor({ ...row, config: { ...row.config, units: {} } }, execution, result)
  return requested.length ? { ...snapshot, nextOffset: snapshot.truncated ? columnOffset + snapshot.rows.length : null } : snapshot
}

export function createSourceService({ transactions, credentialKeys = '', egressTargets }: { transactions: PrincipalTransactions; credentialKeys?: string; egressTargets?: readonly SourceEgressTarget[] }) {
  const vault = createCredentialVault(credentialKeys)
  const dbhub = createDbhubRuntime()
  const fixedPolicy = egressTargets === undefined ? undefined : createSourceEgressPolicy(egressTargets)
  async function sourcePolicy(connection: PoolClient, principal: BusinessPrincipal, token: string, row: Row) {
    let policy = fixedPolicy
    if (!policy) {
      await connection.query("SELECT set_config('dyoffice.global_session_hash',$1,true),set_config('dyoffice.global_idle_ms',$2,true)", [tokenHash(token), String(transactions.sessionIdleMs)])
      policy = createSourceEgressPolicy(await readSourceEgressTargets(connection, principal.deploymentId), { allowUnlistedSql: true })
    }
    return dbhub.bind(policy, [principal.deploymentId, principal.userId, row.source_id, row.version])
  }
  async function access<T>(token: string, operation: (connection: PoolClient, principal: BusinessPrincipal) => Promise<T>): Promise<T> {
    return transactions.withPrincipalTransaction({ kind: 'session', token }, async (connection, principal) => {
      if (!principal.roles.includes('personal') || principal.job) throw sourceError(404)
      return operation(connection, principal)
    })
  }
  async function audit(c: PoolClient, p: BusinessPrincipal, id: string, action: string, detail: Row = {}) {
    await c.query('INSERT INTO data_source_audit(id,deployment_id,owner_id,source_id,actor_id,session_id,action,detail) VALUES($1,$2,$3,$4,$3,$5,$6,$7::jsonb)', [randomUUID(), ...scope(p, id), p.sessionId, action, JSON.stringify(detail)])
  }
  async function get(c: PoolClient, p: BusinessPrincipal, id: string, lock: boolean | 'share' = false): Promise<Row> {
    const lockRows = lock === 'share' ? ' FOR SHARE OF s,d' : lock ? ' FOR UPDATE OF s,d' : ''
    const row = (await c.query(joined + ' WHERE s.deployment_id=$1 AND s.owner_id=$2 AND s.source_id=$3 AND s.deleted_at IS NULL' + lockRows, scope(p, id))).rows[0]
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
  async function execute(policy: SourceEgressPolicy, row: Row, secret: string, query: Record<string, any>) {
    const execution: SourceExecution = row.execution ?? executionFor(row.kind, row.config)
    if (row.kind === 'http') {
      if (query.sql !== undefined) throw sourceError()
      return { rows: await queryHttpSource(policy, secret, row.config, execution), execution }
    }
    return { sql: await querySqlSource(policy, row.kind, secret, query.sql, execution, { allowedTables: row.config.allowedTables, allowedSchemas: row.config.allowedSchemas, defaultSchema: row.kind === 'postgres' ? 'public' : parseSourceDsn(row.kind, secret).database }), execution }
  }
  return Object.freeze({
    close: dbhub.close,
    /** AI metadata projection: current saved names only, never credentials or configs. */
    async listSavedMetadata(token: string, input: unknown = {}) {
      const query = object(input, ['after'])
      const after = query.after === undefined ? '' : sourceId(query.after)
      return access(token, async (c, p) => {
        const rows = (await c.query(`SELECT s.source_id,d.name,d.kind,d.version
          FROM data_sources s JOIN data_source_drafts d USING(deployment_id,owner_id,source_id)
          WHERE s.deployment_id=$1 AND s.owner_id=$2 AND s.source_id>$3
            AND s.deleted_at IS NULL AND s.enabled=true AND d.credential_ref IS NOT NULL
          ORDER BY s.source_id LIMIT 51`, [p.deploymentId,p.userId,after])).rows
        return {items: rows.slice(0,50).map(row => ({sourceId: row.source_id as string, name: row.name as string, kind: row.kind as SourceKind, sourceVersion: row.version as number})), nextCursor: rows.length > 50 ? rows[49].source_id as string : null}
      })
    },
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
    async detail(token: string, input: unknown, lockCurrent = false): Promise<SourceDetail> {
      const id = sourceId(input)
      return access(token, async (c, p) => {
        const row = await get(c, p, id, lockCurrent ? 'share' : false)
        return { source: descriptor(row), config: row.config }
      })
    },
    async create(token: string, input: unknown): Promise<SourceDescriptor> {
      const value = object(input, ['sourceId','name','kind','config','secret','enabled'])
      const id = sourceId(value.sourceId), name = sourceName(value.name), kind = value.kind as SourceKind
      if (!['http','postgres','mysql','starrocks'].includes(kind)) throw sourceError()
      if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw sourceError()
      const config = sourceConfig(kind, value.config ?? {}), secret = validateSourceSecret(kind, value.secret, config)
      return access(token, async (c, p) => {
        if (!vault.available) throw sourceError(503)
        const inserted = await c.query('INSERT INTO data_sources(deployment_id,owner_id,source_id,enabled) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING source_id', [...scope(p, id), value.enabled ?? true])
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
        const policy = await sourcePolicy(c, p, token, row)
        try { return { row, policy, secret: await readCredential(c, p, id, row) } } catch { return { row, policy, secret: null } }
      })
      let ok = false, code = 'SOURCE_UNAVAILABLE'
      if (prepared.secret) try { await execute(prepared.policy, prepared.row, prepared.secret, prepared.row.kind === 'http' ? {} : { sql: 'SELECT 1 AS connection_ok' }); ok = true } catch (error) { const { statusCode: status, code: failure } = error as { statusCode?: number; code?: string }; code = failure === 'SOURCE_TLS_UNSUPPORTED' ? failure : status === 400 ? 'TARGET_NOT_APPROVED' : status === 403 ? 'READONLY_ROLE_REQUIRED' : status === 504 ? 'SOURCE_TIMEOUT' : 'SOURCE_UNAVAILABLE' }
      return access(token, async (c, p) => {
        // Lock the permanent root through the final authorization/audit commit.
        // A deleted scoped ID cannot be recreated, so this is the same instance.
        const current = await get(c, p, id, true)
        if (!current.enabled || current.version !== prepared.row.version) throw sourceError(409)
        await audit(c, p, id, 'source_tested', { ok, version: current.version })
        return { ok, kind: prepared.row.kind as SourceKind, ...(ok ? {} : { code }) }
      })
    },
    async discover(token: string, input: unknown, payload: unknown): Promise<SourceDiscovery> {
      const id = sourceId(input), request = object(payload, ['expectedVersion','directory','page'])
      const version = positiveVersion(request.expectedVersion)
      const page = request.page === undefined ? undefined : positiveVersion(request.page)
      const maxRows = page === undefined ? 1000 : 50
      const directory = request.directory
      const selectable = (name: unknown): name is string => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_$]{0,127}$/.test(name)
      const userDirectory = (name: unknown): name is string => selectable(name) && !/^(?:pg_|information_schema$|mysql$|sys$|performance_schema$)/i.test(name)
      if (directory !== undefined && !userDirectory(directory)) throw sourceError()
      const prepared = await access(token, async (c, p) => {
        const row = await get(c, p, id)
        if (row.version !== version || !row.enabled) throw sourceError(409)
        if (row.kind === 'http') throw sourceError(400)
        return {row, secret: await readCredential(c,p,id,row), policy: await sourcePolicy(c,p,token,row)}
      })
      const {row,secret,policy} = prepared
      const connectedDatabase = parseSourceDsn(row.kind,secret).database
      if (row.kind !== 'postgres' && directory !== undefined && directory !== connectedDatabase) throw withAssistantErrorCode(sourceError(403), 'SOURCE_SCOPE_DENIED')
      // Only fixed metadata queries run here. The optional filter names one
      // validated directory; no query, DSN or account comes from this request.
      const quote = (name: string) => "'" + name.replaceAll("'", "''") + "'"
      const condition = directory !== undefined ? `table_schema = ${quote(directory)}`
        : row.kind !== 'postgres' ? `table_schema = ${quote(connectedDatabase)}`
        : userSchemaFilter
      const column = directory === undefined ? 'table_schema' : 'table_name'
      const window = page === undefined ? '' : ` LIMIT ${maxRows + 1} OFFSET ${(page - 1) * maxRows}`
      const sql = `SELECT DISTINCT ${column} FROM information_schema.tables WHERE ${condition} ORDER BY ${column}${window}`
      const result = await querySqlSource(policy,row.kind,secret,sql,{...executionFor(row.kind,row.config),maxRows},
        {defaultSchema:row.kind === 'postgres' ? 'public' : connectedDatabase,allowedTables:['information_schema.tables']})
      return access(token, async (c,p) => {
        const current = await get(c,p,id,true)
        if (!current.enabled || current.version !== version) throw sourceError(409)
        return {...(page === undefined ? {} : {page}),items:result.rows.slice(0,maxRows).map(([name])=>name).filter(directory === undefined ? userDirectory : selectable),truncated:result.rows.length > maxRows}
      })
    },
    async describe(token: string, input: unknown, payload: unknown = {}) {
      const id = sourceId(input)
      const prepared = await access(token, async (c, p) => {
        const row = await get(c, p, id)
        if (!row.enabled) throw sourceError(409)
        return { row, secret: await readCredential(c, p, id, row), policy: await sourcePolicy(c, p, token, row) }
      })
      const metadata = await describeSourceMetadata(prepared, payload)
      return access(token, async (c, p) => {
        const current = await get(c, p, id, true)
        if (!current.enabled || current.version !== prepared.row.version) throw sourceError(409)
        return { sourceId: id, sourceVersion: prepared.row.version as number, kind: prepared.row.kind as SourceKind, config: prepared.row.config as SourceConfig, metadata }
      })
    },
    async querySource(token: string, input: unknown, payload: unknown = {}, expectedVersion?: number): Promise<QuerySnapshot> {
      const id = sourceId(input), query = object(payload, ['sql'])
      const prepared = await access(token, async (c, p) => {
        const source = await get(c, p, id)
        // A batch may execute only against the connection it pinned before its first statement.
        if (!source.enabled || expectedVersion !== undefined && source.version !== expectedVersion) throw sourceError(409)
        const row: Row = { ...source, execution: executionFor(source.kind, source.config) }
        return { row, secret: await readCredential(c, p, id, row), policy: await sourcePolicy(c, p, token, row) }
      })
      const result = await execute(prepared.policy, prepared.row, prepared.secret, query)
      const snapshot = snapshotFor(prepared.row, result.execution, result.sql, result.rows)
      // No identity transaction is held over network I/O. Recheck revocation and
      // source state before releasing any data or writing a success audit.
      return access(token, async (c, p) => {
        // Lock the permanent root through the final authorization/audit commit.
        // A deleted scoped ID cannot be recreated, so this is the same instance.
        const current = await get(c, p, id, true)
        if (!current.enabled || current.version !== prepared.row.version) throw sourceError(409)
        await audit(c, p, id, 'source_queried', { version: prepared.row.version, rows: snapshot.rows.length, truncated: snapshot.truncated, sha256: snapshot.sha256 })
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
/** Exported for the offline analysis evaluation harness (tools/dyoffice/analysis-eval). */
export function snapshotFor(row: Row, execution: SourceExecution, sql?: SqlRows, http?: unknown[]): QuerySnapshot {
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
  const maxBytes = execution.maxResponseBytes ?? 1_000_000
  const fitted = fitSnapshotRows({ sourceId: row.source_id, sourceVersion: row.version, schema, timezone: row.config.timezone, rows }, { maxRows, maxBytes })
  // A single row larger than the whole budget leaves nothing to show: fail rather than return an empty result.
  if (fitted.truncated && !fitted.rows.length && rows.length) throw sourceError(502)
  rows = fitted.rows
  const sourceTruncated = fitted.truncated || (sql?.rows.length ?? http?.length ?? 0) > maxRows
  try { return createQuerySnapshot({ sourceId: row.source_id, sourceVersion: row.version, schema, timezone: row.config.timezone, rows, sourceTruncated }, { maxRows, maxBytes }) } catch { throw sourceError(502) }
}
export type SourceService = ReturnType<typeof createSourceService>
