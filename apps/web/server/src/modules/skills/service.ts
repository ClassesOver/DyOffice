import type { PoolClient } from 'pg'
import type { BusinessPrincipal, PrincipalTransactions } from '../../db/context.ts'
import { authorize } from '../policy/authorize.ts'
import { authError, tokenHash } from '../auth/sessions.ts'

export function createSkillService(transactions: PrincipalTransactions) {
  const nameOf = (name: string) => {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(name)) throw authError(400)
    return name
  }
  const access = <T>(token: string, write: boolean, run: (c: PoolClient, p: BusinessPrincipal) => Promise<T>) =>
    transactions.withPrincipalTransaction({kind: 'session', token}, async (c, p) => {
      authorize(p, write ? 'preferences:write' : 'preferences:read', {deploymentId: p.deploymentId, ownerId: p.userId})
      await c.query("SELECT set_config('dyoffice.global_session_hash',$1,true),set_config('dyoffice.global_idle_ms',$2,true)", [tokenHash(token), String(transactions.sessionIdleMs)])
      return run(c, p)
    })
  return {
    list: (token: string) => access<{name: string; description: string}[]>(token, false, async (c, p) =>
      (await c.query('SELECT name,description FROM user_skills WHERE deployment_id=$1 AND owner_id=$2 ORDER BY name', [p.deploymentId, p.userId])).rows),
    read: (token: string, name: string) => access<{name: string; description: string; body: string}>(token, false, async (c, p) => {
      const row = (await c.query('SELECT name,description,body FROM user_skills WHERE deployment_id=$1 AND owner_id=$2 AND name=$3', [p.deploymentId, p.userId, nameOf(name)])).rows[0]
      if (!row) throw authError(404)
      return row
    }),
    async save(token: string, name: string, value: unknown) {
      nameOf(name)
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['description','body'].includes(k))) throw authError(400)
      const {description, body} = value as Record<string, unknown>
      if (typeof description !== 'string' || Buffer.byteLength(description) > 4096 || typeof body !== 'string' || !body.trim() || Buffer.byteLength(body) > 262144 || body.includes('\0') || description.includes('\0')) throw authError(400)
      return access<{name: string; description: string}>(token, true, async (c, p) => {
        // Serialize quota admission for this owner, including different names.
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['skills:' + p.deploymentId + ':' + p.userId])
        const count = await c.query('SELECT count(*)::integer AS count FROM user_skills WHERE deployment_id=$1 AND owner_id=$2 AND name<>$3', [p.deploymentId, p.userId, name])
        if (count.rows[0].count >= 100) throw authError(409)
        await c.query('INSERT INTO user_skills(deployment_id,owner_id,workspace_id,name,description,body) SELECT $1,$2,id,$3,$4,$5 FROM workspaces WHERE deployment_id=$1 AND owner_id=$2 ON CONFLICT(deployment_id,owner_id,name) DO UPDATE SET description=EXCLUDED.description,body=EXCLUDED.body', [p.deploymentId, p.userId, name, description, body])
        return {name, description}
      })
    },
    remove: (token: string, name: string) => access<void>(token, true, async (c, p) => {
      const result = await c.query('DELETE FROM user_skills WHERE deployment_id=$1 AND owner_id=$2 AND name=$3', [p.deploymentId, p.userId, nameOf(name)])
      if (!result.rowCount) throw authError(404)
    }),
  }
}
