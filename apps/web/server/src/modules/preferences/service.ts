import type { PoolClient } from 'pg'
import type { BusinessPrincipal, PrincipalTransactions } from '../../db/context.ts'
import { authorize } from '../policy/authorize.ts'
import { authError } from '../auth/sessions.ts'
import { DEFAULT_ASSISTANT_PREFERENCES, DOCUMENT_THEME_MODES, PDF_DEFAULT_ZOOM_MODES, isAssistantPreferences, type DocumentTheme, type PdfDefaultZoom } from '../../../../../../packages/web-contracts/src/preferences.ts'

export const preferenceDefaults = Object.freeze({ theme: 'system', documentTheme: 'follow', language: 'zh', authorName: '', autoSave: true, showAssistant: true, restoreSession: true, sleepInactiveTabs: true, skipOdfImportPrompt: false, pdfDefaultZoom: 'width', ...DEFAULT_ASSISTANT_PREFERENCES })
const fields = Object.keys(preferenceDefaults)
export function createPreferenceService(transactions: PrincipalTransactions) {
  async function access<T>(token: string, action: 'preferences:read' | 'preferences:write', operation: (connection: PoolClient, principal: BusinessPrincipal, workspaceId: string) => Promise<T>): Promise<T> {
    return transactions.withPrincipalTransaction({ kind: 'session', token }, async (connection, principal) => {
      const workspace = (await connection.query('SELECT id FROM workspaces WHERE deployment_id=$1 AND owner_id=$2', [principal.deploymentId, principal.userId])).rows[0]
      if (!workspace) throw authError(404)
      authorize(principal, action, { deploymentId: principal.deploymentId, ownerId: principal.userId })
      return operation(connection, principal, workspace.id)
    })
  }
  const safe = (value: Record<string, unknown>) => Object.fromEntries(fields.map(key => [key, value[key] ?? preferenceDefaults[key as keyof typeof preferenceDefaults]]))
  return {
    get: (token: string) => access<Record<string, unknown>>(token, 'preferences:read', async (connection, principal) => {
      const row = (await connection.query('SELECT data FROM personal_preferences WHERE deployment_id=$1 AND owner_id=$2', [principal.deploymentId, principal.userId])).rows[0]
      return safe(row?.data ?? preferenceDefaults)
    }),
    async update(token: string, patch: unknown) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !fields.includes(key))) throw authError(400)
      const value = patch as Record<string, unknown>
      if (!isAssistantPreferences(value) || (value.documentTheme !== undefined && !DOCUMENT_THEME_MODES.includes(value.documentTheme as DocumentTheme))) throw authError(400)
      if ((value.theme !== undefined && !['light','dark','system'].includes(value.theme as string)) || (value.language !== undefined && !['zh','en'].includes(value.language as string)) || (value.authorName !== undefined && (typeof value.authorName !== 'string' || [...value.authorName].length > 100)) || ['autoSave','showAssistant','restoreSession','sleepInactiveTabs','skipOdfImportPrompt'].some(key => value[key] !== undefined && typeof value[key] !== 'boolean') || (value.pdfDefaultZoom !== undefined && !PDF_DEFAULT_ZOOM_MODES.includes(value.pdfDefaultZoom as PdfDefaultZoom))) throw authError(400)
      return access<Record<string, unknown>>(token, 'preferences:write', async (connection, principal, workspaceId) => {
        const result = await connection.query('INSERT INTO personal_preferences(deployment_id,owner_id,workspace_id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(deployment_id,owner_id) DO UPDATE SET data=personal_preferences.data||$5::jsonb,revision=personal_preferences.revision+1 RETURNING data', [principal.deploymentId, principal.userId, workspaceId, JSON.stringify({ ...preferenceDefaults,...value }), JSON.stringify(value)])
        return safe(result.rows[0].data)
      })
    },
  }
}
