/** T15 evidence DTO. This is not an authorization capability. */
export type QueryCell = string | number | boolean | null
export type QueryColumn = Readonly<{ name: string; type: 'string' | 'number' | 'boolean'; unit?: string }>
export type QuerySnapshot = Readonly<{
  version: 1
  sourceId: string
  sourceVersion: number
  schema: readonly QueryColumn[]
  timezone: string
  rows: readonly Readonly<Record<string, QueryCell>>[]
  truncated: boolean
  sha256: string
}>
