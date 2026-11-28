// Keep the base64 batch within the 32 MiB PDF operation envelope, with room
// for annotations and other draft edits. The saved PDF has its own size limit.
export const MAX_PDF_ATTACHMENT_BYTES = 20 * 1024 * 1024
export const MAX_PDF_ATTACHMENT_BASE64 = Math.ceil(MAX_PDF_ATTACHMENT_BYTES / 3) * 4
export const MAX_PDF_ATTACHMENT_ADDITIONS = 8

export function isPdfAttachmentName(name: string): boolean {
  return name.length <= 255 && !!name.trim() && name !== '.' && name !== '..' &&
    !/[\\/\u0000-\u001f\u007f]/.test(name)
}
