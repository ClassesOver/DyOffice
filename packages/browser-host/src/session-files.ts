import { createBrowserHost } from './index.ts'
import { isRevisionRef, type OpenFileResult, type RevisionRef, type SaveInput } from '../../web-contracts/src/api.ts'
import { hostError, HostError } from '../../web-contracts/src/errors.ts'

type Lease = { leaseEpoch: number; editorId: string; expiresAt: string }
type Pending = { authorized?:()=>boolean; touchedEntries?: string[]; input: SaveInput; sha256: string; size: number }
type Context = { preparing: boolean; leaseOperation: number; exclusiveLease: number | null; revision: RevisionRef; name: string; lease: Lease | null; pending: Pending | null; status: 'idle' | 'saving' | 'unknown' | 'conflict' | 'unauthorized'; staged: Map<string, { base: string; epoch: number; sha256: string; size: number }> }
const uuid = (value: string) => { if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw hostError('INVALID_REVISION','identifier'); return value.toLowerCase() }
const digest = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes.slice().buffer as ArrayBuffer)),value => value.toString(16).padStart(2,'0')).join('')
function errorFor(status: number) {
  const code = status === 401 || status === 403 ? 'UNAUTHORIZED' : status === 409 || status === 410 ? 'CONFLICT' : status === 413 ? 'PAYLOAD_TOO_LARGE' : status >= 500 || status === 408 ? 'UNAVAILABLE' : 'INVALID_RESPONSE'
  return Object.assign(hostError(code,'request'),{ status })
}
export function createSessionFileHost({ fetchImpl = fetch, editorId = crypto.randomUUID(), onState, leaseRetryDelayMs = 150 }: { fetchImpl?: typeof fetch; editorId?: string; onState?: () => void; leaseRetryDelayMs?: number } = {}) {
  const editor = uuid(editorId), contexts = new Map<string,Context>(), references = new Map<string,RevisionRef>(), timers = new Map<string,ReturnType<typeof setInterval>>()
  const expirations = new Map<string,ReturnType<typeof setTimeout>>()
  const renewals = new Map<string,{context: Context; operation: number; promise: Promise<Lease>}>()
  const retryDelay = Math.max(0,Math.min(1000,Number.isFinite(leaseRetryDelayMs) ? leaseRetryDelayMs : 150))
  const listeners = new Set<() => void>()
  const committing = new WeakSet<Context>()
  let csrf: string | undefined, disposed = false
  // JSON metadata/preferences are bounded independently of 32MiB document bytes.
  // 1MiB leaves room for ordinary file/capability lists without unbounded json().
  const maxJsonBytes = 1024 * 1024
  const requests = new Map<AbortController, boolean>()
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>()
  const assertActive = () => { if (disposed) throw hostError('UNAVAILABLE','disposed') }
  const discard = (reply: Response) => { void reply.body?.cancel().catch(() => {}) }
  const emit = () => { if (!disposed) { try { onState?.(); for (const listener of listeners) listener() } catch { /* UI listeners cannot change durable results. */ } } }
  const context = (fileId: string) => { const value = contexts.get(uuid(fileId)); if (!value || disposed) throw hostError('INVALID_REVISION','context'); return value }
  function remember(ref: RevisionRef) { references.set(ref.fileId + ':' + ref.revision,{ ...ref }); if (references.size > 256) references.delete(references.keys().next().value!) }
  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    assertActive()
    if (!/^\/api\/[^\s\u0000-\u001f\u007f\\#]*$/.test(path)) throw hostError('INVALID_RESPONSE','request path')
    const controller = new AbortController(), keepalive = init.keepalive === true
    requests.set(controller,keepalive)
    try {
      // Firefox otherwise sends Origin: null for writes under the page's no-referrer policy.
      const reply = await fetchImpl(path,{ ...init,credentials: 'same-origin',mode: 'same-origin', referrerPolicy: 'same-origin',redirect: 'error',cache: 'no-store',signal: controller.signal })
      if (reply.redirected || (disposed && !keepalive)) { discard(reply); throw hostError('UNAVAILABLE','request unconfirmed') }
      return reply
    } catch (error) { controller.abort(); if (error instanceof HostError) throw error; throw hostError('UNAVAILABLE','network') }
    finally { requests.delete(controller) }
  }
  async function readJson(reply: Response) {
    if (disposed) { discard(reply); throw hostError('UNAVAILABLE','disposed') }
    if (!reply.ok) { discard(reply); throw errorFor(reply.status) }
    if (reply.status === 204) { discard(reply); return undefined }
    if (reply.headers.get('content-type')?.split(';',1)[0]?.trim().toLowerCase() !== 'application/json') { discard(reply); throw hostError('INVALID_RESPONSE','JSON') }
    const reader = reply.body?.getReader()
    if (!reader) throw hostError('INVALID_RESPONSE','JSON body')
    readers.add(reader)
    try {
      const decoder = new TextDecoder('utf-8',{fatal:true})
      let text = '', size = 0
      for (;;) {
        assertActive()
        const chunk = await reader.read()
        assertActive()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > maxJsonBytes) throw hostError('INVALID_RESPONSE','JSON response limit')
        text += decoder.decode(chunk.value,{stream:true})
      }
      text += decoder.decode()
      assertActive()
      return JSON.parse(text)
    } catch (error) { if (error instanceof HostError) throw error; throw hostError('INVALID_RESPONSE','JSON') }
    finally { readers.delete(reader); void reader.cancel().catch(() => {}); reader.releaseLock() }
  }
  const get = async (path: string) => readJson(await request(path))
  async function csrfToken() {
    if (!csrf) {
      const result = await get('/api/v1/auth/csrf')
      assertActive()
      if (typeof result?.csrfToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.csrfToken)) throw hostError('INVALID_RESPONSE','csrf')
      csrf = result.csrfToken
    }
    return csrf!
  }
  async function mutation(path: string, method: string, body?: unknown, binary = false, keepalive = false, authorized:()=>boolean = ()=>true) {
    for (let attempt = 0; attempt < 2; attempt++) {
      // Cached proof permits a pagehide keepalive request to start synchronously
      // before disposal clears private browser state.
      const proof = csrf ?? await csrfToken()
      let permitted=false;try{permitted=authorized()}catch{}
      if(!permitted)throw Object.assign(hostError('UNAVAILABLE','save authorization changed'),{saveNotSubmitted:true})
      const reply = await request(path,{ method,keepalive,headers: { 'x-csrf-token': proof,...(body === undefined ? {} : { 'content-type': binary ? 'application/octet-stream' : 'application/json' }) },...(body === undefined ? {} : { body: binary ? body as BodyInit : JSON.stringify(body) }) })
      // A pagehide release may already be sent before disposal. Do not abort or
      // replay it, and do not treat its late response as live UI authority.
      if (disposed && keepalive) { discard(reply); if (!reply.ok) throw errorFor(reply.status); return undefined }
      if (reply.status === 403 && attempt === 0) { discard(reply); csrf = undefined; continue }
      return readJson(reply)
    }
  }
  function clearExpiration(id: string) { clearTimeout(expirations.get(id)); expirations.delete(id) }
  function expireLease(id: string, ctx: Context, notify = true) {
    if (!ctx.lease || Date.parse(ctx.lease.expiresAt) > Date.now()) return
    // Local expiry disables writes, but a renewal already accepted by the
    // server may still arrive with a future expiry. Only explicit authority
    // changes fence that reply; passage of time does not supersede its request.
    ctx.lease = null; clearExpiration(id)
    if (!ctx.pending && !ctx.preparing) ctx.status = 'conflict'
    if (notify) emit()
  }
  function armExpiration(id: string, ctx: Context) {
    clearExpiration(id)
    if (!ctx.lease) return
    const timer = setTimeout(() => { expirations.delete(id); if (!disposed && contexts.get(id) === ctx) { expireLease(id,ctx); if (ctx.lease) armExpiration(id,ctx) } },Math.min(2_147_483_647,Math.max(0,Date.parse(ctx.lease.expiresAt)-Date.now())))
    ;(timer as unknown as {unref?(): void}).unref?.()
    expirations.set(id,timer)
  }
  function liveContext(fileId: string, notify = true) { const id=uuid(fileId),ctx=context(id);expireLease(id,ctx,notify);return ctx }
  function revokeLease(id: string,ctx: Context) {ctx.lease=null;ctx.leaseOperation++;clearExpiration(id)}
  function readLease(value: unknown): Lease {
    const v = value as Lease
    if (!v || !Number.isSafeInteger(v.leaseEpoch) || v.leaseEpoch < 1 || v.editorId !== editor || typeof v.expiresAt !== 'string' || !Number.isFinite(Date.parse(v.expiresAt)) || Date.parse(v.expiresAt) <= Date.now()) throw hostError('INVALID_RESPONSE','lease')
    return { leaseEpoch: v.leaseEpoch,editorId: editor,expiresAt: v.expiresAt }
  }
  const currentOperation = (id: string,ctx: Context,operation: number) => !disposed && contexts.get(id) === ctx && ctx.leaseOperation === operation
  async function leaseOperation(fileId: string, suffix: string, body: object, operation?: number) {
    const id = uuid(fileId), ctx = context(id), op = operation ?? ++ctx.leaseOperation
    try {
      let lease: Lease | undefined
      for (let attempt=0;attempt<3;attempt++) {
        if (!currentOperation(id,ctx,op)) throw hostError('CONFLICT','superseded lease')
        try { lease=readLease(await mutation(`/api/v1/files/${id}/lease${suffix}`,'POST',body));break }
        catch(error) {
          // A refresh may acquire before the old page's keepalive release arrives.
          // Retry acquire only; it must never silently take over a live editor.
          if (suffix !== '' || (error as HostError).code !== 'CONFLICT' || attempt === 2 || !currentOperation(id,ctx,op)) throw error
          if (retryDelay) await new Promise(resolve=>setTimeout(resolve,retryDelay*(attempt+1)))
        }
      }
      if (!currentOperation(id,ctx,op)) throw hostError('CONFLICT','superseded lease')
      ctx.lease = lease!; armExpiration(id,ctx); if (!ctx.pending && !ctx.preparing) ctx.status = 'idle'; emit(); return { ...lease! }
    } catch (error) { if (currentOperation(id,ctx,op)) { ctx.lease = null; clearExpiration(id); if (!ctx.pending && !ctx.preparing) ctx.status = (error as HostError).code === 'UNAUTHORIZED' ? 'unauthorized' : 'conflict'; emit() }; throw error }
  }
  function renewLease(fileId: string): Promise<Lease> {
    const id=uuid(fileId),ctx=liveContext(id),lease=ctx.lease
    if (!lease || ctx.exclusiveLease !== null) return Promise.reject(hostError('CONFLICT','renew'))
    const existing=renewals.get(id)
    if (existing?.context===ctx && existing.operation===ctx.leaseOperation) return existing.promise
    const operation=++ctx.leaseOperation,promise=leaseOperation(id,'/renew',{editorId:editor,leaseEpoch:lease.leaseEpoch},operation)
    const renewal={context:ctx,operation,promise};renewals.set(id,renewal)
    void promise.finally(()=>{if(renewals.get(id)===renewal)renewals.delete(id)}).catch(()=>{})
    return promise
  }
  function accept(fileId: string, ctx: Context, pending: Pending, value: unknown) {
    assertActive()
    if (!isRevisionRef(value) || value.fileId !== fileId || value.sha256 !== pending.sha256 || value.size !== pending.size) throw hostError('INVALID_RESPONSE','commit')
    const ref = { ...value }
    ctx.revision = ref; ctx.pending = null; ctx.status = 'idle'; ctx.staged.delete(pending.input.uploadId); remember(ref); emit()
    return ref
  }
  async function commit(fileId: string, ctx: Context, pending: Pending, authorized:()=>boolean = ()=>true) {
    // A retry may only start after the previous attempt settles. Otherwise an
    // older response can clear a newer pending save or regress its revision.
    if (committing.has(ctx)) throw hostError('UNAVAILABLE','commit already in flight')
    committing.add(ctx)
    const recovering = ctx.pending === pending
    pending.authorized ??= authorized
    const permitted=()=>pending.authorized!()&&authorized()
    ctx.pending = pending; ctx.status = 'saving'; emit()
    try { return accept(fileId,ctx,pending,await mutation(`/api/v1/files/${fileId}/commits`,'POST',pending.input,false,false,permitted)) }
    catch (error) {
      const status = (error as { status?: number }).status
      if((error as {saveNotSubmitted?:boolean}).saveNotSubmitted){
        // A first attempt stopped before fetch is known-not-sent. A blocked
        // retry cannot erase uncertainty about an earlier submitted request.
        ctx.pending=recovering?pending:null;ctx.status=recovering?'unknown':'idle';emit();throw error
      }
      if (status && status >= 400 && status < 500 && status !== 408) {
        ctx.pending = null; ctx.status = (error as HostError).code === 'UNAUTHORIZED' ? 'unauthorized' : 'conflict'
        if (ctx.status === 'unauthorized' || (error as HostError).code === 'CONFLICT') revokeLease(fileId,ctx)
      } else ctx.status = 'unknown'
      emit(); throw error
    } finally { committing.delete(ctx) }
  }
  function commitStaged(input:SaveInput,authorized:()=>boolean = ()=>true){
    const id=uuid(input.fileId),ctx=context(id),staged=ctx.staged.get(input.uploadId)
    if(!staged||staged.base!==input.baseRevision||staged.epoch!==input.leaseEpoch||ctx.pending||ctx.preparing)throw hostError('INVALID_REVISION','snapshot')
    return commit(id,ctx,{input:Object.freeze({...input}),sha256:staged.sha256,size:staged.size},authorized)
  }
  const host = createBrowserHost({
    getCapabilities: () => get('/api/v1/capabilities'),
    async open(fileId) {
      const id = uuid(fileId)
      if (contexts.get(id)?.pending || contexts.get(id)?.preparing) throw hostError('UNAVAILABLE','unconfirmed commit')
      const result = await get(`/api/v1/files/${id}`) as OpenFileResult & { name?: string }
      assertActive()
      if (!isRevisionRef(result?.file) || result.file.fileId !== id) throw hostError('INVALID_RESPONSE','open')
      const name = typeof result.name === 'string' && result.name.length <= 255 ? result.name : id + '.' + result.format
      contexts.set(id,{ preparing: false,leaseOperation: 0,exclusiveLease: null,revision: { ...result.file },name,lease: null,pending: null,status: 'idle',staged: new Map() }); remember(result.file); emit()
      return result
    },
    async readBytes(fileId, revision) {
      const id = uuid(fileId), rev = uuid(revision)
      let ref = references.get(id + ':' + rev)
      if (!ref) {
        const fetched = await get(`/api/v1/files/${id}/revisions/${rev}`)
        assertActive()
        if (!isRevisionRef(fetched) || fetched.fileId !== id || fetched.revision !== rev) throw hostError('INVALID_RESPONSE','revision metadata')
        ref = fetched; remember(ref)
      }
      if (ref.size < 1 || ref.size > 32 * 1024 * 1024) throw hostError('PAYLOAD_TOO_LARGE','read')
      const reply = await request(`/api/v1/files/${id}/content?revision=${rev}`)
      if (!reply.ok) { discard(reply); throw errorFor(reply.status) }
      if (!reply.headers.get('content-type')?.startsWith('application/octet-stream') || !reply.body) { discard(reply); throw hostError('INVALID_RESPONSE','bytes') }
      const reader = reply.body.getReader(), chunks: Uint8Array[] = []
      let size = 0
      readers.add(reader)
      try {
        for (;;) { assertActive(); const { value,done } = await reader.read(); assertActive(); if (done) break; size += value.byteLength; if (size > ref.size) throw hostError('INVALID_RESPONSE','length'); chunks.push(value) }
      } catch (error) { void reader.cancel().catch(() => {}); throw error }
      finally { readers.delete(reader); reader.releaseLock() }
      const bytes = new Uint8Array(size); let offset = 0
      for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength }
      if (size !== ref.size || await digest(bytes) !== ref.sha256) throw hostError('INVALID_RESPONSE','integrity')
      assertActive()
      return bytes
    },
    async stageSave(bytes, fileId) {
      const id = uuid(fileId), ctx = liveContext(id), lease = ctx.lease
      if (!lease || ctx.pending || ctx.preparing) throw hostError(ctx.pending || ctx.preparing ? 'UNAVAILABLE' : 'CONFLICT','stage')
      const snapshot = bytes.slice(), sha256 = await digest(snapshot), base = ctx.revision.revision
      try {
        const result = await mutation(`/api/v1/files/${id}/uploads`,'POST',{ size: snapshot.byteLength,baseRevision: base,leaseEpoch: lease.leaseEpoch,editorId: editor })
        const uploadId = uuid(result?.uploadId)
        await mutation(`/api/v1/uploads/${uploadId}/content`,'PUT',snapshot,true)
        assertActive()
        ctx.staged.set(uploadId,{ base,epoch: lease.leaseEpoch,sha256,size: snapshot.byteLength })
        return { uploadId }
      } catch (error) { if ((error as HostError).code === 'CONFLICT' || (error as HostError).code === 'UNAUTHORIZED') { revokeLease(id,ctx); ctx.status = (error as HostError).code === 'UNAUTHORIZED' ? 'unauthorized' : 'conflict'; emit() }; throw error }
    },
    async commitSave(input) {
      return commitStaged(input)
    },
    getPreferences: () => get('/api/preferences'),
  })
  return {
    ...host,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    getState(fileId: string) { const ctx = liveContext(fileId,false); return { revision: { ...ctx.revision },name: ctx.name,lease: ctx.lease ? { ...ctx.lease } : null,status: ctx.status } },
    getEditorId: () => editor,
    observeRealtime(fileId: string, remote: { lease: { leaseEpoch: number; editorId: string | null; heldByCurrentSession: boolean; active: boolean; expiresAt: string | null } } | null) {
      const id = uuid(fileId), ctx = liveContext(id, false), lease = ctx.lease
      // A notification may revoke authority; only the HTTP lease endpoint can
      // grant it. Ignore older polls and never adopt a notified document head.
      if (remote && (!lease || remote.lease.leaseEpoch < lease.leaseEpoch || (remote.lease.leaseEpoch === lease.leaseEpoch && remote.lease.editorId === editor && remote.lease.heldByCurrentSession && (remote.lease.active || (remote.lease.expiresAt !== null && Date.parse(remote.lease.expiresAt) < Date.parse(lease.expiresAt)))))) return
      revokeLease(id, ctx)
      if (!ctx.pending && !ctx.preparing) ctx.status = remote ? 'conflict' : 'unauthorized'
      emit()
    },
    async acquireLease(fileId: string) {
      const id=uuid(fileId),ctx=context(id),operation=++ctx.leaseOperation
      ctx.exclusiveLease=operation
      try {return await leaseOperation(id,'',{editorId:editor},operation)}
      finally {if(ctx.exclusiveLease===operation)ctx.exclusiveLease=null}
    },
    renewLease,
    async takeoverLease(fileId: string) {
      const id=uuid(fileId),ctx=liveContext(id),operation=++ctx.leaseOperation
      ctx.exclusiveLease=operation
      try {
        const state = await get(`/api/v1/files/${id}/lease`)
        if (!currentOperation(id,ctx,operation)) throw hostError('CONFLICT','superseded takeover')
        if (!Number.isSafeInteger(state?.leaseEpoch) || state.leaseEpoch < 1) return await leaseOperation(id,'',{ editorId: editor },operation)
        return await leaseOperation(id,'/takeover',{ editorId: editor,expectedEpoch: state.leaseEpoch },operation)
      } catch(error) {
        if (currentOperation(id,ctx,operation)) {ctx.lease=null;clearExpiration(id);if(!ctx.pending && !ctx.preparing)ctx.status=(error as HostError).code==='UNAUTHORIZED'?'unauthorized':'conflict';emit()}
        throw error
      } finally {if(ctx.exclusiveLease===operation)ctx.exclusiveLease=null}
    },
    async releaseLease(fileId: string, keepalive = false) {
      const id = uuid(fileId), ctx = liveContext(id), lease = ctx.lease
      ++ctx.leaseOperation; ctx.lease=null; clearExpiration(id); emit()
      if (lease) await mutation(`/api/v1/files/${id}/lease`,'DELETE',{ editorId: editor,leaseEpoch: lease.leaseEpoch },false,keepalive)
    },
    // Read-only comparison: never bind an old editor model to a newer base.
    async isCurrentRevision(fileId: string) {
      const id=uuid(fileId),ctx=context(id),base={...ctx.revision}
      const result=await get(`/api/v1/files/${id}`) as OpenFileResult
      if(!isRevisionRef(result?.file)||result.file.fileId!==id)throw hostError('INVALID_RESPONSE','head')
      if(context(id)!==ctx || ctx.revision.revision!==base.revision)throw hostError('CONFLICT','changed head')
      return result.file.revision===base.revision && result.file.sha256===base.sha256 && result.file.size===base.size
    },
    async refreshHead(fileId: string) {
      const id=uuid(fileId),ctx=context(id),base=ctx.revision.revision
      if(ctx.pending || ctx.preparing)throw hostError('UNAVAILABLE','unconfirmed save')
      const result=await get(`/api/v1/files/${id}`) as OpenFileResult & {name?: string}
      if(!isRevisionRef(result?.file)||result.file.fileId!==id)throw hostError('INVALID_RESPONSE','head')
      if(context(id)!==ctx || ctx.pending || ctx.preparing || ctx.revision.revision!==base)throw hostError('CONFLICT','changed head')
      ctx.revision={...result.file};remember(result.file)
      if(typeof result.name==='string' && result.name.length<=255)ctx.name=result.name
      emit();return {...result.file}
    },
    async reconcile(fileId: string, authorized:()=>boolean = ()=>true) { const id = uuid(fileId), ctx = context(id); if (!ctx.pending) return { ...ctx.revision }; return commit(id,ctx,ctx.pending,authorized) },
    async reconcileSheets(fileId: string, authorized:()=>boolean = ()=>true) {
      const id=uuid(fileId),ctx=context(id),pending=ctx.pending
      if (!pending?.touchedEntries) throw hostError('INVALID_REVISION','sheet receipt')
      const saved=await commit(id,ctx,pending,authorized)
      return {...saved,touchedEntries:[...pending.touchedEntries]}
    },
    async saveSheets(fileId: string, edits: unknown, authorized:()=>boolean = ()=>true) {
      if(!authorized())throw hostError('UNAVAILABLE','save authorization changed')
      const id = uuid(fileId), ctx = liveContext(id), lease = ctx.lease, base = ctx.revision.revision
      // An uncertain receipt must be reconciled before replaying edits: sheet
      // insertion and other structural commands are not idempotent operations.
      if (ctx.pending || ctx.preparing) throw hostError('UNAVAILABLE','unconfirmed save')
      if (!lease) throw hostError('CONFLICT','lease')
      ctx.preparing = true; ctx.status = 'saving'; emit()
      let committing = false
      try {
        const snapshot = structuredClone(edits)
        const body = { baseRevision: base,leaseEpoch: lease.leaseEpoch,editorId: editor,request: snapshot }
        // Match the server's existing sheets/uploads bodyLimit. Count the full
        // UTF-8 JSON envelope, not just edits or UTF-16 string length.
        if (new TextEncoder().encode(JSON.stringify(body)).byteLength > 4 * 1024 * 1024) throw hostError('PAYLOAD_TOO_LARGE','workbook save; edits remain unsaved')
        const draft = await mutation(`/api/v1/files/${id}/sheets/uploads`,'POST',body)
        const uploadId = uuid(draft?.uploadId)
        if (draft.baseRevision !== base || draft.leaseEpoch !== lease.leaseEpoch || typeof draft.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(draft.sha256) || !Number.isSafeInteger(draft.size) || draft.size < 1 || draft.size > 32 * 1024 * 1024) throw hostError('INVALID_RESPONSE','prepared workbook')
        if (context(id) !== ctx || ctx.revision.revision !== base || ctx.lease?.leaseEpoch !== lease.leaseEpoch) throw hostError('CONFLICT','changed save authority')
        if (!Array.isArray(draft.touchedEntries) || draft.touchedEntries.length > 256 || draft.touchedEntries.some((name: unknown) => typeof name !== 'string' || name.length > 1024)) throw hostError('INVALID_RESPONSE','changed parts')
        if(!authorized())throw hostError('UNAVAILABLE','save authorization changed')
        committing = true
        const saved = await commit(id,ctx,{ touchedEntries: [...draft.touchedEntries], input: Object.freeze({fileId: id,uploadId,baseRevision: base,leaseEpoch: lease.leaseEpoch,idempotencyKey: crypto.randomUUID()}),sha256: draft.sha256,size: draft.size },authorized)
        return {...saved,touchedEntries: draft.touchedEntries as string[]}
      } catch (error) {
        if (!committing) {
          const code = (error as HostError).code
          ctx.status = code === 'UNAUTHORIZED' ? 'unauthorized' : code === 'CONFLICT' ? 'conflict' : 'idle'
          if (code === 'UNAUTHORIZED' || code === 'CONFLICT') revokeLease(id,ctx)
        }
        throw error
      } finally { ctx.preparing = false; emit() }
    },
    // Slides save: the server exports the generation-pinned pptx session and
    // stages it through the same T06 upload/receipt protocol as sheets. The
    // request is the renderer session pointer {revision, generation}; the
    // server resolves it against its in-process session and returns the
    // prepared draft receipt. Never replays while a receipt is unconfirmed.
    async saveSlides(fileId: string, request: unknown) {
      const id = uuid(fileId), ctx = liveContext(id), lease = ctx.lease, base = ctx.revision.revision
      if (ctx.pending || ctx.preparing) throw hostError('UNAVAILABLE','unconfirmed save')
      if (!lease) throw hostError('CONFLICT','lease')
      ctx.preparing = true; ctx.status = 'saving'; emit()
      let committing = false
      try {
        const snapshot = structuredClone(request)
        const draft = await mutation(`/api/v1/files/${id}/slides/uploads`,'POST',{ baseRevision: base,leaseEpoch: lease.leaseEpoch,editorId: editor,request: snapshot })
        const uploadId = uuid(draft?.uploadId)
        if (draft.baseRevision !== base || draft.leaseEpoch !== lease.leaseEpoch || typeof draft.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(draft.sha256) || !Number.isSafeInteger(draft.size) || draft.size < 1 || draft.size > 32 * 1024 * 1024) throw hostError('INVALID_RESPONSE','prepared deck')
        if (context(id) !== ctx || ctx.revision.revision !== base || ctx.lease?.leaseEpoch !== lease.leaseEpoch) throw hostError('CONFLICT','changed save authority')
        // Changed zip parts are optional (the slides save service does not diff them yet);
        // the receipt itself stays the T06 idempotent commit.
        const touchedEntries = Array.isArray(draft.touchedEntries) && draft.touchedEntries.length <= 256 && draft.touchedEntries.every((name: unknown) => typeof name === 'string' && name.length <= 1024) ? [...draft.touchedEntries as string[]] : []
        committing = true
        const saved = await commit(id,ctx,{ touchedEntries, input: Object.freeze({fileId: id,uploadId,baseRevision: base,leaseEpoch: lease.leaseEpoch,idempotencyKey: crypto.randomUUID()}),sha256: draft.sha256,size: draft.size })
        return {...saved,touchedEntries}
      } catch (error) {
        if (!committing) {
          const code = (error as HostError).code
          ctx.status = code === 'UNAUTHORIZED' ? 'unauthorized' : code === 'CONFLICT' ? 'conflict' : 'idle'
          if (code === 'UNAUTHORIZED' || code === 'CONFLICT') revokeLease(id,ctx)
        }
        throw error
      } finally { ctx.preparing = false; emit() }
    },
    async reconcileSlides(fileId: string) {
      const id = uuid(fileId), ctx = context(id), pending = ctx.pending
      if (!pending) throw hostError('INVALID_REVISION','slides receipt')
      const saved = await commit(id,ctx,pending)
      return {...saved,touchedEntries:[...(pending.touchedEntries ?? [])]}
    },
    async save(fileId: string, bytes: Uint8Array, authorized:()=>boolean = ()=>true) {
      if(!authorized())throw hostError('UNAVAILABLE','save authorization changed')
      const id = uuid(fileId), ctx = context(id)
      if (ctx.pending) { const prior = ctx.pending; const recovered = await commit(id,ctx,prior,authorized); if (await digest(bytes) === prior.sha256) return recovered }
      const { uploadId } = await host.stageSave(bytes,id), staged = ctx.staged.get(uploadId)!
      if(!authorized())throw hostError('UNAVAILABLE','save authorization changed')
      return commitStaged({fileId:id,uploadId,baseRevision:staged.base,leaseEpoch:staged.epoch,idempotencyKey:crypto.randomUUID()},authorized)
    },
    startRenewal(fileId: string) {
      const id = uuid(fileId)
      if (!timers.has(id)) timers.set(id,setInterval(() => { if (!disposed && contexts.has(id)) { const ctx=liveContext(id); if(ctx.lease)void renewLease(id).catch(()=>{}) } },15_000))
      return () => { clearInterval(timers.get(id)); timers.delete(id) }
    },
    dispose() { disposed = true; for (const [controller,keepalive] of requests) if (!keepalive) controller.abort(); for (const reader of readers) void reader.cancel().catch(() => {}); for (const timer of timers.values()) clearInterval(timer); for(const timer of expirations.values())clearTimeout(timer);expirations.clear();renewals.clear(); timers.clear(); listeners.clear(); contexts.clear(); references.clear(); csrf = undefined },
  }
}
export type SessionFileHost = ReturnType<typeof createSessionFileHost>
