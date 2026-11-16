import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { createIdentityStore } from '../../server/src/db/identity.ts'
import { provisionRuntimeRoles } from '../../server/src/db/roles.ts'
import { createPasswordService } from '../../server/src/modules/auth/passwords.ts'
import { createAccountService } from '../../server/src/modules/auth/service.ts'
import { createSessionService } from '../../server/src/modules/auth/sessions.ts'
import { createUserService } from '../../server/src/modules/admin/users/service.ts'
import { buildLocalApp } from '../../server/src/app.ts'
import { createPrincipalTransactions } from '../../server/src/db/context.ts'
import { createPreferenceService } from '../../server/src/modules/preferences/service.ts'
import { password } from './identity.mjs'
export const restrictedOrigin = 'https://office.example'

export async function restrictedFixture(t, { origin = restrictedOrigin, objectStore, filePolicy, nativeDocsDirectory, nativeSheetsDirectory, nativeJobs = false, sheetsNative, sheetsPlanner, sheetsPackageReader, worker = false, beforeMigrate, businessMax = 1, seedAccounts = true } = {}) {
  const source = process.env.DYOFFICE_TEST_DATABASE_URL
  assert.ok(source, 'Disposable PostgreSQL admin connection required')
  assert.match(new URL(source).pathname, /^\/dyoffice_test(?:_[a-z0-9_]+)?$/)
  const suffix = randomBytes(6).toString('hex'), database = 'dyoffice_test_rls_' + suffix
  const names = { owner: 'dy_' + suffix + '_owner', auth: 'dy_' + suffix + '_auth', business: 'dy_' + suffix + '_business' }
  if (worker) names.worker = 'dy_' + suffix + '_worker'
  const admin = new Pool({ connectionString: source, connectionTimeoutMillis: 5000 })
  const pools = [], roles = [], cleanup = []
  let madeDatabase = false
  t.after(async () => {
    try {
      for (const operation of cleanup) await operation()
    } finally {
      await Promise.allSettled(pools.map(pool => pool.end()))
      try {
        if (madeDatabase) {
          const deadline = Date.now() + 4000
          while ((await admin.query('SELECT 1 FROM pg_stat_activity WHERE datname=$1', [database])).rowCount) {
            if (Date.now() >= deadline) throw new Error('Test database still has open connections after pool shutdown')
            await new Promise(resolve => setImmediate(resolve))
          }
          await admin.query('DROP DATABASE ' + database)
        }
        for (const name of roles.reverse()) await admin.query('DROP ROLE ' + name)
      } finally { await admin.end() }
    }
  })
  const urls = {}
  for (const [kind, name] of Object.entries(names)) {
    const secret = randomBytes(24).toString('hex')
    // Names and passwords are generated hex, never user-controlled SQL or logged.
    await admin.query(`CREATE ROLE ${name} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${secret}'`)
    roles.push(name)
    const url = new URL(source); url.username = name; url.password = secret; url.pathname = '/' + database
    urls[kind] = url.toString()
  }
  await admin.query('CREATE DATABASE ' + database + ' OWNER ' + names.owner)
  madeDatabase = true
  const makePool = (kind, max = 6) => {
    const pool = new Pool({ connectionString: urls[kind], max, connectionTimeoutMillis: 5000, application_name: 'dyoffice-rls-' + suffix + '-' + kind })
    pools.push(pool); return pool
  }
  const ownerPool = makePool('owner'), ownerDb = createIdentityStore(ownerPool)
  if (beforeMigrate) await beforeMigrate(ownerPool)
  await ownerDb.migrate()
  await provisionRuntimeRoles(ownerPool, { authRole: names.auth, businessRole: names.business,workerRole: names.worker })
  const authPool = makePool('auth'), businessPool = makePool('business', businessMax), db = createIdentityStore(authPool)
  const passwords = await createPasswordService(), deploymentId = randomUUID()
  const ownerAccounts = createAccountService({ db: ownerDb, passwords, deploymentId })
  const initial = await ownerAccounts.bootstrapAdmin({ username: 'owner', password })
  const accounts = createAccountService({ db, passwords, deploymentId })
  const sessions = createSessionService({ db, accounts, deploymentId })
  const users = createUserService({ db, accounts, sessions, passwords, deploymentId })
  const adminSigned = seedAccounts ? await sessions.login('owner', password) : undefined
  const signUser = async username => {
    const created = await users.create(adminSigned.token, { username })
    await users.redeemAction(created.action.token, 'activate', password)
    return { user: created.user, ...await sessions.login(username, password) }
  }
  const alice = seedAccounts ? await signUser('alice') : undefined, bob = seedAccounts ? await signUser('bob') : undefined
  const workerPool = worker ? makePool('worker') : undefined
  const csrfKey = randomBytes(32).toString('hex')
  const app = await buildLocalApp({ db, businessPool, passwords, deploymentId, origin, csrfKey, objectStore, filePolicy, nativeDocsDirectory, nativeSheetsDirectory, nativeJobs, sheetsNative, sheetsPlanner, sheetsPackageReader })
  cleanup.push(() => app.close())
  const transactions = createPrincipalTransactions({ pool: businessPool, deploymentId })
  const preferences = createPreferenceService(transactions)
  return { db, ownerDb, ownerPool, authPool, businessPool, workerPool, passwords, deploymentId, accounts, sessions, users, adminSigned, alice, bob, app, transactions, preferences, cleanup, admin, database, names, urls, initial, csrfKey }
}
export async function waitForDatabaseLock(fixture, kind) {
  const deadline = Date.now() + 4000
  const applicationName = kind === 'business' ? fixture.businessPool.options.application_name : fixture.authPool.options.application_name
  while (Date.now() < deadline) {
    const result = await fixture.admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND application_name=$2 AND wait_event_type='Lock'", [fixture.database, applicationName])
    if (result.rowCount) return
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error('Expected ' + kind + ' lock wait was not observed')
}
