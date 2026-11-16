import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const schema = await readFile(new URL('../server/db/migrations/0003_files.sql', import.meta.url), 'utf8')

test('file metadata points at an immutable object and does not enable RLS', () => {
  assert.match(schema, /CREATE TABLE dyoffice_files \(/)
  assert.match(schema, /FOREIGN KEY \(deployment_id, owner_user_id\) REFERENCES dyoffice_users \(deployment_id, id\)/)
  assert.match(schema, /sha256 CHAR\(64\) NOT NULL CHECK \(sha256 ~ '\^\[0-9a-f\]\{64\}\$'\)/)
  assert.match(schema, /object_key TEXT NOT NULL CHECK \(object_key ~ '\^blobs\/\[0-9a-f\]\{64\}\$'\)/)
  assert.match(schema, /format IN \('docx', 'xlsx', 'pptx', 'pdf'\)/)
  assert.match(schema, /PENDING T04/)
  const executable = schema.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
  assert.doesNotMatch(executable, /ENABLE ROW LEVEL SECURITY/i)
  assert.doesNotMatch(executable, /CREATE POLICY/i)
})
