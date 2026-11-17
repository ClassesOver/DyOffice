import type { CreateSourceRequest, SourceDescriptor, SourceDetail, SourceList, SourceQueryRequest, SaveSourceRequest, PublishedSourceVersion, QuerySnapshot, SourceConnectionCheck } from '../../../../packages/web-contracts/src/sources.ts'

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>
export interface SourcesClientState { pending: boolean; unknownWrite: boolean }
const id = (value: string) => { if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value)) throw Error('数据源标识无效。'); return encodeURIComponent(value) }
function safeError(error: unknown) {
  const status = (error as { status?: number })?.status
  const message = status === 409 ? '数据源版本或状态已变化。当前草稿已保留，请读取最新版本后核对。'
    : status === 401 || status === 403 ? '当前会话无权操作此数据源，请重新登录或联系管理员。'
    : status === 503 ? '数据源或凭据存储暂不可用，请检查部署配置。'
    : status === 400 || status === 422 ? '数据源配置或查询无效，请检查输入。'
    : '操作结果未确认，请读取最新数据源并核对。'
  return Object.assign(Error(message), { status })
}

/** Authentication/session fencing belongs to the shared local client. Unknown
 * writes remain fenced across modal remounts: this instance lives at Home scope. */
export function createSourcesClient(request: Request) {
  let pending = false, unknownWrite = false
  const listeners = new Set<() => void>()
  const emit = () => { for (const listener of listeners) listener() }
  async function run<T>(write: boolean, operation: () => Promise<T>, acknowledge = false) {
    if (pending) throw Error('数据源操作正在进行中。')
    if (write && unknownWrite) throw Error('上次写入结果未确认，请先读取并核对最新数据源。')
    pending = true; emit()
    try {
      const result = await operation()
      if (acknowledge) unknownWrite = false
      return result
    } catch (error) {
      const status = (error as { status?: number })?.status
      if (write && (status === undefined || status >= 500 || status === 408)) unknownWrite = true
      throw safeError(error)
    } finally { pending = false; emit() }
  }
  const path = (sourceId: string) => '/api/v1/sources/' + id(sourceId)
  return {
    getState: (): SourcesClientState => ({ pending, unknownWrite }),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    list(after?: string) { return run(false, () => request<SourceList>('/api/v1/sources?limit=50' + (after ? '&after=' + id(after) : ''))) },
    detail(sourceId: string) { return run(false, () => request<SourceDetail>(path(sourceId))) },
    acknowledgeLatest() { if (pending) throw Error('数据源操作正在进行中。'); unknownWrite = false; emit() },
    create(input: CreateSourceRequest) { const body = structuredClone(input); return run(true, () => request<SourceDescriptor>('/api/v1/sources', 'POST', body)) },
    save(sourceId: string, input: SaveSourceRequest) { const body = structuredClone(input); return run(true, () => request<SourceDescriptor>(path(sourceId), 'PUT', body)) },
    publish(sourceId: string, expectedVersion: number) { return run(true, () => request<PublishedSourceVersion>(path(sourceId) + '/publish', 'POST', { expectedVersion })) },
    test(sourceId: string) { return run(false, () => request<SourceConnectionCheck>(path(sourceId) + '/test', 'POST', {})) },
    query(sourceId: string, input: SourceQueryRequest) { const body = structuredClone(input); return run(false, () => request<QuerySnapshot>(path(sourceId) + '/query', 'POST', body)) },
    remove(sourceId: string, expectedVersion: number) { return run(true, () => request<void>(path(sourceId), 'DELETE', { expectedVersion })) },
  }
}
export type SourcesClient = ReturnType<typeof createSourcesClient>
