import { randomBytes, randomUUID } from 'node:crypto'
import type { McpReadScope, McpPrincipalTransactions, McpPdfRotation } from '../../db/context.ts'
import { authError, tokenHash } from '../auth/sessions.ts'
import { uuid, loadFile } from '../files/queries.ts'
import type { McpExternalCredential } from './credential.ts'

export function createMcpReadGrants(transactions: McpPrincipalTransactions) {
  return {
    async issue(session: string, target: McpReadScope, rotation?: McpPdfRotation) {
      const fileId = uuid(target.fileId)
      const revision = uuid(target.revision)
      const id = randomUUID()
      const token = randomBytes(32).toString('base64url')
      const expiresAt = await transactions.withPrincipalTransaction({ kind: 'session', token: session }, async (connection, principal) => {
        if (rotation) {
          const file = await loadFile(connection, principal, fileId)
          if (file.format !== 'pdf') throw authError(415)
          if (file.current_revision !== revision) throw authError(409)
        }
        const parameters = [principal.deploymentId, tokenHash(session), transactions.sessionIdleMs, id, tokenHash(token), fileId, revision]
        const { rows: [row] } = rotation
          ? await connection.query<{ expires_at: Date | null }>(
            'SELECT issue_mcp_pdf_rotation_grant($1,$2,$3,$4,$5,$6,$7,$8,$9) AS expires_at',
            [...parameters, rotation.pages, rotation.degrees],
          )
          : await connection.query<{ expires_at: Date | null }>(
            'SELECT issue_mcp_read_grant($1,$2,$3,$4,$5,$6,$7) AS expires_at',
            parameters,
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
