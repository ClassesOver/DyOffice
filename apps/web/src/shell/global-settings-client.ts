import {GLOBAL_SETTING_KINDS} from '../../../../packages/web-contracts/src/settings'
import type {AdminGlobalConfig, AdminGlobalEntry, GlobalConfigCheck, GlobalConfigPatch, GlobalDefaults, GlobalEntryUpsert, GlobalSettingKind, ProviderCatalogEntry} from '../../../../packages/web-contracts/src/settings'

/** The caller owns cookie authentication, CSRF and session-generation fencing. */
export type GlobalSettingsRequest = <T>(path: string, method?: string, body?: unknown) => Promise<T>
export type GlobalSettingsState = {pending: null | 'load' | 'save' | 'check' | 'rotate'; unknownWrite: boolean}
const messages = {
  busy: '配置操作正在进行中，请等待完成。',
  write_unknown: '无法确认上次写入结果。请先读取最新配置并核对，系统不会自动重复提交。',
  invalid_request: '配置输入无效，请检查名称、服务地址、版本和密钥操作。非密钥草稿已保留。',
  invalid_response: '无法确认服务器返回的配置，请读取最新配置后核对。',
  conflict: '配置已被其他管理员更新。当前非密钥草稿已保留，请读取最新配置后核对。',
  unavailable: '配置服务或密钥存储暂不可用。非密钥草稿已保留，请检查服务器配置后重试。',
  unauthorized: '登录已过期，请重新登录。',
  forbidden: '当前账号没有管理全局配置的权限。',
  stale_session: '登录状态已改变，请重新加载当前工作区。',
  rate_limited: '请求过于频繁，请稍后再试。',
  request_failed: '配置操作未完成。非密钥草稿已保留，请检查输入或读取最新配置。',
} as const
type ErrorCode = keyof typeof messages
export class GlobalSettingsError extends Error {
  constructor(public readonly code: ErrorCode, public readonly status?: number) {super(messages[code]); this.name = 'GlobalSettingsError'}
}
const fail = (code: ErrorCode, status?: number) => new GlobalSettingsError(code, status)
const kinds = new Set<string>(GLOBAL_SETTING_KINDS)
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const validId = (value: unknown): value is string => typeof value === 'string' && idPattern.test(value)
const validText = (value: unknown, max: number, empty = false): value is string => typeof value === 'string' && value.length <= max && (empty || !!value.trim()) && ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
const validRevision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 2147483647

function entry(value: unknown, code: 'invalid_request' | 'invalid_response'): Omit<AdminGlobalEntry, 'hasKey'> {
  if (!record(value) || !validId(value.id) || !kinds.has(value.kind as string) || !validId(value.providerId) || !validText(value.label, 200) || !validText(value.model, 256, true) || !validText(value.baseUrl, 2048, true) || typeof value.enabled !== 'boolean') throw fail(code)
  return {id: value.id, kind: value.kind as GlobalSettingKind, providerId: value.providerId, label: value.label, model: value.model, baseUrl: value.baseUrl, enabled: value.enabled}
}

function snapshot(value: unknown, expectedRevision?: number): AdminGlobalConfig {
  if (!record(value) || !validRevision(value.revision) || (expectedRevision !== undefined && value.revision !== expectedRevision) || !Array.isArray(value.entries) || value.entries.length > 100 || !record(value.defaults) || !Array.isArray(value.providerCatalog) || typeof value.keyStorageAvailable !== 'boolean') throw fail('invalid_response')
  const entries = value.entries.map(raw => {
    const result = entry(raw, 'invalid_response')
    if (!record(raw) || typeof raw.hasKey !== 'boolean') throw fail('invalid_response')
    return {...result, hasKey: raw.hasKey}
  })
  if (new Set(entries.map(item => item.id)).size !== entries.length) throw fail('invalid_response')
  const defaults: GlobalDefaults = {}
  for (const [kind, id] of Object.entries(value.defaults)) {
    if (!kinds.has(kind) || !validId(id) || !entries.some(item => item.id === id && item.kind === kind && item.enabled)) throw fail('invalid_response')
    defaults[kind as GlobalSettingKind] = id
  }
  const providerCatalog: ProviderCatalogEntry[] = value.providerCatalog.map(raw => {
    if (!record(raw) || !validId(raw.id) || !validText(raw.label, 200) || !Array.isArray(raw.kinds) || raw.kinds.some(kind => typeof kind !== 'string' || !kinds.has(kind)) || !Array.isArray(raw.models) || raw.models.some(model => !validText(model, 256, true)) || !validText(raw.defaultBaseUrl, 2048, true) || typeof raw.available !== 'boolean' || (raw.unavailableReason !== undefined && !validText(raw.unavailableReason, 1000, true))) throw fail('invalid_response')
    return {id: raw.id, label: raw.label, kinds: [...raw.kinds] as GlobalSettingKind[], models: [...raw.models] as string[], defaultBaseUrl: raw.defaultBaseUrl, available: raw.available, ...(typeof raw.unavailableReason === 'string' ? {unavailableReason: raw.unavailableReason} : {})}
  })
  return {revision: value.revision, entries, defaults, providerCatalog, keyStorageAvailable: value.keyStorageAvailable}
}

