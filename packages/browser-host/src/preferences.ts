import { isCsvImportLimitMb, type CsvImportLimitMb } from '../../xlsx-gateway/src/gateway/csv-limits.ts'
import {ASSISTANT_PREFERENCES_FIELDS,DOCUMENT_THEME_MODES,PDF_DEFAULT_ZOOM_MODES,isAssistantPreferences,type AssistantPreferences,type DocumentTheme,type PdfDefaultZoom} from '../../web-contracts/src/preferences.ts'
import type {PublicGlobalSettings} from '../../web-contracts/src/settings.ts'
import {IMPORT_PROMPT_FIELDS,type ImportPromptPreferences} from '../../web-contracts/src/file-imports.ts'

export interface PersonalPreferences extends AssistantPreferences, ImportPromptPreferences {
  theme: 'light' | 'dark' | 'system'
  documentTheme?: DocumentTheme
  language: 'zh' | 'en'
  authorName: string
  autoSave: boolean
  autoSaveUpdatedAt?: number
  showAssistant: boolean
  restoreSession?: boolean
  sleepInactiveTabs?: boolean
  csvImportLimitMb?: CsvImportLimitMb
  pdfDefaultZoom?: PdfDefaultZoom
}
export type SettingsRequest = <T = unknown>(path: string, method?: string, body?: unknown, signal?: AbortSignal) => Promise<T>
const fields = ['theme', 'documentTheme', 'language', 'authorName', 'autoSave', 'showAssistant', 'restoreSession', 'sleepInactiveTabs', 'skipOdfImportPrompt', 'csvImportLimitMb', 'pdfDefaultZoom', ...IMPORT_PROMPT_FIELDS, ...ASSISTANT_PREFERENCES_FIELDS] as const

function project(value: unknown): PersonalPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无法确认偏好保存结果，请重新加载。')
  const v = value as PersonalPreferences
  if (!['light', 'dark', 'system'].includes(v.theme) || !['zh', 'en'].includes(v.language) || typeof v.authorName !== 'string' || typeof v.autoSave !== 'boolean' || typeof v.showAssistant !== 'boolean' || [v.restoreSession,v.sleepInactiveTabs,v.skipOdfImportPrompt,...IMPORT_PROMPT_FIELDS.map(field=>v[field])].some(value=>value!==undefined&&typeof value!=='boolean') || (v.csvImportLimitMb !== undefined && !isCsvImportLimitMb(v.csvImportLimitMb)) || (v.pdfDefaultZoom !== undefined && !PDF_DEFAULT_ZOOM_MODES.includes(v.pdfDefaultZoom)) || (v.documentTheme !== undefined && !DOCUMENT_THEME_MODES.includes(v.documentTheme)) || !isAssistantPreferences(v)) throw new Error('无法确认偏好保存结果，请重新加载。')
  const stamp = v.autoSaveUpdatedAt
  if (stamp !== undefined && (!Number.isSafeInteger(stamp) || stamp < 1)) throw new Error('无法确认偏好保存结果，请重新加载。')
  return Object.fromEntries([...fields, 'autoSaveUpdatedAt' as const].filter(key => v[key] !== undefined).map(key => [key, v[key]])) as unknown as PersonalPreferences
}

/** Keep one client for a session so replacing a settings panel cannot duplicate a write. */
export function createPreferencesClient(request: SettingsRequest) {
  let inFlight: Promise<PersonalPreferences> | undefined
  let uncertain = false
  let writeVersion = 0
  return {
    async getPreferences(signal?: AbortSignal): Promise<PersonalPreferences> {
      if (inFlight) return inFlight
      const version = writeVersion
      const prefs = project(await request('/api/v1/preferences', 'GET', undefined, signal))
      if (version === writeVersion) uncertain = false
      return prefs
    },
    async updatePreferences(patch: Partial<PersonalPreferences>): Promise<PersonalPreferences> {
      if (inFlight) throw new Error('个人偏好正在保存，请稍候。')
      if (uncertain) throw new Error('上次保存结果尚未确认，请重新加载后再修改。')
      if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !fields.includes(key as typeof fields[number]))) throw new Error('只接受个人偏好字段。')
      const snapshot = {...patch}
      writeVersion++
      inFlight = Promise.resolve().then(() => request('/api/v1/preferences', 'PUT', snapshot)).then(project).catch(error => {
        const status = (error as {status?: number})?.status
        uncertain = !(status !== undefined && status >= 400 && status < 500 && status !== 408) && (error as {code?: string})?.code !== 'stale_session'
        throw error
      }).finally(() => { inFlight = undefined })
      return inFlight
    },
    getPublicSettings(): Promise<PublicGlobalSettings> {
      return request('/api/v1/settings/public')
    },
  }
}

