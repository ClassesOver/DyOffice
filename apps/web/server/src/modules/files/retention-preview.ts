/** Read-only planning over a trusted, authorized snapshot. Never a purge capability. */
export interface TrashRetentionSnapshot {
  readonly id: string
  readonly deploymentId: string
  readonly ownerId: string
  readonly deletedAtMs: number | null
  readonly purgeStarted: boolean
  readonly purged: boolean
  readonly activeJobs: number
  readonly receivingUploads: number
  readonly uncertainUploads: number
}
export interface TrashRetentionPreviewInput {
  readonly scope: Readonly<{ deploymentId: string; ownerId: string }>
  readonly nowMs: number
  readonly policy?: Readonly<{ enabled: false } | { enabled: true; retainForMs: number }>
  readonly limit: number
  readonly files: readonly TrashRetentionSnapshot[]
}
type BlockReason = 'not_trashed' | 'invalid_snapshot' | 'not_old_enough' | 'already_purged' | 'purge_in_progress' | 'active_jobs' | 'receiving_uploads' | 'uncertain_uploads'
export interface TrashRetentionPreview {
  readonly kind: 'disabled' | 'review_only'
  readonly candidates: readonly Readonly<{ fileId: string; deletedAtMs: number }>[]
  readonly blocked: Readonly<Partial<Record<BlockReason, number>>>
  readonly truncated: boolean
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const validId = (v: unknown): v is string => typeof v === 'string' && uuid.test(v)
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const invalid = (): never => { throw new Error('Invalid retention preview') }

// No clock reads, SQL, object store, policy persistence or scheduling. A future
// adapter must obtain an owner-authorized snapshot. Every eventual purge must
// separately reauthorize and recheck current state in the existing transaction.
export function previewTrashRetention(input: TrashRetentionPreviewInput): TrashRetentionPreview {
  if (!input || typeof input !== 'object') invalid()
  const policy = input.policy
  if (policy === undefined || policy?.enabled === false) return Object.freeze({ kind: 'disabled', candidates: Object.freeze([]), blocked: Object.freeze({}), truncated: false })
  if (policy?.enabled !== true || !integer(policy.retainForMs) || policy.retainForMs < 1) invalid()
  const { scope, nowMs, limit, files } = input
  if (!scope || !validId(scope.deploymentId) || !validId(scope.ownerId) || !integer(nowMs) || !integer(limit) || limit < 1 || limit > 100 || !Array.isArray(files) || files.length > 1000) invalid()
  const ids = new Set<string>()
  const candidates: { fileId: string; deletedAtMs: number }[] = []
  const blocked: Partial<Record<BlockReason, number>> = {}
  const block = (reason: BlockReason) => { blocked[reason] = (blocked[reason] ?? 0) + 1 }
  for (const row of files) {
    if (!row || !validId(row.id) || ids.has(row.id) || row.deploymentId !== scope.deploymentId || row.ownerId !== scope.ownerId ||
      (row.deletedAtMs !== null && !integer(row.deletedAtMs)) || typeof row.purgeStarted !== 'boolean' || typeof row.purged !== 'boolean' ||
      !integer(row.activeJobs) || !integer(row.receivingUploads) || !integer(row.uncertainUploads)) invalid()
    ids.add(row.id)
    if (row.purged) { block('already_purged'); continue }
    if (row.purgeStarted) { block('purge_in_progress'); continue }
    if (row.deletedAtMs === null) { block('not_trashed'); continue }
    if (row.deletedAtMs > nowMs) { block('invalid_snapshot'); continue }
    if (nowMs - row.deletedAtMs < policy.retainForMs) { block('not_old_enough'); continue }
    if (row.activeJobs) { block('active_jobs'); continue }
    if (row.receivingUploads) { block('receiving_uploads'); continue }
    if (row.uncertainUploads) { block('uncertain_uploads'); continue }
    candidates.push({ fileId: row.id, deletedAtMs: row.deletedAtMs })
  }
  candidates.sort((a, b) => a.deletedAtMs - b.deletedAtMs || (a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0))
  return Object.freeze({ kind: 'review_only', candidates: Object.freeze(candidates.slice(0, limit).map(row => Object.freeze(row))), blocked: Object.freeze(blocked), truncated: candidates.length > limit })
}
