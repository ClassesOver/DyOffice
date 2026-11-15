import { createHmac } from 'node:crypto'
import { isIP } from 'node:net'

const DEFAULT_LIMITS = Object.freeze({
  global: { maxAttempts: 600, windowMs: 60_000 },
  ip: { maxAttempts: 40, windowMs: 60_000 },
  account: { maxAttempts: 12, windowMs: 15 * 60_000 },
})
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ACCOUNT = /^[a-z][a-z0-9._-]{2,63}$/

const CLAIM = [
  'INSERT INTO dyoffice_login_rate_buckets AS b (bucket_key, window_started, attempts, updated_at)',
  'VALUES ($1::bytea, clock_timestamp(), 1, clock_timestamp())',
  'ON CONFLICT (bucket_key) DO UPDATE SET',
  "attempts = CASE WHEN b.window_started <= clock_timestamp() - ($2::bigint * INTERVAL '1 millisecond')",
  'THEN 1 ELSE LEAST(b.attempts + 1, 2147483647) END,',
  "window_started = CASE WHEN b.window_started <= clock_timestamp() - ($2::bigint * INTERVAL '1 millisecond')",
  'THEN clock_timestamp() ELSE b.window_started END,',
  'updated_at = clock_timestamp()',
  'RETURNING attempts',
].join(' ')

/** Expand a valid IPv6 literal (no zone) to eight 16-bit groups. */
function ipv6Groups(address) {
  let text = address.toLowerCase()
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (tail) {
    const [a, b, c, d] = tail[1].split('.').map(Number)
    text = text.slice(0, -tail[1].length) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16)
  }
  const [head, rest] = text.split('::')
  const left = head ? head.split(':') : []
  const right = rest === undefined ? [] : rest ? rest.split(':') : []
  const fill = rest === undefined ? [] : new Array(8 - left.length - right.length).fill('0')
  return [...left, ...fill, ...right].map(group => parseInt(group, 16))
}

/**
 * Per-IP budget identity. One IPv6 client typically controls a whole /64, so
 * IPv6 is counted per /64; IPv4-mapped IPv6 shares the plain IPv4 budget.
 */
export function ipBudgetIdentity(ipAddress) {
  const address = ipAddress.split('%')[0]
  if (isIP(address) === 4) return address
  const groups = ipv6Groups(address)
  if (groups.slice(0, 5).every(g => g === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join('.')
  }
  return groups.slice(0, 4).map(g => g.toString(16)).join(':') + '::/64'
}

function validateLimits(limits) {
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) throw new TypeError('Invalid login limit policy')
  const copy = {}
  for (const category of ['global','ip','account']) {
    const value = limits[category]
    if (!value || !Number.isSafeInteger(value.maxAttempts) || value.maxAttempts < 1 || value.maxAttempts > 100_000 ||
        !Number.isSafeInteger(value.windowMs) || value.windowMs < 1_000 || value.windowMs > 24 * 60 * 60 * 1000) {
      throw new TypeError('Invalid login rate window ' + category)
    }
    copy[category] = { maxAttempts: value.maxAttempts, windowMs: value.windowMs }
  }
  return Object.freeze(copy)
}

/**
 * PostgreSQL-backed attempt budgets across every app instance. Claims happen
 * BEFORE password hashing. There is deliberately no per-process fail-open path.
 *
 * Callers must supply the IP from the trusted socket / configured proxy, never
 * directly from a user-supplied X-Forwarded-For header.
 */
export function createPgLoginThrottle({ pool, hmacKey, limits = DEFAULT_LIMITS } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('PostgreSQL pool required')
  if (!(hmacKey instanceof Uint8Array) || hmacKey.byteLength < 32) throw new TypeError('Login throttle HMAC key must be at least 32 random bytes')
  const key = Buffer.from(hmacKey)
  const policy = validateLimits(limits)
  function bucket(deploymentId, category, identity) {
    return createHmac('sha256', key).update('dyoffice-login-v1\0')
      .update(deploymentId.toLowerCase()).update('\0').update(category).update('\0').update(identity).digest()
  }
  return Object.freeze({
    async consume({ deploymentId, usernameNormalized, ipAddress }) {
      if (typeof deploymentId !== 'string' || !UUID.test(deploymentId) ||
          typeof usernameNormalized !== 'string' || !ACCOUNT.test(usernameNormalized) ||
          typeof ipAddress !== 'string' || !isIP(ipAddress)) {
        throw new TypeError('Invalid login throttle identity')
      }
      // Global first means a flooded deployment stops creating arbitrary
      // per-account/IP rows once the shared budget is exceeded. Uniform order
      // across all requests prevents deadlocks under contention.
      const buckets = [
        { category: 'global', identity: deploymentId },
        { category: 'ip', identity: ipBudgetIdentity(ipAddress) },
        { category: 'account', identity: usernameNormalized },
      ]
      const client = await pool.connect()
      let begun = false
      try {
        await client.query('BEGIN')
        begun = true
        let allowed = true
        for (const {category, identity} of buckets) {
          const limit = policy[category]
          const result = await client.query(CLAIM, [bucket(deploymentId, category, identity), limit.windowMs])
          if (result.rowCount !== 1 || !Number.isSafeInteger(result.rows[0]?.attempts)) {
            throw new Error('Login throttle counter unavailable')
          }
          if (result.rows[0].attempts > limit.maxAttempts) {
            allowed = false
            break
          }
        }
        await client.query('COMMIT')
        begun = false
        return { allowed }
      } catch (error) {
        if (begun) await client.query('ROLLBACK').catch(() => {})
        throw new Error('Login throttle unavailable', { cause: error })
      } finally {
        client.release()
      }
    },
  })
}
