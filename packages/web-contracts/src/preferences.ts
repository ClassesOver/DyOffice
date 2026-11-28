export const PDF_DEFAULT_ZOOM_MODES = ['width', 'page', 'last'] as const
export type PdfDefaultZoom = typeof PDF_DEFAULT_ZOOM_MODES[number]

export const DOCUMENT_THEME_MODES = ['follow', 'light', 'dark'] as const
export type DocumentTheme = typeof DOCUMENT_THEME_MODES[number]
