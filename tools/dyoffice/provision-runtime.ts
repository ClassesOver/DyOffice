import { connectIdentityStore } from '../../apps/web/server/src/db/identity.ts'
import { provisionRuntimeRoles } from '../../apps/web/server/src/db/roles.ts'

async function main() {
  const connectionString = process.env.DYOFFICE_DATABASE_URL
  const authRole = process.env.DYOFFICE_AUTH_ROLE
  const businessRole = process.env.DYOFFICE_BUSINESS_ROLE
  if (!connectionString || !authRole || !businessRole || process.argv.length !== 2) throw new Error('Explicit owner connection and existing runtime roles required')
  const { db, close } = connectIdentityStore(connectionString)
  try {
    const { rows: [owner] } = await db.pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')
    if (owner.rolsuper || owner.rolbypassrls) throw new Error('Non-superuser migration owner required')
    await db.migrate()
    await provisionRuntimeRoles(db.pool, { authRole, businessRole })
    console.log('Runtime database grants installed. No login password was created or changed.')
  } finally { await close() }
}
main().catch(() => {
  console.error('provision-runtime: failed; use a dedicated non-superuser migration owner and precreated restricted runtime roles')
  process.exitCode = 1
})
