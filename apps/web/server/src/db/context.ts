import type { Pool, PoolClient } from 'pg'
import { assertRuntimePool } from './roles.ts'
import { tokenHash, authError } from '../modules/auth/sessions.ts'
import type { McpExternalCredential } from '../modules/mcp-server/credential.ts'
import type { Principal } from '../../../../../packages/web-contracts/src/api.ts'

export interface JobCredential { kind: 'job'; jobId: string; epoch: number; token: string }
export type FileCredential = string | JobCredential
export type OfficeReadCredential = FileCredential | McpExternalCredential
export type McpReadScope = Readonly<{ fileId: string; revision: string }>
export type McpXlsxCell = Readonly<{ sheetId: string; row: number; column: number; value: string | number | boolean | null }>
export type McpEditApproval =
  | Readonly<{ kind: 'pdf.rotate'; pages: readonly number[]; degrees: number }>
  | Readonly<{ kind: 'xlsx.cells'; cells: readonly McpXlsxCell[] }>
  | Readonly<{ kind: 'pptx.notes'; slide: number; text: string }>
  | Readonly<{ kind: 'docx.paragraph'; docxIndex: number; expectedText: string; replacement: string }>
export type McpFileGrant = McpReadScope & Readonly<{ id: string; approval?: McpEditApproval; resultRevision?: string }>
const mcpEditKeyPrefix = { 'pdf.rotate': 'mcp_pdf_rotate_', 'xlsx.cells': 'mcp_xlsx_cells_', 'pptx.notes': 'mcp_pptx_notes_', 'docx.paragraph': 'mcp_docx_paragraph_' }
export const mcpEditKey = (kind: McpEditApproval['kind'], grantId: string) => mcpEditKeyPrefix[kind] + grantId
export interface DshEditCredential { kind: 'dsh-edit'; token: string }
type TransactionCredential = BusinessCredential | McpExternalCredential | DshEditCredential
export type BusinessCredential = SessionCredential | JobCredential
export type BusinessPrincipal = Principal & { roles: readonly string[]; authVersion: number; job?: Readonly<{ id: string; epoch: number; fileId: string; baseRevision: string }>; mcpRead?: McpFileGrant; dshEdit?: Readonly<{ fileId: string; editorId: string; format: string }> }
export interface SessionCredential { kind: 'session'; token: string }
export function createPrincipalTransactions({ pool, deploymentId, idleMs = 8 * 3600_000, sessionCredentials }: { pool: Pool; deploymentId: string; idleMs?: number; sessionCredentials?: { verify: (token: string) => void } }) {
  if (!Number.isSafeInteger(idleMs) || idleMs < 1 || idleMs > 2592000000) throw new Error('Invalid session idle lifetime')
  deploymentId = deploymentId.toLowerCase()
  let admitted: ReturnType<typeof assertRuntimePool> | undefined
  async function transact<T>(input: TransactionCredential, operation: (connection: PoolClient, principal: BusinessPrincipal) => Promise<T>, { signal, grantMode = 'read' }: { signal?: AbortSignal; grantMode?: 'read' | 'publish' | 'cancel' } = {}): Promise<T> {
    // Capture before the first await: callers cannot switch capabilities
    // between initial authorization and the final commit recheck.
    const credential = Object.freeze({ ...input })
    await (admitted ??= assertRuntimePool(pool, 'business'))
    if (!credential || !['session','job','external-token','dsh-edit'].includes(credential.kind) || typeof credential.token !== 'string') throw authError()
    if (credential.kind==='session' && sessionCredentials) sessionCredentials.verify(credential.token)
    else if (!/^[A-Za-z0-9_-]{43}$/.test(credential.token)) throw authError()
    if (credential.kind==='job' && (Object.keys(credential).some(key => !['kind','jobId','epoch','token'].includes(key)) || typeof credential.jobId!=='string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(credential.jobId) || !Number.isSafeInteger(credential.epoch) || credential.epoch<1)) throw authError()
    signal?.throwIfAborted()
    const connection = await pool.connect()
    let discard: Error | undefined
    try {
      await connection.query('BEGIN')
      await connection.query("SET LOCAL lock_timeout='5s'")
      await connection.query("SET LOCAL statement_timeout='10s'")
      const hash = tokenHash(credential.token)
      const lock = (final: boolean) => {
        switch (credential.kind) {
          case 'session':
            return connection.query('SELECT * FROM lock_business_session($1::uuid,$2::text,$3::bigint)', [deploymentId, hash, idleMs])
          case 'job':
            return connection.query('SELECT lock_job_principal($1::uuid,$2::uuid,$3::bigint,$4::text,$5::boolean) AS job', [deploymentId, credential.jobId, credential.epoch, hash, final])
          case 'dsh-edit':
            return connection.query('SELECT * FROM lock_dsh_edit_grant($1::uuid,$2::text,$3::bigint,NULL)', [deploymentId, hash, idleMs])
          case 'external-token':
            return connection.query('SELECT * FROM lock_mcp_file_grant($1::uuid,$2::text,$3::bigint,$4::text)', [deploymentId, hash, idleMs, grantMode])
        }
      }
      const { rows: [locked] } = await lock(false)
      if (!locked) throw authError()
      const job = locked.job
      const roles: readonly string[] = Object.freeze(credential.kind === 'session' ? locked.roles : ['personal'])
      const scopes = {
        session: roles.includes('personal') ? ['workspace:read','preferences:read','preferences:write','files:read','files:write'] : [],
        job: ['files:read', 'files:write'],
        'external-token': ['files:read'],
        'dsh-edit': ['files:read','files:write'],
      }
      const principal: BusinessPrincipal = Object.freeze({
        deploymentId,
        userId: job ? job.userId : locked.user_id,
        sessionId: job ? job.sessionId : locked.session_id,
        authVersion: job ? job.authVersion : locked.auth_version,
        roles,
        scopes: Object.freeze(scopes[credential.kind]),
        ...(job && { job: Object.freeze({ id: job.jobId, epoch: job.epoch, fileId: job.fileId, baseRevision: job.baseRevision }) }),
        ...(credential.kind === 'dsh-edit' && { dshEdit: Object.freeze({fileId:locked.file_id,editorId:locked.editor_id,format:locked.format}) }),
        ...(credential.kind === 'external-token' && { mcpRead: Object.freeze({
          id: locked.grant_id,
          fileId: locked.file_id,
          revision: locked.revision_id,
          ...(locked.committed_edit_revision && { resultRevision: locked.committed_edit_revision }),
          ...(locked.approved_edit && { approval: locked.approved_edit as McpEditApproval }),
        }) }),
      })
      await connection.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true),set_config('dyoffice.session_id',$3,true)", [deploymentId, principal.userId, principal.sessionId])
      const result = await operation(connection, principal)
      // Object I/O may outlast a session deadline. Locks prevent revocation
      // races, but clock-based expiry must also be checked before commit.
      await lock(true)
      signal?.throwIfAborted()
      await connection.query('COMMIT')
      return result
    } catch (error) {
      try { await connection.query('ROLLBACK') } catch (rollback) { discard = rollback instanceof Error ? rollback : new Error('Rollback failed') }
      if ((error as { code?: string }).code === '28000') throw authError()
      throw error
    } finally { connection.release(discard) }
  }
  return {
    get sessionIdleMs() { return idleMs },
    async withPrincipalTransaction<T>(credential: BusinessCredential, operation: (connection: PoolClient, principal: BusinessPrincipal) => Promise<T>) {
      if (credential?.kind !== 'session' && credential?.kind !== 'job') throw authError()
      return transact(credential, operation)
    },
    async withDshEditTransaction<T>(credential: DshEditCredential, operation: (connection: PoolClient, principal: BusinessPrincipal) => Promise<T>) {
      if (credential?.kind !== 'dsh-edit') throw authError()
      return transact(credential, operation)
    },
    async redeemDshEditTicket(ticket:string,replacement:string) {
      if (![ticket,replacement].every(token=>/^[A-Za-z0-9_-]{43}$/.test(token))) throw authError()
      await (admitted ??= assertRuntimePool(pool, 'business'))
      try {
        const {rows:[row]} = await pool.query('SELECT * FROM lock_dsh_edit_grant($1::uuid,$2::text,$3::bigint,$4::text)',[deploymentId,tokenHash(ticket),idleMs,tokenHash(replacement)])
        return {fileId:row.file_id as string,editorId:row.editor_id as string,format:row.format as string}
      } catch (error) {
        if ((error as {code?:string}).code==='28000') throw authError()
        throw error
      }
    },
    async withMcpReadTransaction<T>(credential: McpExternalCredential, target: McpReadScope, operation: (connection: PoolClient, principal: BusinessPrincipal) => Promise<T>) {
      if (credential?.kind !== 'external-token') throw authError()
      const { fileId, revision } = target
      return transact(credential, (connection, principal) => {
        const grant = principal.mcpRead!
        if (grant.fileId !== fileId || (grant.revision !== revision && grant.resultRevision !== revision)) throw authError(404)
        return operation(connection, principal)
      })
    },
    async withMcpEditTransaction<T>(credential: McpExternalCredential, target: McpFileGrant, operation: (connection: PoolClient, principal: BusinessPrincipal) => Promise<T>, options: { signal?: AbortSignal; publishingGrant?: boolean } = {}) {
      if (credential?.kind !== 'external-token') throw authError()
      const { id, fileId, revision } = target
      return transact(credential, (connection, principal) => {
        const grant = principal.mcpRead!
        if (grant.id !== id || grant.fileId !== fileId || grant.revision !== revision || !grant.approval || grant.approval.kind !== target.approval?.kind) throw authError(404)
        options.signal?.throwIfAborted()
        return operation(connection, Object.freeze({ ...principal, scopes: Object.freeze(['files:read', 'files:write']) }))
      }, { signal: options.signal, grantMode: options.publishingGrant ? 'publish' : 'read' })
    },
    async authenticateMcpCancellation(credential: McpExternalCredential): Promise<void> {
      if (credential?.kind !== 'external-token') throw authError()
      await transact(credential, async () => {}, { grantMode: 'cancel' })
    },
    async inspectMcpReadScope(credential: McpExternalCredential): Promise<McpFileGrant> {
      if (credential?.kind !== 'external-token') throw authError()
      return transact(credential, async (_connection, principal) => principal.mcpRead!)
    },
  }
}
export type McpPrincipalTransactions = ReturnType<typeof createPrincipalTransactions>
export type PrincipalTransactions = Pick<McpPrincipalTransactions, 'sessionIdleMs' | 'withPrincipalTransaction'> & Partial<Pick<McpPrincipalTransactions, 'withDshEditTransaction'>>
