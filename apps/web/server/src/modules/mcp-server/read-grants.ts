import { randomBytes, randomUUID } from 'node:crypto'
import type { McpReadScope, McpPrincipalTransactions, McpEditApproval } from '../../db/context.ts'
import { authError, tokenHash } from '../auth/sessions.ts'
import { uuid, loadFile } from '../files/queries.ts'
import type { McpExternalCredential } from './credential.ts'

const editFormats = { 'pdf.rotate': 'pdf', 'xlsx.cells': 'xlsx', 'pptx.notes': 'pptx', 'docx.paragraph': 'docx' } as const

export function createMcpReadGrants(transactions: McpPrincipalTransactions) {
  return {
    async issue(session: string, target: McpReadScope, approval?: McpEditApproval) {
      const fileId = uuid(target.fileId)
      const revision = uuid(target.revision)
      const id = randomUUID()
      const token = randomBytes(32).toString('base64url')
      const expiresAt = await transactions.withPrincipalTransaction({ kind: 'session', token: session }, async (connection, principal) => {
        if (approval) {
          const file = await loadFile(connection, principal, fileId)
          if (file.format !== editFormats[approval.kind]) throw authError(415)
          if (file.current_revision !== revision) throw authError(409)
        }
        const parameters = [principal.deploymentId, tokenHash(session), transactions.sessionIdleMs, id, tokenHash(token), fileId, revision]
        const { rows: [row] } = approval
          ? await connection.query<{ expires_at: Date | null }>(
            'SELECT issue_mcp_edit_grant($1,$2,$3,$4,$5,$6,$7,$8::jsonb) AS expires_at',
            [...parameters, JSON.stringify(approval)],
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
