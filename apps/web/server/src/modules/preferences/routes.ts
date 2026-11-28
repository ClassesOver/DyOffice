import type { FastifyInstance } from 'fastify'
import { CSV_IMPORT_LIMIT_CHOICES_MB } from '@genoffice/xlsx-gateway/gateway/csv-limits'
import type { createCsrfService } from '../auth/csrf.ts'
import type { SessionService } from '../auth/sessions.ts'
import { cookies } from '../auth/csrf.ts'
import type { createPreferenceService } from './service.ts'
import { AI_CUSTOM_FONT_MAX_PX, AI_CUSTOM_FONT_MIN_PX, AI_FONT_SIZES } from '../../../../../../packages/ui/src/ai-panel-prefs.ts'
import { AI_PANEL_SIDES, DOCUMENT_THEME_MODES, PDF_DEFAULT_ZOOM_MODES } from '../../../../../../packages/web-contracts/src/preferences.ts'

const patchSchema = { type: 'object', additionalProperties: false, properties: { theme: { type: 'string', enum: ['light','dark','system'] }, documentTheme: { type: 'string', enum: DOCUMENT_THEME_MODES }, language: { type: 'string', enum: ['zh','en'] }, authorName: { type: 'string', maxLength: 100 }, autoSave: { type: 'boolean' }, showAssistant: { type: 'boolean' }, restoreSession: { type: 'boolean' }, sleepInactiveTabs: { type: 'boolean' }, skipOdfImportPrompt: { type: 'boolean' }, pdfDefaultZoom: { type: 'string', enum: PDF_DEFAULT_ZOOM_MODES },
  csvImportLimitMb: { type: 'integer', enum: CSV_IMPORT_LIMIT_CHOICES_MB },
  aiPanelSide: { type: 'string', enum: AI_PANEL_SIDES },
  aiFontSize: { type: 'string', enum: AI_FONT_SIZES },
  aiCustomFontSize: { type: 'integer', minimum: AI_CUSTOM_FONT_MIN_PX, maximum: AI_CUSTOM_FONT_MAX_PX },
  aiSpellcheck: { type: 'boolean' },
  aiOpenInNewDocs: { type: 'boolean' },
  aiShowAskTrigger: { type: 'boolean' },
} } as const
export function registerPreferenceRoutes(app: FastifyInstance, preferences: ReturnType<typeof createPreferenceService>, sessions: SessionService, csrf: ReturnType<typeof createCsrfService>) {
  for (const url of ['/api/preferences','/api/v1/preferences']) {
    app.get(url, { schema: { querystring: { type: 'object', additionalProperties: false, properties: {} } } }, async request => {
      const token = cookies(request).session ?? ''
      await sessions.authenticate(token) // Touch activity; the business transaction independently revalidates authority.
      return preferences.get(token)
    })
    app.put(url, { bodyLimit: 4096, schema: { body: patchSchema, querystring: { type: 'object', additionalProperties: false, properties: {} } } }, async request => {
      const token = cookies(request).session
      csrf.requireSession(request, token)
      await sessions.authenticate(token!)
      return preferences.update(token!, request.body)
    })
  }
}
