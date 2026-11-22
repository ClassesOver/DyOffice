/** Restrict optional PDF.js features when opening user-supplied bytes. */
export const PDF_OPEN_OPTIONS = Object.freeze({
  useWasm: false,
  disableFontFace: true,
  isOffscreenCanvasSupported: false,
  isImageDecoderSupported: false,
  enableXfa: false,
  useSystemFonts: false,
})
