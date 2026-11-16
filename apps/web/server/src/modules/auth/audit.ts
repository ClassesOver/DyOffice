import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { normalizeUsername } from './passwords.ts'

export interface AuthContext { requestId?: string; accountKey?: string }
export async function appendAuthEvent(connection: Pick<PoolClient, 'query'>, deploymentId: string, event: string, context: AuthContext & { actorId?: string; sessionId?: string; subjectUserId?: string } = {}) {
  await connection.query('INSERT INTO auth_security_events(id,deployment_id,actor_id,event,request_id,account_key,session_id,subject_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [randomUUID(), deploymentId, context.actorId ?? null, event, context.requestId ?? randomUUID(), context.accountKey ?? null, context.sessionId ?? null, context.subjectUserId ?? null])
}

// Attribute at this INSERT statement's MVCC snapshot, not request start or
// password-check time. An uncommitted rename still belongs to its old UUID;
// a committed rename is observed as the new owner (or no owner). One statement
// removes lookup/insert gaps without an account-row lock/timing oracle.
export async function appendLoginAttempt(connection: Pick<PoolClient, 'query'>, deploymentId: string, event: 'login_failed' | 'login_throttled', usernameInput: unknown, context: AuthContext = {}) {
  let username: string | undefined
  try { username = normalizeUsername(usernameInput) } catch { /* Unknown/invalid subjects remain unassigned. */ }
  await connection.query(`INSERT INTO auth_security_events(id,deployment_id,actor_id,event,request_id,account_key,session_id,subject_user_id)
    SELECT $1,$2,NULL,$3,$4,$5,NULL,u.id
    FROM (VALUES (1)) AS attempt(singleton)
    LEFT JOIN users u ON u.deployment_id=$2 AND u.username_normalized=$6`,
    [randomUUID(), deploymentId, event, context.requestId ?? randomUUID(), context.accountKey ?? null, username ?? null])
}
