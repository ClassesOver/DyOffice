/**
 * In-process stand-in for an S3-compatible bucket.
 * Its ETag is intentionally not a content hash. Callers must hash the bytes.
 */
export function createFakeBlobClient() {
  const objects = new Map()
  let serial = 0
  return {
    async put(key, bytes, { immutable = false } = {}) {
      if (typeof key !== 'string' || key.length === 0 || key.includes('..')) {
        throw Object.assign(new Error('UNSAFE_KEY'), { code: 'UNSAFE_KEY', status: 400 })
      }
      const existing = objects.get(key)
      if (existing && immutable) return { created: false, etag: existing.etag }
      const etag = `W/"not-sha-${++serial}"`
      objects.set(key, { bytes: Buffer.from(bytes), etag })
      return { created: !existing, etag }
    },
    async get(key) {
      const found = objects.get(key)
      return found ? Buffer.from(found.bytes) : null
    },
    async delete(key) {
      objects.delete(key)
    },
    async list(prefix) {
      return [...objects.keys()].filter((key) => key.startsWith(prefix)).sort()
    },
    replaceForTest(key, bytes) {
      const found = objects.get(key)
      if (!found) throw new Error('missing blob')
      found.bytes = Buffer.from(bytes)
    },
  }
}
