export function finiteDecimalCellValue(value: string | number | boolean | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const text = value.trim()
  // Number() also accepts JavaScript-only spellings such as 0x10 and 0b10.
  if (!/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(text)) return null
  const number = Number(text)
  return Number.isFinite(number) ? number : null
}
