/** Page order and padding shared by the desktop folder and Web archive exports. */
export function exportImageNames(baseName: string, count: number, ext: 'png' | 'jpg'): string[] {
  const pad = count >= 100 ? 3 : 2
  return Array.from({length:Math.max(0,count)}, (_, index) =>
    `${baseName}-${String(index + 1).padStart(pad, '0')}.${ext}`,
  )
}
