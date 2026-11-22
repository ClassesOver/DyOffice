import { randomBytes, randomUUID } from 'node:crypto'
import type { McpReadScope, McpPrincipalTransactions } from '../../db/context.ts'
import { authError, tokenHash } from '../auth/sessions.ts'
import { uuid } from '../files/queries.ts'
import type { McpExternalCredential } from './credential.ts'

export function createMcpReadGrants(transactions: McpPrincipalTransactions) {
  return {
    async issue(session: string, target: McpReadScope) {
      const fileId = uuid(target.fileId)
      const revision = uuid(target.revision)
      const id = randomUUID()
      const token = randomBytes(32).toString('base64url')
      const expiresAt = await transactions.withPrincipalTransaction({ kind: 'session', token: session }, async (connection, principal) => {
        const { rows: [row] } = await connection.query<{ expires_at: Date | null }>(
          'SELECT issue_mcp_read_grant($1,$2,$3,$4,$5,$6,$7) AS expires_at',
          [principal.deploymentId, tokenHash(session), transactions.sessionIdleMs, id, tokenHash(token), fileId, revision],
        )
        if (!row.expires_at) throw authError(404)
        return row.expires_at
      })
      return { id, fileId, revision, token, expiresAt: expiresAt.toISOString() }
    },
    async revoke(session: string, grantId: string) {
      const id = uuid(grantId)
      await transactions.withPrincipalTransaction({ kind: 'session', token: session }, async (connection, principal) => {
        const { rows: [row] } = await connection.query<{ revoked: boolean }>(
          'SELECT revoke_mcp_read_grant($1,$2,$3,$4) AS revoked',
          [principal.deploymentId, tokenHash(session), transactions.sessionIdleMs, id],
        )
        if (!row.revoked) throw authError(404)
      })
    },
    inspect: (credential: McpExternalCredential) => transactions.inspectMcpReadScope(credential),
  }
}
