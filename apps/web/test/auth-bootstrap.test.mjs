import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { bootstrapInitialAdmin } from '../server/auth/bootstrap-admin.mjs'

const hash = '$argon2id$v=19$m=19456,t=2,p=1$' + 'A'.repeat(22) + '$' + 'B'.repeat(43)
const password = 'a varied and secure passphrase'
const deploymentId = randomUUID()
const hasher = { async hashPassword(value) { assert.equal(value, password); return hash } }

function fakePool() {
  const persisted = { users: [], roles: [], workspaces: [], bootstrap: [] }
  let released = 0
  const seen = []
  return {
    state: persisted, seen,
    get released() { return released },
    async connect() {
      let work
      return {
        async query(sql, params = []) {
          seen.push({ sql, params })
          if (sql === 'BEGIN') { work = structuredClone(persisted); return { rows: [] } }
          if (sql === 'COMMIT') {
            for (const table of Object.keys(work)) persisted[table] = work[table]
            return { rows: [] }
          }
          if (sql === 'ROLLBACK') { work = null; return { rows: [] } }
          if (sql.startsWith('SELECT EXISTS (SELECT 1 FROM dyoffice_users')) {
            return { rows: [{ has_users: work.users.some(row => row[1] === params[0]) }] }
          }
          const name = /INSERT INTO (dyoffice_\w+)/.exec(sql)?.[1]
          if (!name) throw new Error('Unsupported fake SQL')
          if (name === 'dyoffice_users') work.users.push(params)
          else if (name === 'dyoffice_user_roles') work.roles.push(params)
          else if (name === 'dyoffice_personal_workspaces') work.workspaces.push(params)
          else if (name === 'dyoffice_admin_bootstrap') {
            if (work.bootstrap.some(row => row[0] === params[0])) throw new Error('unique_violation')
            work.bootstrap.push(params)
          } else throw new Error('Unexpected table')
          return { rows: [] }
        },
        release() { released++ },
      }
    },
  }
}

test('bootstrap records hashed admin, role and workspace in a single transaction', async () => {
  const pool = fakePool()
  const result = await bootstrapInitialAdmin({ pool, passwordHasher:hasher, deploymentId,
    username:' Root.Admin ', displayName:' Administrator ', password })
  assert.equal(result.username, 'root.admin')
  assert.deepEqual(Object.values(pool.state).map(rows => rows.length), [1,1,1,1])
  assert.equal(pool.state.users[0][4], hash)
  assert.equal(pool.state.roles[0][2], 'config_admin')
  assert.equal(pool.state.bootstrap[0][1], result.userId)
  assert.equal(pool.state.workspaces[0][2], result.userId)
  assert.equal(pool.released, 1)
  assert.deepEqual(pool.seen.filter(x => ['BEGIN','COMMIT'].includes(x.sql)).map(x => x.sql), ['BEGIN','COMMIT'])
  assert.equal(JSON.stringify(pool.seen).includes(password), false)
  assert.equal(JSON.stringify(result).includes(hash), false)
})

test('duplicate first-admin initialization rolls back without partial rows', async () => {
  const pool = fakePool()
  const input = { pool, passwordHasher:hasher, deploymentId, username:'root.admin', displayName:'Admin', password }
  await bootstrapInitialAdmin(input)
  await assert.rejects(bootstrapInitialAdmin(input), /setup failed/i)
  assert.deepEqual(Object.values(pool.state).map(rows => rows.length), [1,1,1,1])
  assert.equal(pool.seen.at(-1).sql, 'ROLLBACK')
  assert.equal(pool.released, 2)
})

test('invalid setup input is rejected before connecting to DB', async () => {
  const pool = fakePool()
  const input = { pool, passwordHasher:hasher, deploymentId, username:'root.admin', displayName:'Admin', password }
  await assert.rejects(bootstrapInitialAdmin({ ...input, password:'short' }), TypeError)
  await assert.rejects(bootstrapInitialAdmin({ ...input, deploymentId:'invalid' }), TypeError)
  await assert.rejects(bootstrapInitialAdmin({ ...input, passwordHasher:{ hashPassword:async()=> 'sha256:fake' } }), /unacceptable hash/)
  assert.equal(pool.released, 0)
})
