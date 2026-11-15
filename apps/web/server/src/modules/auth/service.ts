import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { users } from '../../db/schema.ts'
import type { IdentityStore } from '../../db/identity.ts'
import { normalizeUsername, type PasswordService } from './passwords.ts'

export function createAccountService({ db, passwords, deploymentId }: { db: IdentityStore; passwords: PasswordService; deploymentId: string }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deploymentId)) throw new Error('Invalid deployment ID')
  return {
    async bootstrapAdmin(input: { username: unknown; password: unknown }) {
      const username = normalizeUsername(input.username)
      const encoded = await passwords.hash(input.password)
      return db.transaction(async connection => {
        await connection.query('INSERT INTO deployments(id) VALUES($1) ON CONFLICT DO NOTHING', [deploymentId])
        const { rows: [deployment] } = await connection.query('SELECT bootstrap_completed FROM deployments WHERE id=$1 FOR UPDATE', [deploymentId])
        if (deployment.bootstrap_completed) throw Object.assign(new Error('Bootstrap is closed'), { code: 'BOOTSTRAP_CLOSED' })
        const existing = await connection.query('SELECT 1 FROM users WHERE deployment_id=$1 LIMIT 1', [deploymentId])
        if (existing.rowCount) throw Object.assign(new Error('Bootstrap is closed'), { code: 'BOOTSTRAP_CLOSED' })
        const id = randomUUID()
        await connection.query("INSERT INTO users(id,deployment_id,username_normalized,password_hash,password_changed_at,status) VALUES($1,$2,$3,$4,now(),'active')", [id, deploymentId, username, encoded])
        await connection.query("INSERT INTO user_roles(deployment_id,user_id,role) VALUES($1,$2,'config_admin'),($1,$2,'personal')", [deploymentId, id])
        await connection.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true)", [deploymentId, id])
        await connection.query('INSERT INTO workspaces(id,deployment_id,owner_id) VALUES($1,$2,$3)', [randomUUID(), deploymentId, id])
        await connection.query("INSERT INTO auth_audit_events(id,deployment_id,actor_id,event) VALUES($1,$2,$3,'admin_bootstrapped')", [randomUUID(), deploymentId, id])
        await connection.query('UPDATE deployments SET bootstrap_completed=true WHERE id=$1', [deploymentId])
        return { id, deploymentId, username }
      })
    },
    // Password verification is only a candidate. Session creation/protected writes
    // must lock and revalidate status/auth_version (T03b/T04), never trust this alone.
    async verifyCredentials(usernameInput: unknown, password: unknown) {
      let username = ''
      try { username = normalizeUsername(usernameInput) } catch { /* Same lookup + dummy work for invalid identities. */ }
      const [user] = await db.orm.select().from(users).where(and(eq(users.deploymentId, deploymentId), eq(users.username, username))).limit(1)
      const valid = await passwords.verifyCandidate(password, user?.passwordHash)
      if (!valid || !user || user.status !== 'active' || user.passwordResetRequired) return null
      return { userId: user.id, deploymentId, authVersion: user.authVersion }
    },
  }
}
