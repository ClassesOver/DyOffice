import test from 'node:test'
import assert from 'node:assert/strict'
import { loadMigrations } from '../../server/src/db/migration-manifest.ts'

test('AI search and media provider function is included in the active migration manifest', async () => {
  const migrations = await loadMigrations()
  const migration = migrations.find(item => item.version === 35)
  assert.ok(migration, 'migration 0035 must run before AI tool services call its provider function')
  assert.match(migration.sql, /CREATE FUNCTION[\s\S]*global_ai_tool_provider/)
})

test('user-owned PPTX style-template storage is included in the active migration manifest',async()=>{
 const migrations=await loadMigrations(),migration=migrations.find(item=>item.version===36)
 assert.ok(migration,'migration 0036 must create the private style-template store')
 assert.match(migration.sql,/CREATE TABLE user_style_templates/)
 assert.match(migration.sql,/ENABLE ROW LEVEL SECURITY/)
 assert.match(migration.sql,/FORCE ROW LEVEL SECURITY/)
})
