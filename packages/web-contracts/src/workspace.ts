import type { OfficeFormat } from './api.ts'

export type WorkspaceView = 'all' | 'recent' | 'starred' | 'trash'

export interface WorkspaceFile {
  id: string
  name: string
  format: OfficeFormat
  size: number
  updatedAt: string
  starred: boolean
  folderId: string | null
  lastOpenedAt: string | null
}

export interface WorkspaceFileQuery {
  ext?: OfficeFormat
  q?: string
  /** Direct identity lookup; totalAll is limited to this identity, not the entire workspace. */
  id?: string
  view?: WorkspaceView
  /** Omit to include all folders; use "root" for files without a folder. */
  folderId?: string
  limit?: number
  offset?: number
}

export interface WorkspaceFileList { files: WorkspaceFile[]; total: number; totalAll: number }

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

