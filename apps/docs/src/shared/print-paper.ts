/** Printable dimensions in twips, from 0.1 to 50 inches. */
export function validPrintDim(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 144 && value <= 72000
}

export function validPrintPaper(
  paper: unknown,
): { widthTwips: number; heightTwips: number } | null {
  if (typeof paper !== 'object' || paper === null) return null
  const { widthTwips, heightTwips } = paper as Record<string, unknown>
  if (!validPrintDim(widthTwips) || !validPrintDim(heightTwips)) return null
  return { widthTwips, heightTwips }
}
