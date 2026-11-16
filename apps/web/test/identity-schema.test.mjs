import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const schema = await readFile(new URL('../server/db/migrations/0001_identity.sql', import.meta.url), 'utf8')

test('initial identity schema enforces normalized unique users, roles, and owner FK', () => {
  for (const name of ['dyoffice_users','dyoffice_user_roles','dyoffice_personal_workspaces','dyoffice_sessions','dyoffice_password_action_tokens','dyoffice_admin_bootstrap']) {
    assert.match(schema, new RegExp('CREATE TABLE ' + name + ' \\('))
  }
  assert.match(schema, /UNIQUE \(deployment_id, username_normalized\)/)
  assert.match(schema, /CONSTRAINT dyoffice_one_workspace_per_owner UNIQUE \(deployment_id, owner_user_id\)/)
  assert.match(schema, /FOREIGN KEY \(deployment_id, user_id\) REFERENCES dyoffice_users \(deployment_id, id\)/)
  assert.match(schema, /password_hash LIKE '\$argon2id\$%'/)
  assert.match(schema, /session_token_hash BYTEA NOT NULL UNIQUE CHECK \(octet_length\(session_token_hash\) = 32\)/)
  assert.match(schema, /token_hash BYTEA NOT NULL UNIQUE CHECK \(octet_length\(token_hash\) = 32\)/)
  assert.match(schema, /initial_admin_user_id UUID NOT NULL/)
})

test('schema has no bootstrap default password or reversible password storage', () => {
  assert.doesNotMatch(schema, /DEFAULT\s+'[^']*admin[^']*'/i)
  assert.doesNotMatch(schema, /INSERT\s+INTO\s+dyoffice_users/i)
  assert.doesNotMatch(schema, /\bpassword_plaintext\b|\bpassword_salt_fixed\b/i)
})
