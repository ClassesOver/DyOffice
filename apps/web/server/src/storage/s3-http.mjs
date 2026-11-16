import { createHash, createHmac } from 'node:crypto'

const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest()
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

function canonicalQuery(query) {
  if (!query) return ''
  return query.split('&').filter(Boolean).map((part) => {
    const eq = part.indexOf('=')
    const key = eq === -1 ? part : part.slice(0, eq)
    const value = eq === -1 ? '' : part.slice(eq + 1)
    return [encodeRfc3986(decodeURIComponent(key)), encodeRfc3986(decodeURIComponent(value))]
  }).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)
    .map(([key, value]) => `${key}=${value}`).join('&')
}

function canonicalPath(path) {
  const encoded = path.split('/').map((segment) => encodeRfc3986(decodeURIComponent(segment))).join('/')
  return encoded.startsWith('/') ? encoded : `/${encoded}`
}

/**
 * Header-based AWS Signature Version 4 for one S3 request.
 * `amzDate` is injectable so the published Amazon example can be checked.
 */
export function authorizationHeader({
  method, path, query = '', headers, body = Buffer.alloc(0),
  accessKeyId, secretAccessKey, region, amzDate,
}) {
  const payloadHash = headers['x-amz-content-sha256'] || sha256(body)
  const signed = { ...headers, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate }
  const names = Object.keys(signed).map((name) => name.toLowerCase()).sort()
  const canonicalHeaders = names.map((name) => `${name}:${String(signed[name]).trim()}\n`).join('')
  const signedHeaders = names.join(';')
  const canonical = [
    method.toUpperCase(),
    canonicalPath(path),
    canonicalQuery(query),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')
  const datestamp = amzDate.slice(0, 8)
  const scope = `${datestamp}/${region}/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n')
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, datestamp), region), 's3'), 'aws4_request')
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
}

function amzNow() {
  return new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
}

function reject(status, code) {
  throw Object.assign(new Error(code), { code, status })
}

/**
 * Path-style S3 client for one bucket. Suitable for MinIO and S3.
 * It is not a multi-node highly available deployment.
 */
export function createHttpBlobClient({ endpoint, bucket, accessKeyId, secretAccessKey, region = 'us-east-1' } = {}) {
  if (typeof endpoint !== 'string' || !/^https?:\/\//.test(endpoint)) reject(400, 'UNSAFE_ENDPOINT')
  if (typeof bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) reject(400, 'UNSAFE_BUCKET')
  if (typeof accessKeyId !== 'string' || !accessKeyId || typeof secretAccessKey !== 'string' || !secretAccessKey) reject(400, 'UNSAFE_CREDENTIALS')
  const root = new URL(endpoint.endsWith('/') ? endpoint : `${endpoint}/`)
  const host = root.port ? `${root.hostname}:${root.port}` : root.hostname

  async function call(method, key, { query = '', body = Buffer.alloc(0), headers = {} } = {}) {
    const path = canonicalPath(`/${bucket}${key ? `/${key}` : ''}`)
    const signedQuery = canonicalQuery(query)
    const payloadHash = sha256(body)
    const amzDate = amzNow()
    const requestHeaders = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...headers,
    }
    const authorization = authorizationHeader({
      method, path, query: signedQuery, headers: requestHeaders, body,
      accessKeyId, secretAccessKey, region, amzDate,
    })
    const url = `${root.origin}${path}${signedQuery ? `?${signedQuery}` : ''}`
    const response = await fetch(url, {
      method,
      headers: { ...requestHeaders, authorization },
      body: method === 'GET' || method === 'HEAD' || method === 'DELETE' ? undefined : body,
      signal: AbortSignal.timeout(15_000),
    })
    return response
  }

  return {
    async ensureBucket() {
      const response = await call('PUT', '')
      if (response.ok || response.status === 409) return
      reject(response.status, 'BUCKET_FAILED')
    },
    async put(key, bytes, { immutable = false } = {}) {
      if (immutable) {
        const existing = await call('HEAD', key)
        if (existing.status === 200) return { created: false, etag: existing.headers.get('etag') }
        if (existing.status !== 404) reject(existing.status, 'S3_HEAD_FAILED')
      }
      const response = await call('PUT', key, { body: Buffer.from(bytes) })
      if (!response.ok) reject(response.status, 'S3_PUT_FAILED')
      return { created: true, etag: response.headers.get('etag') }
    },
    async get(key) {
      const response = await call('GET', key)
      if (response.status === 404) return null
      if (!response.ok) reject(response.status, 'S3_GET_FAILED')
      return Buffer.from(await response.arrayBuffer())
    },
    async delete(key) {
      const response = await call('DELETE', key)
      if (!response.ok && response.status !== 404) reject(response.status, 'S3_DELETE_FAILED')
    },
    async list(prefix) {
      const found = []
      let token = ''
      do {
        const query = `list-type=2&prefix=${encodeRfc3986(prefix)}${token ? `&continuation-token=${encodeRfc3986(token)}` : ''}`
        const response = await call('GET', '', { query })
        if (!response.ok) reject(response.status, 'S3_LIST_FAILED')
        const xml = await response.text()
        for (const match of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) found.push(decodeURIComponent(match[1].replaceAll('&amp;', '&')))
        const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml)
        const next = xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/)
        token = truncated && next ? next[1] : ''
      } while (token)
      return found.sort()
    },
  }
}

export { EMPTY_HASH }
