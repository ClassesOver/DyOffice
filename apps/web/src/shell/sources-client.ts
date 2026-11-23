import { zh } from './i18n/sources/zh'
import type { CreateSourceRequest, SourceDescriptor, SourceDetail, SourceList, SourceQueryRequest, SaveSourceRequest, QuerySnapshot, SourceConnectionCheck, SourceDiscovery } from '../../../../packages/web-contracts/src/sources.ts'

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>
/** The message is the zh text; `sourcesKey` lets the panel show it in the current UI language. */
const keyed = (key: keyof typeof zh, extra: Record<string, unknown> = {}) => Object.assign(Error(zh[key]), { sourcesKey: key }, extra)
export interface SourcesClientState { pending: boolean; unknownWrite: boolean; unknownSourceId: string | null }
const id = (value: string) => { if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value)) throw keyed('srcErrInvalidSourceId'); return encodeURIComponent(value) }
function safeError(error: unknown) {
  const status = (error as { status?: number })?.status
  const key = status === 409 ? 'srcErrSourceChanged'
    : status === 401 || status === 403 ? 'srcErrSourceForbidden'
    : status === 503 ? 'srcErrStoreUnavailable'
    : status === 400 || status === 422 ? 'srcErrSourceInvalid'
    : 'srcErrResultUnconfirmed'
  return keyed(key, { status })
}

/** Authentication/session fencing belongs to the shared local client. Unknown
 * writes remain fenced across modal remounts: this instance lives at Home scope. */
export function createSourcesClient(request: Request) {
  let pending = false, unknownWrite = false
  let unknownSourceId:string|null=null, verifiedSourceId:string|null=null
  const listeners = new Set<() => void>()
  const emit = () => { for (const listener of listeners) listener() }
  async function run<T>(write: boolean, operation: () => Promise<T>, sourceId?:string) {
    if (pending) throw keyed('srcErrOperationPending')
    if (write && unknownWrite) throw keyed('srcErrLastWriteUnconfirmed')
    pending = true; emit()
    try {
      const result = await operation()
      return result
    } catch (error) {
      const status = (error as { status?: number })?.status
      if (write && (status === undefined || status >= 500 || status === 408)){unknownWrite=true;unknownSourceId=sourceId??null;verifiedSourceId=null}
      throw safeError(error)
    } finally { pending = false; emit() }
  }
  const path = (sourceId: string) => '/api/v1/sources/' + id(sourceId)
  return {
    getState: (): SourcesClientState => ({ pending, unknownWrite, unknownSourceId }),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    list(after?: string) { return run(false, () => request<SourceList>('/api/v1/sources?limit=50' + (after ? '&after=' + id(after) : ''))) },
    detail(sourceId: string) { return run(false, async () => {verifiedSourceId=null;try{const result=await request<SourceDetail>(path(sourceId));if(result.source.sourceId!==sourceId)throw keyed('srcErrSourceIdMismatch');verifiedSourceId=sourceId;return result}catch(error){if((error as {status?:number}).status===404)verifiedSourceId=sourceId;throw error}}) },
    acknowledgeLatest(sourceId:string) { if (pending) throw keyed('srcErrOperationPending');if(unknownWrite&&(sourceId!==unknownSourceId||verifiedSourceId!==sourceId))return false;unknownWrite=false;unknownSourceId=null;verifiedSourceId=null;emit();return true },
    create(input: CreateSourceRequest) { const body = structuredClone(input); return run(true, () => request<SourceDescriptor>('/api/v1/sources', 'POST', body),input.sourceId) },
    save(sourceId: string, input: SaveSourceRequest) { const body = structuredClone(input); return run(true, () => request<SourceDescriptor>(path(sourceId), 'PUT', body),sourceId) },
    test(sourceId: string) { return run(false, () => request<SourceConnectionCheck>(path(sourceId) + '/test', 'POST', {})) },
    discover(sourceId:string, expectedVersion:number, directory?:string, page=1) { return run(false, () => request<SourceDiscovery>(path(sourceId) + '/discover', 'POST', {expectedVersion,page,...(directory === undefined ? {} : {directory})})) },
    query(sourceId: string, input: SourceQueryRequest) { const body = structuredClone(input); return run(false, () => request<QuerySnapshot>(path(sourceId) + '/query', 'POST', body)) },
    remove(sourceId: string, expectedVersion: number) { return run(true, () => request<void>(path(sourceId), 'DELETE', { expectedVersion }),sourceId) },
  }
}
export type SourcesClient = ReturnType<typeof createSourcesClient>
