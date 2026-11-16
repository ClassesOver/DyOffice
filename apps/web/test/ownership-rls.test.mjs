import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createMigrationPool } from '../server/db/postgres.mjs'
import { applyMigrations } from '../server/db/migrate.mjs'
import { assertAppRole, withPrincipalTransaction } from '../server/db/context.mjs'
import { createAuthorizer } from '../server/src/modules/policy/authorize.mjs'
import { createSessionService, SESSION_COOKIE_NAME } from '../server/auth/session-core.mjs'
import { buildApp } from '../server/src/app.mjs'

const databaseUrl = process.env.DYOFFICE_TEST_DATABASE_URL
const skip = databaseUrl ? false : 'DYOFFICE_TEST_DATABASE_URL is not set'
const LOGIN_PASSWORD = 'local-ci-only-not-for-production'
const PASSWORD_HASH = '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const SHA = 'ab'.repeat(32)
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

function appUrl() {
  const url = new URL(databaseUrl)
  url.username = 'dyoffice_rls_login'
  url.password = LOGIN_PASSWORD
  return url.toString()
}

function actor(userId, deploymentId, roles = ['user']) {
  return {
    userId,
    ownerId: userId,
    deploymentId,
    sessionId: randomUUID(),
    roles,
    source: 'session',
  }
}

