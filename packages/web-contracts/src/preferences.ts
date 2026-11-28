import {
  AI_CUSTOM_FONT_MAX_PX, AI_CUSTOM_FONT_MIN_PX, DEFAULT_AI_PANEL_PREFS, isAiFontSize, type AiFontSize, type AiPanelSide,
} from '../../ui/src/ai-panel-prefs.ts'

export const PDF_DEFAULT_ZOOM_MODES = ['width', 'page', 'last'] as const
export type PdfDefaultZoom = typeof PDF_DEFAULT_ZOOM_MODES[number]

export const DOCUMENT_THEME_MODES = ['follow', 'light', 'dark'] as const
export type DocumentTheme = typeof DOCUMENT_THEME_MODES[number]

export const AI_PANEL_SIDES = ['left', 'right'] as const satisfies readonly AiPanelSide[]

export interface AssistantPreferences {
  aiPanelSide?: AiPanelSide
  aiFontSize?: AiFontSize
  aiCustomFontSize?: number
  aiSpellcheck?: boolean
  aiOpenInNewDocs?: boolean
}

export const ASSISTANT_PREFERENCES_FIELDS = ['aiPanelSide', 'aiFontSize', 'aiCustomFontSize', 'aiSpellcheck', 'aiOpenInNewDocs'] as const
export const DEFAULT_ASSISTANT_PREFERENCES = {
  aiPanelSide: DEFAULT_AI_PANEL_PREFS.side,
  aiFontSize: DEFAULT_AI_PANEL_PREFS.fontSize,
  aiCustomFontSize: DEFAULT_AI_PANEL_PREFS.customFontSize,
  aiSpellcheck: DEFAULT_AI_PANEL_PREFS.spellcheck,
  aiOpenInNewDocs: false,
} satisfies Required<AssistantPreferences>

export function isAssistantPreferences(value: Partial<Record<typeof ASSISTANT_PREFERENCES_FIELDS[number], unknown>>): boolean {
  const {aiPanelSide, aiFontSize, aiCustomFontSize, aiSpellcheck, aiOpenInNewDocs} = value
  return (aiPanelSide === undefined || aiPanelSide === 'left' || aiPanelSide === 'right') &&
    (aiFontSize === undefined || isAiFontSize(aiFontSize)) &&
    (aiCustomFontSize === undefined || (typeof aiCustomFontSize === 'number' && Number.isInteger(aiCustomFontSize) &&
      aiCustomFontSize >= AI_CUSTOM_FONT_MIN_PX && aiCustomFontSize <= AI_CUSTOM_FONT_MAX_PX)) &&
    (aiSpellcheck === undefined || typeof aiSpellcheck === 'boolean') &&
    (aiOpenInNewDocs === undefined || typeof aiOpenInNewDocs === 'boolean')
}
