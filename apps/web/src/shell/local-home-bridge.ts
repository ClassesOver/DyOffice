import type {HomeApi, RecentEntry, RecentQuery, MoveResult} from '../../../shell/src/shared/home-api'
import type {WorkspaceFile, WorkspaceFileList, WorkspaceFolder, WorkspaceFolderList, WorkspaceView} from '../../../../packages/web-contracts/src/workspace.ts'
import type {createPreferencesClient, SettingsRequest} from '../../../../packages/browser-host/src/preferences.ts'
import {createWebHomeBridge} from './web-home-bridge.ts'

interface Dependencies {
  request: SettingsRequest
  preferences: ReturnType<typeof createPreferencesClient>
  open(id: string): Promise<void>
  browse(): Promise<void>
  openTrash(): void
  changed(): void
  unsupported(message: string): void
}
const rootPath = '/workspace'
const folderId = (path: string) => path === rootPath ? null : path.split('/').at(-1)!
const fileEntry = (file: WorkspaceFile): RecentEntry => ({path: file.id, name: file.name, ext: file.format, mtimeMs: Date.parse(file.updatedAt), sizeBytes: file.size, starred: file.starred})

/** The original Home UI keeps its contract; every personal mutation uses the scoped API. */
export function createLocalHomeBridge(deps: Dependencies): HomeApi {
  const pending = new Map<string, {promise: Promise<unknown>; intent: string}>()
  const folderListeners = new Set<(paths: string[]) => void>()
  const knownFolders = new Set([rootPath])
  function changed() { deps.changed(); for (const listener of folderListeners) listener([...knownFolders]) }
  function once<T>(key: string, action: () => Promise<T>, intent = key): Promise<T> {
    const current = pending.get(key)
    if (current) return current.intent === intent ? current.promise as Promise<T> : Promise.reject(new Error('此文件的操作正在进行中，请完成后重试。'))
    const result = Promise.resolve().then(action).finally(() => pending.delete(key))
    pending.set(key, {promise: result, intent})
    return result
  }
  async function files(view: WorkspaceView, folder?: string): Promise<WorkspaceFile[]> {
    const result: WorkspaceFile[] = []
    for (let offset = 0;;) {
      const page = await deps.request<WorkspaceFileList>(`/api/v1/workspace/files?view=${view}&limit=100&offset=${offset}${folder === undefined ? '' : '&folderId=' + encodeURIComponent(folder)}`)
      if (!page || !Array.isArray(page.files) || !Number.isSafeInteger(page.total) || page.total < 0) throw new Error('无法读取个人文件列表。')
      result.push(...page.files); offset += page.files.length
      if (offset >= page.total) return result
      if (!page.files.length) throw new Error('文件列表已变化，请刷新后重试。')
    }
  }
  async function folders() { return (await deps.request<WorkspaceFolderList>('/api/v1/workspace/folders')).folders }
  function paths(items: WorkspaceFolder[]) {
    const byId = new Map(items.map(folder => [folder.id, folder]))
    const result = new Map<string, string>()
    for (const folder of items) {
      const chain: string[] = []; const seen = new Set<string>(); let current: WorkspaceFolder | undefined = folder
      while (current) {
        if (seen.has(current.id)) throw new Error('文件夹结构无效。')
        seen.add(current.id); chain.unshift(current.id)
        if (current.parentId && !byId.has(current.parentId)) throw new Error('文件夹结构无效。')
        current = current.parentId ? byId.get(current.parentId) : undefined
      }
      const path = rootPath + '/' + chain.join('/'); result.set(folder.id, path); knownFolders.add(path)
    }
    return result
  }
  async function page(view: WorkspaceView, query: RecentQuery = {}) {
    const all = (await files(view)).map(fileEntry), filtered = all.filter(file => !query.ext || file.ext === query.ext)
    return {entries: filtered.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 50)), total: filtered.length, totalAll: all.length}
  }
  async function mutateFiles(ids: string[], action: string, method: string, body?: unknown) {
    for (const id of new Set(ids)) {
      await once(`${action}:${id}`, async () => {
        await deps.request(`/api/v1/${action === 'trash' ? 'files/' + encodeURIComponent(id) : 'workspace/files/' + encodeURIComponent(id) + '/' + action}`, method, body)
        changed()
      }, JSON.stringify([action, method, body]))
    }
  }
  const base = createWebHomeBridge({request: path => path === '/preferences' ? deps.preferences.getPreferences() : files('all'), open: deps.open, changed, unsupported: deps.unsupported, browse: deps.browse})
  Object.assign(base, {
    recents: (query?: RecentQuery) => page('recent', query),
    starred: (query?: RecentQuery) => page('starred', query),
    starredGroups: async () => [],
    toggleStar: (id: string) => once('star:' + id, async () => {
      const file = (await files('all')).find(file => file.id === id)
      if (!file) throw new Error('文件不存在或已移入回收站。')
      await deps.request(`/api/v1/workspace/files/${encodeURIComponent(id)}/star`, 'PUT', {starred: !file.starred}); changed()
    }),
    unstarPaths: (ids: string[]) => mutateFiles(ids, 'star', 'PUT', {starred: false}),
    removeRecent: (ids: string[]) => mutateFiles(ids, 'recent', 'DELETE'),
    deleteFiles: (ids: string[]) => mutateFiles(ids, 'trash', 'DELETE'),
    openTrash: async () => deps.openTrash(),
    statPaths: async (ids: string[]) => (await files('all')).filter(file => ids.includes(file.id)).map(fileEntry),
    renameFile: (id: string, name: string) => once(JSON.stringify(['rename', id, name]), async () => {
      await deps.request(`/api/v1/files/${encodeURIComponent(id)}`, 'PATCH', {name}); changed(); return {ok: true, path: id}
    }),
    folderRoots: async () => [{path: rootPath, name: (await deps.preferences.getPreferences()).language === 'en' ? 'My files' : '个人文件', usable: true, readable: true, removable: false}],
    listFolder: async (dir: string) => {
      const all = await folders(), mapping = paths(all), id = folderId(dir)
      if (id && mapping.get(id) !== dir) return {dir, folders: [], files: [], missing: true}
      return {dir, folders: all.filter(folder => folder.parentId === id).map(folder => ({path: mapping.get(folder.id)!, name: folder.name, mtimeMs: Date.parse(folder.updatedAt), hasSubfolders: all.some(child => child.parentId === folder.id)})), files: (await files('all', id ?? 'root')).map(fileEntry)}
    },
    createFolder: (parent: string, name: string) => once(JSON.stringify(['folder-create', parent, name]), async () => {
      const folder = await deps.request<WorkspaceFolder>('/api/v1/workspace/folders', 'POST', {name, parentId: folderId(parent)})
      const path = parent + '/' + folder.id; knownFolders.add(path); changed(); return {ok: true, path}
    }),
    renameFolder: (dir: string, name: string) => once(JSON.stringify(['folder-rename', dir, name]), async () => {
      await deps.request(`/api/v1/workspace/folders/${encodeURIComponent(folderId(dir) ?? '')}`, 'PATCH', {name}); changed(); return {ok: true, path: dir}
    }),
    deleteFolder: (dir: string) => once('folder-delete:' + dir, async () => {
      await deps.request(`/api/v1/workspace/folders/${encodeURIComponent(folderId(dir) ?? '')}`, 'DELETE'); changed()
    }),
    movePaths: async (items: string[], target: string): Promise<MoveResult> => {
      const result: MoveResult = {moved: [], conflicts: [], failed: []}
      for (const path of new Set(items)) {
        try {
          const moved = await once(JSON.stringify(['move', path, target]), async () => {
            const folder = path.startsWith(rootPath + '/'), id = folder ? folderId(path)! : path
            await deps.request(`/api/v1/workspace/${folder ? 'folders/' + encodeURIComponent(id) : 'files/' + encodeURIComponent(id) + '/folder'}`, 'PATCH', folder ? {parentId: folderId(target)} : {folderId: folderId(target)})
            changed(); return {from: path, to: folder ? target + '/' + id : path}
          })
          result.moved.push(moved)
        } catch (error) { result.failed.push({path, error: error instanceof Error ? error.message : '移动失败'}) }
      }
      return result
    },
    onFolderChanged: (handler: (paths: string[]) => void) => { folderListeners.add(handler); return () => { folderListeners.delete(handler) } },
    getLanguage: async () => (await deps.preferences.getPreferences()).language,
    setLanguage: async (language: 'zh' | 'en') => { await deps.preferences.updatePreferences({language}) },
    getTheme: async () => (await deps.preferences.getPreferences()).theme,
    setTheme: async (theme: 'system' | 'light' | 'dark') => { await deps.preferences.updatePreferences({theme}) },
    searchFiles: async (query: {q: string; ext?: string; offset?: number; limit?: number}) => {
      const matches = (await files('all')).filter(file => (!query.ext || file.format === query.ext) && file.name.toLocaleLowerCase().includes(query.q.toLocaleLowerCase()))
      return {hits: matches.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 50)).map(file => ({...fileEntry(file), snippet: null, needles: [query.q]})), total: matches.length, index: {indexed: matches.length, pending: 0, scanning: false}}
    },
  } satisfies Partial<HomeApi>)
  return base
}