async function prepareLogin(admin) {
  const database = new URL(databaseUrl).pathname.replace(/^\//, '')
  if (!/^[A-Za-z0-9_]+$/.test(database)) throw new Error('Unexpected database name')
  await admin.query(`
    DO $login$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dyoffice_rls_login') THEN
        CREATE ROLE dyoffice_rls_login LOGIN PASSWORD '${LOGIN_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
      END IF;
    END
    $login$;
  `)
  await admin.query(`ALTER ROLE dyoffice_rls_login WITH NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE LOGIN PASSWORD '${LOGIN_PASSWORD}'`)
  await admin.query('GRANT dyoffice_app TO dyoffice_rls_login')
  await admin.query(`GRANT CONNECT ON DATABASE ${database} TO dyoffice_rls_login`)
  await admin.query('GRANT USAGE ON SCHEMA public TO dyoffice_rls_login')
}

async function seed(admin) {
  const deploymentId = randomUUID()
  const userA = randomUUID()
  const userB = randomUUID()
  const adminId = randomUUID()
  const workspaceA = randomUUID()
  const workspaceB = randomUUID()
  const fileId = randomUUID()
  const revisionFileId = randomUUID()
  const objectId = randomUUID()
  const outboxId = randomUUID()
  const revision = `rev_${'a'.repeat(32)}`
  const people = [
    [userA, 'owner.alpha', 'user'],
    [userB, 'owner.beta', 'user'],
    [adminId, 'owner.admin', 'config_admin'],
  ]
  for (const [id, name, role] of people) {
    await admin.query(
      `INSERT INTO dyoffice_users (id, deployment_id, username_normalized, display_name, password_hash, status)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'active')`,
      [id, deploymentId, name, name, PASSWORD_HASH],
    )
    await admin.query(
      'INSERT INTO dyoffice_user_roles (deployment_id, user_id, role) VALUES ($1::uuid, $2::uuid, $3)',
      [deploymentId, id, role],
    )
  }
  await admin.query(
    `INSERT INTO dyoffice_personal_workspaces (id, deployment_id, owner_user_id)
     VALUES ($1::uuid, $3::uuid, $4::uuid), ($2::uuid, $3::uuid, $5::uuid)`,
    [workspaceA, workspaceB, deploymentId, userA, userB],
  )
  await admin.query(
    `INSERT INTO dyoffice_files
      (id, deployment_id, owner_user_id, workspace_id, object_key, sha256, size_bytes, format, name)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, 4, 'docx', 'a.docx')`,
    [fileId, deploymentId, userA, workspaceA, `blobs/${SHA}`, SHA],
  )
  await admin.query(
    `INSERT INTO dyoffice_revision_files
      (deployment_id, owner_id, file_id, format, current_revision, object_id, sha256, size_bytes)
     VALUES ($1, $2, $3::uuid, 'docx', $4, $5::uuid, $6, 4)`,
    [deploymentId, userA, revisionFileId, revision, objectId, SHA],
  )
  await admin.query(
    `INSERT INTO dyoffice_file_revisions
      (deployment_id, owner_id, file_id, revision, object_id, sha256, size_bytes, source)
     VALUES ($1, $2, $3::uuid, $4, $5::uuid, $6, 4, 'import')`,
    [deploymentId, userA, revisionFileId, revision, objectId, SHA],
  )
  await admin.query(
    `INSERT INTO dyoffice_outbox
      (id, deployment_id, owner_id, file_id, event_type, revision, object_id, sha256)
     VALUES ($1::uuid, $2, $3, $4::uuid, 'revision.committed', $5, $6::uuid, $7)`,
    [outboxId, deploymentId, userA, revisionFileId, revision, objectId, SHA],
  )
  return { deploymentId, userA, userB, adminId, workspaceA, workspaceB, fileId, revisionFileId, outboxId }
}

async function openPools() {
  const admin = createMigrationPool({ connectionString: databaseUrl, max: 4 })
  await applyMigrations(admin)
  await prepareLogin(admin)
  const runtime = createMigrationPool({ connectionString: appUrl(), max: 4 })
  return { admin, runtime }
}

test('row security role is not a superuser, owner, or bypass role', { skip, timeout: 60_000 }, async () => {
  const { admin, runtime } = await openPools()
  try {
    const client = await runtime.connect()
    try {
      const login = await client.query('SELECT current_user AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')
      assert.equal(login.rows[0].role, 'dyoffice_rls_login')
      assert.equal(login.rows[0].rolsuper, false)
      assert.equal(login.rows[0].rolbypassrls, false)
      await client.query('BEGIN')
      await assert.rejects(assertAppRole(client), { code: 'PRIVILEGED_ROLE' })
      await client.query('ROLLBACK')
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE dyoffice_app')
      const flags = await client.query(`
        SELECT current_user AS role, session_user AS login,
               rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
        FROM pg_roles WHERE rolname = current_user
      `)
      assert.equal(flags.rows[0].role, 'dyoffice_app')
      assert.equal(flags.rows[0].login, 'dyoffice_rls_login')
      assert.equal(flags.rows[0].rolsuper, false)
      assert.equal(flags.rows[0].rolbypassrls, false)
      assert.equal(flags.rows[0].rolcreatedb, false)
      assert.equal(flags.rows[0].rolcreaterole, false)
      const tables = await client.query(`
        SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, c.relowner::regrole::text AS owner
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        WHERE c.relkind = 'r' AND c.relname = ANY($1::text[])
      `, [OWNED])
      assert.equal(tables.rowCount, OWNED.length)
      for (const row of tables.rows) {
        assert.equal(row.relrowsecurity, true, row.relname)
        assert.equal(row.relforcerowsecurity, true, row.relname)
        assert.equal(row.owner === 'dyoffice_app' || row.owner === 'dyoffice_rls_login', false, row.relname)
      }
      const defined = await client.query(`
        SELECT proname, prosecdef FROM pg_proc
        WHERE proname IN ('dyoffice_current_actor', 'dyoffice_current_deployment')
      `)
      assert.equal(defined.rowCount, 2)
      assert.equal(defined.rows.every((row) => row.prosecdef === false), true)
      await client.query('SAVEPOINT secret')
      await assert.rejects(client.query("SELECT password_hash FROM dyoffice_users"), /permission denied/i)
      await client.query('ROLLBACK TO SAVEPOINT secret')
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
    const superuser = await admin.connect()
    try {
      await superuser.query('BEGIN')
      await assert.rejects(assertAppRole(superuser), { code: 'PRIVILEGED_ROLE' })
      await superuser.query('ROLLBACK')
      const probeUser = randomUUID()
      const probeDeployment = randomUUID()
      await superuser.query('BEGIN')
      await superuser.query(
        `INSERT INTO dyoffice_users (id, deployment_id, username_normalized, display_name, password_hash, status)
         VALUES ($1::uuid, $2::uuid, 'auth.probe', 'Auth probe', $3, 'active')`,
        [probeUser, probeDeployment, PASSWORD_HASH],
      )
      await superuser.query('SET LOCAL ROLE dyoffice_auth')
      const lookup = await superuser.query('SELECT id::text, password_hash FROM dyoffice_users WHERE id = $1::uuid', [probeUser])
      assert.equal(lookup.rows[0].id, probeUser)
      assert.match(lookup.rows[0].password_hash, /^\$argon2id\$/)
      await assert.rejects(superuser.query('SELECT id FROM dyoffice_files'), /permission denied/i)
      await superuser.query('ROLLBACK')
    } finally {
      superuser.release()
    }
  } finally {
    await runtime.end()
    await admin.end()
  }
})

test('owners cannot read, update, or reference each other, and a pool connection does not keep the previous principal', { skip, timeout: 60_000 }, async () => {
  const { admin, runtime } = await openPools()
  const isolated = createMigrationPool({ connectionString: appUrl(), max: 1 })
  try {
    const data = await seed(admin)
    const ownerA = actor(data.userA, data.deploymentId)
    const ownerB = actor(data.userB, data.deploymentId)
    const adminActor = actor(data.adminId, data.deploymentId, ['config_admin'])
    const authorize = createAuthorizer(isolated)

    const visible = await withPrincipalTransaction(runtime, ownerA, async (client) => {
      const who = await client.query('SELECT current_user AS role, current_setting(\'app.current_user\', true) AS actor')
      assert.equal(who.rows[0].role, 'dyoffice_app')
      assert.equal(who.rows[0].actor, data.userA)
      return client.query('SELECT id::text FROM dyoffice_files')
    })
    assert.deepEqual(visible.rows.map((row) => row.id), [data.fileId])

    const hidden = await withPrincipalTransaction(runtime, ownerB, async (client) => {
      const files = await client.query('SELECT id::text FROM dyoffice_files')
      const revisions = await client.query('SELECT file_id::text FROM dyoffice_revision_files')
      const outbox = await client.query('SELECT id::text FROM dyoffice_outbox')
      const workspaces = await client.query('SELECT id::text FROM dyoffice_personal_workspaces')
      const users = await client.query('SELECT id::text FROM dyoffice_users')
      return {
        files: files.rowCount,
        revisions: revisions.rowCount,
        outbox: outbox.rowCount,
        workspaces: workspaces.rows.map((row) => row.id),
        users: users.rows.map((row) => row.id),
      }
    })
    assert.deepEqual(hidden, {
      files: 0,
      revisions: 0,
      outbox: 0,
      workspaces: [data.workspaceB],
      users: [data.userB],
    })

    const asAdmin = await withPrincipalTransaction(runtime, adminActor, async (client) => {
      return client.query('SELECT id::text FROM dyoffice_files')
    })
    assert.equal(asAdmin.rowCount, 0)

    const bare = await runtime.connect()
    try {
      await bare.query('BEGIN')
      await bare.query('SET LOCAL ROLE dyoffice_app')
      assert.equal((await bare.query('SELECT id FROM dyoffice_files')).rowCount, 0)
      await bare.query(`SELECT set_config('app.current_user', $1, true)`, [data.userA])
      assert.equal((await bare.query('SELECT id FROM dyoffice_files')).rowCount, 0)
      await bare.query('ROLLBACK')
    } finally {
      bare.release()
    }

    await assert.rejects(withPrincipalTransaction(runtime, ownerA, async (client) => {
      await client.query('UPDATE dyoffice_files SET owner_user_id = $2::uuid WHERE id = $1::uuid', [data.fileId, data.userB])
    }), (error) => error.code === '42501')
    await assert.rejects(withPrincipalTransaction(runtime, ownerA, async (client) => {
      await client.query(
        `INSERT INTO dyoffice_files
          (id, deployment_id, owner_user_id, object_key, sha256, size_bytes, format, name)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 4, 'docx', 'stolen.docx')`,
        [randomUUID(), data.deploymentId, data.userB, `blobs/${'cd'.repeat(32)}`, 'cd'.repeat(32)],
      )
    }), (error) => error.code === '42501')
    await assert.rejects(withPrincipalTransaction(runtime, ownerA, async (client) => {
      await client.query(
        `INSERT INTO dyoffice_files
          (id, deployment_id, owner_user_id, workspace_id, object_key, sha256, size_bytes, format, name)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, 4, 'docx', 'cross.docx')`,
        [randomUUID(), data.deploymentId, data.userA, data.workspaceB, `blobs/${'ef'.repeat(32)}`, 'ef'.repeat(32)],
      )
    }), (error) => error.code === '23503')
    await assert.rejects(withPrincipalTransaction(runtime, ownerB, async (client) => {
      await client.query(
        `INSERT INTO dyoffice_file_revisions
          (deployment_id, owner_id, file_id, revision, object_id, sha256, size_bytes, source)
         VALUES ($1, $2, $3::uuid, 'rev_foreign', $4::uuid, $5, 4, 'commit')`,
        [data.deploymentId, data.userB, data.revisionFileId, randomUUID(), SHA],
      )
    }), (error) => error.code === '23503')

    const stillA = await admin.query('SELECT owner_user_id::text AS owner FROM dyoffice_files WHERE id = $1::uuid', [data.fileId])
    assert.equal(stillA.rows[0].owner, data.userA)

    await assert.rejects(authorize(ownerB, 'job:enqueue', { artifactId: data.fileId }), (error) => error.code === 'NOT_FOUND' && error.message === '文件不存在')
    await assert.rejects(authorize(adminActor, 'job:enqueue', { artifactId: data.fileId }), (error) => error.code === 'NOT_FOUND' && error.message === '文件不存在')
    await assert.rejects(authorize(ownerB, 'job:cancel', { artifactId: data.revisionFileId }), (error) => error.code === 'NOT_FOUND')
    await authorize(ownerA, 'job:enqueue', { artifactId: data.fileId })
    await authorize(ownerA, 'revision:commit', { artifactId: data.revisionFileId })
    const missingId = randomUUID()
    let missing
    try {
      await authorize(ownerA, 'file:read', { id: missingId })
    } catch (error) {
      missing = { status: error.status, code: error.code, message: error.message }
    }
    let crossed
    try {
      await authorize(ownerB, 'file:read', { id: data.fileId })
    } catch (error) {
      crossed = { status: error.status, code: error.code, message: error.message }
    }
    assert.deepEqual(crossed, missing)
    assert.equal(JSON.stringify(crossed).includes(data.userA), false)

    const held = await isolated.connect()
    const pid = (await held.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    held.release()
    const abandoned = randomUUID()
    await assert.rejects(withPrincipalTransaction(isolated, ownerA, async (client) => {
      assert.equal((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, pid)
      await client.query(
        `INSERT INTO dyoffice_files
          (id, deployment_id, owner_user_id, object_key, sha256, size_bytes, format, name)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 4, 'pdf', 'rolled.pdf')`,
        [abandoned, data.deploymentId, data.userA, `blobs/${'11'.repeat(32)}`, '11'.repeat(32)],
      )
      throw new Error('boom')
    }), /boom/)
    await assert.rejects(withPrincipalTransaction(isolated, ownerA, async (client) => {
      await client.query('SELECT $1::uuid', ['not-a-uuid'])
    }))
    await assert.rejects(withPrincipalTransaction(isolated, ownerA, async (client) => {
      await client.query('SET ROLE dyoffice_auth')
    }), /permission denied/i)
    const reused = await withPrincipalTransaction(isolated, ownerB, async (client) => {
      const state = await client.query(`
        SELECT pg_backend_pid() AS pid, current_setting('app.current_user', true) AS actor, current_user AS role
      `)
      assert.equal(state.rows[0].pid, pid)
      assert.equal(state.rows[0].actor, data.userB)
      assert.equal(state.rows[0].role, 'dyoffice_app')
      return client.query('SELECT id::text FROM dyoffice_files WHERE id = $1::uuid', [abandoned])
    })
    assert.equal(reused.rowCount, 0)
    const outside = await isolated.connect()
    try {
      const cleared = await outside.query(`
        SELECT pg_backend_pid() AS pid, current_setting('app.current_user', true) AS actor, current_user AS role
      `)
      assert.equal(cleared.rows[0].pid, pid)
      assert.ok(cleared.rows[0].actor === null || cleared.rows[0].actor === '')
      assert.notEqual(cleared.rows[0].actor, data.userA)
      assert.notEqual(cleared.rows[0].actor, data.userB)
      assert.equal(cleared.rows[0].role, 'dyoffice_rls_login')
      await outside.query('BEGIN')
      await outside.query('SET LOCAL ROLE dyoffice_app')
      assert.equal((await outside.query('SELECT id FROM dyoffice_files')).rowCount, 0)
      await outside.query('ROLLBACK')
    } finally {
      outside.release()
    }

    const sessions = createSessionService({ pool: admin, idleTimeoutMs: 60 * 60 * 1000 })
    const issuedA = await sessions.issue({ deploymentId: data.deploymentId, userId: data.userA })
    const issuedB = await sessions.issue({ deploymentId: data.deploymentId, userId: data.userB })
    const issuedAdmin = await sessions.issue({ deploymentId: data.deploymentId, userId: data.adminId })
    const cookie = (issued) => issued.cookie.split(';')[0]
    const app = await buildApp({
      env: 'test',
      logger: false,
      rateLimit: { max: 100, windowMs: 60_000 },
      readyCheck: async () => true,
      auth: {
        authenticate(request) {
          return sessions.authenticate(request, { deploymentId: data.deploymentId })
        },
      },
    })
    const httpAuthorize = createAuthorizer(runtime)
    app.get('/api/v1/artifacts/:id', async (request, reply) => {
      try {
        const resource = { id: request.params.id }
        if (typeof request.query.ownerId === 'string') resource.ownerId = request.query.ownerId
        if (typeof request.query.role === 'string') resource.role = request.query.role
        await httpAuthorize(request.principal, request.query.action === 'job' ? 'job:enqueue' : 'file:read', resource)
        return { ok: true }
      } catch (error) {
        return reply.code(error.status || 500).send({ error: error.message, code: error.code })
      }
    })
    const headers = (issued) => ({ cookie: cookie(issued) })
    const allowed = await app.inject({ method: 'GET', url: `/api/v1/artifacts/${data.fileId}`, headers: headers(issuedA) })
    assert.equal(allowed.statusCode, 200, allowed.body)
    const deniedB = await app.inject({ method: 'GET', url: `/api/v1/artifacts/${data.fileId}`, headers: headers(issuedB) })
    const deniedAdmin = await app.inject({ method: 'GET', url: `/api/v1/artifacts/${data.fileId}`, headers: headers(issuedAdmin) })
    const deniedMissing = await app.inject({ method: 'GET', url: `/api/v1/artifacts/${missingId}`, headers: headers(issuedA) })
    const deniedJob = await app.inject({
      method: 'GET',
      url: `/api/v1/artifacts/${data.revisionFileId}?action=job`,
      headers: headers(issuedB),
    })
    const forged = await app.inject({
      method: 'GET',
      url: `/api/v1/artifacts/${data.fileId}?ownerId=${data.userA}&role=config_admin`,
      headers: headers(issuedB),
    })
    assert.equal(deniedB.statusCode, 404)
    assert.deepEqual(deniedB.json(), deniedMissing.json())
    assert.deepEqual(deniedAdmin.json(), deniedMissing.json())
    assert.deepEqual(deniedJob.json(), deniedMissing.json())
    assert.deepEqual(forged.json(), deniedMissing.json())
    assert.equal(JSON.stringify(deniedB.json()).includes(data.userA), false)
    assert.match(cookie(issuedA), new RegExp('^' + SESSION_COOKIE_NAME + '='))
    await app.close()
  } finally {
    await isolated.end()
    await runtime.end()
    await admin.end()
  }
})
