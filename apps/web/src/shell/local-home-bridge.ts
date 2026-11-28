import type {HomeApi, RecentEntry, RecentQuery, MoveResult} from '../../../shell/src/shared/home-api'
import type {WorkspaceFile, WorkspaceFileList, WorkspaceFileQuery, WorkspaceFolder, WorkspaceFolderList, WorkspaceStarredGroups, WorkspaceView} from '../../../../packages/web-contracts/src/workspace.ts'
import type {createPreferencesClient, SettingsRequest} from '../../../../packages/browser-host/src/preferences.ts'
import {notifyRevealWorkspaceFolder} from '../../../shell/src/renderer/src/file-events.ts'
import {createWebHomeBridge} from './web-home-bridge.ts'

interface Dependencies {
  request: SettingsRequest
  preferences: ReturnType<typeof createPreferencesClient>
  open(id: string): Promise<void>
  browse(): Promise<void>
  openTrash(): void
  changed(): void
  renamed?(id: string, name: string): void
  unsupported(message: string): void
}
const rootPath = '/workspace'
const folderId = (path: string) => path === rootPath ? null : path.split('/').at(-1)!

/** The original Home UI keeps its contract; every personal mutation uses the scoped API. */
export function createLocalHomeBridge(deps: Dependencies): HomeApi {
  const pending = new Map<string, {promise: Promise<unknown>; intent: string}>()
  const pendingCopies = new Map<string, {uploadId:string; revision:string; language:'en'|'zh'}>()
  const unknownStars = new Map<string, boolean>()
  type Batch={key:string;intent:string;ids:string[];confirmed:Set<string>}
  const batches=new Map<string,Batch>()
  const unknownMutations=new Map<string,{action:string;id:string;batch:Batch}>()
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
  async function queryFiles(view: WorkspaceView, query: Omit<WorkspaceFileQuery,'view'|'ext'|'family'> & {ext?: string} = {}): Promise<WorkspaceFileList> {
    const params = new URLSearchParams({view, limit: String(query.limit ?? 50), offset: String(query.offset ?? 0)})
    for (const key of ['folderId','q','id','sort','group'] as const) if (query[key] !== undefined) params.set(key, query[key]!)
    if (query.ext === 'xlsx') params.set('family', 'spreadsheet')
    else if (query.ext !== undefined) params.set('ext', query.ext)
    const page = await deps.request<WorkspaceFileList>(`/api/v1/workspace/files?${params}`)
    if (!page || !Array.isArray(page.files) || !Number.isSafeInteger(page.total) || page.total < 0 || !Number.isSafeInteger(page.totalAll) || page.totalAll < page.total || page.files.length > (query.limit ?? 50)) throw new Error('无法读取个人文件列表。')
    return page
  }
  // FolderListing has no paging contract. Fail visibly above a bounded size rather than silently omit files.
  async function files(view: WorkspaceView, folder?: string): Promise<WorkspaceFile[]> {
    const result: WorkspaceFile[] = []
    for (let offset = 0; offset < 10000;) {
      const page = await queryFiles(view, {folderId: folder, limit: 100, offset})
      if (page.total > 10000) throw new Error('目录文件过多，请使用分页文件列表或搜索。')
      result.push(...page.files); offset += page.files.length
      if (offset >= page.total) return result
      if (!page.files.length) throw new Error('文件列表已变化，请刷新后重试。')
    }
    throw new Error('目录文件过多，请使用分页文件列表或搜索。')
  }
  async function folders() { return (await deps.request<WorkspaceFolderList>('/api/v1/workspace/folders')).folders }
  async function fileEntries(items: WorkspaceFile[], knownFolders?: WorkspaceFolder[]): Promise<RecentEntry[]> {
    if (!items.length) return []
    const language = (await deps.preferences.getPreferences()).language
    const rootLabel = language === 'en' ? 'My files' : '个人文件'
    const unavailable = language === 'en' ? 'Location unavailable' : '位置不可用'
    const byId = new Map((items.some(file => file.folderId !== null) ? knownFolders ?? await folders() : []).map(folder => [folder.id, folder]))
    function location(file: WorkspaceFile): string {
      if (file.folderId === null) return rootLabel
      const names: string[] = [], seen = new Set<string>()
      let id: string | null = file.folderId
      while (id !== null) {
        const folder = byId.get(id)
        if (!folder || seen.has(id)) return unavailable
        seen.add(id); names.unshift(folder.name); id = folder.parentId
      }
      return names.join(' / ') || unavailable
    }
    return items.map(file => ({path: file.id, name: file.name, ext: file.format, mtimeMs: Date.parse(file.updatedAt), sizeBytes: file.size, starred: file.starred, ...(file.group ? {group:file.group} : {}), locationLabel: location(file)}))
  }
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
    const limit = query.limit ?? 50, offset = query.offset ?? 0
    const filters = {ext:query.ext, sort:query.sort, group:view==='starred'?query.group:undefined}
    const page = await queryFiles(view, {...filters,offset, limit: Math.min(limit, 100)})
    const items = [...page.files], seen = new Set(items.map(file => file.id))
    // Home refreshes the number of rows already loaded; the API caps each request at 100.
    while (items.length < limit && offset + items.length < page.total) {
      const next = await queryFiles(view, {...filters,offset: offset + items.length, limit: Math.min(limit - items.length, 100)})
      if (next.total !== page.total || next.totalAll !== page.totalAll || !next.files.length || next.files.some(file => seen.has(file.id))) throw new Error('文件列表已变化，请刷新后重试。')
      for (const file of next.files) {seen.add(file.id); items.push(file)}
    }
    return {entries: await fileEntries(items), total: page.total, totalAll: page.totalAll}
  }
  function confirmItem(batch:Batch,id:string){
    batch.confirmed.add(id)
    for(const candidate of batches.values())if(candidate.intent===batch.intent&&candidate.ids.includes(id)){
      candidate.confirmed.add(id);if(candidate.confirmed.size===candidate.ids.length)batches.delete(candidate.key)
    }
  }
  const awaitingReview=()=>new Error('部分操作结果待核对，请再次执行原操作核对；未确认前不会重复提交或继续处理后续文件。')
  async function mutationAchieved(action:string,id:string){
    const view=action==='trash'?'trash':action==='recent'?'recent':'all'
    const result=await queryFiles(view,{id,limit:1}),file=result.files.find(file=>file.id===id)
    return action==='trash'?!!file:action==='recent'?!file:file?.starred===false
  }
  async function reconcileMutation(key:string){
    const entry=unknownMutations.get(key)
    if(!entry)return
    try{
      if(!await mutationAchieved(entry.action,entry.id))throw awaitingReview()
    }catch{throw awaitingReview()}
    unknownMutations.delete(key);confirmItem(entry.batch,entry.id);changed()
  }
  async function mutateFiles(ids: string[], action: string, method: string, body?: unknown) {
    const normalized=[...new Set(ids)].sort(),key=JSON.stringify([action,normalized,body]),intent=JSON.stringify([action,method,body])
    return once('batch:'+key,async()=>{
    const batch=batches.get(key)??{key,intent,ids:normalized,confirmed:new Set<string>()};batches.set(key,batch)
    const previouslyConfirmed=[...batch.confirmed]
    // Reconcile every uncertain resource before starting any new write, even if the selection changed.
    for(const id of normalized)if(unknownMutations.has(`${action}:${id}`)){await once(`${action}:${id}`,()=>reconcileMutation(`${action}:${id}`),intent);confirmItem(batch,id)}
    // A restore, reopen or star change may have reversed a confirmed item since the batch stopped.
    for(const id of previouslyConfirmed){
      let achieved:boolean
      try{achieved=await mutationAchieved(action,id)}catch{throw new Error('已完成项目的当前状态待核对，读取失败；请重新执行原操作核对，暂不继续提交。')}
      if(!achieved)batch.confirmed.delete(id)
    }
    for (const id of normalized) {
      if(batch.confirmed.has(id))continue
      if(action==='star'&&unknownStars.has(id)){
        if(unknownStars.get(id)!==(body as {starred:boolean}).starred)throw new Error('收藏结果尚未确认，再次点击将核对收藏，请先核对后再更改目标。')
        await toggleStar(id);confirmItem(batch,id);continue
      }
      await once(`${action}:${id}`, async () => {
        if(unknownMutations.has(`${action}:${id}`)){await reconcileMutation(`${action}:${id}`);return}
        try{await deps.request(`/api/v1/${action === 'trash' ? 'files/' + encodeURIComponent(id) : 'workspace/files/' + encodeURIComponent(id) + '/' + action}`, method, body)}
        catch(error){const status=(error as {status?:number})?.status;if(status===undefined||status===408||status>=500){unknownMutations.set(`${action}:${id}`,{action,id,batch});throw awaitingReview()}throw error}
        changed()
      },intent)
      confirmItem(batch,id)
    }
    batches.delete(key)
    })
  }
  const uncertainTrash = new Set<string>()
  async function trashFiles(selection: string[]) {
    const ids = [...new Set(selection)].sort()
    if (!ids.length) return
    if (ids.length > 10000) throw new Error('一次最多可移动 10000 个文件，请分批选择。')
    return once('trash-selection', async () => {
      const uncertain = ids.filter(id => uncertainTrash.has(id))
      let targets = ids
      if (uncertain.length) {
        // A lost response can follow a commit. Check first, including overlapping selections.
        let active: string[]
        try {
          const state = await deps.request<{active: string[]}>('/api/v1/files/trash-batch/status', 'POST', {ids: uncertain})
          if (!Array.isArray(state?.active)) throw new Error()
          active = state.active
        } catch {
          throw new Error('文件状态暂时无法核对。请稍后重试，或在废纸篓中查看。')
        }
        const remaining = new Set(active)
        targets = ids.filter(id => !uncertainTrash.has(id) || remaining.has(id))
        for (const id of uncertain) uncertainTrash.delete(id)
      }
      if (targets.length) {
        try {
          await deps.request('/api/v1/files/trash-batch', 'POST', {ids: targets})
        } catch (error) {
          const status = (error as {status?: number})?.status
          if (!status || status === 408 || status >= 500) {
            for (const id of targets) uncertainTrash.add(id)
            throw new Error('尚未确认移动结果。再次确认时会先核对废纸篓，只处理仍在文件列表中的项目。')
          }
          if (status === 429) throw new Error('请求过于频繁，本次请求未移动文件。请稍后重试。')
          if (status === 404) throw new Error('部分文件已不存在或无法访问，本次请求未移动文件。请刷新列表后重新选择。')
          throw error
        }
      }
      changed()
    }, JSON.stringify(ids))
  }
  function toggleStar(id:string):Promise<void>{return once('star:'+id,async()=>{
    if(unknownMutations.has('star:'+id)){await reconcileMutation('star:'+id);return}
    const reconciling=unknownStars.has(id)
    try{
      const file=(await queryFiles('all',{id,limit:1})).files.find(file=>file.id===id)
      if(!file)throw Object.assign(new Error('文件不存在或已移入回收站。'),{status:404})
      const target=reconciling?unknownStars.get(id)!:!file.starred
      if(reconciling&&file.starred===target){unknownStars.delete(id);changed();return}
      try{await deps.request(`/api/v1/workspace/files/${encodeURIComponent(id)}/star`,'PUT',{starred:target})}
      catch(error){const status=(error as {status?:number})?.status;if(reconciling||status===undefined||status===408||status>=500)unknownStars.set(id,target);else unknownStars.delete(id);throw error}
      unknownStars.delete(id);changed()
    }catch(error){
      if(unknownStars.has(id))throw new Error(`${error instanceof Error?error.message:'收藏操作失败。'} 收藏结果尚未确认，再次点击将核对收藏，请勿更改为相反操作。`)
      throw error
    }
  })}
  const base = createWebHomeBridge({request: path => path === '/preferences' ? deps.preferences.getPreferences() : files('all'), open: deps.open, changed, unsupported: deps.unsupported, browse: deps.browse})
  Object.assign(base, {
    revealPath: async (path: string, signal?: AbortSignal) => {
      signal?.throwIfAborted()
      const mapping = paths(await folders())
      signal?.throwIfAborted()
      let dir: string, fileId: string | undefined
      if (path === rootPath || path.startsWith(rootPath + '/')) {
        if (path !== rootPath && mapping.get(folderId(path)!) !== path) throw new Error('文件夹不存在，请刷新后重试。')
        dir = path
      } else {
        const file = (await queryFiles('all', {id: path, limit: 1})).files.find(file => file.id === path)
        signal?.throwIfAborted()
        if (!file) throw new Error('文件不存在或已移入回收站。')
        dir = file.folderId === null ? rootPath : mapping.get(file.folderId) ?? ''
        if (!dir) throw new Error('文件所在文件夹不存在，请刷新后重试。')
        fileId = file.id
      }
      if (typeof window !== 'undefined') await window.aiOfficeTabs?.activate('home')
      signal?.throwIfAborted()
      changed()
      notifyRevealWorkspaceFolder({dir, ...(fileId ? {fileId} : {})})
    },
    recents: (query?: RecentQuery) => page('recent', query),
    starred: (query?: RecentQuery) => page('starred', query),
    starredGroups: async () => {
      const result = await deps.request<WorkspaceStarredGroups>('/api/v1/workspace/starred-groups')
      if (!Array.isArray(result?.groups) || result.groups.some(name=>typeof name!=='string')) throw new Error('无法读取收藏分组。')
      return result.groups
    },
    setStarredGroup: async (paths, group) => {
      const ids = [...new Set(paths)].sort()
      if (!ids.length) return
      await once('starred-group', async () => {
        await deps.request('/api/v1/workspace/starred-groups', 'PUT', {ids,group})
        changed()
      },JSON.stringify({ids,group}))
    },
    toggleStar,
    unstarPaths: (ids: string[]) => mutateFiles(ids, 'star', 'PUT', {starred: false}),
    removeRecent: (ids: string[]) => mutateFiles(ids, 'recent', 'DELETE'),
    deleteFiles: trashFiles,
    openTrash: async () => deps.openTrash(),
    statPaths: async (ids: string[]) => {
      const result: WorkspaceFile[] = []
      for (const id of new Set(ids)) result.push(...(await queryFiles('all', {id, limit: 1})).files.filter(file => file.id === id))
      return fileEntries(result)
    },
    renameFile: (id: string, name: string) => once(JSON.stringify(['rename', id]), async () => {
      await deps.request(`/api/v1/files/${encodeURIComponent(id)}`, 'PATCH', {name}); deps.renamed?.(id, name); changed(); return {ok: true, path: id}
    },name),
    duplicateFile: id => once(JSON.stringify(['duplicate',id]), async () => {
      const endpoint = `/api/v1/files/${encodeURIComponent(id)}/duplicate`
      let copy = pendingCopies.get(id)
      if (!copy) {
        const language = (await deps.preferences.getPreferences()).language === 'en' ? 'en' : 'zh'
        const upload = await deps.request<{uploadId:string;revision:string}>(endpoint+'/uploads','POST')
        copy = {...upload,language}
        pendingCopies.set(id,copy)
      }
      const {uploadId,revision,language} = copy
      try {
        await deps.request(`${endpoint}/${encodeURIComponent(uploadId)}/finish`,'POST',{revision,language})
      } catch (error) {
        const status = (error as {status?:number})?.status
        if (typeof status !== 'number' || status === 408 || status === 429 || status >= 500) {
          throw new Error('副本尚未确认，请再次执行创建副本以核对结果。',{cause:error})
        }
        pendingCopies.delete(id)
        await deps.request(`/api/v1/uploads/${encodeURIComponent(uploadId)}`,'DELETE').catch(()=>{})
        throw error
      }
      pendingCopies.delete(id)
      changed()
    }),
    folderRoots: async () => [{path: rootPath, name: (await deps.preferences.getPreferences()).language === 'en' ? 'My files' : '个人文件', usable: true, readable: true, removable: false}],
    listFolder: async (dir: string) => {
      const all = await folders(), mapping = paths(all), id = folderId(dir)
      if (id && mapping.get(id) !== dir) return {dir, folders: [], files: [], missing: true}
      return {dir, folders: all.filter(folder => folder.parentId === id).map(folder => ({path: mapping.get(folder.id)!, name: folder.name, mtimeMs: Date.parse(folder.updatedAt), hasSubfolders: all.some(child => child.parentId === folder.id)})), files: await fileEntries(await files('all', id ?? 'root'), all)}
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
          const moved = await once(JSON.stringify(['move', path]), async () => {
            const folder = path.startsWith(rootPath + '/'), id = folder ? folderId(path)! : path
            await deps.request(`/api/v1/workspace/${folder ? 'folders/' + encodeURIComponent(id) : 'files/' + encodeURIComponent(id) + '/folder'}`, 'PATCH', folder ? {parentId: folderId(target)} : {folderId: folderId(target)})
            changed(); return {from: path, to: folder ? target + '/' + id : path}
          },target)
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
      const page = await queryFiles('all', {q: query.q, ext: query.ext, offset: query.offset, limit: query.limit})
      return {hits: (await fileEntries(page.files)).map(file => ({...file, snippet: null, needles: [query.q]})), total: page.total, index: {indexed: page.total, pending: 0, scanning: false}}
    },
  } satisfies Partial<HomeApi>)
  return base
}

