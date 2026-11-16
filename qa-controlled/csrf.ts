// Disposable QA transport, no credentials are exposed to the page global.
export async function getCsrfToken() {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const r = await fetch('/api/v1/auth/csrf', {
      mode: 'same-origin',
      redirect: 'error',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    })
    if (
      !r.ok ||
      r.redirected ||
      r.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json' ||
      !r.body
    )
      throw Error('Session unavailable')
    reader = r.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > 4096) throw Error('Invalid session response')
      chunks.push(part.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const part of chunks) {
      bytes.set(part, offset)
      offset += part.byteLength
    }
    const token = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).csrfToken
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw Error('Invalid session proof')
    return token
  } finally {
    clearTimeout(timeout)
    void reader?.cancel().catch(() => {})
  }
}