function safePatch(value: GlobalConfigPatch): GlobalConfigPatch {
  if (!record(value)) throw fail('invalid_request')
  const patch: GlobalConfigPatch = {}, seen = new Set<string>()
  if (value.upserts !== undefined) {
    if (!Array.isArray(value.upserts) || value.upserts.length > 100) throw fail('invalid_request')
    patch.upserts = value.upserts.map(raw => {
      const result: GlobalEntryUpsert = entry(raw, 'invalid_request')
      if (seen.has(result.id)) throw fail('invalid_request')
      seen.add(result.id)
      if (raw.apiKey !== undefined) {
        if (typeof raw.apiKey !== 'string' || new TextEncoder().encode(raw.apiKey).length > 8192 || ['\0', '\r', '\n'].some(character => raw.apiKey!.includes(character))) throw fail('invalid_request')
        if (raw.apiKey.trim()) result.apiKey = raw.apiKey
      }
      if (raw.clearKey !== undefined && raw.clearKey !== true) throw fail('invalid_request')
      if (raw.clearKey) {if (result.apiKey) throw fail('invalid_request'); result.clearKey = true}
      return result
    })
  }
  if (value.removes !== undefined) {
    if (!Array.isArray(value.removes) || value.removes.length > 100) throw fail('invalid_request')
    patch.removes = value.removes.map(id => {if (!validId(id) || seen.has(id)) throw fail('invalid_request'); seen.add(id); return id})
  }
  if (value.defaults !== undefined) {
    if (!record(value.defaults)) throw fail('invalid_request')
    patch.defaults = {}
    for (const [kind, id] of Object.entries(value.defaults)) {
      if (!kinds.has(kind) || (id !== null && !validId(id))) throw fail('invalid_request')
      patch.defaults[kind as GlobalSettingKind] = id
    }
  }
  if (!(patch.upserts?.length || patch.removes?.length || Object.keys(patch.defaults ?? {}).length)) throw fail('invalid_request')
  return patch
}

function safeError(error: unknown): GlobalSettingsError {
  if (error instanceof GlobalSettingsError) return error
  const cause = error as {status?: unknown; code?: unknown} | null
  const status = typeof cause?.status === 'number' ? cause.status : undefined
  const code = cause?.code === 'stale_session' ? 'stale_session' : status === 409 ? 'conflict' : status === 400 || status === 428 ? 'invalid_request' : status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 503 ? 'unavailable' : status === 429 ? 'rate_limited' : 'request_failed'
  return fail(code, status)
}

/** No snapshots or secrets are cached here. The operation fence survives modal remounts. */
export function createGlobalSettingsClient(request: GlobalSettingsRequest) {
  let pending: GlobalSettingsState['pending'] = null, unknownWrite = false
  const listeners = new Set<() => void>()
  const notify = () => {for (const listener of listeners) listener()}
  async function run<T>(kind: Exclude<GlobalSettingsState['pending'], null>, work: () => Promise<T>, reconcile = false): Promise<T> {
    if (pending) throw fail('busy')
    if (unknownWrite && kind !== 'load') throw fail('write_unknown')
    pending = kind; notify()
    try {
      const result = await work()
      if (kind === 'load' && reconcile) unknownWrite = false
      return result
    } catch (cause) {
      const error = safeError(cause)
      const rejected = error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 408
      if ((kind === 'save' || kind === 'rotate') && !rejected) {
        unknownWrite = true
        throw error.code === 'stale_session' ? error : fail('write_unknown', error.status)
      }
      throw error
    } finally {pending = null; notify()}
  }
  const revision = (value: number) => {if (!validRevision(value) || value >= 2147483647) throw fail('invalid_request'); return value}
  return {
    async load(options?: {reconcile?: boolean}): Promise<AdminGlobalConfig> {
      return run('load', async () => snapshot(await request('/api/v1/admin/config', 'GET')), options?.reconcile === true)
    },
    async save(expectedRevision: number, patch: GlobalConfigPatch): Promise<AdminGlobalConfig> {
      revision(expectedRevision)
      const body = {expectedRevision, patch: safePatch(patch)}
      return run('save', async () => snapshot(await request('/api/v1/admin/config', 'PUT', body), expectedRevision + 1))
    },
    async check(expectedRevision: number, entryId?: string): Promise<GlobalConfigCheck> {
      revision(expectedRevision)
      if (entryId !== undefined && !validId(entryId)) throw fail('invalid_request')
      return run('check', async () => {
        const value = await request<unknown>('/api/v1/admin/config/check', 'POST', {expectedRevision, ...(entryId !== undefined ? {entryId} : {})})
        if (!record(value) || value.revision !== expectedRevision || value.configuration !== 'valid' || !Number.isSafeInteger(value.checkedEntries) || (value.checkedEntries as number) < 0 || !['readable', 'not_required'].includes(value.secrets as string) || value.connection !== 'not_run') throw fail('invalid_response')
        return {revision: expectedRevision, configuration: 'valid', checkedEntries: value.checkedEntries as number, secrets: value.secrets as 'readable' | 'not_required', connection: 'not_run'}
      })
    },
    async rotate(expectedRevision: number): Promise<AdminGlobalConfig> {
      revision(expectedRevision)
      return run('rotate', async () => snapshot(await request('/api/v1/admin/config/rotate-key', 'POST', {expectedRevision}), expectedRevision + 1))
    },
    getState: (): GlobalSettingsState => ({pending, unknownWrite}),
    subscribe(listener: () => void) {listeners.add(listener); return () => {listeners.delete(listener)}},
  }
}
export type GlobalSettingsClient = ReturnType<typeof createGlobalSettingsClient>

