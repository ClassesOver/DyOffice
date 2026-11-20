import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

export async function loadMigrations() {
  return Promise.all(['0001_identity.sql', '0002_auth_sessions.sql', '0003_account_lifecycle.sql', '0004_rls.sql', '0005_files.sql', '0006_revisions.sql', '0007_jobs.sql', '0008_job_output.sql', '0009_job_leases.sql', '0010_native_readiness.sql', '0011_native_deployment.sql', '0012_revision_delivery.sql', '0013_login_history.sql', '0014_session_idle_guard.sql', '0015_revision_ack_deadline.sql', '0016_abandoned_upload_reclamation.sql', '0017_permanent_file_purge.sql', '0018_global_config.sql', '0019_workspace.sql', '0020_command_journal.sql', '0021_provider_budget.sql', '0022_command_abandonment.sql', '0023_user_skills.sql', '0024_personal_provider.sql', '0025_sources.sql', '0026_source_connector_kinds.sql', '0027_realtime_tickets.sql', '0028_workspace_data_results.sql', '0029_harness_artifacts.sql', '0030_assistant_channels.sql', '0031_assistant_channel_data.sql', '0032_login_history_pages.sql', '0033_session_pages.sql', '0034_shared_provider.sql', '0035_global_ai_tools.sql', '0036_user_style_templates.sql', '0037_assistant_background.sql', '0038_sources_current_config.sql', '0039_source_egress_targets.sql', '0040_global_config_readiness.sql', '0041_dsh_token_history.sql', '0042_word_collab.sql', '0043_file_assistant_chat.sql', '0044_pdf_auto_name.sql'].map(async (file, i) => {
    const sql = await readFile(new URL('./migrations/' + file, import.meta.url), 'utf8')
    return { version: i + 1, sql, digest: createHash('sha256').update(sql).digest('hex') }
  }))
}

export async function getMigrationManifest() { return (await loadMigrations()).map(({ version,digest }) => ({ version,sha256: digest })) }
