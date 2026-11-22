import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { SourceEgressTarget } from '../../../../../packages/web-contracts/src/settings.ts'
import { publicAddress } from './ip-ranges.ts'
export type { SourceEgressTarget } from '../../../../../packages/web-contracts/src/settings.ts'

export type SqlSourceKind = 'postgres' | 'mysql' | 'starrocks'
const unavailable = () => Object.assign(new Error('Source target is not approved'), { statusCode: 400, code: 'SOURCE_TARGET_NOT_APPROVED' as const })
export function normalizePinnedAddress(value: string): string {
  const family = isIP(value)
  if (!family) throw unavailable()
  return family === 6 ? new URL(`http://[${value}]/`).hostname.slice(1, -1) : value
}
export function forbiddenPinnedAddress(ip: string): boolean {
  ip = normalizePinnedAddress(ip)
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number)
    return a === 0 || a === 169 && b === 254 || a >= 224 || ip === '100.100.100.200'
  }
  return ip === 'fd00:ec2::254' || ip === '::' || /^(fe[89ab]|ff|::ffff:)/.test(ip)
}
export function parseSourceDsn(kind: SqlSourceKind, secret: string) {
  try {
    const url = new URL(secret)
    if (url.protocol !== (kind === 'postgres' ? 'postgresql:' : kind + ':') || !url.hostname || !url.username || !url.password || url.search || url.hash) throw unavailable()
    const database = decodeURIComponent(url.pathname.slice(1)), username = decodeURIComponent(url.username), password = decodeURIComponent(url.password)
    if (!/^[A-Za-z_][A-Za-z0-9_$.-]{0,127}$/.test(database) || !/^[A-Za-z_][A-Za-z0-9_$.-]{0,127}$/.test(username) || !password || password.length > 4096) throw unavailable()
    const port = Number(url.port || (kind === 'postgres' ? 5432 : kind === 'starrocks' ? 9030 : 3306))
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw unavailable()
    return { hostname: url.hostname.replace(/^\[|\]$/g, ''), port, username, password, database, endpoint: `${url.protocol}//${url.hostname}:${port}` }
  } catch { throw unavailable() }
}
export function validateSourceEgressTargets(input: unknown): SourceEgressTarget[] {
  const targets = input as readonly SourceEgressTarget[]
  let approved: SourceEgressTarget[]
  try {
    if (!Array.isArray(targets) || targets.length > 256) throw unavailable()
    approved = targets.map(target => {
      if (!target || Object.keys(target).some(k => !['kind','endpoint','addresses','username','database','allowInsecure','ca'].includes(k)) || !['http','postgres','mysql','starrocks'].includes(target.kind) || typeof target.endpoint !== 'string' || target.endpoint.length > 8192 || !Array.isArray(target.addresses) || !target.addresses.length || target.addresses.length > 32 || target.allowInsecure !== undefined && typeof target.allowInsecure !== 'boolean' || target.ca !== undefined && typeof target.ca !== 'string') throw unavailable()
      if (target.addresses.some((ip: unknown) => typeof ip !== 'string')) throw unavailable()
      const addresses = target.addresses.map(normalizePinnedAddress)
      if (addresses.some(forbiddenPinnedAddress) || new Set(addresses).size !== addresses.length) throw unavailable()
      const url = new URL(target.endpoint)
      if (url.username || url.password || url.hash) throw unavailable()
      if (target.kind === 'http') {
        if (!['https:', ...(target.allowInsecure ? ['http:'] : [])].includes(url.protocol) || target.username !== undefined || target.database !== undefined) throw unavailable()
        return { ...target, endpoint: url.href, addresses: Object.freeze(addresses) }
      }
      const protocol = target.kind === 'postgres' ? 'postgresql:' : target.kind + ':'
      if (url.protocol !== protocol || url.search || !['','/'].includes(url.pathname) || typeof target.username !== 'string' || typeof target.database !== 'string') throw unavailable()
      const parsed = parseSourceDsn(target.kind, `${protocol}//${encodeURIComponent(target.username)}:unused@${url.host}/${encodeURIComponent(target.database)}`)
      return { ...target, endpoint: parsed.endpoint, addresses: Object.freeze(addresses) }
    })
  } catch { throw new Error('Invalid source egress configuration') }
  const keys = approved.map(target => JSON.stringify([target.kind, target.endpoint, target.username, target.database]))
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate source egress target')
  return approved
}
export function createSourceEgressPolicy(targets: readonly SourceEgressTarget[] = [], { allowUnlistedSql = false } = {}) {
  const approved = validateSourceEgressTargets(targets)
  // publicOnly: an administrator has not approved this host, so it may reach
  // only globally routable addresses, never loopback or a private network.
  async function resolve(hostname: string, addresses?: readonly string[], publicOnly = false) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const answers = await Promise.race([
        isIP(hostname) ? Promise.resolve([{ address: hostname, family: isIP(hostname) }]) : lookup(hostname, { all: true, verbatim: true }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(unavailable()), 3000) }),
      ])
      if (!answers.length || answers.length > 32 || answers.some(a => forbiddenPinnedAddress(a.address) || (publicOnly && !publicAddress(normalizePinnedAddress(a.address))) || (addresses && !addresses.includes(normalizePinnedAddress(a.address))))) throw unavailable()
      return { address: normalizePinnedAddress(answers[0].address), family: answers[0].family as 4 | 6 }
    } catch { throw unavailable() } finally { clearTimeout(timer) }
  }
  return Object.freeze({
    async http(secret: string) {
      let url: URL
      try { url = new URL(secret) } catch { throw unavailable() }
      if (url.username || url.password || url.hash) throw unavailable()
      const matches = approved.filter(p => p.kind === 'http' && p.endpoint === url.href)
      if (matches.length !== 1) throw unavailable()
      const target = matches[0]
      // Transport independently resolves/checks this complete pin set immediately before dialing.
      return { url: url.href, addresses: target.addresses, ca: target.ca, allowHttp: target.allowInsecure === true }
    },
    async sql(kind: SqlSourceKind, secret: string) {
      const parsed = parseSourceDsn(kind, secret)
      if (allowUnlistedSql && approved.every(target => target.kind === 'http')) {
        return { ...parsed, ...await resolve(parsed.hostname, undefined, true), tls: false, ca: undefined }
      }
      const matches = approved.filter(p => p.kind === kind && p.endpoint === parsed.endpoint && p.username === parsed.username && p.database === parsed.database)
      if (matches.length !== 1) throw unavailable()
      const target = matches[0], pinned = await resolve(parsed.hostname, target.addresses)
      return { ...parsed, ...pinned, tls: target.allowInsecure !== true, ca: target.ca }
    },
  })
}
export type SourceEgressPolicy = ReturnType<typeof createSourceEgressPolicy>
