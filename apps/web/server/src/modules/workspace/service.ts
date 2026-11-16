import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { BusinessPrincipal, PrincipalTransactions } from '../../db/context.ts'
import type { CreateWorkspaceFolder, UpdateWorkspaceFolder, WorkspaceFile, WorkspaceFileList, WorkspaceFileQuery, WorkspaceFolder, WorkspaceFolderList } from '../../../../../../packages/web-contracts/src/workspace.ts'
import { authError } from '../auth/sessions.ts'
import { loadFile, scope, uuid } from '../files/queries.ts'
import { authorize } from '../policy/authorize.ts'

type Timestamp = Date | string
type FolderRow = { id: string; name: string; parent_id: string | null; created_at: Timestamp; updated_at: Timestamp }
type FileRow = { id: string; name: string; format: WorkspaceFile['format']; size: number; updated_at: Timestamp; starred: boolean; folder_id: string | null; last_opened_at: Timestamp | null }
const iso = (value: Timestamp) => (value instanceof Date ? value : new Date(value)).toISOString()
const folderDto = (row: FolderRow): WorkspaceFolder => ({ id: row.id, name: row.name, parentId: row.parent_id, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) })
const fileDto = (row: FileRow): WorkspaceFile => ({ id: row.id, name: row.name, format: row.format, size: row.size, updatedAt: iso(row.updated_at), starred: row.starred, folderId: row.folder_id, lastOpenedAt: row.last_opened_at === null ? null : iso(row.last_opened_at) })

function record(value: unknown, allowed: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw authError(400)
  return value as Record<string, unknown>
}
function folderName(value: unknown) {
  if (typeof value !== 'string') throw authError(400)
  const name = value.trim().normalize('NFC')
  if (!name || [...name].length > 100 || Buffer.byteLength(name) > 255 || ['.','..'].includes(name) || /[\u0000-\u001f\u007f-\u009f/\\]/u.test(name)) throw authError(400)
  return name
}
async function requireFolder(connection: PoolClient, principal: BusinessPrincipal, id: string) {
  const row = (await connection.query<FolderRow>('SELECT id,name,parent_id,created_at,updated_at FROM workspace_folders WHERE deployment_id=$1 AND owner_id=$2 AND id=$3', [...scope(principal),id])).rows[0]
  if (!row) throw authError(404)
  return row
}
async function lockTree(connection: PoolClient, principal: BusinessPrincipal) {
  // Lock before checking ancestors or membership. Per-user serialization also
  // closes the opposite-move cycle and delete-versus-move races.
  await connection.query('SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1,0))', ['dyoffice:workspace:' + principal.deploymentId + ':' + principal.userId])
}

