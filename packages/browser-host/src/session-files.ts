import { createBrowserHost } from './index.ts'
import { isRevisionRef, type OpenFileResult, type RevisionRef, type SaveInput } from '../../web-contracts/src/api.ts'
import { hostError, HostError } from '../../web-contracts/src/errors.ts'

type Lease = { leaseEpoch: number; editorId: string; expiresAt: string }
type DocxPasswordChange = { password: string | null }
type Pending = { passwordChange?: DocxPasswordChange; authorized?:()=>boolean; touchedEntries?: string[]; input: SaveInput; sha256: string; size: number; sourceSha256?:string }
type Context = { docxPasswordProtected?:boolean; docxPasswordChange?:DocxPasswordChange; docxUnlockProof?:string; docxUnlockId?:string; docxRecoveryUnlockId?:string; recoveredDocx?:{revision:string;sourceSha256:string}; autoNamePending:boolean; preparing: boolean; leaseOperation: number; exclusiveLease: number | null; revision: RevisionRef; name: string; lease: Lease | null; pending: Pending | null; status: 'idle' | 'saving' | 'unknown' | 'conflict' | 'unauthorized'; staged: Map<string, { base: string; epoch: number; sha256: string; size: number; sourceSha256?:string; passwordChange?:DocxPasswordChange }> }
const uuid = (value: string) => { if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw hostError('INVALID_REVISION','identifier'); return value.toLowerCase() }
const digest = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes.slice().buffer as ArrayBuffer)),value => value.toString(16).padStart(2,'0')).join('')
function errorFor(status: number) {
  const code = status === 401 || status === 403 ? 'UNAUTHORIZED' : status === 409 || status === 410 ? 'CONFLICT' : status === 413 ? 'PAYLOAD_TOO_LARGE' : status >= 500 || status === 408 ? 'UNAVAILABLE' : 'INVALID_RESPONSE'
  return Object.assign(hostError(code,'request'),{ status })
}
export class CitedRevisionChanged extends HostError {
  constructor() { super('CONFLICT', 'The cited revision is no longer the current document revision.') }
}

