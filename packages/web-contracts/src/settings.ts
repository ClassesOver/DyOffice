/** Global configuration is separate from personal preferences and desktop AiSettings. */
export const GLOBAL_SETTING_KINDS = ['chat','image_generation','image_analysis','video_analysis','web_search','image_search','rerank','http_mcp'] as const
export type GlobalSettingKind = typeof GLOBAL_SETTING_KINDS[number]
export type GlobalDefaults = Partial<Record<GlobalSettingKind, string>>
export interface PublicGlobalEntry { id: string; kind: GlobalSettingKind; providerId: string; label: string; model: string; ready?: boolean }
export interface AdminGlobalEntry extends PublicGlobalEntry { baseUrl: string; enabled: boolean; hasKey: boolean }
export interface ProviderCatalogEntry {
  id: string; label: string; kinds: GlobalSettingKind[]; models: string[]; defaultBaseUrl: string;
  available: boolean; unavailableReason?: string
}
export interface PublicGlobalSettings { revision: number; catalog: PublicGlobalEntry[]; defaults: GlobalDefaults }
export interface SourceEgressTarget {
  kind: 'http' | 'postgres' | 'mysql' | 'starrocks'
  endpoint: string
  addresses: readonly string[]
  username?: string
  database?: string
  allowInsecure?: boolean
  ca?: string
}
export interface AdminGlobalConfig {
  revision: number; entries: AdminGlobalEntry[]; defaults: GlobalDefaults;
  providerCatalog: ProviderCatalogEntry[]; keyStorageAvailable: boolean
  sourceEgressTargets?: SourceEgressTarget[]
}
/** Missing/blank apiKey preserves the stored key; only clearKey removes it. */
export type GlobalEntryUpsert = Omit<AdminGlobalEntry, 'hasKey'> & { apiKey?: string; clearKey?: true }
export interface GlobalConfigPatch {
  upserts?: GlobalEntryUpsert[]; removes?: string[]; defaults?: Partial<Record<GlobalSettingKind, string | null>>
  sourceEgressTargets?: SourceEgressTarget[]
}
export interface SaveGlobalConfigRequest { expectedRevision?: number; patch: GlobalConfigPatch }
export interface CheckGlobalConfigRequest { expectedRevision?: number; entryId?: string }
export interface GlobalConfigCheck {
  revision: number; configuration: 'valid'; checkedEntries: number;
  secrets: 'readable' | 'not_required'; connection: 'not_run'
}
export const MODEL_CONNECTION_FAILURES = ['PROVIDER_AUTH_REJECTED','PROVIDER_RATE_LIMITED','PROVIDER_TEMPORARILY_UNAVAILABLE'] as const
export type ModelConnectionFailure = typeof MODEL_CONNECTION_FAILURES[number]
export type ModelConnectionResult = {ok:true} | {ok:false;reason?:ModelConnectionFailure}