export function createWorkspaceService(transactions: PrincipalTransactions) {
  async function access<T>(token: string, action: 'workspace:read' | 'files:read' | 'files:write', operation: (connection: PoolClient, principal: BusinessPrincipal, workspaceId: string) => Promise<T>): Promise<T> {
    try {
      return await transactions.withPrincipalTransaction({ kind: 'session', token }, async (connection, principal) => {
        authorize(principal, action, { deploymentId: principal.deploymentId, ownerId: principal.userId })
        const workspace = (await connection.query('SELECT id FROM workspaces WHERE deployment_id=$1 AND owner_id=$2', scope(principal))).rows[0]
        if (!workspace) throw authError(404)
        return operation(connection, principal, workspace.id)
      })
    } catch (error) {
      if (['23505','23503'].includes((error as { code?: string }).code ?? '')) throw authError(409)
      throw error
    }
  }
  return {
    async listFiles(token: string, options: WorkspaceFileQuery = {}): Promise<WorkspaceFileList> {
      const input = record(options, ['view','folderId','limit','offset'])
      const view = input.view ?? 'all', limit = input.limit ?? 50, offset = input.offset ?? 0
      if (!['all','recent','starred','trash'].includes(view as string) || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100 || !Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > 1_000_000) throw authError(400)
      const filtered = input.folderId !== undefined, folderId = !filtered || input.folderId === 'root' ? null : uuid(input.folderId as string)
      return access(token, 'files:read', async (connection, principal) => {
        if (folderId !== null) await requireFolder(connection, principal, folderId)
        const order = view === 'recent' ? 'last_opened_at DESC,id' : 'updated_at DESC,id'
        // Count and page share one MVCC snapshot, including an empty final page.
        const result = (await connection.query<{ total: string; files: FileRow[] }>(`
          WITH matching AS MATERIALIZED (
            SELECT f.id,f.name,f.format,r.size,f.updated_at,
              COALESCE(s.starred,false) AS starred,s.folder_id,s.last_opened_at
            FROM files f
            JOIN file_revisions r ON r.deployment_id=f.deployment_id AND r.owner_id=f.owner_id AND r.file_id=f.id AND r.id=f.current_revision
            LEFT JOIN workspace_file_state s ON s.deployment_id=f.deployment_id AND s.owner_id=f.owner_id AND s.file_id=f.id
            WHERE f.deployment_id=$1 AND f.owner_id=$2
              AND (f.deleted_at IS NOT NULL)=($3::text='trash')
              AND ($3<>'recent' OR s.last_opened_at IS NOT NULL)
              AND ($3<>'starred' OR s.starred)
              AND (NOT $4::boolean OR s.folder_id IS NOT DISTINCT FROM $5::uuid)
          )
          SELECT (SELECT count(*) FROM matching) AS total,COALESCE(json_agg(page),'[]'::json) AS files
          FROM (SELECT * FROM matching ORDER BY ${order} LIMIT $6 OFFSET $7) page
        `, [...scope(principal),view,filtered,folderId,limit,offset])).rows[0]
        return { files: result.files.map(fileDto), total: Number(result.total) }
      })
    },
    listFolders: (token: string): Promise<WorkspaceFolderList> => access(token, 'workspace:read', async (connection, principal) => {
      const result = await connection.query<FolderRow>('SELECT id,name,parent_id,created_at,updated_at FROM workspace_folders WHERE deployment_id=$1 AND owner_id=$2 ORDER BY name_key,id', scope(principal))
      return { folders: result.rows.map(folderDto) }
    }),
    async createFolder(token: string, input: CreateWorkspaceFolder): Promise<WorkspaceFolder> {
      const value = record(input, ['name','parentId']), name = folderName(value.name), parentId = value.parentId === null ? null : uuid(value.parentId as string)
      return access(token, 'files:write', async (connection, principal, workspaceId) => {
        await lockTree(connection, principal)
        if (parentId !== null) await requireFolder(connection, principal, parentId)
        const result = await connection.query<FolderRow>('INSERT INTO workspace_folders(id,deployment_id,owner_id,workspace_id,name,parent_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,parent_id,created_at,updated_at', [randomUUID(),...scope(principal),workspaceId,name,parentId])
        return folderDto(result.rows[0])
      })
    },
    async updateFolder(token: string, folderId: string, patch: UpdateWorkspaceFolder): Promise<WorkspaceFolder> {
      const id = uuid(folderId), value = record(patch, ['name','parentId'])
      if (!Object.keys(value).length) throw authError(400)
      const name = Object.hasOwn(value, 'name') ? folderName(value.name) : null
      const move = Object.hasOwn(value, 'parentId'), parentId = !move || value.parentId === null ? null : uuid(value.parentId as string)
      return access(token, 'files:write', async (connection, principal) => {
        await lockTree(connection, principal)
        await requireFolder(connection, principal, id)
        if (parentId !== null) {
          await requireFolder(connection, principal, parentId)
          const cycle = await connection.query(`WITH RECURSIVE ancestors AS (
            SELECT id,parent_id FROM workspace_folders WHERE deployment_id=$1 AND owner_id=$2 AND id=$3
            UNION
            SELECT f.id,f.parent_id FROM workspace_folders f JOIN ancestors a ON f.id=a.parent_id WHERE f.deployment_id=$1 AND f.owner_id=$2
          ) SELECT 1 FROM ancestors WHERE id=$4`, [...scope(principal),parentId,id])
          if (cycle.rowCount) throw authError(409)
        }
        const result = await connection.query<FolderRow>('UPDATE workspace_folders SET name=COALESCE($4,name),parent_id=CASE WHEN $5::boolean THEN $6::uuid ELSE parent_id END,updated_at=clock_timestamp() WHERE deployment_id=$1 AND owner_id=$2 AND id=$3 RETURNING id,name,parent_id,created_at,updated_at', [...scope(principal),id,name,move,parentId])
        return folderDto(result.rows[0])
      })
    },
    deleteFolder: (token: string, folderId: string) => access(token, 'files:write', async (connection, principal) => {
      const id = uuid(folderId)
      await lockTree(connection, principal)
      await requireFolder(connection, principal, id)
      const occupied = await connection.query('SELECT 1 FROM workspace_folders WHERE deployment_id=$1 AND owner_id=$2 AND parent_id=$3 UNION ALL SELECT 1 FROM workspace_file_state WHERE deployment_id=$1 AND owner_id=$2 AND folder_id=$3 LIMIT 1', [...scope(principal),id])
      if (occupied.rowCount) throw authError(409)
      await connection.query('DELETE FROM workspace_folders WHERE deployment_id=$1 AND owner_id=$2 AND id=$3', [...scope(principal),id])
    }),
    async setStar(token: string, fileId: string, input: { starred: boolean }) {
      const id = uuid(fileId), value = record(input, ['starred'])
      if (typeof value.starred !== 'boolean') throw authError(400)
      return access(token, 'files:write', async (connection, principal, workspaceId) => {
        await loadFile(connection, principal, id)
        await connection.query('INSERT INTO workspace_file_state(deployment_id,owner_id,workspace_id,file_id,starred) VALUES($1,$2,$3,$4,$5) ON CONFLICT(deployment_id,owner_id,file_id) DO UPDATE SET starred=EXCLUDED.starred', [...scope(principal),workspaceId,id,value.starred])
      })
    },
    recordOpen: (token: string, fileId: string) => access(token, 'files:write', async (connection, principal, workspaceId) => {
      const id = uuid(fileId)
      await loadFile(connection, principal, id)
      await connection.query('INSERT INTO workspace_file_state(deployment_id,owner_id,workspace_id,file_id,last_opened_at) VALUES($1,$2,$3,$4,clock_timestamp()) ON CONFLICT(deployment_id,owner_id,file_id) DO UPDATE SET last_opened_at=clock_timestamp()', [...scope(principal),workspaceId,id])
    }),
    removeRecent: (token: string, fileId: string) => access(token, 'files:write', async (connection, principal) => {
      const id = uuid(fileId)
      await loadFile(connection, principal, id)
      await connection.query('UPDATE workspace_file_state SET last_opened_at=NULL WHERE deployment_id=$1 AND owner_id=$2 AND file_id=$3', [...scope(principal),id])
    }),
    async moveFile(token: string, fileId: string, input: { folderId: string | null }) {
      const id = uuid(fileId), value = record(input, ['folderId']), folderId = value.folderId === null ? null : uuid(value.folderId as string)
      return access(token, 'files:write', async (connection, principal, workspaceId) => {
        await lockTree(connection, principal)
        await loadFile(connection, principal, id)
        if (folderId !== null) await requireFolder(connection, principal, folderId)
        await connection.query('INSERT INTO workspace_file_state(deployment_id,owner_id,workspace_id,file_id,folder_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(deployment_id,owner_id,file_id) DO UPDATE SET folder_id=EXCLUDED.folder_id', [...scope(principal),workspaceId,id,folderId])
      })
    },
  }
}
export type WorkspaceService = ReturnType<typeof createWorkspaceService>
