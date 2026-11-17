import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request } from 'node:https'
import { request as requestHttp } from 'node:http'
import { normalizePinnedAddress as address, forbiddenPinnedAddress as forbidden } from './egress.ts'

export type PinnedJsonTarget = Readonly<{ url: string; addresses: readonly string[]; ca?: string; allowHttp?: boolean }>
export type PinnedJsonHop = { kind: 'json'; body: unknown } | { kind: 'redirect'; location: string }
const failure = () => new Error('Source request failed')
function invalid(): never { throw new Error('Invalid egress configuration') }
/** Trusted server-side targets only. No ambient proxy/agent or caller headers.
 * get() never redirects; getHop() returns a location without dialing it. The
 * source service must approve each exact next URL before creating its transport.
 */
export function createPinnedJsonClient(targets: Readonly<Record<string, PinnedJsonTarget>>, { timeoutMs = 10_000, maxBytes = 1_000_000 }: { timeoutMs?: number; maxBytes?: number } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8_000_000) invalid()
  const configs = new Map<string, { url: URL; addresses: readonly string[]; ca?: string }>()
  for (const [id, target] of Object.entries(targets)) {
    try {
      const url = new URL(target.url)
      if (!id || !['https:', ...(target.allowHttp === true ? ['http:'] : [])].includes(url.protocol) || url.username || url.password || url.hash || !Array.isArray(target.addresses) || !target.addresses.length || target.addresses.length > 32) invalid()
      const addresses = target.addresses.map(address)
      if (addresses.some(forbidden) || target.ca !== undefined && typeof target.ca !== 'string') invalid()
      configs.set(id, { url, addresses: Object.freeze(addresses), ca: target.ca })
    } catch { invalid() }
  }
  async function getHop(sourceId: string, signal?: AbortSignal, redirects = true): Promise<PinnedJsonHop> {
    const config = configs.get(sourceId)
    if (!config || signal?.aborted) throw failure()
    const controller = new AbortController(), cancel = () => controller.abort()
    signal?.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(cancel, timeoutMs)
    let rejectAbort: (() => void) | undefined
    try {
      const aborted = new Promise<never>((_, reject) => { rejectAbort = () => reject(failure()); controller.signal.addEventListener('abort', rejectAbort, { once: true }) })
      const operation = (async () => {
        const hostname = config.url.hostname.replace(/^\[|\]$/g, '')
        const answers = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true, verbatim: true })
        if (controller.signal.aborted || !answers.length || answers.length > 32 || answers.some(a => forbidden(a.address) || !config.addresses.includes(address(a.address)))) throw failure()
        const pinned = address(answers[0].address)
        return await new Promise<PinnedJsonHop>((resolve, reject) => {
          const send = config.url.protocol === 'https:' ? request : requestHttp
          const req = send({ protocol: config.url.protocol, hostname: pinned, family: answers[0].family, port: config.url.port || (config.url.protocol === 'https:' ? 443 : 80), path: config.url.pathname + config.url.search, method: 'GET', headers: { host: config.url.host, accept: 'application/json', 'accept-encoding': 'identity' }, servername: isIP(hostname) ? undefined : hostname, rejectUnauthorized: true, ca: config.ca, agent: false, maxHeaderSize: 16_384, signal: controller.signal }, res => {
            if (redirects && [301,302,303,307,308].includes(res.statusCode ?? 0) && res.headers.location && res.headers.location.length <= 8192) {
              const location = res.headers.location
              res.destroy(); resolve({ kind: 'redirect', location }); return
            }
            const type = res.headers['content-type']?.split(';', 1)[0].trim().toLowerCase()
            if (res.statusCode !== 200 || type !== 'application/json' || res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') { res.destroy(); reject(failure()); return }
            const chunks: Buffer[] = []; let bytes = 0
            res.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > maxBytes) { res.destroy(); reject(failure()) } else chunks.push(chunk) })
            res.on('error', () => reject(failure())); res.on('aborted', () => reject(failure()))
            res.on('end', () => { try { const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); resolve({ kind: 'json', body: JSON.parse(text) }) } catch { reject(failure()) } })
          })
          req.on('error', () => reject(failure())); req.end()
        })
      })()
      return await Promise.race([operation, aborted])
    } catch { throw failure() } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel)
      if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort)
    }
  }
  return Object.freeze({
    getHop: (sourceId: string, signal?: AbortSignal) => getHop(sourceId, signal),
    async get(sourceId: string, signal?: AbortSignal): Promise<unknown> {
      const result = await getHop(sourceId, signal, false)
      if (result.kind !== 'json') throw failure()
      return result.body
    },
  })
}
