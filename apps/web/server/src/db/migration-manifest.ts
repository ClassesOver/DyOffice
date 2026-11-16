import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

export async function loadMigrations() {
  return Promise.all(['0001_identity.sql', '0002_auth_sessions.sql', '0003_account_lifecycle.sql', '0004_rls.sql', '0005_files.sql', '0006_revisions.sql', '0007_jobs.sql', '0008_job_output.sql', '0009_job_leases.sql', '0010_native_readiness.sql', '0011_native_deployment.sql', '0012_revision_delivery.sql', '0013_login_history.sql', '0014_session_idle_guard.sql', '0015_revision_ack_deadline.sql'].map(async (file, i) => {
    const sql = await readFile(new URL('./migrations/' + file, import.meta.url), 'utf8')
    return { version: i + 1, sql, digest: createHash('sha256').update(sql).digest('hex') }
  }))
}

export async function getMigrationManifest() { return (await loadMigrations()).map(({ version,digest }) => ({ version,sha256: digest })) }
