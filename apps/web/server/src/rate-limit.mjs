/**
 * Single-process fixed window. This is not a multi-replica limiter.
 * The key must be the socket address, never a client-supplied header.
 */
export function createFixedWindowLimiter({ max, windowMs }) {
  const buckets = new Map()
  const capacity = 5000
  let lastNow = -Infinity
  return function hit(key, now = Date.now()) {
    // Keep insertion/expiry order stable if the wall clock moves backwards.
    now = lastNow = Math.max(lastNow, now)
    // All buckets use the same window and are inserted in clock order. Remove
    // only the expired prefix: repeated rejected sources never scan the table.
    for (const [name, bucket] of buckets) {
      if (now < bucket.resetAt) break
      buckets.delete(name)
    }
    const current = buckets.get(key)
    if (!current) {
      if (buckets.size >= capacity) {
        const first = buckets.values().next().value
        return { retryAfter: Math.max(1, Math.ceil((first.resetAt - now) / 1000)) }
      }
      buckets.set(key, { count: 1, resetAt: now + windowMs })
      return null
    }
    if (current.count < max) {
      current.count += 1
      return null
    }
    return { retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) }
  }
}
