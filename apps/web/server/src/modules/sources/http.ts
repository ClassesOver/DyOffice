import { createPinnedJsonClient } from '../../security/pinned-json.ts'
import type { SourceEgressPolicy } from '../../security/egress.ts'
import type { HttpSourceConfig, SourceExecution } from '../../../../../../packages/web-contracts/src/sources.ts'
import { sourceError } from './config.ts'

/** Reapprove every exact URL before opening a new pinned, header-free socket. */
export async function queryHttpSource(policy: SourceEgressPolicy, secret: string, config: HttpSourceConfig, execution: SourceExecution): Promise<unknown[]> {
  let url = secret
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), execution.requestTimeoutMs ?? 10_000)
  try {
    for (let hop = 0; hop <= 2; hop++) {
      if (controller.signal.aborted) throw sourceError(504)
      const target = await policy.http(url)
      const transport = createPinnedJsonClient({ source: target }, { timeoutMs: execution.requestTimeoutMs ?? 10_000, maxBytes: execution.maxResponseBytes ?? 1_000_000 })
      const result = await transport.getHop('source', controller.signal)
      if (result.kind === 'redirect') {
        if (hop === 2) throw sourceError()
        const next = new URL(result.location, url)
        if (new URL(url).protocol === 'https:' && next.protocol !== 'https:') throw sourceError()
        url = next.href
        continue
      }
      let rows: unknown = result.body
      if (config.rowPath) for (const part of config.rowPath.split('.')) {
        if (!rows || typeof rows !== 'object' || !Object.hasOwn(rows, part)) throw sourceError(502)
        rows = (rows as Record<string, unknown>)[part]
      }
      else if (!Array.isArray(rows) && rows && typeof rows === 'object' && Object.hasOwn(rows, 'rows')) rows = (rows as Record<string, unknown>).rows
      if (!Array.isArray(rows)) throw sourceError(502)
      return rows
    }
    throw sourceError()
  } catch (error) {
    if (controller.signal.aborted) throw sourceError(504)
    if ((error as { statusCode?: number }).statusCode === 400) throw sourceError()
    throw sourceError(502)
  } finally { clearTimeout(timer) }
}
