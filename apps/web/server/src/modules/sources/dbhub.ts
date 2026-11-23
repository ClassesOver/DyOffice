import { randomUUID } from 'node:crypto'
import { chmod, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { SourceExecution } from '../../../../../../packages/web-contracts/src/sources.ts'
import type { SourceEgressPolicy, SqlSourceKind } from '../../security/egress.ts'
import { sourceError } from './config.ts'
import type { SqlRows } from './sql-types.ts'

const DEFAULT_PACKAGE = '@bytebase/dbhub@latest'

export function dbhubDsn(kind: SqlSourceKind, target: Awaited<ReturnType<SourceEgressPolicy['sql']>>): string {
  // DBHub supports MySQL, and StarRocks exposes the MySQL wire protocol.
  const scheme = kind === 'postgres' ? 'postgresql' : 'mysql'
  const tls = target.tls ? '' : '?ssl-mode=DISABLED'
  return `${scheme}://${encodeURIComponent(target.username)}:${encodeURIComponent(target.password)}@${target.address.includes(':') ? `[${target.address}]` : target.address}:${target.port}/${encodeURIComponent(target.database)}${tls}`
}

export function dbhubConfig(maxRows: number, timeoutMs: number): string {
  return `[[sources]]\nid = "default"\ndsn = "${'${DYOFFICE_DBHUB_DSN}'}"\nquery_timeout = ${Math.max(1, Math.ceil(timeoutMs / 1000))}\n\n[[tools]]\nname = "execute_sql"\nreadonly = true\nmax_rows = ${maxRows + 1}\n`
}

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

export async function queryDbhubSource(policy: SourceEgressPolicy, kind: SqlSourceKind, secret: string, sql: string, execution: SourceExecution): Promise<SqlRows> {
  const target = await policy.sql(kind, secret)
  const timeoutMs = execution.statementTimeoutMs ?? 5000
  const configPath = join(tmpdir(), `dyoffice-dbhub-${randomUUID()}.toml`)
  await writeFile(configPath, dbhubConfig(execution.maxRows, timeoutMs), { encoding: 'utf8', mode: 0o600 })
  await chmod(configPath, 0o600)
  const command = process.env.DYOFFICE_DBHUB_COMMAND || 'npx'
  const packageName = process.env.DYOFFICE_DBHUB_PACKAGE || DEFAULT_PACKAGE
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('DBHub query timed out', 'TimeoutError')), timeoutMs + 5000)
  const client = new Client({ name: 'dyoffice-dbhub-client', version: '1.0.0' })
  try {
    const transport = new StdioClientTransport({ command, args: ['-y', packageName, '--transport', 'stdio', '--config', configPath], env: { ...process.env, DYOFFICE_DBHUB_DSN: dbhubDsn(kind, target) } })
    await client.connect(transport)
    const result = await client.callTool({ name: 'execute_sql', arguments: { sql } }, undefined, { signal: controller.signal, timeout: timeoutMs + 4000 })
    if (result.isError) throw sourceError(400)
    const parsed = parseToolResult(result)
    return statementsToRows(parsed)
  } catch (error) {
    if (controller.signal.aborted) throw sourceError(504)
    if ((error as { statusCode?: number }).statusCode) throw error
    throw sourceError(502)
  } finally {
    clearTimeout(timer)
    controller.abort()
    await client.close().catch(() => {})
    await rm(configPath, { force: true }).catch(() => {})
  }
}
