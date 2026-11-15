import { createBrowserHost } from './index.ts'
import { HostError, hostError } from '../../web-contracts/src/errors.ts'
import type { BrowserHost, CapabilityCatalog } from '../../web-contracts/src/host.ts'
import type { OpenFileResult, PublicSettings, RevisionRef, SaveInput } from '../../web-contracts/src/api.ts'

export interface HttpFileHostOptions {
  fetchImpl?: typeof fetch
  /** Temporary development bearer-header bridge; production should use an authenticated same-origin session. */
  getAuthHeaders?: () => HeadersInit
  /** When true, stage and commit DOCX bytes. Off by default so read-only hosts stay read-only. */
  enableSaves?: boolean
}

function responseError(status: number): HostError {
  if (status === 401 || status === 403) return hostError('UNAUTHORIZED', 'request')
  if (status === 409) return hostError('CONFLICT', 'request')
  if (status >= 500) return hostError('UNAVAILABLE', 'request')
  return hostError('INVALID_RESPONSE', 'request')
}

/** Read imported bytes. Saves are off unless `enableSaves` is set, so a read-only host cannot advertise editing. */
export function createHttpFileHost(options: HttpFileHostOptions = {}): BrowserHost {
  const fetchImpl = options.fetchImpl ?? fetch
  async function get(path: string): Promise<Response> {
    const response = await fetchImpl(path, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: options.getAuthHeaders?.(),
    })
    if (!response.ok) throw responseError(response.status)
    return response
  }
  async function json(path: string): Promise<unknown> {
    const response = await get(path)
    if (!response.headers.get('content-type')?.includes('application/json')) throw hostError('INVALID_RESPONSE', 'JSON content type')
    try { return await response.json() }
    catch { throw hostError('INVALID_RESPONSE', 'JSON body') }
  }
  async function post(path: string, body: BodyInit, contentType: string): Promise<Response> {
    const headers = new Headers(options.getAuthHeaders?.())
    headers.set('Content-Type', contentType)
    const response = await fetchImpl(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers, body })
    if (!response.ok) throw responseError(response.status)
    if (!response.headers.get('content-type')?.includes('application/json')) throw hostError('INVALID_RESPONSE', 'JSON content type')
    return response
  }
  return createBrowserHost({
    getCapabilities: async () => await json('/api/v1/capabilities') as CapabilityCatalog,
    open: async fileId => await json(`/api/v1/files/${encodeURIComponent(fileId)}`) as OpenFileResult,
    readBytes: async (fileId, revision) => {
      const response = await get(`/api/v1/files/${encodeURIComponent(fileId)}/content?revision=${encodeURIComponent(revision)}`)
      if (!response.headers.get('content-type')?.startsWith('application/octet-stream')) throw hostError('INVALID_RESPONSE', 'file content type')
      const limit = 50 * 1024 * 1024
      const declaredLength = response.headers.get('content-length')
      if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || !Number.isSafeInteger(Number(declaredLength)))) throw hostError('INVALID_RESPONSE', 'file length')
      if (declaredLength !== null && Number(declaredLength) > limit) throw hostError('PAYLOAD_TOO_LARGE', 'file download')
      if (!response.body) throw hostError('INVALID_RESPONSE', 'missing file stream')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > limit) throw hostError('PAYLOAD_TOO_LARGE', 'file download')
          chunks.push(value)
        }
      } catch (error) {
        await reader.cancel().catch(() => {})
        throw error
      } finally {
        reader.releaseLock()
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      if (declaredLength !== null && bytes.byteLength !== Number(declaredLength)) throw hostError('INVALID_RESPONSE', 'file length mismatch')
      // Legacy SHA-based revision verifies bytes were not corrupted/truncated in transit.
      const match = /^sha256:([a-f0-9]{64})$/.exec(revision)
      if (match) {
        const digest = await crypto.subtle.digest('SHA-256', bytes)
        const actual = Array.from(new Uint8Array(digest), v => v.toString(16).padStart(2, '0')).join('')
        if (actual !== match[1]) throw hostError('INVALID_RESPONSE', 'file integrity')
      }
      return bytes
    },
    getPreferences: async () => await json('/api/preferences') as PublicSettings,
    ...(options.enableSaves ? {
      async stageSave(bytes: Uint8Array, fileId: string): Promise<{ uploadId: string }> {
        const response = await post(`/api/v1/files/${encodeURIComponent(fileId)}/uploads`, bytes, 'application/octet-stream')
        const value = await response.json() as { uploadId?: unknown }
        if (!value || typeof value.uploadId !== 'string' || !value.uploadId) throw hostError('INVALID_RESPONSE', 'stageSave')
        return { uploadId: value.uploadId }
      },
      async commitSave(input: SaveInput): Promise<RevisionRef> {
        const response = await post(`/api/v1/files/${encodeURIComponent(input.fileId)}/revisions`, JSON.stringify({
          fileId: input.fileId,
          uploadId: input.uploadId,
          baseRevision: input.baseRevision,
          idempotencyKey: input.idempotencyKey,
          leaseEpoch: input.leaseEpoch,
          ...(input.sourceCommandId ? { sourceCommandId: input.sourceCommandId } : {}),
        }), 'application/json')
        return await response.json() as RevisionRef
      },
    } : {}),
  })
}
