import { createBrowserHost } from './index.ts'
import { isRevisionRef, type OpenFileResult, type RevisionRef, type SaveInput } from '../../web-contracts/src/api.ts'
import { hostError, HostError } from '../../web-contracts/src/errors.ts'

type Lease = { leaseEpoch: number; editorId: string; expiresAt: string }
type Pending = { input: SaveInput; sha256: string; size: number }
type Context = { leaseOperation: number; revision: RevisionRef; name: string; lease: Lease | null; pending: Pending | null; status: 'idle' | 'saving' | 'unknown' | 'conflict' | 'unauthorized'; staged: Map<string, { base: string; epoch: number; sha256: string; size: number }> }
const uuid = (value: string) => { if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw hostError('INVALID_REVISION','identifier'); return value.toLowerCase() }
const digest = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes.slice().buffer as ArrayBuffer)),value => value.toString(16).padStart(2,'0')).join('')
function errorFor(status: number) {
  const code = status === 401 || status === 403 ? 'UNAUTHORIZED' : status === 409 || status === 410 ? 'CONFLICT' : status === 413 ? 'PAYLOAD_TOO_LARGE' : status >= 500 || status === 408 ? 'UNAVAILABLE' : 'INVALID_RESPONSE'
  return Object.assign(hostError(code,'request'),{ status })
}
export function createSessionFileHost({ fetchImpl = fetch, editorId = crypto.randomUUID(), onState }: { fetchImpl?: typeof fetch; editorId?: string; onState?: () => void } = {}) {
  const editor = uuid(editorId), contexts = new Map<string,Context>(), references = new Map<string,RevisionRef>(), timers = new Map<string,ReturnType<typeof setInterval>>()
  const listeners = new Set<() => void>()
  let csrf: string | undefined, disposed = false
  const emit = () => { if (!disposed) { try { onState?.(); for (const listener of listeners) listener() } catch { /* UI listeners cannot change durable results. */ } } }
  const context = (fileId: string) => { const value = contexts.get(uuid(fileId)); if (!value || disposed) throw hostError('INVALID_REVISION','context'); return value }
  function remember(ref: RevisionRef) { references.set(ref.fileId + ':' + ref.revision,{ ...ref }); if (references.size > 256) references.delete(references.keys().next().value!) }
  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    if (disposed) throw hostError('UNAVAILABLE','disposed')
    try { return await fetchImpl(path,{ ...init,credentials: 'same-origin',cache: 'no-store' }) }
    catch (error) { if (error instanceof HostError) throw error; throw hostError('UNAVAILABLE','network') }
  }
  async function readJson(reply: Response) {
    if (!reply.ok) throw errorFor(reply.status)
    if (reply.status === 204) return undefined
    if (!reply.headers.get('content-type')?.includes('application/json')) throw hostError('INVALID_RESPONSE','JSON')
    try { return await reply.json() } catch { throw hostError('INVALID_RESPONSE','JSON') }
  }
  const get = async (path: string) => readJson(await request(path))
  async function csrfToken() {
    if (!csrf) {
      const result = await get('/api/v1/auth/csrf')
      if (typeof result?.csrfToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.csrfToken)) throw hostError('INVALID_RESPONSE','csrf')
      csrf = result.csrfToken
    }
    return csrf!
  }
  async function mutation(path: string, method: string, body?: unknown, binary = false, keepalive = false) {
    for (let attempt = 0; attempt < 2; attempt++) {
      // Cached proof permits a pagehide keepalive request to start synchronously
      // before disposal clears private browser state.
      const proof = csrf ?? await csrfToken()
      const reply = await request(path,{ method,keepalive,headers: { 'x-csrf-token': proof,...(body === undefined ? {} : { 'content-type': binary ? 'application/octet-stream' : 'application/json' }) }, body: body === undefined ? undefined : binary ? body as BodyInit : JSON.stringify(body) })
      if (reply.status === 403 && attempt === 0) { csrf = undefined; continue }
      return readJson(reply)
    }
  }
  function readLease(value: unknown): Lease {
    const v = value as Lease
    if (!v || !Number.isSafeInteger(v.leaseEpoch) || v.leaseEpoch < 1 || v.editorId !== editor || typeof v.expiresAt !== 'string' || !Number.isFinite(Date.parse(v.expiresAt))) throw hostError('INVALID_RESPONSE','lease')
    return { leaseEpoch: v.leaseEpoch,editorId: editor,expiresAt: v.expiresAt }
  }
  async function leaseOperation(fileId: string, suffix: string, body: object) {
    const id = uuid(fileId), ctx = context(id), operation = ++ctx.leaseOperation
    try {
      const lease = readLease(await mutation(`/api/v1/files/${id}/lease${suffix}`,'POST',body))
      if (operation === ctx.leaseOperation) { ctx.lease = lease; if (!ctx.pending) ctx.status = 'idle'; emit() }; return { ...lease }
    } catch (error) { if (operation === ctx.leaseOperation) { ctx.lease = null; if (!ctx.pending) ctx.status = (error as HostError).code === 'UNAUTHORIZED' ? 'unauthorized' : 'conflict'; emit() }; throw error }
  }
  function accept(fileId: string, ctx: Context, pending: Pending, value: unknown) {
    if (!isRevisionRef(value) || value.fileId !== fileId || value.sha256 !== pending.sha256 || value.size !== pending.size) throw hostError('INVALID_RESPONSE','commit')
    const ref = { ...value }
    ctx.revision = ref; ctx.pending = null; ctx.status = 'idle'; ctx.staged.delete(pending.input.uploadId); remember(ref); emit()
    return ref
  }
  async function commit(fileId: string, ctx: Context, pending: Pending) {
    ctx.pending = pending; ctx.status = 'saving'; emit()
    try { return accept(fileId,ctx,pending,await mutation(`/api/v1/files/${fileId}/commits`,'POST',pending.input)) }
    catch (error) {
      const status = (error as { status?: number }).status
      if (status && status >= 400 && status < 500 && status !== 408) {
        ctx.pending = null; ctx.status = (error as HostError).code === 'UNAUTHORIZED' ? 'unauthorized' : 'conflict'
        if (ctx.status === 'unauthorized' || (error as HostError).code === 'CONFLICT') ctx.lease = null
      } else ctx.status = 'unknown'
      emit(); throw error
    }
  }
  const host = createBrowserHost({
    getCapabilities: () => get('/api/v1/capabilities'),
    async open(fileId) {
      const id = uuid(fileId)
      if (contexts.get(id)?.pending) throw hostError('UNAVAILABLE','unconfirmed commit')
      const result = await get(`/api/v1/files/${id}`) as OpenFileResult & { name?: string }
      if (!isRevisionRef(result?.file) || result.file.fileId !== id) throw hostError('INVALID_RESPONSE','open')
      const name = typeof result.name === 'string' && result.name.length <= 255 ? result.name : id + '.' + result.format
      contexts.set(id,{ leaseOperation: 0,revision: { ...result.file },name,lease: null,pending: null,status: 'idle',staged: new Map() }); remember(result.file); emit()
      return result
    },
    async readBytes(fileId, revision) {
      const id = uuid(fileId), rev = uuid(revision)
      let ref = references.get(id + ':' + rev)
      if (!ref) {
        const fetched = await get(`/api/v1/files/${id}/revisions/${rev}`)
        if (!isRevisionRef(fetched) || fetched.fileId !== id || fetched.revision !== rev) throw hostError('INVALID_RESPONSE','revision metadata')
        ref = fetched; remember(ref)
      }
      if (ref.size < 1 || ref.size > 32 * 1024 * 1024) throw hostError('PAYLOAD_TOO_LARGE','read')
      const reply = await request(`/api/v1/files/${id}/content?revision=${rev}`)
      if (!reply.ok) throw errorFor(reply.status)
      if (!reply.headers.get('content-type')?.startsWith('application/octet-stream') || !reply.body) throw hostError('INVALID_RESPONSE','bytes')
      const reader = reply.body.getReader(), chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) { const { value,done } = await reader.read(); if (done) break; size += value.byteLength; if (size > ref.size) throw hostError('INVALID_RESPONSE','length'); chunks.push(value) }
      } catch (error) { await reader.cancel().catch(() => {}); throw error }
      finally { reader.releaseLock() }
      const bytes = new Uint8Array(size); let offset = 0
      for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength }
      if (size !== ref.size || await digest(bytes) !== ref.sha256) throw hostError('INVALID_RESPONSE','integrity')
      return bytes
    },
    async stageSave(bytes, fileId) {
      const id = uuid(fileId), ctx = context(id), lease = ctx.lease
      if (!lease || ctx.pending) throw hostError(ctx.pending ? 'UNAVAILABLE' : 'CONFLICT','stage')
      const snapshot = bytes.slice(), sha256 = await digest(snapshot), base = ctx.revision.revision
      try {
        const result = await mutation(`/api/v1/files/${id}/uploads`,'POST',{ size: snapshot.byteLength,baseRevision: base,leaseEpoch: lease.leaseEpoch,editorId: editor })
        const uploadId = uuid(result?.uploadId)
        await mutation(`/api/v1/uploads/${uploadId}/content`,'PUT',snapshot,true)
        ctx.staged.set(uploadId,{ base,epoch: lease.leaseEpoch,sha256,size: snapshot.byteLength })
        return { uploadId }
      } catch (error) { if ((error as HostError).code === 'CONFLICT' || (error as HostError).code === 'UNAUTHORIZED') { ctx.lease = null; ctx.status = (error as HostError).code === 'UNAUTHORIZED' ? 'unauthorized' : 'conflict'; emit() }; throw error }
    },
    async commitSave(input) {
      const id = uuid(input.fileId), ctx = context(id), staged = ctx.staged.get(input.uploadId)
      if (!staged || staged.base !== input.baseRevision || staged.epoch !== input.leaseEpoch || ctx.pending) throw hostError('INVALID_REVISION','snapshot')
      return commit(id,ctx,{ input: Object.freeze({ ...input }),sha256: staged.sha256,size: staged.size })
    },
    getPreferences: () => get('/api/preferences'),
  })
  return {
    ...host,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    getState(fileId: string) { const ctx = context(fileId); return { revision: { ...ctx.revision },name: ctx.name,lease: ctx.lease ? { ...ctx.lease } : null,status: ctx.status } },
    acquireLease: (fileId: string) => leaseOperation(fileId,'',{ editorId: editor }),
    renewLease(fileId: string) { const lease = context(fileId).lease; if (!lease) return Promise.reject(hostError('CONFLICT','renew')); return leaseOperation(fileId,'/renew',{ editorId: editor,leaseEpoch: lease.leaseEpoch }) },
    async takeoverLease(fileId: string) {
      const state = await get(`/api/v1/files/${uuid(fileId)}/lease`)
      if (!Number.isSafeInteger(state?.leaseEpoch) || state.leaseEpoch < 1) return leaseOperation(fileId,'',{ editorId: editor })
      return leaseOperation(fileId,'/takeover',{ editorId: editor,expectedEpoch: state.leaseEpoch })
    },
    async releaseLease(fileId: string, keepalive = false) { const id = uuid(fileId), ctx = context(id), lease = ctx.lease, operation = ++ctx.leaseOperation; if (lease) { await mutation(`/api/v1/files/${id}/lease`,'DELETE',{ editorId: editor,leaseEpoch: lease.leaseEpoch },false,keepalive); if (operation === ctx.leaseOperation) { ctx.lease = null; emit() } } },
    async reconcile(fileId: string) { const id = uuid(fileId), ctx = context(id); if (!ctx.pending) return { ...ctx.revision }; return commit(id,ctx,ctx.pending) },
    async save(fileId: string, bytes: Uint8Array) {
      const id = uuid(fileId), ctx = context(id)
      if (ctx.pending) { const prior = ctx.pending; const recovered = await commit(id,ctx,prior); if (await digest(bytes) === prior.sha256) return recovered }
      const { uploadId } = await host.stageSave(bytes,id), staged = ctx.staged.get(uploadId)!
      return host.commitSave({ fileId: id,uploadId,baseRevision: staged.base,leaseEpoch: staged.epoch,idempotencyKey: crypto.randomUUID() })
    },
    startRenewal(fileId: string) {
      const id = uuid(fileId)
      if (!timers.has(id)) timers.set(id,setInterval(() => { const ctx = contexts.get(id); if (ctx?.lease && !disposed) void leaseOperation(id,'/renew',{ editorId: editor,leaseEpoch: ctx.lease.leaseEpoch }).catch(() => {}) },15_000))
      return () => { clearInterval(timers.get(id)); timers.delete(id) }
    },
    dispose() { disposed = true; for (const timer of timers.values()) clearInterval(timer); timers.clear(); listeners.clear(); contexts.clear(); references.clear(); csrf = undefined },
  }
}
export type SessionFileHost = ReturnType<typeof createSessionFileHost>
