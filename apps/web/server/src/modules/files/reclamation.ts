import type { PoolClient } from 'pg'
import type { BusinessPrincipal } from '../../db/context.ts'
import type { ObjectStore } from '../../storage/object-store.ts'
import { authError } from '../auth/sessions.ts'
import { objectKey, scope } from './queries.ts'

// Called only inside a personal, files:write-authorized transaction. Lock order
// matches publication: principal -> account -> upload. Terminal records are
// retained forever so their keys cannot be reused by any application path.
export async function reclaimAbandonedUploads(connection: PoolClient, principal: BusinessPrincipal, objects: ObjectStore) {
  if (principal.job) throw authError(404)
  if (!objects.removeUnreferenced) return { reclaimedBytes: 0, reclaimedUploads: 0 }
  // Do NOT expire rows in this transaction: terminalization must already be
  // committed before irreversible deletion, even if the DB clock later changes.
  const account = (await connection.query<{ stored_bytes: string }>(
    'SELECT stored_bytes FROM storage_accounts WHERE deployment_id=$1 AND owner_id=$2 FOR UPDATE', scope(principal))).rows[0]
  if (!account) return { reclaimedBytes: 0, reclaimedUploads: 0 }
  const candidates = await connection.query<{ id: string; revision_id: string; expected_size: number }>(`
    SELECT u.id,u.revision_id,u.expected_size FROM uploads u
    WHERE u.deployment_id=$1 AND u.owner_id=$2
      AND u.state IN ('cancelled','expired') AND u.sha256 IS NOT NULL AND u.reclaimed_at IS NULL
      AND u.completed_file_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM file_revisions r
        WHERE r.deployment_id=u.deployment_id AND r.owner_id=u.owner_id AND r.id=u.revision_id)
    ORDER BY u.id LIMIT 1 FOR UPDATE OF u`, scope(principal))
  const total = candidates.rows.reduce((sum, row) => sum + row.expected_size, 0)
  if (!Number.isSafeInteger(total) || total < 0 || total > Number(account.stored_bytes)) throw authError(503)
  let reclaimedBytes = 0, reclaimedUploads = 0
  for (const row of candidates.rows) {
    // sha256 is assigned only AFTER putImmutable has completed. Never collect
    // an expired receiving upload: its delayed PUT could arrive after deletion.
    try { await objects.removeUnreferenced(objectKey(principal, row.revision_id)) }
    catch {
      // Storage inability/ambiguous deletion retains the charge. It must not
      // prevent a new upload while quota remains. Do not swallow DB or auth errors.
      break
    }
    const updated = await connection.query(`UPDATE uploads SET reclaimed_at=clock_timestamp()
      WHERE deployment_id=$1 AND owner_id=$2 AND id=$3 AND reclaimed_at IS NULL
      AND state IN ('cancelled','expired') AND sha256 IS NOT NULL AND completed_file_id IS NULL`, [...scope(principal),row.id])
    if (updated.rowCount !== 1) throw authError(503)
    const credited = await connection.query(`UPDATE storage_accounts SET stored_bytes=stored_bytes-$3
      WHERE deployment_id=$1 AND owner_id=$2 AND stored_bytes >= $3`, [...scope(principal),row.expected_size])
    if (credited.rowCount !== 1) throw authError(503)
    reclaimedBytes += row.expected_size; reclaimedUploads++
  }
  // If COMMIT fails, quota/markers roll back but deletions do not. Retry is safe:
  // no publication path accepts terminal rows, and missing objects delete OK.
  return { reclaimedBytes, reclaimedUploads }
}
