import { createHash, randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { SourceExecution } from '../../../../../../packages/web-contracts/src/sources.ts'
import type { SourceEgressPolicy, SqlSourceKind } from '../../security/egress.ts'
import { sourceError } from './config.ts'
import { validateReadOnlySql, type SqlTableScope } from './sql-policy.ts'
import { DbhubPool } from './dbhub-pool.ts'
import type { SqlRows } from './sql-types.ts'

const DEFAULT_PACKAGE = '@bytebase/dbhub@2.1.0'
export const DBHUB_STARTUP_TIMEOUT_MS = 30_000

type DbhubSourceKind = Exclude<SqlSourceKind, 'postgres'>

export function dbhubDsn(target: Awaited<ReturnType<SourceEgressPolicy['sql']>>): string {
  // MySQL and StarRocks both use the MySQL wire protocol here.
  const tls = target.tls ? '' : '?ssl-mode=DISABLED'
  return `mysql://${encodeURIComponent(target.username)}:${encodeURIComponent(target.password)}@${target.address.includes(':') ? `[${target.address}]` : target.address}:${target.port}/${encodeURIComponent(target.database)}${tls}`
}

export function dbhubConfig(maxRows: number, timeoutMs: number): string {
  return `[[sources]]\nid = "default"\ndsn = "${'${DYOFFICE_DBHUB_DSN}'}"\nquery_timeout = ${Math.max(1, Math.ceil(timeoutMs / 1000))}\n\n[[tools]]\nname = "execute_sql"\nsource = "default"\nreadonly = true\nmax_rows = ${maxRows + 1}\n\n[[tools]]\nname = "search_objects"\nsource = "default"\n`
}

type DbhubTool = 'execute_sql' | 'search_objects'

function parseToolResult(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'structuredContent' in value) {
    const structured = (value as { structuredContent?: unknown }).structuredContent
    if (structured !== undefined) return structured
  }
  const content = value && typeof value === 'object' && 'content' in value ? (value as { content?: unknown }).content : undefined
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (!block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'text') continue
    const text = (block as { text?: unknown }).text
    if (typeof text !== 'string') continue
    try { return JSON.parse(text) as unknown } catch { /* continue */ }
  }
  return undefined
}

export function statementsToRows(payload: unknown): SqlRows {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { statements?: unknown }).statements)) throw sourceError(502)
  const statement = (payload as { statements: unknown[] }).statements[0]
  if (!statement || typeof statement !== 'object') throw sourceError(502)
  const rows = (statement as { rows?: unknown }).rows
  if (!Array.isArray(rows)) throw sourceError(502)
  if (!rows.length) return { names: [], rows: [], types: [] }
  if (rows.every(row => row && typeof row === 'object' && !Array.isArray(row))) {
    const names = Object.keys(rows[0] as object)
    const values = rows.map(row => names.map(name => (row as Record<string, unknown>)[name]))
    return { names, rows: values, types: names.map((_, index) => columnType(values, index)) }
  }
  if (!rows.every(row => Array.isArray(row))) throw sourceError(502)
  const width = (rows[0] as unknown[]).length
  const names = Array.from({ length: width }, (_, index) => `column_${index + 1}`)
  const values = rows as unknown[][]
  return { names, rows: values, types: names.map((_, index) => columnType(values, index)) }
}

function columnType(rows: unknown[][], index: number): 'string' | 'number' | 'boolean' {
  const sample = rows.map(row => row[index]).find(value => value !== null && value !== undefined)
  if (typeof sample === 'number' || typeof sample === 'bigint') return 'number'
  if (typeof sample === 'boolean') return 'boolean'
  return 'string'
}

type Session = { client: Client; close(): Promise<void> }
const bindings = new WeakMap<SourceEgressPolicy, { pool: DbhubPool<Session>; identity: string }>()

