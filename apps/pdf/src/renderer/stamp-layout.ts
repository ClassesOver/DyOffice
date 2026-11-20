/** Shared geometry and placeholders for desktop bitmap and Web vector stamps. */
export const fillStampPlaceholders = (text: string, page: number, total: number): string =>
  text.replaceAll('{page}', String(page)).replaceAll('{total}', String(total))

export function stampBarLayout(pageWidth: number, pageHeight: number, fontSize: number) {
  return { height: fontSize * 2.2, margin: Math.min(pageHeight * 0.035, 26), padding: pageWidth * 0.06 }
}

export function fitWatermarkFontSize(pageWidth: number, pageHeight: number, ratio: number, measuredWidth: number) {
  const size = pageWidth * ratio, maxWidth = Math.hypot(pageWidth, pageHeight) * 0.8
  return measuredWidth > maxWidth ? size * maxWidth / measuredWidth : size
}
