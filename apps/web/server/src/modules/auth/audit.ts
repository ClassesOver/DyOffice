import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { normalizeUsername } from './passwords.ts'

export interface AuthContext { requestId?: string; accountKey?: string }
export async function appendAuthEvent(connection: Pick<PoolClient, 'query'>, deploymentId: string, event: string, context: AuthContext & { actorId?: string; sessionId?: string; subjectUserId?: string } = {}) {
  await connection.query('INSERT INTO auth_security_events(id,deployment_id,actor_id,event,request_id,account_key,session_id,subject_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [randomUUID(), deploymentId, context.actorId ?? null, event, context.requestId ?? randomUUID(), context.accountKey ?? null, context.sessionId ?? null, context.subjectUserId ?? null])
}

// Bind an attempted account at audit-write time to its immutable ID. A row
// SHARE lock prevents a concurrent rename/delete from changing that attribution
// before this transaction commits. Never infer historical ownership from HMACs.
export async function appendLoginAttempt(connection: Pick<PoolClient, 'query'>, deploymentId: string, event: 'login_failed' | 'login_throttled', usernameInput: unknown, context: AuthContext = {}) {
  let username: string | undefined
  try { username = normalizeUsername(usernameInput) } catch { /* Unknown/invalid subjects remain unassigned. */ }
  const subject = username === undefined ? undefined : (await connection.query<{ id: string }>('SELECT id FROM users WHERE deployment_id=$1 AND username_normalized=$2 FOR SHARE', [deploymentId, username])).rows[0]
  await appendAuthEvent(connection, deploymentId, event, { ...context, subjectUserId: subject?.id })
}
