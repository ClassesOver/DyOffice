/** Policy for the PDF viewer document. No eval, no inline script, no wildcard origin. */
export const PDF_VIEWER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join('; ')

/** pdf.js options that stay inside that policy: no WASM compile and no font-face injection. */
export const PDF_OPEN_OPTIONS = Object.freeze({
  useWasm: false,
  disableFontFace: true,
  isOffscreenCanvasSupported: false,
  isImageDecoderSupported: false,
  enableXfa: false,
  useSystemFonts: false,
})
