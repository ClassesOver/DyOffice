/** JSONB key ordering is not approval identity. Compare JSON values, reject
 * excessive nesting, and retain exact array order and primitive values. */
export function sameCommandJson(a: unknown, b: unknown, depth = 0): boolean {
  if (depth > 32) return false
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ak = Object.keys(a).sort(),
    bk = Object.keys(b).sort()
  return (
    ak.length === bk.length &&
    ak.every(
      (k, i) =>
        k === bk[i] &&
        sameCommandJson(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
          depth + 1,
        ),
    )
  )
}
