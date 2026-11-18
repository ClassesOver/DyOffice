import type {PublicGlobalSettings} from '../../web-contracts/src/settings.ts'

export interface PersonalPreferences {
  theme: 'light' | 'dark' | 'system'
  language: 'zh' | 'en'
  authorName: string
  autoSave: boolean
  showAssistant: boolean
}
export type SettingsRequest = <T = unknown>(path: string, method?: string, body?: unknown) => Promise<T>
const fields = ['theme', 'language', 'authorName', 'autoSave', 'showAssistant'] as const

function project(value: unknown): PersonalPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无法确认偏好保存结果，请重新加载。')
  const v = value as PersonalPreferences
  if (!['light', 'dark', 'system'].includes(v.theme) || !['zh', 'en'].includes(v.language) || typeof v.authorName !== 'string' || typeof v.autoSave !== 'boolean' || typeof v.showAssistant !== 'boolean') throw new Error('无法确认偏好保存结果，请重新加载。')
  return {theme: v.theme, language: v.language, authorName: v.authorName, autoSave: v.autoSave, showAssistant: v.showAssistant}
}

/** Keep one client for a session so replacing a settings panel cannot duplicate a write. */
export function createPreferencesClient(request: SettingsRequest) {
  let inFlight: Promise<PersonalPreferences> | undefined
  let uncertain = false
  let writeVersion = 0
  return {
    async getPreferences(): Promise<PersonalPreferences> {
      if (inFlight) return inFlight
      const version = writeVersion
      const prefs = project(await request('/api/v1/preferences'))
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

