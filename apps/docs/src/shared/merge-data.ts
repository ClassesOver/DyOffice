import { mergeDataFromRows } from '@genoffice/docx-engine'
import type { MergeDataSource } from './ipc'

export const BROWSER_MAIL_MERGE_MAX_OUTPUT_BYTES = 64 * 1024 * 1024

export function mergeSourceFromRows(
  path: string,
  name: string,
  rows: readonly (readonly string[])[],
): MergeDataSource {
  const header = rows[0] ?? []
  const used = new Set<string>()
  const nextSuffix = new Map<string, number>()
  const names = header.map((raw, index) => {
    const base = raw.trim() || `Column${index + 1}`
    let field = base
    let suffix = nextSuffix.get(base) ?? 2
    while (used.has(field)) field = `${base}${suffix++}`
    nextSuffix.set(base, suffix)
    used.add(field)
    return field
  })
  const { fields, records } = mergeDataFromRows(header.length ? [names, ...rows.slice(1)] : [])
  return { path, name, fields: [...fields], records: [...records] }
}
