import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const rls = await readFile(new URL('../server/db/migrations/0005_rls.sql', import.meta.url), 'utf8')
const executable = rls.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')

const OWNED = [
  'dyoffice_personal_workspaces',
  'dyoffice_files',
  'dyoffice_revision_files',
  'dyoffice_file_revisions',
  'dyoffice_edit_leases',
  'dyoffice_revision_uploads',
  'dyoffice_revision_idempotency',
  'dyoffice_outbox',
  'dyoffice_users',
  'dyoffice_user_roles',
  'dyoffice_sessions',
  'dyoffice_password_action_tokens',
  'dyoffice_admin_bootstrap',
]

test('T04 forces row level security on every owned table', () => {
  for (const name of OWNED) {
    assert.match(executable, new RegExp(`ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY`))
    assert.match(executable, new RegExp(`ALTER TABLE ${name} FORCE ROW LEVEL SECURITY`))
  }
  assert.match(executable, /CREATE ROLE dyoffice_app NOLOGIN NOSUPERUSER NOBYPASSRLS/)
  assert.match(executable, /CREATE ROLE dyoffice_auth NOLOGIN NOSUPERUSER NOBYPASSRLS/)
  assert.doesNotMatch(executable, /(?<!NO)BYPASSRLS/)
  assert.match(executable, /CREATE POLICY dyoffice_files_owner ON dyoffice_files/)
  assert.match(executable, /WITH CHECK/)
  assert.match(executable, /dyoffice_current_actor\(\)/)
  assert.match(executable, /dyoffice_files_workspace_owner_fk/)
  assert.match(executable, /UNIQUE \(deployment_id, owner_user_id, id\)/)
  assert.doesNotMatch(executable, /GRANT SELECT \(password_hash\) ON dyoffice_users TO dyoffice_app/)
  assert.doesNotMatch(executable, /GRANT [^;]* ON dyoffice_files TO dyoffice_auth/)
})