export function createDbhubRuntime() {
  const pool = new DbhubPool<Session>()
  return {
    bind(policy: SourceEgressPolicy, identity: readonly unknown[]) {
      const scoped = { ...policy }
      bindings.set(scoped, { pool, identity: JSON.stringify(identity) })
      return scoped
    },
    close: () => pool.close(),
  }
}

async function openSession(dsn: string, config: string, kind: DbhubSourceKind): Promise<Session> {
  const configPath = join(tmpdir(), `dyoffice-dbhub-${randomUUID()}.toml`)
  const client = new Client({ name: 'dyoffice-dbhub-client', version: '1.0.0' })
  const close = async () => { try { await client.close() } finally { await rm(configPath, { force: true }) } }
  try {
    await writeFile(configPath, config, { mode: 0o600, flag: 'wx' })
    const entry = process.env.DYOFFICE_DBHUB_ENTRY
    const preload = '--import=' + new URL('./dbhub-starrocks.mjs', import.meta.url).href
    const args = entry ? [...(kind === 'starrocks' ? [preload] : []), entry]
      : ['-y', ...(kind === 'starrocks' ? ['--node-options=' + preload] : []), process.env.DYOFFICE_DBHUB_PACKAGE || DEFAULT_PACKAGE]
    const transport = new StdioClientTransport({ command: entry ? process.execPath : process.env.DYOFFICE_DBHUB_COMMAND || 'npx',
      args: [...args, '--transport', 'stdio', '--config', configPath], env: { DYOFFICE_DBHUB_DSN: dsn, DYOFFICE_DBHUB_DIALECT: kind } })
    await client.connect(transport, { timeout: DBHUB_STARTUP_TIMEOUT_MS })
    return { client, close }
  } catch (error) { await close(); throw error }
}

async function callDbhub(policy: SourceEgressPolicy, kind: DbhubSourceKind, secret: string, tool: DbhubTool, args: Record<string, unknown>, execution: SourceExecution): Promise<unknown> {
  const target = await policy.sql(kind, secret)
  const timeoutMs = execution.statementTimeoutMs ?? 5000
  const config = dbhubConfig(execution.maxRows, timeoutMs), dsn = dbhubDsn(target)
  const start = () => openSession(dsn, config, kind)
  const run = async ({ client }: Session) => {
    if (!client.transport) throw new Error('DBHub disconnected')
    const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: timeoutMs + 4000 })
    if (result.isError) throw sourceError(400)
    const response = parseToolResult(result) as { success?: boolean; data?: unknown } | undefined
    if (response?.success !== true || response.data === undefined) throw sourceError(502)
    return response.data
  }
  try {
    const binding = bindings.get(policy)
    if (!binding) {
      const session = await start()
      try { return await run(session) } finally { await session.close() }
    }
    const key = createHash('sha256').update(JSON.stringify([binding.identity, kind, target, config])).digest('hex')
    return await binding.pool.use(key, start, run)
  } catch (error) {
    if ((error as { code?: number }).code === -32001) throw sourceError(504)
    if ((error as { statusCode?: number }).statusCode) throw error
    throw sourceError(502)
  }
}

export async function queryDbhubSource(policy: SourceEgressPolicy, kind: DbhubSourceKind, secret: string, sql: unknown, execution: SourceExecution, scope?: SqlTableScope): Promise<SqlRows> {
  const normalized = validateReadOnlySql(sql, kind, scope)
  return statementsToRows(await callDbhub(policy, kind, secret, 'execute_sql', { sql: normalized }, execution))
}

/** Use DBHub's schema search tool for metadata; it avoids connector-specific catalog SQL. */
export async function searchDbhubObjects(policy: SourceEgressPolicy, kind: DbhubSourceKind, secret: string, args: Record<string, unknown>, execution: SourceExecution): Promise<Record<string, unknown>> {
  const payload = await callDbhub(policy, kind, secret, 'search_objects', args, execution)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw sourceError(502)
  return payload as Record<string, unknown>
}