export function createSessionFileHost({ fetchImpl = fetch, editorId = crypto.randomUUID(), onState, leaseRetryDelayMs = 150, expectedRevision }: { fetchImpl?: typeof fetch; editorId?: string; onState?: () => void; leaseRetryDelayMs?: number; expectedRevision?: string | undefined } = {}) {
  let citedRevision = expectedRevision
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
        try { lease=readLease(await mutation(`/api/v1/files/${id}/lease${suffix}`,'POST',ctx.docxUnlockId?{...body,docxUnlockId:ctx.docxUnlockId}:body));break }
        catch(error) {
          // A refresh may acquire before the old page's keepalive release arrives.
          // Retry acquire only; it must never silently take over a live editor.
          if (suffix !== '' || (error as HostError).code !== 'CONFLICT' || attempt === 2 || !currentOperation(id,ctx,op)) throw error
          if (retryDelay) await new Promise(resolve=>setTimeout(resolve,retryDelay*(attempt+1)))
        }
      }
      if (!currentOperation(id,ctx,op)) throw hostError('CONFLICT','superseded lease')
      ctx.lease = lease!; armExpiration(id,ctx); if (!ctx.pending && !ctx.preparing) ctx.status = 'idle'; emit(); return { ...lease! }
    } catch (error) {
      const {code,status} = error as HostError & {status?:number}
      // A transient renewal failure cannot extend the lease or invalidate the last confirmed deadline.
      if (currentOperation(id,ctx,op) && !(suffix === '/renew' && (code === 'UNAVAILABLE' || status === 429))) {
        ctx.lease = null; clearExpiration(id)
        if (status===423)delete ctx.docxUnlockId
        if (!ctx.pending && !ctx.preparing) ctx.status = code === 'UNAUTHORIZED' ? 'unauthorized' : 'conflict'
        emit()
      }
      throw error
    }
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
    if(pending.passwordChange){
      ctx.docxPasswordProtected=!!pending.passwordChange.password
      delete ctx.docxUnlockId
      delete ctx.docxRecoveryUnlockId
      ctx.leaseOperation++;renewals.delete(fileId)
      if(ctx.docxPasswordChange===pending.passwordChange)delete ctx.docxPasswordChange
    }
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
    try {
      const saved=accept(fileId,ctx,pending,await mutation(`/api/v1/files/${fileId}/commits`,'POST',pending.input,false,false,permitted))
      if(recovering&&pending.sourceSha256)ctx.recoveredDocx={revision:saved.revision,sourceSha256:pending.sourceSha256}
      // The old editing grant cannot authorize a revision encrypted with a new password.
      const password=pending.passwordChange?.password
      if(password){
        try{
          await readUnlockedDocx(fileId,'unlock',{password},true)
          if(!ctx.lease&&ctx.docxUnlockId)await leaseOperation(fileId,'',{editorId:editor})
        }catch{/* The user can re-enter the new password in the open document. */}
        emit()
      }
      return saved
    }
    catch (error) {
      const status = (error as { status?: number }).status
      if((error as {saveNotSubmitted?:boolean}).saveNotSubmitted){
        // A first attempt stopped before fetch is known-not-sent. A blocked
        // retry cannot erase uncertainty about an earlier submitted request.
        ctx.pending=recovering?pending:null;ctx.status=recovering?'unknown':'idle';emit();throw error
      }
      // A rate limit can block a receipt lookup after the write already landed.
      // Keep the staged request so the next attempt uses the same idempotency key.
      if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) {
        ctx.pending = null; ctx.status = (error as HostError).code === 'UNAUTHORIZED' ? 'unauthorized' : 'conflict'
        ctx.staged.delete(pending.input.uploadId)
        const docxLocked=status===423&&!!ctx.docxPasswordProtected
        if(docxLocked)delete ctx.docxUnlockId
        if (docxLocked || ctx.status === 'unauthorized' || (error as HostError).code === 'CONFLICT') revokeLease(fileId,ctx)
      } else ctx.status = 'unknown'
      emit(); throw error
    } finally { committing.delete(ctx) }
  }
  function commitStaged(input:SaveInput,authorized:()=>boolean = ()=>true){
    const id=uuid(input.fileId),ctx=context(id),staged=ctx.staged.get(input.uploadId)
    if(!staged||staged.base!==input.baseRevision||staged.epoch!==input.leaseEpoch||ctx.pending||ctx.preparing)throw hostError('INVALID_REVISION','snapshot')
    return commit(id,ctx,{input:Object.freeze({...input}),sha256:staged.sha256,size:staged.size,...(staged.sourceSha256?{sourceSha256:staged.sourceSha256}:{}),...(staged.passwordChange?{passwordChange:staged.passwordChange}:{})},authorized)
  }
  async function prepareAndCommitSheets(fileId:string,payload:{request:unknown;unlockId?:string}|{newPassword:string;unlockId:string}|{csvContent:string},authorized:()=>boolean) {
    if(!authorized())throw hostError('UNAVAILABLE','save authorization changed')
    const id = uuid(fileId), ctx = liveContext(id), lease = ctx.lease, base = ctx.revision.revision
    // An uncertain receipt must be reconciled before replaying edits: sheet
    // insertion and other structural commands are not idempotent operations.
    if (ctx.pending || ctx.preparing) throw hostError('UNAVAILABLE','unconfirmed save')
    if (!lease) throw hostError('CONFLICT','lease')
    ctx.preparing = true; ctx.status = 'saving'; emit()
    let committing = false
    try {
      const authority={baseRevision:base,leaseEpoch:lease.leaseEpoch,editorId:editor}
      const path=`/api/v1/files/${id}/sheets`
      let draft
      if('csvContent' in payload){
        const bytes=new Blob(['\ufeff',payload.csvContent])
        if(bytes.size>32*1024*1024)throw hostError('PAYLOAD_TOO_LARGE','CSV save; edits remain unsaved')
        const query=new URLSearchParams({...authority,leaseEpoch:String(lease.leaseEpoch)})
        draft=await mutation(path+'/csv-uploads?'+query,'POST',bytes,true,false,authorized)
      }else{
        const changingPassword = 'newPassword' in payload
        const body = {...authority,
          ...(changingPassword ? {newPassword:payload.newPassword} : {request:structuredClone(payload.request)}),
          ...(payload.unlockId ? {unlockId:uuid(payload.unlockId)} : {}),
        }
        // Match the server's body limit for the full UTF-8 JSON edit envelope.
        if (!changingPassword && new TextEncoder().encode(JSON.stringify(body)).byteLength > 4 * 1024 * 1024) throw hostError('PAYLOAD_TOO_LARGE','workbook save; edits remain unsaved')
        const endpoint = changingPassword ? 'password-uploads' : 'uploads'
        draft=await mutation(path+'/'+endpoint,'POST',body)
      }
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
  }
  async function readBoundedBytes(reply:Response,limit:number) {
    if (!reply.ok) { discard(reply); throw errorFor(reply.status) }
    if (!reply.headers.get('content-type')?.startsWith('application/octet-stream') || !reply.body) { discard(reply); throw hostError('INVALID_RESPONSE','bytes') }
    const reader = reply.body.getReader(), chunks: Uint8Array[] = []
    let size = 0
    readers.add(reader)
    try {
      for (;;) { assertActive(); const { value,done } = await reader.read(); assertActive(); if (done) break; size += value.byteLength; if (size > limit) throw hostError('INVALID_RESPONSE','length'); chunks.push(value) }
    } catch (error) { void reader.cancel().catch(() => {}); throw error }
    finally { readers.delete(reader); reader.releaseLock() }
    const bytes = new Uint8Array(size); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength }
    return bytes
  }
  async function readUnlockedDocx(fileId:string,action:'unlock'|'import-unlock',credential:{password:string}|{unlockId:string},edit:boolean){
    const id=uuid(fileId),ctx=context(id),revision=ctx.revision.revision
    if(!ctx.docxUnlockProof)throw hostError('UNAUTHORIZED','document unlock session')
    // A stale session proof requires reopening. Never replay credentials with a new cookie.
    const reply=await request(`/api/v1/files/${id}/docx/${action}`,{
      method:'POST',headers:{'content-type':'application/json','x-csrf-token':ctx.docxUnlockProof},body:JSON.stringify({revision,...credential,...(edit?{editorId:editor}:{})}),
    })
    const bytes=await readBoundedBytes(reply,32 * 1024 * 1024)
    if(!bytes.byteLength||context(id)!==ctx||ctx.revision.revision!==revision)throw hostError('CONFLICT','document unlock')
    const unlockId=reply.headers.get('x-dyoffice-docx-unlock')
    if(unlockId)ctx.docxRecoveryUnlockId=uuid(unlockId)
    if(unlockId&&unlockId!==ctx.docxUnlockId){
      ctx.docxUnlockId=uuid(unlockId)
      ctx.leaseOperation++;renewals.delete(id)
    }
    return bytes
  }
  async function uploadDocxDraft(id:string,ctx:Context,lease:Lease,endpoint:'uploads'|'copy/uploads'|'password/uploads',bytes:Uint8Array<ArrayBuffer>,name?:string,change?:DocxPasswordChange){
    if(!ctx.docxUnlockProof||(ctx.docxPasswordProtected&&!ctx.docxUnlockId))throw hostError('CONFLICT','document unlock')
    let body:BodyInit=bytes,mime='application/octet-stream'
    if(change){
      const password=new TextEncoder().encode(change.password??'')
      const prefix=new Uint8Array(2)
      new DataView(prefix.buffer).setUint16(0,password.byteLength)
      body=new Blob([prefix,password,bytes])
      password.fill(0)
      mime='application/vnd.dyoffice.docx-password-change'
    }
    const query=new URLSearchParams({baseRevision:ctx.revision.revision,editorId:editor,leaseEpoch:String(lease.leaseEpoch)})
    if(name!==undefined)query.set('name',name)
    return readJson(await request(`/api/v1/files/${id}/docx/${endpoint}?${query}`,{
      method:'POST',headers:{'content-type':mime,'x-csrf-token':ctx.docxUnlockProof,...(ctx.docxUnlockId&&{'x-dyoffice-docx-unlock':ctx.docxUnlockId})},body,
    }))
  }
  const host = createBrowserHost({
    getCapabilities: () => get('/api/v1/capabilities'),
    async open(fileId) {
      const id = uuid(fileId)
      if (contexts.get(id)?.pending || contexts.get(id)?.preparing) throw hostError('UNAVAILABLE','unconfirmed commit')
      const initialCitation = citedRevision === undefined ? undefined : uuid(citedRevision)
      const result = await get(`/api/v1/files/${id}`) as OpenFileResult & { name?: string }
      assertActive()
      if (!isRevisionRef(result?.file) || result.file.fileId !== id) throw hostError('INVALID_RESPONSE','open')
      if (initialCitation && initialCitation !== result.file.revision) throw new CitedRevisionChanged()
      citedRevision = undefined
      const name = typeof result.name === 'string' && result.name.length <= 255 ? result.name : id + '.' + result.format
      let docxUnlockProof:string|undefined
      if(result.format==='docx'&&result.documentPasswordProtected===true){
        const proof=await get('/api/v1/auth/session-proof')
        if(typeof proof?.csrfToken!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(proof.csrfToken))throw hostError('INVALID_RESPONSE','document session proof')
        docxUnlockProof=proof.csrfToken
      }
      assertActive()
      contexts.set(id,{ ...(docxUnlockProof?{docxUnlockProof,docxPasswordProtected:true}:{}),autoNamePending:result.autoNamePending===true, preparing: false,leaseOperation: 0,exclusiveLease: null,revision: { ...result.file },name,lease: null,pending: null,status: 'idle',staged: new Map() }); remember(result.file); emit()
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
      if (ref.size > 32 * 1024 * 1024) throw hostError('PAYLOAD_TOO_LARGE','read')
      const reply = await request(`/api/v1/files/${id}/content?revision=${rev}`)
      const bytes=await readBoundedBytes(reply,ref.size)
      if (bytes.byteLength !== ref.size || await digest(bytes) !== ref.sha256) throw hostError('INVALID_RESPONSE','integrity')
      assertActive()
      return bytes
    },
    async stageSave(bytes, fileId) {
      const id = uuid(fileId), ctx = liveContext(id), lease = ctx.lease
      if (!lease || ctx.pending || ctx.preparing) throw hostError(ctx.pending || ctx.preparing ? 'UNAVAILABLE' : 'CONFLICT','stage')
      const snapshot = bytes.slice(), base = ctx.revision.revision
      const protectedDocx=!!ctx.docxPasswordProtected, passwordChange=ctx.docxPasswordChange
      const sealedPath=protectedDocx||!!passwordChange
      if(sealedPath){ctx.preparing=true;ctx.status='saving';emit()}
      try {
        const sha256=await digest(snapshot)
        if(sealedPath){
          if(ctx.revision.revision!==base||ctx.lease?.leaseEpoch!==lease.leaseEpoch)throw hostError('CONFLICT','save authority changed')
          const draft=await uploadDocxDraft(id,ctx,lease,passwordChange?'password/uploads':'uploads',snapshot,undefined,passwordChange)
          const uploadId=uuid(draft?.uploadId)
          if(draft.baseRevision!==base||draft.leaseEpoch!==lease.leaseEpoch||!/^([a-f0-9]{64})$/.test(draft.sha256)||!Number.isSafeInteger(draft.size)||draft.size<1||draft.size>32*1024*1024)throw hostError('INVALID_RESPONSE','protected revision')
          if(context(id)!==ctx||ctx.revision.revision!==base||ctx.lease?.leaseEpoch!==lease.leaseEpoch)throw hostError('CONFLICT','save authority changed')
          ctx.staged.set(uploadId,{base,epoch:lease.leaseEpoch,sha256:draft.sha256,size:draft.size,sourceSha256:sha256,...(passwordChange?{passwordChange}:{})})
          return {uploadId}
        }
        const result = await mutation(`/api/v1/files/${id}/uploads`,'POST',{ size: snapshot.byteLength,baseRevision: base,leaseEpoch: lease.leaseEpoch,editorId: editor })
        const uploadId = uuid(result?.uploadId)
        await mutation(`/api/v1/uploads/${uploadId}/content`,'PUT',snapshot,true)
        assertActive()
        ctx.staged.set(uploadId,{ base,epoch: lease.leaseEpoch,sha256,size: snapshot.byteLength })
        return { uploadId }
      } catch (error) {
        const {code,status}=error as HostError & {status?:number}
        const docxLocked=protectedDocx&&status===423
        if(docxLocked)delete ctx.docxUnlockId
        if(docxLocked||code==='CONFLICT'||code==='UNAUTHORIZED'){
          revokeLease(id,ctx);ctx.status=code==='UNAUTHORIZED'?'unauthorized':'conflict';emit()
        }
        throw error
      }
      finally{if(sealedPath){ctx.preparing=false;if(ctx.status==='saving')ctx.status='idle';emit()}}
    },
    async commitSave(input) {
      return commitStaged(input)
    },
    getPreferences: () => get('/api/preferences'),
  })
  return {
    ...host,
    isDocxPasswordProtected:(fileId:string)=>context(fileId).docxPasswordProtected===true,
    hasDocxPasswordChange:(fileId:string)=>!!context(fileId).docxPasswordChange,
    setDocxPassword(fileId:string,password:string|null,proof:string){
      const id=uuid(fileId),ctx=liveContext(id)
      if(!ctx.lease||ctx.status!=='idle'||ctx.preparing||ctx.pending||committing.has(ctx)||!/^[-_A-Za-z0-9]{43}$/.test(proof)||
        (ctx.docxUnlockProof&&ctx.docxUnlockProof!==proof)||(ctx.docxPasswordProtected&&!ctx.docxUnlockId)||
        (password!==null&&(!password.length||password.length>255)))throw hostError('CONFLICT','document password')
      ctx.docxUnlockProof=proof
      for(const [upload,staged] of ctx.staged)if(staged.passwordChange)ctx.staged.delete(upload)
      if(password===null&&!ctx.docxPasswordProtected)delete ctx.docxPasswordChange
      else ctx.docxPasswordChange={password}
      delete ctx.recoveredDocx
      emit()
    },
    async unlockDocx(fileId:string,password:string,edit=true) {
      if(!password.length||password.length>255)throw hostError('INVALID_RESPONSE','document password')
      return readUnlockedDocx(fileId,'unlock',{password},edit)
    },
    async claimDocxImportUnlock(fileId:string,unlockId:string,edit=true){
      return readUnlockedDocx(fileId,'import-unlock',{unlockId:uuid(unlockId)},edit)
    },
    async stageDocxDraftCopy(fileId:string,name:string,bytes:Uint8Array){
      const id=uuid(fileId),ctx=liveContext(id),lease=ctx.lease
      if(!lease||ctx.status!=='idle'||(!ctx.docxPasswordProtected&&!ctx.docxPasswordChange))throw hostError('CONFLICT','document copy')
      const unlockId=ctx.docxUnlockId
      try{
        const draft=await uploadDocxDraft(id,ctx,lease,'copy/uploads',bytes.slice(),name,ctx.docxPasswordChange)
        return {uploadId:uuid(draft?.uploadId)}
      }catch(error){
        if((error as {status?:number}).status===423&&ctx.docxUnlockId===unlockId){
          delete ctx.docxUnlockId
          revokeLease(id,ctx)
          if(ctx.status==='idle')ctx.status='conflict'
          emit()
        }
        throw error
      }
    },
    canSealDocxRecovery:(fileId:string)=>!!context(fileId).docxRecoveryUnlockId,
    async sealDocxRecovery(fileId:string,bytes:Uint8Array){
      const id=uuid(fileId),ctx=context(id),unlockId=ctx.docxRecoveryUnlockId
      if(!ctx.docxPasswordProtected||!unlockId||!ctx.docxUnlockProof||ctx.status==='unauthorized')throw hostError('UNAUTHORIZED','document recovery')
      const query=new URLSearchParams({editorId:editor})
      const reply=await request(`/api/v1/files/${id}/docx/recovery-draft?${query}`,{
        method:'POST',headers:{'content-type':'application/octet-stream','x-csrf-token':ctx.docxUnlockProof,'x-dyoffice-docx-unlock':unlockId},body:bytes.slice(),
      })
      const encrypted=await readBoundedBytes(reply,32 * 1024 * 1024)
      const signature=[0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]
      if(context(id)!==ctx||ctx.docxRecoveryUnlockId!==unlockId||!ctx.docxPasswordProtected||!signature.every((byte,index)=>encrypted[index]===byte))throw hostError('INVALID_RESPONSE','encrypted recovery')
      return encrypted
    },
    hasDocxEditUnlock:(fileId:string)=>!!context(fileId).docxUnlockId,
    async closeDocxEdit(fileId:string){
      const id=uuid(fileId),ctx=context(id),unlockId=ctx.docxUnlockId??ctx.docxRecoveryUnlockId
      if(!unlockId||!ctx.docxUnlockProof)return
      delete ctx.docxUnlockId
      delete ctx.docxRecoveryUnlockId
      const reply=await request(`/api/v1/files/${id}/docx/unlock`,{
        method:'DELETE',keepalive:true,headers:{'content-type':'application/json','x-csrf-token':ctx.docxUnlockProof},body:JSON.stringify({unlockId}),
      })
      discard(reply)
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    getState(fileId: string) { const ctx = liveContext(fileId,false); return { revision: { ...ctx.revision },name: ctx.name,autoNamePending:ctx.autoNamePending,lease: ctx.lease ? { ...ctx.lease } : null,status: ctx.status } },
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
    async nameSavedBlank(fileId:string,revision:string,candidate:string){
      const id=uuid(fileId),ctx=context(id),previous=ctx.name
      if(!ctx.autoNamePending||ctx.revision.revision!==revision||!candidate.trim())return
      const result=await mutation(`/api/v1/files/${id}/auto-name`,'POST',{revision,candidate:Array.from(candidate).slice(0,120).join('')})
      if(context(id)!==ctx||ctx.revision.revision!==revision||result?.renamed!==true||typeof result.name!=='string'||result.name.length>255)return
      ctx.name=result.name;ctx.autoNamePending=false;emit()
      if(typeof window!=='undefined'&&window.parent!==window)window.parent.postMessage({type:'dyoffice-file-auto-name',previous,name:ctx.name},window.location.origin)
      return ctx.name
    },
    async refreshHead(fileId: string) {
      const id=uuid(fileId),ctx=context(id),base=ctx.revision.revision
      if(ctx.pending || ctx.preparing)throw hostError('UNAVAILABLE','unconfirmed save')
      const result=await get(`/api/v1/files/${id}`) as OpenFileResult & {name?: string}
      if(!isRevisionRef(result?.file)||result.file.fileId!==id)throw hostError('INVALID_RESPONSE','head')
      if(context(id)!==ctx || ctx.pending || ctx.preparing || ctx.revision.revision!==base)throw hostError('CONFLICT','changed head')
      ctx.revision={...result.file};ctx.autoNamePending=result.autoNamePending===true;remember(result.file)
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
    saveSheets(fileId:string,edits:unknown,authorized:()=>boolean=()=>true,unlockId?:string) {
      return prepareAndCommitSheets(fileId,{request:edits,...(unlockId?{unlockId}:{})},authorized)
    },
    saveCsv(fileId:string,csvContent:string,authorized:()=>boolean=()=>true) {
      return prepareAndCommitSheets(fileId,{csvContent},authorized)
    },
    async changeSheetsPassword(fileId:string,newPassword:string,unlockId:string,authorized:()=>boolean=()=>true) {
      if(typeof newPassword!=='string'||!newPassword.length||newPassword.length>255)throw hostError('INVALID_RESPONSE','workbook password length')
      return prepareAndCommitSheets(fileId,{newPassword,unlockId},authorized)
    },
    // Slides save: the server exports the generation-pinned pptx session and
    // stages it through the same T06 upload/receipt protocol as sheets. The
    // request is the renderer session pointer {revision, generation}; the
    // server resolves it against its in-process session and returns the
    // prepared draft receipt. Never replays while a receipt is unconfirmed.
    async saveSlides(fileId: string, request: unknown, authorized:()=>boolean=()=>true) {
      if(!authorized())throw hostError('UNAVAILABLE','save authorization changed')
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
        if(!authorized())throw hostError('UNAVAILABLE','save authorization changed')
        committing = true
        const saved = await commit(id,ctx,{ touchedEntries, input: Object.freeze({fileId: id,uploadId,baseRevision: base,leaseEpoch: lease.leaseEpoch,idempotencyKey: crypto.randomUUID()}),sha256: draft.sha256,size: draft.size },authorized)
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
    async wordLeaseActive(fileId:string) {return (await get('/api/v1/files/'+uuid(fileId)+'/lease')).active===true},
    async wordCollab(fileId:string,body:{revision:string;version?:number;steps?:unknown[]}) {
      return mutation('/api/v1/files/'+uuid(fileId)+'/word-collab','POST',{...body,clientId:editor})
    },
    async save(fileId: string, bytes: Uint8Array, authorized:()=>boolean = ()=>true,wordVersion?:number) {
      if(!authorized())throw hostError('UNAVAILABLE','save authorization changed')
      const id = uuid(fileId), ctx = context(id)
      if (ctx.pending) { const prior = ctx.pending; const recovered = await commit(id,ctx,prior,authorized); if (await digest(bytes) === (prior.sourceSha256??prior.sha256)) {delete ctx.recoveredDocx;return recovered} }
      if(ctx.recoveredDocx){
        const recovered=ctx.recoveredDocx
        if(recovered.revision===ctx.revision.revision&&await digest(bytes)===recovered.sourceSha256){delete ctx.recoveredDocx;return {...ctx.revision}}
        delete ctx.recoveredDocx
      }
      const { uploadId } = await host.stageSave(bytes,id), staged = ctx.staged.get(uploadId)!
      if(!authorized())throw hostError('UNAVAILABLE','save authorization changed')
      return commitStaged({fileId:id,uploadId,baseRevision:staged.base,leaseEpoch:staged.epoch,idempotencyKey:crypto.randomUUID(),...(wordVersion===undefined?{}:{wordVersion})},authorized)
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
