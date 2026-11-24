/** Keep newly authored Web PDF links navigable in browsers and PDF readers. */
export function isWebPdfLinkUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value))
    return false
  if (!/^(https?:\/\/|mailto:|tel:)/i.test(value)) return false
  try {
    const url = new URL(value)
    return Boolean(url.hostname || url.pathname)
  } catch {
    return false
  }
}
