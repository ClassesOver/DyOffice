export const WEB_EMBEDDED_FONT_LIMITS = {
  maxFaces: 16,
  maxFaceBytes: 4 * 1024 * 1024,
  maxTotalBytes: 12 * 1024 * 1024,
} as const

export type SlidesEmbeddedTypeface = {
  id: string
  family: string
  bold: boolean
  italic: boolean
  bytes: Uint8Array
}
