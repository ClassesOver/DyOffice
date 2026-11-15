import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { applyMigrations, readMigrations } from '../server/db/migrate.mjs'

function fakePool() {
  let committed = []
  let releases = 0
  const calls = []
  return {
    get rows() { return committed }, get releases() { return releases }, calls,
    async connect() {
      let current = []
      return {
        async query(sql, params) {
          calls.push({ sql, params })
          if (sql === 'BEGIN') { current = structuredClone(committed); return { rows: [] } }
          if (sql === 'COMMIT') { committed = current; return { rows: [] } }
          if (sql === 'ROLLBACK') { current = []; return { rows: [] } }
          if (sql.startsWith('SELECT version')) return { rows: current }
          if (sql.startsWith('INSERT INTO dyoffice_schema_migrations')) {
            current.push({ version:params[0],name:params[1],checksum:params[2] }); return { rows:[] }
          }
          if (sql.includes('BROKEN_SQL')) throw new Error('syntax_error')
          return { rows: [] }
        },
        release() { releases++ },
      }
    },
  }
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-migrations-'))
  t.after(() => rm(directory, { recursive:true, force:true }))
  return directory
}

test('migration runner applies checksummed files only once', async t => {
  const directory = await fixture(t)
  await writeFile(join(directory,'0001_alpha.sql'),'CREATE TABLE alpha (id int);')
  await writeFile(join(directory,'0002_beta.sql'),'CREATE TABLE beta (id int);')
  const pool = fakePool()
  assert.deepEqual(await applyMigrations(pool,{directory}),['0001_alpha.sql','0002_beta.sql'])
  assert.deepEqual(await applyMigrations(pool,{directory}),[])
  assert.equal(pool.rows.length,2)
  assert.equal(pool.releases,2)
  assert.equal(pool.calls.filter(q=>q.sql.includes('pg_advisory_xact_lock')).length,2)
})

test('migration history drift fails closed with rollback', async t => {
  const directory = await fixture(t)
  await writeFile(join(directory,'0001_alpha.sql'),'CREATE TABLE alpha (id int);')
  const pool = fakePool()
  await applyMigrations(pool,{directory})
  await writeFile(join(directory,'0001_alpha.sql'),'CREATE TABLE alpha (id bigint);')
  await assert.rejects(applyMigrations(pool,{directory}),/history does not match source/)
  assert.equal(pool.rows.length,1)
  assert.equal(pool.calls.at(-1).sql,'ROLLBACK')
  assert.equal(pool.releases,2)
})

test('broken migration rolls back journal and releases connection', async t => {
  const directory = await fixture(t)
  await writeFile(join(directory,'0001_alpha.sql'),'CREATE TABLE alpha (id int);')
  await writeFile(join(directory,'0002_beta.sql'),'BROKEN_SQL')
  const pool = fakePool()
  await assert.rejects(applyMigrations(pool,{directory}),/syntax_error/)
  assert.equal(pool.rows.length,0)
  assert.equal(pool.releases,1)
  assert.equal(pool.calls.at(-1).sql,'ROLLBACK')
})

test('migration parser rejects duplicate versions and empty SQL', async t => {
  const directory = await fixture(t)
  await writeFile(join(directory,'0001_alpha.sql'),'SELECT 1;')
  await writeFile(join(directory,'0001_other.sql'),'SELECT 2;')
  await assert.rejects(readMigrations(directory),/Duplicate migration/)
  await rm(join(directory,'0001_other.sql'))
  await writeFile(join(directory,'0001_alpha.sql'),'')
  await assert.rejects(readMigrations(directory),/Invalid migration size/)
})
