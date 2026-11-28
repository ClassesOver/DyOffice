import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { BusinessPrincipal, PrincipalTransactions } from '../../db/context.ts'
import type { CreateWorkspaceFolder, UpdateWorkspaceFolder, UpdateWorkspaceStarredGroup, WorkspaceFile, WorkspaceFileList, WorkspaceFileQuery, WorkspaceFolder, WorkspaceFolderList, WorkspaceStarredGroups } from '../../../../../../packages/web-contracts/src/workspace.ts'
import { authError } from '../auth/sessions.ts'
import { loadFile, scope, uuid } from '../files/queries.ts'
import { authorize } from '../policy/authorize.ts'

type Timestamp = Date | string
type FolderRow = { id: string; name: string; parent_id: string | null; created_at: Timestamp; updated_at: Timestamp }
type FileRow = { id: string; name: string; format: WorkspaceFile['format']; size: number; updated_at: Timestamp; starred: boolean; starred_group: string | null; folder_id: string | null; last_opened_at: Timestamp | null }
const iso = (value: Timestamp) => (value instanceof Date ? value : new Date(value)).toISOString()
const folderDto = (row: FolderRow): WorkspaceFolder => ({ id: row.id, name: row.name, parentId: row.parent_id, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) })
const fileDto = (row: FileRow, showGroup: boolean): WorkspaceFile => ({ id: row.id, name: row.name, format: row.format, size: row.size, updatedAt: iso(row.updated_at), starred: row.starred, ...(showGroup && row.starred_group ? {group: row.starred_group} : {}), folderId: row.folder_id, lastOpenedAt: row.last_opened_at === null ? null : iso(row.last_opened_at) })

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
function starredGroupName(value: unknown) {
  if (value === null) return null
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw authError(400)
  const name = value.trim()
  if ([...name].length > 100) throw authError(400)
  return name || null
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
      const input = record(options, ['view','sort','folderId','limit','offset','ext','family','q','id','group'])
      const view = input.view ?? 'all', limit = input.limit ?? 50, offset = input.offset ?? 0
      if (!['all','recent','starred','trash'].includes(view as string) || !Number.isSafeInteger(limit) || (limit as number) < 0 || (limit as number) > 100 || !Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > 1_000_000) throw authError(400)
      if (input.ext !== undefined && !['docx','xlsx','pptx','pdf','csv','xlsm'].includes(input.ext as string)) throw authError(400)
      if (input.family !== undefined && (input.family !== 'spreadsheet' || input.ext !== undefined)) throw authError(400)
      const formats = input.family === 'spreadsheet' ? ['xlsx','xlsm','csv'] : input.ext === undefined ? null : [input.ext]
      if (input.sort !== undefined && !['modified-asc','modified-desc'].includes(input.sort as string)) throw authError(400)
      if (input.q !== undefined && (typeof input.q !== 'string' || [...input.q].length > 200 || /[\u0000-\u001f\u007f]/u.test(input.q))) throw authError(400)
      const group = input.group === undefined ? null : starredGroupName(input.group)
      if (input.group !== undefined && (view !== 'starred' || group === null)) throw authError(400)
      const selectedId = input.id === undefined ? null : uuid(input.id as string)
      const filtered = input.folderId !== undefined, folderId = !filtered || input.folderId === 'root' ? null : uuid(input.folderId as string)
      return access(token, 'files:read', async (connection, principal) => {
        if (folderId !== null) await requireFolder(connection, principal, folderId)
        const order = input.sort === 'modified-asc' ? 'updated_at ASC,id' : input.sort === 'modified-desc' ? 'updated_at DESC,id' : view === 'recent' ? 'last_opened_at DESC,id' : 'updated_at DESC,id'
        // Count and page share one MVCC snapshot, including an empty final page.
        const result = (await connection.query<{ total: string; total_all: string; files: FileRow[] }>(`
          WITH scoped AS MATERIALIZED (
            SELECT f.id,f.name,f.format,r.size,f.updated_at,
              COALESCE(s.starred,false) AS starred,s.starred_group,s.folder_id,s.last_opened_at
            FROM files f
            JOIN file_revisions r ON r.deployment_id=f.deployment_id AND r.owner_id=f.owner_id AND r.file_id=f.id AND r.id=f.current_revision
            LEFT JOIN workspace_file_state s ON s.deployment_id=f.deployment_id AND s.owner_id=f.owner_id AND s.file_id=f.id
            WHERE f.deployment_id=$1 AND f.owner_id=$2 AND f.purge_started_at IS NULL
              ${selectedId === null ? 'AND $10::uuid IS NULL' : 'AND f.id=$10::uuid'}
              AND (f.deleted_at IS NOT NULL)=($3::text='trash')
              AND ($3<>'recent' OR s.last_opened_at IS NOT NULL)
              AND ($3<>'starred' OR s.starred)
              AND ($11::text IS NULL OR s.starred_group=$11)
              AND (NOT $4::boolean OR s.folder_id IS NOT DISTINCT FROM $5::uuid)
          ), matching AS MATERIALIZED (
            SELECT * FROM scoped WHERE ($8::text[] IS NULL OR format=ANY($8::text[]))
              AND ($9::text IS NULL OR strpos(lower(name),lower($9)) > 0)
          )
          SELECT (SELECT count(*) FROM scoped) AS total_all,(SELECT count(*) FROM matching) AS total,COALESCE(json_agg(page),'[]'::json) AS files
          FROM (SELECT * FROM matching ORDER BY ${order} LIMIT $6 OFFSET $7) page
        `, [...scope(principal),view,filtered,folderId,limit,offset,formats,input.q ?? null,selectedId,group])).rows[0]
        return { files: result.files.map(row=>fileDto(row,view==='starred')), total: Number(result.total), totalAll: Number(result.total_all) }
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
      // Permanent purge keeps identity tombstones, but those cannot keep a folder
      // occupied forever. The per-user tree lock serializes membership changes.
      await connection.query('UPDATE workspace_file_state s SET folder_id=NULL FROM files f WHERE s.deployment_id=$1 AND s.owner_id=$2 AND s.folder_id=$3 AND f.deployment_id=s.deployment_id AND f.owner_id=s.owner_id AND f.id=s.file_id AND f.purge_started_at IS NOT NULL', [...scope(principal),id])
      const occupied = await connection.query('SELECT 1 FROM workspace_folders WHERE deployment_id=$1 AND owner_id=$2 AND parent_id=$3 UNION ALL SELECT 1 FROM workspace_file_state WHERE deployment_id=$1 AND owner_id=$2 AND folder_id=$3 LIMIT 1', [...scope(principal),id])
      if (occupied.rowCount) throw authError(409)
      await connection.query('DELETE FROM workspace_folders WHERE deployment_id=$1 AND owner_id=$2 AND id=$3', [...scope(principal),id])
    }),
    async setStar(token: string, fileId: string, input: { starred: boolean }) {
      const id = uuid(fileId), value = record(input, ['starred'])
      if (typeof value.starred !== 'boolean') throw authError(400)
      return access(token, 'files:write', async (connection, principal, workspaceId) => {
        await loadFile(connection, principal, id)
        await connection.query('INSERT INTO workspace_file_state(deployment_id,owner_id,workspace_id,file_id,starred) VALUES($1,$2,$3,$4,$5) ON CONFLICT(deployment_id,owner_id,file_id) DO UPDATE SET starred=EXCLUDED.starred,starred_group=CASE WHEN EXCLUDED.starred THEN workspace_file_state.starred_group ELSE NULL END', [...scope(principal),workspaceId,id,value.starred])
      })
    },
    listStarredGroups: (token: string): Promise<WorkspaceStarredGroups> => access(token, 'files:read', async (connection, principal) => {
      const result = await connection.query<{starred_group: string}>(`SELECT DISTINCT s.starred_group FROM workspace_file_state s
        JOIN files f ON f.deployment_id=s.deployment_id AND f.owner_id=s.owner_id AND f.id=s.file_id
        WHERE s.deployment_id=$1 AND s.owner_id=$2 AND s.starred AND s.starred_group IS NOT NULL
          AND f.deleted_at IS NULL AND f.purge_started_at IS NULL
        ORDER BY s.starred_group`, scope(principal))
      return {groups: result.rows.map(row=>row.starred_group)}
    }),
    async setStarredGroup(token: string, input: UpdateWorkspaceStarredGroup) {
      const value = record(input, ['ids','group']), group = starredGroupName(value.group)
      if (!Array.isArray(value.ids) || value.ids.length<1 || value.ids.length>1000) throw authError(400)
      const ids = [...new Set(value.ids.map(uuid))]
      return access(token, 'files:write', async (connection, principal) => {
        const params = [...scope(principal),ids]
        // Keep trash and purge from changing membership while a group write is running.
        const files = await connection.query(`SELECT id FROM files WHERE deployment_id=$1 AND owner_id=$2
          AND id=ANY($3::uuid[]) AND deleted_at IS NULL AND purge_started_at IS NULL ORDER BY id FOR SHARE`, params)
        if (files.rowCount!==ids.length) throw authError(404)
        // Overlapping batches lock existing state rows in the same order.
        await connection.query(`SELECT file_id FROM workspace_file_state WHERE deployment_id=$1 AND owner_id=$2
          AND file_id=ANY($3::uuid[]) ORDER BY file_id FOR UPDATE`, params)
        await connection.query(`UPDATE workspace_file_state SET starred_group=$4 WHERE deployment_id=$1 AND owner_id=$2
          AND file_id=ANY($3::uuid[]) AND starred AND starred_group IS DISTINCT FROM $4::text`, [...params,group])
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

