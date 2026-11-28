export const PDF_DEFAULT_ZOOM_MODES = ['width', 'page', 'last'] as const
export type PdfDefaultZoom = typeof PDF_DEFAULT_ZOOM_MODES[number]
