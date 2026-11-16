import { normalizePrincipal } from '../src/modules/policy/principal.mjs'

const ROLE_GUARD = `
  SELECT r.rolname,
         r.rolsuper,
         r.rolbypassrls,
         r.rolcreatedb,
         r.rolcreaterole,
         c.relowner = r.oid AS owns_files,
         c.relrowsecurity,
         c.relforcerowsecurity
  FROM pg_roles r
  JOIN pg_class c ON c.relname = 'dyoffice_files'
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  WHERE r.rolname = current_user
`

function refused(code, message) {
  return Object.assign(new Error(message), { code, status: 500, publicCode: code })
}

/** Reject a superuser, table owner, or role that bypasses row security. */
export async function assertAppRole(client) {
  const row = (await client.query(ROLE_GUARD)).rows[0]
  if (!row || row.rolname !== 'dyoffice_app' || row.rolsuper || row.rolbypassrls || row.owns_files) {
    throw refused('PRIVILEGED_ROLE', '数据库运行角色不能绕过行级安全')
  }
  if (!row.relrowsecurity || !row.relforcerowsecurity) {
    throw refused('RLS_REQUIRED', '文件表未强制行级安全')
  }
  return row
}

/**
 * Run fn as dyoffice_app with transaction-local principal settings.
 * set_config(..., true) is SET LOCAL. COMMIT or ROLLBACK clears it before
 * the connection returns to the pool. The principal is the server session,
 * not a request body.
 */
export async function withPrincipalTransaction(pool, principal, fn) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('PostgreSQL pool required')
  if (typeof fn !== 'function') throw new TypeError('Transaction callback required')
  const actor = normalizePrincipal(principal)
  const client = await pool.connect()
  let begun = false
  try {
    await client.query('BEGIN')
    begun = true
    await client.query('SET LOCAL ROLE dyoffice_app')
    await assertAppRole(client)
    await client.query(
      `SELECT set_config('app.current_user', $1, true),
              set_config('app.current_deployment', $2, true),
              set_config('app.current_session', $3, true)`,
      [actor.userId, actor.deploymentId, actor.sessionId],
    )
    const result = await fn(client, actor)
    await client.query('COMMIT')
    begun = false
    return result
  } catch (error) {
    if (begun) await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}
