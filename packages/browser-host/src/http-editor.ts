import { createHttpFileHost, type HttpFileHostOptions } from './http-files.ts'
import { HostError, hostError } from '../../web-contracts/src/errors.ts'
import type { BrowserHost } from '../../web-contracts/src/host.ts'
import type { RevisionRef } from '../../web-contracts/src/api.ts'

export interface DocxBlockView {
  docxIndex?: number
  type: string
  text: string
  editable: boolean
}

export interface DocxProjection {
  file: RevisionRef
  leaseEpoch: number
  blocks: DocxBlockView[]
}

export interface DocxCommitInput {
  baseRevision: string
  leaseEpoch: number
  idempotencyKey: string
  blocks: Array<{ docxIndex?: number; text?: string; deleted?: boolean }>
}

export interface HttpEditorHost extends BrowserHost {
  acquireLease(fileId: string): Promise<{ leaseEpoch: number }>
  renewLease(fileId: string, leaseEpoch: number): Promise<{ leaseEpoch: number }>
  readDocx(fileId: string): Promise<DocxProjection>
  commitDocx(fileId: string, input: DocxCommitInput): Promise<RevisionRef>
}

function responseError(status: number): HostError {
  if (status === 401 || status === 403) return hostError('UNAUTHORIZED', 'request')
  if (status === 409) return hostError('CONFLICT', 'request')
  if (status >= 500) return hostError('UNAVAILABLE', 'request')
  return hostError('INVALID_RESPONSE', 'request')
}

function isBlock(value: unknown): value is DocxBlockView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const block = value as Record<string, unknown>
  return (block.docxIndex === undefined || (typeof block.docxIndex === 'number' && Number.isSafeInteger(block.docxIndex) && block.docxIndex >= 0)) &&
    typeof block.type === 'string' && block.type.length > 0 &&
    typeof block.text === 'string' && typeof block.editable === 'boolean'
}

/** BrowserHost plus the DOCX projection used by the Web editor. Saves stay on the authenticated same-origin API. */
export function createHttpEditorHost(options: HttpFileHostOptions = {}): HttpEditorHost {
  const fetchImpl = options.fetchImpl ?? fetch
  const host = createHttpFileHost({ ...options, enableSaves: true })
  async function request(path: string, method: 'GET' | 'POST', body?: string): Promise<unknown> {
    const headers = new Headers(options.getAuthHeaders?.())
    if (body !== undefined) headers.set('Content-Type', 'application/json')
    const response = await fetchImpl(path, { method, credentials: 'same-origin', cache: 'no-store', headers, body })
    if (!response.ok) throw responseError(response.status)
    if (!response.headers.get('content-type')?.includes('application/json')) throw hostError('INVALID_RESPONSE', 'JSON content type')
    try { return await response.json() }
    catch { throw hostError('INVALID_RESPONSE', 'JSON body') }
  }
  return Object.assign(host, {
    async renewLease(fileId: string, leaseEpoch: number) {
      const value = await request(`/api/v1/files/${encodeURIComponent(fileId)}/leases/renew`, 'POST', JSON.stringify({ leaseEpoch })) as { leaseEpoch?: unknown }
      if (!value || typeof value.leaseEpoch !== 'number' || !Number.isSafeInteger(value.leaseEpoch) || value.leaseEpoch < 1) throw hostError('INVALID_RESPONSE', 'lease')
      return { leaseEpoch: value.leaseEpoch }
    },
    async acquireLease(fileId: string) {
      const value = await request(`/api/v1/files/${encodeURIComponent(fileId)}/lease`, 'POST', '{}') as { leaseEpoch?: unknown }
      if (!value || typeof value.leaseEpoch !== 'number' || !Number.isSafeInteger(value.leaseEpoch) || value.leaseEpoch < 1) throw hostError('INVALID_RESPONSE', 'lease')
      return { leaseEpoch: value.leaseEpoch }
    },
    async readDocx(fileId: string) {
      const value = await request(`/api/v1/files/${encodeURIComponent(fileId)}/docx`, 'GET') as { file?: unknown; leaseEpoch?: unknown; blocks?: unknown }
      const file = value?.file as RevisionRef | undefined
      if (!file || file.fileId !== fileId || !Array.isArray(value.blocks) || !value.blocks.every(isBlock)) throw hostError('INVALID_RESPONSE', 'docx')
      if (typeof value.leaseEpoch !== 'number' || !Number.isSafeInteger(value.leaseEpoch) || value.leaseEpoch < 1) throw hostError('INVALID_RESPONSE', 'docx')
      return { file: { fileId: file.fileId, revision: file.revision, sha256: file.sha256, size: file.size }, leaseEpoch: value.leaseEpoch, blocks: value.blocks }
    },
    async commitDocx(fileId: string, input: DocxCommitInput) {
      const revision = await request(`/api/v1/files/${encodeURIComponent(fileId)}/docx`, 'POST', JSON.stringify({
        baseRevision: input.baseRevision,
        leaseEpoch: input.leaseEpoch,
        idempotencyKey: input.idempotencyKey,
        blocks: input.blocks,
      })) as RevisionRef
      if (!revision || revision.fileId !== fileId) throw hostError('INVALID_RESPONSE', 'commitDocx')
      return { fileId: revision.fileId, revision: revision.revision, sha256: revision.sha256, size: revision.size }
    },
  })
}
