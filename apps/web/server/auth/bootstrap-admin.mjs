import { randomUUID } from 'node:crypto'
import { normalizeUsername, validateNewPassword, inspectArgon2idHash } from './credential-policy.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Create the first local configuration admin and personal workspace atomically.
 * Must be called only by an authenticated local operator CLI, never by HTTP.
 * The supplied passwordHasher must perform real, audited Argon2id hashing;
 * this module deliberately does not ship a mock or a weaker fallback.
 */
export async function bootstrapInitialAdmin({ pool, passwordHasher, deploymentId, username, displayName, password, createId = randomUUID }) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('PostgreSQL pool required')
  if (!passwordHasher || typeof passwordHasher.hashPassword !== 'function') throw new TypeError('Argon2id password hasher required')
  if (!UUID.test(deploymentId)) throw new TypeError('Invalid deployment identifier')
  const normalized = normalizeUsername(username)
  if (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 200) throw new TypeError('Invalid display name')
  validateNewPassword(password)
  // Heavy hash calculation happens before the transaction, with concurrency
  // limits in the (future) CLI/provider. It must produce a valid PHC string.
  const hash = await passwordHasher.hashPassword(password)
  if (!inspectArgon2idHash(hash)) throw new Error('Argon2id provider returned an unacceptable hash')
  const userId = createId()
  const workspaceId = createId()
  if (!UUID.test(userId) || !UUID.test(workspaceId) || userId === workspaceId) throw new TypeError('Invalid generated identity')
  const client = await pool.connect()
  let begun = false
  try {
    await client.query('BEGIN')
    begun = true
    // This is a first-install operation only: never add an extra admin to a
    // pre-existing deployment whose bootstrap marker is missing/corrupt.
    const existing = await client.query(
      'SELECT EXISTS (SELECT 1 FROM dyoffice_users WHERE deployment_id = $1) AS has_users',
      [deploymentId],
    )
    if (existing.rows[0]?.has_users !== false) throw new Error('Deployment already has accounts')
    // A distinct bootstrap row is the cross-process concurrency fence. If
    // another initialization succeeds, the duplicate insert aborts this TX.
    await client.query(
      "INSERT INTO dyoffice_users (id, deployment_id, username_normalized, display_name, password_hash, status, password_changed_at) VALUES ($1, $2, $3, $4, $5, 'active', now())",
      [userId, deploymentId, normalized, displayName.trim(), hash],
    )
    await client.query(
      'INSERT INTO dyoffice_user_roles (deployment_id, user_id, role) VALUES ($1, $2, $3)',
      [deploymentId, userId, 'config_admin'],
    )
    await client.query(
      'INSERT INTO dyoffice_personal_workspaces (id, deployment_id, owner_user_id) VALUES ($1, $2, $3)',
      [workspaceId, deploymentId, userId],
    )
    await client.query(
      'INSERT INTO dyoffice_admin_bootstrap (deployment_id, initial_admin_user_id) VALUES ($1, $2)',
      [deploymentId, userId],
    )
    await client.query('COMMIT')
    begun = false
    return { userId, workspaceId, username: normalized }
  } catch (error) {
    if (begun) await client.query('ROLLBACK').catch(() => {})
    // SQL details may expose usernames; do not propagate raw DB errors into UI.
    throw new Error('Initial administrator setup failed', { cause: error })
  } finally {
    client.release()
  }
}
