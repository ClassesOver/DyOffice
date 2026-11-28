import type { WorkspaceFileFormat } from './api.ts'

export type WorkspaceView = 'all' | 'recent' | 'starred' | 'trash'
export type WorkspaceFileSort = 'modified-asc' | 'modified-desc'

export interface WorkspaceFile {
  id: string
  name: string
  format: WorkspaceFileFormat
  size: number
  updatedAt: string
  starred: boolean
  group?: string
  folderId: string | null
  lastOpenedAt: string | null
}

export interface WorkspaceFileQuery {
  ext?: WorkspaceFileFormat
  q?: string
  /** Direct identity lookup; totalAll is limited to this identity, not the entire workspace. */
  id?: string
  view?: WorkspaceView
  /** Restrict the starred view to a named group. */
  group?: string
  sort?: WorkspaceFileSort
  /** Omit to include all folders; use "root" for files without a folder. */
  folderId?: string
  limit?: number
  offset?: number
}

export interface WorkspaceFileList { files: WorkspaceFile[]; total: number; totalAll: number }
export interface WorkspaceStarredGroups { groups: string[] }
export interface UpdateWorkspaceStarredGroup { ids: string[]; group: string | null }

export interface WorkspaceFolder {
  id: string
  name: string
  parentId: string | null
  createdAt: string
  updatedAt: string
}

export interface WorkspaceFolderList { folders: WorkspaceFolder[] }
export interface CreateWorkspaceFolder { name: string; parentId: string | null }
export interface UpdateWorkspaceFolder { name?: string; parentId?: string | null }

