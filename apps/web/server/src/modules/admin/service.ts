import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { BusinessPrincipal, PrincipalTransactions } from '../../db/context.ts'
import { authError, tokenHash } from '../auth/sessions.ts'
import { createSecretBox, type SecretKeyring, type SecretEnvelope } from './secrets.ts'
import { findProvider, getProviderCatalog } from './catalog.ts'
import { validateSourceEgressTargets } from '../../security/egress.ts'
import { GLOBAL_SETTING_KINDS } from '../../../../../../packages/web-contracts/src/settings.ts'
import type { AdminGlobalConfig, AdminGlobalEntry, CheckGlobalConfigRequest, GlobalConfigCheck, GlobalConfigPatch, GlobalDefaults, GlobalEntryUpsert, GlobalSettingKind, PublicGlobalEntry, PublicGlobalSettings } from '../../../../../../packages/web-contracts/src/settings.ts'

const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/
const kinds = new Set<string>(GLOBAL_SETTING_KINDS)
const invalid = () => authError(400)
const unavailable = () => Object.assign(new Error('Secret storage unavailable'), { statusCode: 503 })
function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw invalid()
  return value as Record<string, unknown>
}
function id(value: unknown): string { if (typeof value !== 'string' || !idPattern.test(value)) throw invalid(); return value }
function string(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw invalid()
  return value
}
export function requireConfigRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= 2147483647) throw invalid()
  return value as number
}
function endpoint(value: unknown, enabled: boolean): string {
  const raw = string(value, 2048, !enabled)
  if (!raw && !enabled) return ''
  if (raw !== raw.trim() || /[?#\\\s]/.test(raw)) throw invalid()
  try {
    const url = new URL(raw)
    if (!['http:','https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) throw invalid()
    return raw
  } catch { throw invalid() }
}
export function validateGlobalConfigPatch(input: unknown): GlobalConfigPatch {
  const patch = object(input, ['upserts','removes','defaults','sourceEgressTargets'])
  const result: GlobalConfigPatch = {}, seen = new Set<string>()
  if (patch.upserts !== undefined) {
    if (!Array.isArray(patch.upserts) || patch.upserts.length > 100) throw invalid()
    result.upserts = patch.upserts.map(raw => {
      const value = object(raw, ['id','kind','providerId','label','model','baseUrl','enabled','apiKey','clearKey'])
      const entryId = id(value.id), kind = value.kind as GlobalSettingKind, providerId = id(value.providerId)
      if (seen.has(entryId) || !kinds.has(kind) || typeof value.enabled !== 'boolean') throw invalid()
      seen.add(entryId)
      if (!findProvider(kind, providerId)?.available) throw invalid()
      const entry: GlobalEntryUpsert = { id: entryId, kind, providerId, label: string(value.label, 200), model: string(value.model, 256, ['web_search','image_search','http_mcp'].includes(kind)), baseUrl: endpoint(value.baseUrl, value.enabled), enabled: value.enabled }
      if (value.clearKey !== undefined && value.clearKey !== true) throw invalid()
      if (value.apiKey !== undefined) {
        if (typeof value.apiKey !== 'string' || Buffer.byteLength(value.apiKey) > 8192 || /[\u0000\r\n]/.test(value.apiKey)) throw invalid()
        if (value.apiKey.trim()) entry.apiKey = value.apiKey
      }
      if (value.clearKey === true) { if (entry.apiKey !== undefined) throw invalid(); entry.clearKey = true }
      return entry
    })
  }
  if (patch.removes !== undefined) {
    if (!Array.isArray(patch.removes) || patch.removes.length > 100) throw invalid()
    result.removes = patch.removes.map(value => { const entryId = id(value); if (seen.has(entryId)) throw invalid(); seen.add(entryId); return entryId })
  }
  if (patch.defaults !== undefined) {
    const defaults = object(patch.defaults, GLOBAL_SETTING_KINDS)
    result.defaults = Object.fromEntries(Object.entries(defaults).map(([kind,value]) => [kind, value === null ? null : id(value)]))
  }
  if (patch.sourceEgressTargets !== undefined) {
    try { result.sourceEgressTargets = validateSourceEgressTargets(patch.sourceEgressTargets) } catch { throw invalid() }
  }
  if (!(result.upserts?.length || result.removes?.length || Object.keys(result.defaults ?? {}).length || result.sourceEgressTargets)) throw invalid()
  return result
}
interface EntryRow { id: string; kind: GlobalSettingKind; provider_id: string; label: string; model: string; base_url: string; enabled: boolean; has_key: boolean }
interface SecretRow { entry_id: string; kind: GlobalSettingKind; provider_id: string; key_id: string; envelope: SecretEnvelope }
const publicEntry = (row: EntryRow): PublicGlobalEntry => ({ id: row.id, kind: row.kind, providerId: row.provider_id, label: row.label, model: row.model })
const adminEntry = (row: EntryRow): AdminGlobalEntry => ({ ...publicEntry(row), baseUrl: row.base_url, enabled: row.enabled, hasKey: row.has_key })

export async function readSourceEgressTargets(connection: PoolClient, deploymentId: string) {
  const row = (await connection.query('SELECT source_egress_targets FROM global_configs WHERE deployment_id=$1', [deploymentId])).rows[0]
  return validateSourceEgressTargets(row?.source_egress_targets ?? [])
}
export function createGlobalConfigService({ transactions, keyring }: { transactions: PrincipalTransactions; keyring?: SecretKeyring }) {
  const box = keyring ? createSecretBox(keyring) : undefined
  async function access<T>(token: string, admin: boolean, operation: (connection: PoolClient, principal: BusinessPrincipal) => Promise<T>, writing = false): Promise<T> {
    return transactions.withPrincipalTransaction({ kind: 'session', token }, async (connection, principal) => {
      if (admin && !principal.roles.includes('config_admin')) throw authError(403)
      // RLS checks a verified token hash as well as the principal IDs. Ordinary
      // business SQL cannot gain secret access merely by changing user/session GUCs.
      await connection.query("SELECT set_config('dyoffice.global_session_hash',$1,true),set_config('dyoffice.global_idle_ms',$2,true)", [tokenHash(token), String(transactions.sessionIdleMs)])
      // A reader must not combine an old revision/defaults with newly committed
      // entries. The deployment lock also covers the first, still-missing row.
      const lockFunction = writing ? 'pg_advisory_xact_lock' : 'pg_advisory_xact_lock_shared'
      await connection.query(`SELECT pg_catalog.${lockFunction}(pg_catalog.hashtextextended($1,0))`, ['dyoffice:global-config:' + principal.deploymentId])
      return operation(connection, principal)
    })
  }
  async function state(connection: PoolClient, deploymentId: string, includeSecrets: boolean) {
    const config = (await connection.query('SELECT revision,defaults FROM global_configs WHERE deployment_id=$1', [deploymentId])).rows[0]
    const rows = (await connection.query<EntryRow>(`SELECT e.*,${includeSecrets ? 'EXISTS(SELECT 1 FROM global_config_secrets s WHERE s.deployment_id=e.deployment_id AND s.entry_id=e.id)' : 'false'} AS has_key FROM global_config_entries e WHERE e.deployment_id=$1 ORDER BY e.id`, [deploymentId])).rows
    return { revision: config?.revision ?? 0, defaults: (config?.defaults ?? {}) as GlobalDefaults, rows }
  }
  async function adminResult(connection: PoolClient, deploymentId: string): Promise<AdminGlobalConfig> {
    const saved = await state(connection, deploymentId, true)
    return { revision: saved.revision, entries: saved.rows.map(adminEntry), defaults: saved.defaults, providerCatalog: getProviderCatalog(), keyStorageAvailable: Boolean(box), sourceEgressTargets: await readSourceEgressTargets(connection, deploymentId) }
  }
  async function lock(connection: PoolClient, deploymentId: string, expectedRevision: number) {
    await connection.query('INSERT INTO global_configs(deployment_id) VALUES($1) ON CONFLICT DO NOTHING', [deploymentId])
    const current = (await connection.query('SELECT revision,defaults FROM global_configs WHERE deployment_id=$1 FOR UPDATE', [deploymentId])).rows[0]
    if (!current || current.revision !== expectedRevision) throw authError(409)
    return current as { revision: number; defaults: GlobalDefaults }
  }
  async function audit(connection: PoolClient, principal: BusinessPrincipal, action: string, revision: number, entryIds: string[]) {
    await connection.query('INSERT INTO global_config_audit(id,deployment_id,actor_id,session_id,action,revision,entry_ids) VALUES($1,$2,$3,$4,$5,$6,$7)', [randomUUID(),principal.deploymentId,principal.userId,principal.sessionId,action,revision,entryIds])
  }
  async function writeSecret(connection: PoolClient, deploymentId: string, entry: GlobalEntryUpsert, value: string) {
    if (!box) throw unavailable()
    const envelope = box.seal(value, { deploymentId, configId: entry.id, providerId: entry.providerId, kind: entry.kind })
    await connection.query('INSERT INTO global_config_secrets(deployment_id,entry_id,kind,provider_id,key_id,envelope) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(deployment_id,entry_id) DO UPDATE SET kind=EXCLUDED.kind,provider_id=EXCLUDED.provider_id,key_id=EXCLUDED.key_id,envelope=EXCLUDED.envelope,updated_at=clock_timestamp()', [deploymentId,entry.id,entry.kind,entry.providerId,envelope.keyId,JSON.stringify(envelope)])
  }
  return {
    getPublicSettings: (token: string) => access<PublicGlobalSettings>(token, false, async (connection, principal) => {
      const saved = await state(connection, principal.deploymentId, false)
      // Only the readiness bit crosses the secret boundary; secret-table RLS stays admin-only.
      const readiness = new Map((await connection.query<{ id: string; has_key: boolean }>('SELECT id,has_key FROM global_config_key_readiness()')).rows.map(row => [row.id, row.has_key]))
      const rows = saved.rows.filter(row => row.enabled && findProvider(row.kind, row.provider_id)?.available).map(row => ({ ...row, has_key: readiness.get(row.id) === true }))
      const defaults = Object.fromEntries(Object.entries(saved.defaults).filter(([kind,value]) => rows.some(row => row.kind === kind && row.id === value)))
      const catalog = rows.map(row => {
        const keylessSearch = (row.kind === 'web_search' || row.kind === 'image_search') && ['parallel','keenable'].includes(row.provider_id)
        const keylessMedia = row.provider_id === 'custom' && (row.kind === 'image_generation' || row.kind === 'image_analysis') && !!row.base_url
        return { ...publicEntry(row), ready: row.has_key || keylessSearch || keylessMedia }
      })
      return { revision: saved.revision, catalog, defaults }
    }),
    getAdminConfig: (token: string) => access(token, true, (connection, principal) => adminResult(connection, principal.deploymentId)),
    async saveGlobalConfig(token: string, expected: unknown, input: unknown): Promise<AdminGlobalConfig> {
      const expectedRevision = requireConfigRevision(expected), patch = validateGlobalConfigPatch(input)
      return access(token, true, async (connection, principal) => {
        const deployment = principal.deploymentId, current = await lock(connection, deployment, expectedRevision)
        const previous = await state(connection, deployment, true), entries = new Map(previous.rows.map(row => [row.id, adminEntry(row)]))
        for (const entry of patch.upserts ?? []) {
          const before = entries.get(entry.id)
          if (before?.hasKey && (before.kind !== entry.kind || before.providerId !== entry.providerId) && !entry.apiKey && !entry.clearKey) throw invalid()
          if (entry.apiKey && !box) throw unavailable()
          entries.set(entry.id, { id: entry.id, kind: entry.kind, providerId: entry.providerId, label: entry.label, model: entry.model, baseUrl: entry.baseUrl, enabled: entry.enabled, hasKey: entry.clearKey ? false : Boolean(entry.apiKey || before?.hasKey) })
        }
        for (const removed of patch.removes ?? []) { if (!entries.has(removed)) throw authError(404); entries.delete(removed) }
        if (entries.size > 100) throw invalid()
        const defaults: GlobalDefaults = { ...current.defaults }
        for (const [kind,value] of Object.entries(defaults)) if (!entries.get(value)?.enabled || entries.get(value)?.kind !== kind) delete defaults[kind as GlobalSettingKind]
        for (const [kind,value] of Object.entries(patch.defaults ?? {})) {
          if (value === null) delete defaults[kind as GlobalSettingKind]
          else { if (!entries.get(value)?.enabled || entries.get(value)?.kind !== kind) throw invalid(); defaults[kind as GlobalSettingKind] = value }
        }
        for (const removed of patch.removes ?? []) await connection.query('DELETE FROM global_config_entries WHERE deployment_id=$1 AND id=$2', [deployment,removed])
        for (const entry of patch.upserts ?? []) {
          if (entry.clearKey || entry.apiKey) await connection.query('DELETE FROM global_config_secrets WHERE deployment_id=$1 AND entry_id=$2', [deployment,entry.id])
          await connection.query('INSERT INTO global_config_entries(deployment_id,id,kind,provider_id,label,model,base_url,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(deployment_id,id) DO UPDATE SET kind=EXCLUDED.kind,provider_id=EXCLUDED.provider_id,label=EXCLUDED.label,model=EXCLUDED.model,base_url=EXCLUDED.base_url,enabled=EXCLUDED.enabled', [deployment,entry.id,entry.kind,entry.providerId,entry.label,entry.model,entry.baseUrl,entry.enabled])
          if (entry.apiKey) await writeSecret(connection, deployment, entry, entry.apiKey)
        }
        await connection.query('UPDATE global_configs SET revision=revision+1,defaults=$2::jsonb,updated_at=clock_timestamp() WHERE deployment_id=$1', [deployment,JSON.stringify(defaults)])
        if (patch.sourceEgressTargets) await connection.query('UPDATE global_configs SET source_egress_targets=$2::jsonb WHERE deployment_id=$1', [deployment,JSON.stringify(patch.sourceEgressTargets)])
        await audit(connection, principal, 'config_saved', expectedRevision+1, [...(patch.upserts ?? []).map(entry => entry.id),...(patch.removes ?? [])].sort())
        return adminResult(connection, deployment)
      }, true)
    },
    async checkGlobalConfig(token: string, input: CheckGlobalConfigRequest = {}): Promise<GlobalConfigCheck> {
      const options = object(input, ['expectedRevision','entryId'])
      if (options.expectedRevision !== undefined) requireConfigRevision(options.expectedRevision)
      if (options.entryId !== undefined) id(options.entryId)
      return access(token, true, async (connection, principal) => {
        // Shared lock keeps one saved version stable while all stored keys are checked.
        await connection.query('SELECT revision FROM global_configs WHERE deployment_id=$1 FOR SHARE', [principal.deploymentId])
        const saved = await state(connection, principal.deploymentId, true)
        if (options.expectedRevision !== undefined && options.expectedRevision !== saved.revision) throw authError(409)
        const entries = saved.rows.filter(row => options.entryId === undefined || row.id === options.entryId)
        if (options.entryId !== undefined && !entries.length) throw authError(404)
        const secrets = (await connection.query<SecretRow>('SELECT entry_id,kind,provider_id,key_id,envelope FROM global_config_secrets WHERE deployment_id=$1 AND entry_id=ANY($2::text[]) ORDER BY entry_id', [principal.deploymentId,entries.map(row => row.id)])).rows
        for (const secret of secrets) {
          if (!box) throw unavailable()
          box.unseal(secret.envelope, { deploymentId: principal.deploymentId, configId: secret.entry_id, providerId: secret.provider_id, kind: secret.kind })
        }
        await audit(connection, principal, 'config_checked', saved.revision, entries.map(row => row.id))
        return { revision: saved.revision, configuration: 'valid', checkedEntries: entries.length, secrets: secrets.length ? 'readable' : 'not_required', connection: 'not_run' }
      })
    },
    async rotateKey(token: string, expected: unknown): Promise<AdminGlobalConfig> {
      const expectedRevision = requireConfigRevision(expected)
      return access(token, true, async (connection, principal) => {
        if (!box) throw unavailable()
        await lock(connection, principal.deploymentId, expectedRevision)
        const secrets = (await connection.query<SecretRow>('SELECT entry_id,kind,provider_id,key_id,envelope FROM global_config_secrets WHERE deployment_id=$1 ORDER BY entry_id FOR UPDATE', [principal.deploymentId])).rows
        for (const secret of secrets) {
          const context = { deploymentId: principal.deploymentId, configId: secret.entry_id, providerId: secret.provider_id, kind: secret.kind }
          const envelope = box.seal(box.unseal(secret.envelope, context), context)
          await connection.query('UPDATE global_config_secrets SET key_id=$3,envelope=$4::jsonb,updated_at=clock_timestamp() WHERE deployment_id=$1 AND entry_id=$2', [principal.deploymentId,secret.entry_id,envelope.keyId,JSON.stringify(envelope)])
        }
        await connection.query('UPDATE global_configs SET revision=revision+1,updated_at=clock_timestamp() WHERE deployment_id=$1', [principal.deploymentId])
        await audit(connection, principal, 'key_rotated', expectedRevision+1, secrets.map(secret => secret.entry_id))
        return adminResult(connection, principal.deploymentId)
      }, true)
    },
  }
}
export type GlobalConfigService = ReturnType<typeof createGlobalConfigService>

