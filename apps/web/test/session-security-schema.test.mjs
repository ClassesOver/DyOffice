import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const source = await readFile(new URL('../server/db/migrations/0005_session_security_events.sql', import.meta.url), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })

test('session security audit enforces owner-bound session references and action shape', () => {
  assert.match(source, /CREATE TABLE dyoffice_session_security_events/)
  assert.match(source, /UNIQUE \(deployment_id, user_id, id\)/)
  assert.match(source, /FOREIGN KEY \(deployment_id, user_id, actor_session_id\)/)
  assert.match(source, /FOREIGN KEY \(deployment_id, user_id, target_session_id\)/)
  assert.match(source, /action = 'session.revoked' AND target_session_id IS NOT NULL AND affected_count = 1/)
  assert.match(source, /action = 'session.others_revoked' AND target_session_id IS NULL AND affected_count > 0/)
  assert.doesNotMatch(source, /ON DELETE CASCADE|password_hash|session_token_hash/)
})
