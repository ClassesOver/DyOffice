import {
  AI_CUSTOM_FONT_MAX_PX, AI_CUSTOM_FONT_MIN_PX, DEFAULT_AI_PANEL_PREFS, isAiFontSize, type AiFontSize,
} from '../../ui/src/ai-panel-prefs.ts'

export const PDF_DEFAULT_ZOOM_MODES = ['width', 'page', 'last'] as const
export type PdfDefaultZoom = typeof PDF_DEFAULT_ZOOM_MODES[number]

export const DOCUMENT_THEME_MODES = ['follow', 'light', 'dark'] as const
export type DocumentTheme = typeof DOCUMENT_THEME_MODES[number]

export interface AssistantAppearance {
  aiFontSize?: AiFontSize
  aiCustomFontSize?: number
  aiSpellcheck?: boolean
}

export const ASSISTANT_APPEARANCE_FIELDS = ['aiFontSize', 'aiCustomFontSize', 'aiSpellcheck'] as const
export const DEFAULT_ASSISTANT_APPEARANCE = {
  aiFontSize: DEFAULT_AI_PANEL_PREFS.fontSize,
  aiCustomFontSize: DEFAULT_AI_PANEL_PREFS.customFontSize,
  aiSpellcheck: DEFAULT_AI_PANEL_PREFS.spellcheck,
} satisfies Required<AssistantAppearance>

export function isAssistantAppearance(value: Partial<Record<typeof ASSISTANT_APPEARANCE_FIELDS[number], unknown>>): boolean {
  const {aiFontSize, aiCustomFontSize, aiSpellcheck} = value
  return (aiFontSize === undefined || isAiFontSize(aiFontSize)) &&
    (aiCustomFontSize === undefined || (typeof aiCustomFontSize === 'number' && Number.isInteger(aiCustomFontSize) &&
      aiCustomFontSize >= AI_CUSTOM_FONT_MIN_PX && aiCustomFontSize <= AI_CUSTOM_FONT_MAX_PX)) &&
    (aiSpellcheck === undefined || typeof aiSpellcheck === 'boolean')
}
