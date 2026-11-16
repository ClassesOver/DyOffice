/**
 * Single-process fixed window. This is not a multi-replica limiter.
 * The key must be the socket address, never a client-supplied header.
 */
export function createFixedWindowLimiter({ max, windowMs }) {
  const buckets = new Map()
  return function hit(key, now = Date.now()) {
    const current = buckets.get(key)
    if (!current || now >= current.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs })
      if (buckets.size > 5000) {
        for (const [name, bucket] of buckets) {
          if (now >= bucket.resetAt) buckets.delete(name)
        }
      }
      return null
    }
    current.count += 1
    if (current.count <= max) return null
    return { retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) }
  }
}
