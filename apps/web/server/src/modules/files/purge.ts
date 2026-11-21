import type { PrincipalTransactions, FileCredential } from '../../db/context.ts'
import type { ObjectStore } from '../../storage/object-store.ts'
import { authError } from '../auth/sessions.ts'
import { lockAccount, releaseReservation, runFileTransaction, scope, uuid, type Upload } from './queries.ts'

export async function purgeFile(transactions: PrincipalTransactions, objects: ObjectStore, token: FileCredential, fileId: string) {
  const id = uuid(fileId)
  if (!objects.removeUnreferenced) throw authError(503)
  const run = <T>(fn: Parameters<typeof runFileTransaction<T>>[3]) => runFileTransaction(transactions,token,'files:write',async (c,p) => {
    if (p.job) throw authError(404)
    return fn(c,p)
  })
  // Commit irreversibility before touching object storage. A rollback after a
  // successful physical delete must never permit restoration or new references.
  await run(async (c,p) => {
    await lockAccount(c,p)
    const row = (await c.query('SELECT * FROM files WHERE deployment_id=$1 AND owner_id=$2 AND id=$3 FOR UPDATE',[...scope(p),id])).rows[0]
    if (!row) throw authError(404)
    if (row.purge_started_at) return
    if (!row.deleted_at) throw authError(409)
    const active = await c.query("SELECT 1 FROM native_jobs WHERE deployment_id=$1 AND owner_id=$2 AND file_id=$3 AND state IN ('queued','running')",[...scope(p),id])
    if (active.rowCount) throw authError(409)
    const drafts = await c.query<Upload>('SELECT * FROM uploads WHERE deployment_id=$1 AND owner_id=$2 AND file_id=$3 ORDER BY id FOR UPDATE',[...scope(p),id])
    if (drafts.rows.some(u => u.state === 'receiving' || (u.attempt_id && !u.sha256))) throw authError(409)
    for (const upload of drafts.rows) if (upload.state==='staged' || upload.state==='ready') await releaseReservation(c,p,upload,'cancelled')
    await c.query('DELETE FROM file_assistant_messages WHERE deployment_id=$1 AND owner_id=$2 AND file_id=$3',[...scope(p),id])
    await c.query('DELETE FROM harness_task_recovery WHERE deployment_id=$1 AND owner_id=$2 AND file_id=$3',[...scope(p),id])
    await c.query('DELETE FROM word_collab_steps WHERE deployment_id=$1 AND owner_id=$2 AND file_id=$3',[...scope(p),id])
    await c.query('UPDATE files SET purge_started_at=clock_timestamp() WHERE deployment_id=$1 AND owner_id=$2 AND id=$3',[...scope(p),id])
    await c.query('UPDATE edit_leases SET lease_epoch=lease_epoch+1,expires_at=clock_timestamp() WHERE deployment_id=$1 AND owner_id=$2 AND file_id=$3',[...scope(p),id])
    await c.query('UPDATE revision_outbox SET retired_at=clock_timestamp(),delivery_epoch=LEAST(delivery_epoch+1,9007199254740991),delivery_hash=NULL,delivery_until=NULL WHERE deployment_id=$1 AND owner_id=$2 AND file_id=$3 AND retired_at IS NULL',[...scope(p),id])
  })
  return run(async (c,p) => {
    const account = await lockAccount(c,p)
    const file = (await c.query('SELECT purge_started_at,purged_at FROM files WHERE deployment_id=$1 AND owner_id=$2 AND id=$3 FOR UPDATE',[...scope(p),id])).rows[0]
    if (!file?.purge_started_at) throw authError(409)
    if (file.purged_at) return { state: 'purged' as const }
    const candidate = (await c.query<{id:string;object_key:string;size:number;kind:string}>(`
      SELECT id,object_key,size,'revision' AS kind FROM file_revisions
       WHERE deployment_id=$1 AND owner_id=$2 AND file_id=$3 AND reclaimed_at IS NULL
      UNION ALL
      SELECT u.id,u.deployment_id::text||'/'||u.owner_id::text||'/objects/'||u.revision_id::text,u.expected_size,'upload' FROM uploads u
       WHERE u.deployment_id=$1 AND u.owner_id=$2 AND u.file_id=$3 AND u.state IN ('cancelled','expired') AND u.sha256 IS NOT NULL AND u.reclaimed_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM file_revisions r WHERE r.deployment_id=u.deployment_id AND r.owner_id=u.owner_id AND r.id=u.revision_id)
      ORDER BY id LIMIT 1`,[...scope(p),id])).rows[0]
    if (candidate) {
      if (candidate.size>account.storedBytes) throw authError(503)
      try { await objects.removeUnreferenced!(candidate.object_key) }
      catch { return { state: 'pending' as const } }
      const table = candidate.kind==='revision' ? 'file_revisions' : 'uploads'
      const mark = await c.query(`UPDATE ${table} SET reclaimed_at=clock_timestamp() WHERE deployment_id=$1 AND owner_id=$2 AND id=$3 AND reclaimed_at IS NULL`,[...scope(p),candidate.id])
      if (mark.rowCount!==1) throw authError(503)
      const debit = await c.query('UPDATE storage_accounts SET stored_bytes=stored_bytes-$3 WHERE deployment_id=$1 AND owner_id=$2 AND stored_bytes>=$3',[...scope(p),candidate.size])
      if (debit.rowCount!==1) throw authError(503)
    }
    const remaining = await c.query(`SELECT 1 FROM file_revisions WHERE deployment_id=$1 AND owner_id=$2 AND file_id=$3 AND reclaimed_at IS NULL
      UNION ALL SELECT 1 FROM uploads u WHERE u.deployment_id=$1 AND u.owner_id=$2 AND u.file_id=$3 AND u.state IN ('cancelled','expired') AND u.sha256 IS NOT NULL AND u.reclaimed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM file_revisions r WHERE r.deployment_id=u.deployment_id AND r.owner_id=u.owner_id AND r.id=u.revision_id) LIMIT 1`,[...scope(p),id])
    if (remaining.rowCount) return { state: 'pending' as const }
    await c.query('UPDATE files SET purged_at=clock_timestamp() WHERE deployment_id=$1 AND owner_id=$2 AND id=$3',[...scope(p),id])
    return { state: 'purged' as const }
  })
}
