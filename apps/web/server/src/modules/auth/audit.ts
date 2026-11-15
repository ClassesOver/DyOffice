import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'

export interface AuthContext { requestId?: string; accountKey?: string }
export async function appendAuthEvent(connection: Pick<PoolClient, 'query'>, deploymentId: string, event: string, context: AuthContext & { actorId?: string; sessionId?: string; subjectUserId?: string } = {}) {
  await connection.query('INSERT INTO auth_security_events(id,deployment_id,actor_id,event,request_id,account_key,session_id,subject_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [randomUUID(), deploymentId, context.actorId ?? null, event, context.requestId ?? randomUUID(), context.accountKey ?? null, context.sessionId ?? null, context.subjectUserId ?? null])
}
