import {afterEach, beforeEach, expect, test, vi} from 'vitest'
import {act, createElement as h} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {Home} from '../../../shell/src/renderer/src/Home'
import {LocaleProvider} from '../../../shell/src/renderer/src/locale'
import type {FolderListing, HomeApi, RecentEntry} from '../../../shell/src/shared/home-api'

const homeStyles = readFileSync(resolve(import.meta.dirname, '../../../shell/src/renderer/src/home.css'), 'utf8')
const workspaceStyles = readFileSync(resolve(import.meta.dirname, '../../src/shell/workspace-shell.css'), 'utf8')

const fileId = 'aa000000-0000-4000-8000-000000000001'
const project = '/workspace/bb000000-0000-4000-8000-000000000002'
const contracts = `${project}/cc000000-0000-4000-8000-000000000003`
const file: RecentEntry = {path: fileId, name: 'Quarterly report.docx', ext: 'docx', mtimeMs: 1, sizeBytes: 50, starred: true}
let root: Root, host: HTMLDivElement
let api: HomeApi
const listings = (): Record<string, FolderListing> => ({
  '/workspace': {dir: '/workspace', folders: [{path: project, name: 'Projects', mtimeMs: 1, hasSubfolders: true}], files: []},
  [project]: {dir: project, folders: [{path: contracts, name: 'Contracts', mtimeMs: 1, hasSubfolders: false}], files: [file]},
  [contracts]: {dir: contracts, folders: [], files: []},
})
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  HTMLElement.prototype.scrollIntoView = vi.fn()
  HTMLElement.prototype.scrollTo = vi.fn()
  localStorage.clear()
  api = {
    folderRoots: async () => [{path: '/workspace', name: 'My files', usable: true, readable: true, removable: false}],
    listFolder: async path => listings()[path] ?? {dir: path, folders: [], files: []},
    onFolderChanged: () => () => {}, onOpenSettings: () => () => {},
    recents: async () => ({entries: [file], total: 1, totalAll: 1}),
    starred: async () => ({entries: [file], total: 1, totalAll: 1}), starredGroups: async () => [],
    toggleStar: async () => {}, unstarPaths: async () => {}, removeRecent: async () => {}, deleteFiles: async () => {},
    createFolder: async (parent, name) => ({ok: true, path: parent + '/new-folder-id', name}),
    renameFolder: async path => ({ok: true, path}), renameFile: async path => ({ok: true, path}),
    deleteFolder: async () => {}, movePaths: async paths => ({moved: paths.map(path => ({from: path, to: path})), conflicts: [], failed: []}),
  } as unknown as HomeApi
  window.aiOffice = api
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(h(LocaleProvider, {initial: 'en', children: h(Home, {accountEntry: h('div', null, 'Account'), supportedNewFormats: []})})))
})
afterEach(async () => {await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals()})
const button = (label: string, scope: ParentNode = host) => {
  const result = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label)
  expect(result, label).toBeDefined(); return result!
}
async function click(node: HTMLElement) {expect(node).toBeTruthy(); await act(async () => node.click())}
async function chooseFileAction(label: string) {await click(host.querySelector<HTMLButtonElement>('.recent-item:not(.folder-item) .recent-actions .more-btn')!); await click(button(label, host.querySelector('[role="menu"]')!))}
const tree = (name: string) => [...host.querySelectorAll<HTMLElement>('.tree-row')].find(node => node.querySelector('.tree-name')?.textContent === name)!
async function folderAction(label: string) {await click(tree('Projects').querySelector<HTMLButtonElement>('.folder-more-btn')!); await click(button(label, host.querySelector('[role="menu"]')!))}
async function fill(node: HTMLInputElement, value: string) {expect(node).toBeTruthy(); await act(async () => {Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new Event('input', {bubbles: true}))})}
async function enter(node: HTMLInputElement) {await act(async () => node.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})))}
const deferred = <T,>() => {let resolve!: (value: T) => void; const promise = new Promise<T>(yes => {resolve = yes}); return {promise, resolve}}

test('file deletion shows the loaded name while retaining its opaque identity in the operation', async () => {
  const deleted: string[][] = []; api.deleteFiles = async paths => {deleted.push(paths)}
  await chooseFileAction('Delete files')
  const dialog = host.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain('Quarterly report.docx')
  expect(dialog.textContent).not.toContain(fileId)
  await click(button('Delete', dialog))
  expect(deleted).toEqual([[fileId]])
})

test('folder deletion resolves its name and retains the confirmation when the non-empty directory is rejected', async () => {
  api.deleteFolder = async () => {throw new Error('The folder is not empty')}
  await folderAction('Delete folder…')
  expect(host.querySelector('[role="dialog"]')?.textContent).toContain('Projects')
  expect(host.querySelector('[role="dialog"]')?.textContent).not.toContain('bb000000')
  await click(button('Delete', host.querySelector('[role="dialog"]')!))
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('The folder is not empty')
  expect(host.querySelector('[role="dialog"]')).not.toBeNull()
  expect(tree('Projects')).toBeTruthy()
})

test('move search displays human folder ancestry instead of opaque folder IDs', async () => {
  await chooseFileAction('Move to folder…')
  await fill(host.querySelector<HTMLInputElement>('.picker-search')!, 'Contracts')
  await act(async () => {})
  expect(host.querySelector('.picker-rel')?.textContent).toBe('Projects / Contracts')
  expect(host.querySelector('[role="dialog"]')?.textContent).not.toContain('bb000000')
})

test('move destinations can be reached, expanded and selected with the keyboard', async () => {
  const moves: string[] = []; api.movePaths = async (_paths, target) => {moves.push(target); return {moved: [], conflicts: [], failed: []}}
  await chooseFileAction('Move to folder…')
  const dialog = host.querySelector<HTMLElement>('.picker-modal')!
  const search = dialog.querySelector<HTMLInputElement>('.picker-search')!
  expect(document.activeElement).toBe(search)
  const rows = () => [...dialog.querySelectorAll<HTMLElement>('[role="treeitem"]')]
  const key = async (node: HTMLElement, value: string) => {await act(async () => node.dispatchEvent(new KeyboardEvent('keydown', {key: value, bubbles: true, cancelable: true})))}
  const rootRow = rows()[0]
  expect(rootRow.tabIndex).toBe(0)
  await act(async () => rootRow.focus())
  await key(rootRow, 'ArrowDown')
  const projects = rows().find(row => row.querySelector('.picker-name')?.textContent === 'Projects')!
  expect(document.activeElement).toBe(projects)
  expect(projects.getAttribute('aria-expanded')).toBe('false')
  await key(projects, 'ArrowRight')
  await key(projects, 'ArrowRight')
  const contractsRow = rows().find(row => row.querySelector('.picker-name')?.textContent === 'Contracts')!
  expect(document.activeElement).toBe(contractsRow)
  await key(contractsRow, ' ')
  expect(contractsRow.getAttribute('aria-selected')).toBe('true')
  await click(button('Move 1', dialog))
  expect(moves).toEqual([contracts])
})

test('move search results allow keyboard selection and a disabled current folder cannot be picked', async () => {
  await chooseFileAction('Move to folder…')
  const search = host.querySelector<HTMLInputElement>('.picker-search')!
  await fill(search, 'Contracts'); await act(async () => {})
  const match = host.querySelector<HTMLElement>('.picker-row[role="treeitem"]')!
  expect(match.tabIndex).toBe(0)
  await act(async () => {match.focus(); match.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true,cancelable:true}))})
  expect(match.getAttribute('aria-selected')).toBe('true')
  await fill(search, '')
  expect(host.querySelector('.picker-row[tabindex="0"] .picker-name')?.textContent).toBe('My files')
  await click(button('Cancel', host.querySelector('.picker-modal')!))
  await folderAction('Move to folder…')
  const current = [...host.querySelectorAll<HTMLElement>('.picker-row')].find(row => row.querySelector('.picker-name')?.textContent === 'My files')!
  expect(current.getAttribute('aria-disabled')).toBe('true')
  await act(async () => current.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true,cancelable:true})))
  expect(current.getAttribute('aria-selected')).toBe('false')
})

test('Tab stays inside the move picker instead of reaching background file actions', async () => {
  await chooseFileAction('Move to folder…')
  const dialog = host.querySelector('.picker-modal')!
  const search = dialog.querySelector<HTMLInputElement>('.picker-search')!, cancel = button('Cancel', dialog)
  await act(async () => search.dispatchEvent(new KeyboardEvent('keydown', {key:'Tab',shiftKey:true,bubbles:true,cancelable:true})))
  expect(document.activeElement).toBe(cancel)
  await act(async () => cancel.dispatchEvent(new KeyboardEvent('keydown', {key:'Tab',bubbles:true,cancelable:true})))
  expect(document.activeElement).toBe(search)
})

test('failed folder creation leaves a visible error and the draft can be corrected without an automatic retry', async () => {
  const names: string[] = []; api.createFolder = async (_parent, name) => {names.push(name); if (names.length === 1) throw new Error('Invalid folder name'); return {ok: true, path: '/workspace/new-id'}}
  await click(host.querySelector<HTMLButtonElement>('.folder-new-btn')!)
  await fill(host.querySelector<HTMLInputElement>('.folder-rename-input')!, 'bad/name')
  await enter(host.querySelector<HTMLInputElement>('.folder-rename-input')!)
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Invalid folder name')
  expect(host.querySelector<HTMLInputElement>('.folder-rename-input')?.value).toBe('bad/name')
  expect(names).toEqual(['bad/name'])
  await fill(host.querySelector<HTMLInputElement>('.folder-rename-input')!, 'Good folder')
  await enter(host.querySelector<HTMLInputElement>('.folder-rename-input')!)
  expect(names).toEqual(['bad/name', 'Good folder'])
  expect(host.querySelector('.folder-rename-input')).toBeNull()
})

test.each(['file', 'folder'])('a rejected %s rename preserves the typed name and reports its failure', async kind => {
  api.renameFile = api.renameFolder = async () => {throw new Error('That name already exists')}
  if (kind === 'file') await chooseFileAction('Rename')
  else await folderAction('Rename')
  const selector = kind === 'file' ? '.rename-input' : '.folder-rename-input'
  await fill(host.querySelector<HTMLInputElement>(selector)!, 'New name')
  await enter(host.querySelector<HTMLInputElement>(selector)!)
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('That name already exists')
  expect(host.querySelector<HTMLInputElement>(selector)?.value).toBe('New name')
})

test.each(['star', 'recent', 'unstar', 'delete'])('a rejected %s operation is handled visibly and keeps the file on screen', async action => {
  const failure = async () => {throw new Error('Workspace request failed')}
  api.toggleStar = api.removeRecent = api.unstarPaths = api.deleteFiles = failure
  if (action === 'star') await click(host.querySelector<HTMLButtonElement>('.star-btn')!)
  if (action === 'recent') await chooseFileAction('Remove from list')
  if (action === 'unstar') {await click([...host.querySelectorAll<HTMLButtonElement>('.sidebar-nav button')].find(node => node.querySelector('.nav-label')?.textContent === 'Starred')!); await chooseFileAction('Unstar')}
  if (action === 'delete') {await chooseFileAction('Delete files'); await click(button('Delete', host.querySelector('[role="dialog"]')!))}
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Workspace request failed')
  expect(host.querySelector('.recent-name')?.textContent).toBe('Quarterly report.docx')
})

test('a rejected move preserves its target picker and reports the failure', async () => {
  api.movePaths = async () => {throw new Error('Invalid move destination')}
  await chooseFileAction('Move to folder…')
  const target = [...host.querySelectorAll<HTMLElement>('.picker-row')].find(row => row.querySelector('.picker-name')?.textContent === 'Projects')!
  await click(target); await click(button('Move 1'))
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Invalid move destination')
  expect(host.querySelector('.picker-modal')).not.toBeNull()
})

test('folder creation inside the move picker handles rejection and retains its draft', async () => {
  api.createFolder = async () => {throw new Error('Invalid folder name')}
  await chooseFileAction('Move to folder…'); await click(button('New folder', host.querySelector('.picker-modal')!))
  await fill(host.querySelector<HTMLInputElement>('.picker-modal .folder-rename-input')!, 'bad/name')
  await enter(host.querySelector<HTMLInputElement>('.picker-modal .folder-rename-input')!)
  expect(host.querySelector('.picker-modal [role="alert"]')?.textContent).toContain('Invalid folder name')
  expect(host.querySelector<HTMLInputElement>('.picker-modal .folder-rename-input')?.value).toBe('bad/name')
})

test('a host can describe empty-only folder deletion without changing desktop defaults', async () => {
  await act(async () => root.render(h(LocaleProvider, {initial: 'en', children: h(Home, {accountEntry: h('div', null, 'Account'), supportedNewFormats: [], folderDeleteDescription: name => `Delete the empty folder ${name}; move its contents first.`})})))
  await folderAction('Delete folder…')
  expect(host.querySelector('[role="dialog"]')?.textContent).toContain('Delete the empty folder Projects; move its contents first.')
  expect(host.querySelector('[role="dialog"]')?.textContent).not.toContain('everything inside')
})

test('unsupported add-root is shown as an actionable error instead of an unhandled rejection', async () => {
  api.addFolderRoot = async () => {throw new Error('Adding local folders is not available here')}
  await click(host.querySelector<HTMLButtonElement>('.folder-add-root-btn')!)
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Adding local folders is not available here')
})

test('blurring an unchanged rejected draft does not automatically submit it again', async () => {
  let calls = 0
  api.createFolder = async () => {calls++; throw new Error('Invalid folder name')}
  await click(host.querySelector<HTMLButtonElement>('.folder-new-btn')!)
  await fill(host.querySelector<HTMLInputElement>('.folder-rename-input')!, 'bad/name')
  await enter(host.querySelector<HTMLInputElement>('.folder-rename-input')!)
  await act(async () => host.querySelector<HTMLInputElement>('.folder-rename-input')!.dispatchEvent(new FocusEvent('focusout', {bubbles: true})))
  expect(calls).toBe(1)
  await fill(host.querySelector<HTMLInputElement>('.folder-rename-input')!, 'edited/name')
  await act(async () => host.querySelector<HTMLInputElement>('.folder-rename-input')!.dispatchEvent(new FocusEvent('focusout', {bubbles: true})))
  expect(calls).toBe(2)
})

test('a late folder creation preserves a newer draft under another parent', async () => {
  const pending = deferred<{ok: boolean; path: string}>()
  api.createFolder = async () => pending.promise
  await click(host.querySelector<HTMLButtonElement>('.folder-new-btn')!)
  await fill(host.querySelector<HTMLInputElement>('.folder-rename-input')!, 'First')
  await enter(host.querySelector<HTMLInputElement>('.folder-rename-input')!)
  await click(tree('Projects')); await click(host.querySelector<HTMLButtonElement>('.folder-new-btn')!)
  await fill(host.querySelector<HTMLInputElement>('.folder-rename-input')!, 'Second draft')
  await act(async () => pending.resolve({ok: true, path: '/workspace/first-created'}))
  expect(host.querySelector<HTMLInputElement>('.folder-rename-input')?.value).toBe('Second draft')
})

test('a late file rename preserves the newer file rename draft', async () => {
  const second = {...file, path: 'aa000000-0000-4000-8000-000000000009', name: 'Second report.docx'}
  api.recents = async () => ({entries: [file, second], total: 2, totalAll: 2})
  await act(async () => window.dispatchEvent(new Event('focus')))
  const pending = deferred<{ok: boolean; path: string}>()
  api.renameFile = async () => pending.promise
  await chooseFileAction('Rename')
  await fill(host.querySelector<HTMLInputElement>('.rename-input')!, 'First rename')
  await enter(host.querySelector<HTMLInputElement>('.rename-input')!)
  const secondRow = [...host.querySelectorAll<HTMLElement>('.recent-item')].find(row => row.querySelector('.recent-name')?.textContent === 'Second report.docx')!
  await click(secondRow.querySelector<HTMLButtonElement>('.more-btn')!); await click(button('Rename', host.querySelector('[role="menu"]')!))
  await fill(host.querySelector<HTMLInputElement>('.rename-input')!, 'Second rename draft')
  await act(async () => pending.resolve({ok: true, path: fileId}))
  expect(host.querySelector<HTMLInputElement>('.rename-input')?.value).toBe('Second rename draft')
})

test('a late folder rename preserves a newer folder rename draft', async () => {
  await click(tree('Projects'))
  const pending = deferred<{ok: boolean; path: string}>()
  api.renameFolder = async () => pending.promise
  await folderAction('Rename')
  await fill(host.querySelector<HTMLInputElement>('.folder-rename-input')!, 'First rename')
  await enter(host.querySelector<HTMLInputElement>('.folder-rename-input')!)
  await click(host.querySelector<HTMLButtonElement>('.folder-item .more-btn')!)
  await click(button('Rename', host.querySelector('[role="menu"]')!))
  await fill(host.querySelector<HTMLInputElement>('.folder-item .rename-input')!, 'Second folder draft')
  await act(async () => pending.resolve({ok: true, path: project}))
  expect(host.querySelector<HTMLInputElement>('.folder-item .rename-input')?.value).toBe('Second folder draft')
})

test('a late picker creation preserves the destination selected while it was pending', async () => {
  const pending = deferred<{ok: boolean; path: string}>()
  api.createFolder = async () => pending.promise
  await chooseFileAction('Move to folder…'); await click(button('New folder', host.querySelector('.picker-modal')!))
  await fill(host.querySelector<HTMLInputElement>('.picker-modal .folder-rename-input')!, 'First')
  await enter(host.querySelector<HTMLInputElement>('.picker-modal .folder-rename-input')!)
  await click([...host.querySelectorAll<HTMLElement>('.picker-row')].find(row => row.querySelector('.picker-name')?.textContent === 'Projects')!)
  await act(async () => pending.resolve({ok: true, path: '/workspace/first-created'}))
  expect([...host.querySelectorAll<HTMLElement>('.picker-row')].find(row => row.getAttribute('aria-selected') === 'true')?.textContent).toBe('Projects')
})

test.each(['rename', 'delete'])('a late folder %s does not navigate back after the user returns to Recent', async action => {
  await click(tree('Projects'))
  const pending = deferred<{ok: boolean; path: string}>()
  if (action === 'rename') {
    api.renameFolder = async () => pending.promise
    await folderAction('Rename'); await fill(host.querySelector<HTMLInputElement>('.folder-rename-input')!, 'Renamed')
    await enter(host.querySelector<HTMLInputElement>('.folder-rename-input')!)
  } else {
    api.deleteFolder = async () => {await pending.promise}
    await folderAction('Delete folder…'); await click(button('Delete', host.querySelector('[role="dialog"]')!))
    await click(button('Cancel', host.querySelector('[role="dialog"]')!))
  }
  await click([...host.querySelectorAll<HTMLButtonElement>('.sidebar-nav button')].find(node => node.querySelector('.nav-label')?.textContent === 'Recent')!)
  await act(async () => pending.resolve({ok: true, path: project}))
  expect(host.querySelector('.tree-row.active')).toBeNull()
  expect(host.querySelector('.sidebar-nav [aria-current="page"] .nav-label')?.textContent).toBe('Recent')
})

test('a late folder move does not navigate back after the user returns to Recent', async () => {
  api.folderRoots = async () => [
    {path: '/workspace', name: 'My files', usable: true, readable: true, removable: false},
    {path: '/archive', name: 'Archive', usable: true, readable: true, removable: true},
  ]
  await act(async () => window.dispatchEvent(new Event('focus')))
  await click(tree('Projects'))
  const pending = deferred<void>()
  api.movePaths = async () => {await pending.promise; return {moved: [{from: project, to: '/archive/projects'}], conflicts: [], failed: []}}
  await folderAction('Move to folder…')
  await click([...host.querySelectorAll<HTMLElement>('.picker-row')].find(row => row.querySelector('.picker-name')?.textContent === 'Archive')!)
  await click(button('Move 1')); await click(button('Cancel', host.querySelector('.picker-modal')!))
  await click([...host.querySelectorAll<HTMLButtonElement>('.sidebar-nav button')].find(node => node.querySelector('.nav-label')?.textContent === 'Recent')!)
  await act(async () => pending.resolve())
  expect(host.querySelector('.sidebar-nav [aria-current="page"] .nav-label')?.textContent).toBe('Recent')
})

test('a late root removal preserves the folder selected in another root', async () => {
  let removed = false
  api.folderRoots = async () => [
    {path: '/workspace', name: 'My files', usable: true, readable: true, removable: false},
    ...removed ? [] : [{path: '/archive', name: 'Archive', usable: true, readable: true, removable: true}],
  ]
  await act(async () => window.dispatchEvent(new Event('focus')))
  await click(tree('Archive'))
  const pending = deferred<void>()
  api.removeFolderRoot = async () => {await pending.promise; removed = true}
  await click(tree('Archive').querySelector<HTMLButtonElement>('.folder-more-btn')!)
  await click(button('Remove from list', host.querySelector('[role="menu"]')!))
  await click(tree('Projects'))
  await act(async () => pending.resolve())
  expect(host.querySelector('.tree-row.active .tree-name')?.textContent).toBe('Projects')
})

test('a late delete preserves a newer confirmation and selection, then deletes the new confirmed target', async () => {
  const second = {...file, path: 'aa000000-0000-4000-8000-000000000009', name: 'Second report.docx'}
  api.recents = async () => ({entries: [file, second], total: 2, totalAll: 2})
  await act(async () => window.dispatchEvent(new Event('focus')))
  const checkbox = (name: string) => host.querySelector<HTMLInputElement>(`input[aria-label="Select ${name}"]`)!
  const pending = deferred<void>(), deleted: string[][] = []
  api.deleteFiles = async paths => {deleted.push(paths); if (deleted.length === 1) await pending.promise}
  await click(checkbox(file.name)); await click(button('Delete files', host.querySelector('.selection-bar')!))
  await click(button('Delete', host.querySelector('[role="dialog"]')!)); await click(button('Cancel', host.querySelector('[role="dialog"]')!))
  await click(checkbox(file.name)); await click(checkbox(second.name))
  await click(button('Delete files', host.querySelector('.selection-bar')!))
  expect(host.querySelector('[role="dialog"]')?.textContent).toContain(second.name)
  await act(async () => pending.resolve())
  expect(host.querySelector('[role="dialog"]')?.textContent).toContain(second.name)
  expect(checkbox(second.name).checked).toBe(true)
  await click(button('Delete', host.querySelector('[role="dialog"]')!))
  expect(deleted).toEqual([[fileId], [second.path]])
  expect(host.querySelector('[role="dialog"]')).toBeNull()
  expect(checkbox(second.name).checked).toBe(false)
})

test('a late move preserves a newer picker and selection, then moves the new selected target', async () => {
  const second = {...file, path: 'aa000000-0000-4000-8000-000000000009', name: 'Second report.docx'}
  api.recents = async () => ({entries: [file, second], total: 2, totalAll: 2})
  await act(async () => window.dispatchEvent(new Event('focus')))
  const checkbox = (name: string) => host.querySelector<HTMLInputElement>(`input[aria-label="Select ${name}"]`)!
  const destination = (name: string) => [...host.querySelectorAll<HTMLElement>('.picker-row')].find(row => row.querySelector('.picker-name')?.textContent === name)!
  const pending = deferred<void>(), moves: Array<{paths: string[]; target: string}> = []
  api.movePaths = async (paths, target) => {moves.push({paths, target}); if (moves.length === 1) await pending.promise; return {moved: paths.map(path => ({from: path, to: path})), conflicts: [], failed: []}}
  await click(checkbox(file.name)); await click(button('Move to folder…', host.querySelector('.selection-bar')!))
  await click(destination('Projects')); await click(button('Move 1'))
  await click(button('Cancel', host.querySelector('.picker-modal')!))
  await click(checkbox(file.name)); await click(checkbox(second.name))
  await click(button('Move to folder…', host.querySelector('.selection-bar')!)); await click(destination('My files'))
  await act(async () => pending.resolve())
  expect(host.querySelector('.picker-modal')).not.toBeNull()
  expect(destination('My files').getAttribute('aria-selected')).toBe('true')
  expect(checkbox(second.name).checked).toBe(true)
  await click(button('Move 1'))
  expect(moves).toEqual([{paths: [fileId], target: project}, {paths: [second.path], target: '/workspace'}])
  expect(host.querySelector('.picker-modal')).toBeNull()
  expect(checkbox(second.name).checked).toBe(false)
})


test('SaaS home removes the standalone Ask entry without removing workspace navigation', async () => {
  const labels = [...host.querySelectorAll('.sidebar-nav .nav-label')].map(node => node.textContent)
  expect(labels).not.toContain('Ask AI')
  expect(host.querySelector('.kb-ask')).toBeNull()
  expect(labels).toContain('Recent')
  await click([...host.querySelectorAll<HTMLButtonElement>('.sidebar-nav button')].find(node => node.querySelector('.nav-label')?.textContent === 'Starred')!)
  expect(host.querySelector('[aria-current="page"]')?.textContent).toContain('Starred')
  await click([...host.querySelectorAll<HTMLButtonElement>('.sidebar-nav button')].find(node => node.querySelector('.nav-label')?.textContent === 'Recent')!)
  expect(host.querySelector('[aria-current="page"]')?.textContent).toContain('Recent')
})

test('workspace reveal clears a search, opens nested ancestors and selects the located file',async()=>{
 const {notifyRevealWorkspaceFolder}=await import('../../../shell/src/renderer/src/file-events')
 const search=host.querySelector<HTMLInputElement>('input[type="search"]')!
 await fill(search,'no match')
 await act(async()=>notifyRevealWorkspaceFolder({dir:project,fileId}))
 await vi.waitFor(()=>expect(host.querySelector('.recent-item:not(.folder-item) .recent-name')?.textContent).toBe(file.name))
 expect(search.value).toBe('')
 expect(tree('Projects')?.getAttribute('aria-selected')).toBe('true')
 expect(host.querySelector<HTMLInputElement>('.recent-item:not(.folder-item) input[type=checkbox]')?.checked).toBe(true)
 expect(tree('Contracts')).toBeTruthy()
})

test('Web capabilities hide OS folder actions and preserve workspace folder creation', async () => {
  const added = vi.fn(), dropped = vi.fn()
  api.addFolderRoot = added; api.dropFolderRoots = dropped
  await act(async () => root.render(h(LocaleProvider, {initial: 'en', children: h(Home, {accountEntry: h('div', null, 'Account'), supportedNewFormats: [], capabilities: {localFolders: false}})})))
  expect(host.querySelector('.folder-add-root-btn')).toBeNull()
  const drop = new Event('drop', {bubbles: true, cancelable: true})
  Object.defineProperty(drop, 'dataTransfer', {value: {types: ['Files'], files: [new File([''], 'folder')]}})
  await act(async () => host.querySelector('.folder-panel')!.dispatchEvent(drop))
  expect(added).not.toHaveBeenCalled(); expect(dropped).not.toHaveBeenCalled()
  await click(host.querySelector<HTMLButtonElement>('.folder-new-btn')!)
  expect(host.querySelector('.folder-rename-input')).not.toBeNull()
})

test('Web capabilities remove unsupported file actions while retaining supported actions', async () => {
  const groups = vi.fn(async () => ['Team'])
  api.starredGroups = groups
  await act(async () => root.render(h(LocaleProvider, {initial: 'en', children: h(Home, {accountEntry: h('div', null, 'Account'), supportedNewFormats: [], capabilities: {copyPath: false, duplicateFile: false, starredGroups: false}})})))
  await act(async () => window.dispatchEvent(new Event('focus')))
  await click(host.querySelector<HTMLButtonElement>('.recent-item .more-btn')!)
  const menu = host.querySelector('[role="menu"]')!
  expect(menu.textContent).not.toContain('Copy path')
  expect(menu.textContent).not.toContain('Duplicate')
  expect(menu.textContent).not.toContain('Move to group')
  expect(menu.textContent).toContain('Rename')
  expect(menu.textContent).toContain('Move to folder')
  expect(groups).not.toHaveBeenCalled()
})

test('Web hides unavailable semantic ranking and never calls its bridge', async()=>{
 const rerank=vi.fn(async()=>null);api.rerankSearch=rerank
 api.searchFiles=async()=>({hits:[file,{...file,path:'second-id',name:'Second report.docx'}].map(entry=>({...entry,snippet:null,needles:['report']})),total:2,index:{indexed:2,pending:0,scanning:false}})
 await act(async()=>root.render(h(LocaleProvider,{initial:'en',children:h(Home,{accountEntry:h('div',null,'Account'),supportedNewFormats:[],capabilities:{semanticRanking:false}})})))
 expect(host.querySelector('.file-search-settings')).toBeNull()
 const input=host.querySelector<HTMLInputElement>('input[type="search"]')!
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'report');input.dispatchEvent(new Event('input',{bubbles:true}))})
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,350))})
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,650))})
 expect(rerank).not.toHaveBeenCalled();expect(host.querySelector('.search-rerank-badge')).toBeNull()
})

test('recent and search rows display host locations for opaque identities before folders are opened', async () => {
  const located = {...file, locationLabel: 'Parent / Child'}
  api.recents = async () => ({entries: [located], total: 1, totalAll: 1})
  api.searchFiles = async () => ({hits: [{...located, snippet: null, needles: ['report']}], total: 1, index: {indexed: 1, pending: 0, scanning: false}})
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(host.querySelector('.recent-path')?.textContent).toBe('Parent / Child')
  expect(host.querySelector('.recent-path')?.getAttribute('title')).toBe('Parent / Child')
  await fill(host.querySelector<HTMLInputElement>('.file-search input')!, 'report')
  await act(async () => new Promise(resolve => setTimeout(resolve, 200)))
  expect(host.querySelector('.search-path')?.textContent).toBe('Parent / Child')
  expect(host.querySelector('.search-path')?.getAttribute('title')).toBe('Parent / Child')
  expect(host.querySelector('.search-path')?.textContent).not.toContain(fileId)
})

test('Web file and folder menus render outside the scrolling list and retain real actions', async () => {
  const renamed: string[] = []
  api.renameFile = async (_path, name) => {renamed.push(name); return {ok: true, path: fileId}}
  await act(async () => root.render(h(LocaleProvider, {initial: 'en', children: h(Home, {accountEntry: h('div', null, 'Account'), supportedNewFormats: [], supportedFormats: ['docx']})})))
  await click(host.querySelector<HTMLButtonElement>('.recent-item .more-btn')!)
  const menu = document.body.querySelector<HTMLElement>('.row-menu')!
  expect(menu).not.toBeNull(); expect(host.contains(menu)).toBe(false)
  expect(menu.style.position).toBe('fixed')
  const rename = button('Rename', menu)
  await act(async () => rename.dispatchEvent(new MouseEvent('pointerdown', {bubbles: true})))
  expect(document.body.querySelector('.row-menu')).not.toBeNull()
  await click(rename)
  await fill(host.querySelector<HTMLInputElement>('.rename-input')!, 'Renamed')
  await enter(host.querySelector<HTMLInputElement>('.rename-input')!)
  expect(renamed).toEqual(['Renamed.docx'])
  await click(tree('Projects').querySelector<HTMLButtonElement>('.folder-more-btn')!)
  const folderMenu = document.body.querySelector('.folder-menu')!
  expect(host.contains(folderMenu)).toBe(false)
  await click(button('Rename', folderMenu))
  expect(host.querySelector('.folder-rename-input')).not.toBeNull()
})

test('the next-page sentinel stays inside the recent list within the page scrollport', async () => {
  vi.stubGlobal('IntersectionObserver', class {observe() {} disconnect() {}})
  api.recents = async () => ({entries: [file], total: 100, totalAll: 100})
  await act(async () => window.dispatchEvent(new Event('focus')))
  const sentinel = host.querySelector('.recent-list > .load-more')
  expect(sentinel?.tagName).toBe('LI')
})

test.each(['Enter', ' '])('Web row menu supports %s opening, arrow navigation, Escape and normal Tab dismissal', async key => {
  await act(async () => root.render(h(LocaleProvider, {initial: 'en', children: h(Home, {accountEntry: h('div', null, 'Account'), supportedNewFormats: [], supportedFormats: ['docx']})})))
  const trigger = host.querySelector<HTMLButtonElement>('.recent-item .more-btn')!
  trigger.focus()
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles: true, cancelable: true})))
  const menu = document.body.querySelector<HTMLElement>('.row-menu')!
  expect(menu).not.toBeNull()
  const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
  expect(document.activeElement).toBe(items[0])
  await act(async () => items[0].dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true, cancelable: true})))
  expect(document.activeElement).toBe(items[1])
  await act(async () => items[1].dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowUp', bubbles: true, cancelable: true})))
  expect(document.activeElement).toBe(items[0])
  await act(async () => items[0].dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true})))
  expect(document.body.querySelector('.row-menu')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles: true, cancelable: true})))
  const first = document.body.querySelector<HTMLElement>('.row-menu [role="menuitem"]')!
  const tab = new KeyboardEvent('keydown', {key: 'Tab', bubbles: true, cancelable: true})
  await act(async () => first.dispatchEvent(tab))
  expect(document.body.querySelector('.row-menu')).toBeNull()
  expect(tab.defaultPrevented).toBe(false)
})

test('desktop row menu keeps its existing native button keyboard handling', async () => {
  const trigger = host.querySelector<HTMLButtonElement>('.recent-item .more-btn')!
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true})))
  expect(host.querySelector('.row-menu')).toBeNull()
  await click(trigger)
  expect(host.querySelector('.row-menu')).not.toBeNull()
})

test('Web row menu ignores delayed pre-opening scroll events but closes when its list moves', async () => {
  await act(async () => root.render(h(LocaleProvider, {initial: 'en', children: h(Home, {accountEntry: h('div', null, 'Account'), supportedNewFormats: [], supportedFormats: ['docx']})})))
  const list = host.querySelector<HTMLElement>('.recent-list')!
  list.scrollLeft = 99; list.scrollTop = 452
  await click(host.querySelector<HTMLButtonElement>('.recent-item .more-btn')!)
  await act(async () => list.dispatchEvent(new Event('scroll')))
  expect(document.body.querySelector('.row-menu')).not.toBeNull()
  list.scrollLeft = 100
  await act(async () => list.dispatchEvent(new Event('scroll')))
  expect(document.body.querySelector('.row-menu')).toBeNull()
})


test('Web home inherits the original page scrollport, spacing and wrapping card grid', async () => {
 await act(async () => root.render(h(LocaleProvider, {initial: 'en', children: h(Home, {accountEntry: h('div', null, 'Account'), supportedNewFormats: [], supportedFormats: ['docx', 'xlsx', 'pptx', 'pdf']})})))
 const style = document.createElement('style')
 style.textContent = homeStyles + '\n' + workspaceStyles
 document.head.append(style)
 try {
  const content = getComputedStyle(host.querySelector('.content')!)
  expect(content.overflowY).toBe('auto')
  expect(content.overflow).not.toBe('hidden')
  expect(content.padding).toBe('28px 36px 40px')
  expect(getComputedStyle(host.querySelector('.home-hero')!).margin).toBe('28px 0px 20px')
  expect(getComputedStyle(host.querySelector('.hero-title')!).fontSize).toBe('28px')
  const cards = getComputedStyle(host.querySelector('.quick-cards')!)
  expect(cards.display).toBe('grid')
  expect(cards.gridTemplateColumns).toBe('repeat(auto-fill, minmax(148px, 1fr))')
  // CSSOM covers nested viewport rules too; jsdom does not perform responsive layout.
  // The original stylesheet alone owns home geometry at narrow/short viewports.
  const selectors = (rules: CSSRuleList): string[] => [...rules].flatMap(rule => {
   if ('selectorText' in rule) return [(rule as CSSStyleRule).selectorText]
   if ('cssRules' in rule) return selectors((rule as CSSGroupingRule).cssRules)
   return []
  })
  expect(selectors(style.sheet!.cssRules).filter(selector => selector.includes('.home-web'))).toEqual([])
 } finally {style.remove()}
})

test('Web quick cards keep original extension captions and unavailable-creation explanations', async () => {
 await act(async () => root.render(h(LocaleProvider, {initial: 'en', children: h(Home, {accountEntry: h('div', null, 'Account'), supportedNewFormats: [], supportedFormats: ['docx', 'xlsx', 'pptx', 'pdf']})})))
 const cards = [...host.querySelectorAll<HTMLButtonElement>('.quick-card')].filter(card => card.disabled)
 expect(cards.map(card => card.querySelector('.quick-sub')?.textContent)).toEqual(['.docx', '.xlsx', '.pptx', '.pdf'])
 expect(cards.every(card => card.title.includes('暂不支持新建'))).toBe(true)
 expect(host.querySelectorAll('.quick-card')).toHaveLength(5)
 expect((host.querySelectorAll<HTMLButtonElement>('.quick-card')[4]).disabled).toBe(false)
})

test('page-scroll sentinel loads the next real page once and stops after exhaustion', async () => {
 let intersect: IntersectionObserverCallback = () => {}
 const observe = vi.fn(), disconnect = vi.fn(), options: (IntersectionObserverInit | undefined)[] = []
 vi.stubGlobal('IntersectionObserver', class {
  constructor(callback: IntersectionObserverCallback, init?: IntersectionObserverInit) {intersect = callback; options.push(init)}
  observe = observe
  disconnect = disconnect
 })
 const next = {...file, path: 'aa000000-0000-4000-8000-000000000002', name: 'Next report.docx'}
 const recents = vi.fn(async (request?: {offset?: number}) => ({entries: request?.offset ? [next] : [file], total: 2, totalAll: 2}))
 api.recents = recents
 await act(async () => window.dispatchEvent(new Event('focus')))
 const sentinel = host.querySelector('.recent-list > .load-more')!
 expect(host.querySelector('.content')?.contains(sentinel)).toBe(true)
 expect(observe).toHaveBeenCalledWith(sentinel)
 expect(options.at(-1)).toEqual({rootMargin: '240px'})
 await act(async () => intersect([{isIntersecting: true} as IntersectionObserverEntry], {} as IntersectionObserver))
 expect(recents.mock.calls.map(([request]) => request?.offset ?? 0)).toEqual([0, 1])
 expect([...host.querySelectorAll('.recent-name')].map(node => node.textContent)).toEqual(['Quarterly report.docx', 'Next report.docx'])
 expect(host.querySelector('.recent-list > .load-more')).toBeNull()
 await act(async () => intersect([{isIntersecting: true} as IntersectionObserverEntry], {} as IntersectionObserver))
 expect(recents).toHaveBeenCalledTimes(2)
 expect(disconnect).toHaveBeenCalled()
})

function pagingObserver(){let notify:IntersectionObserverCallback=()=>{};vi.stubGlobal('IntersectionObserver',class{constructor(callback:IntersectionObserverCallback){notify=callback}observe(){}disconnect(){}});return()=>notify([{isIntersecting:true} as IntersectionObserverEntry],{} as IntersectionObserver)}
test('same-tick sentinel callbacks share one pending page and never append duplicate rows',async()=>{
 const intersect=pagingObserver(),next={...file,path:'next-file',name:'Next.docx'},pending=deferred<{entries:RecentEntry[];total:number;totalAll:number}>()
 const recents=vi.fn(async(query?:{offset?:number})=>query?.offset?pending.promise:{entries:[file],total:2,totalAll:2});api.recents=recents
 await act(async()=>window.dispatchEvent(new Event('focus')))
 await act(async()=>{intersect();intersect()})
 expect(recents.mock.calls.filter(([query])=>query?.offset)).toHaveLength(1)
 await act(async()=>pending.resolve({entries:[next],total:2,totalAll:2}))
 expect([...host.querySelectorAll('.recent-name')].map(node=>node.textContent)).toEqual([file.name,next.name])
})
test('late paging from an old view cannot clear the new view paging lock',async()=>{
 const intersect=pagingObserver(),old=deferred<{entries:RecentEntry[];total:number;totalAll:number}>(),current=deferred<{entries:RecentEntry[];total:number;totalAll:number}>()
 api.recents=async query=>query?.offset?old.promise:{entries:[file],total:2,totalAll:2}
 const star={...file,path:'star-first',name:'Star first.docx'},next={...file,path:'star-next',name:'Star next.docx'}
 const starred=vi.fn(async(query?:{offset?:number;limit?:number})=>query?.limit===0?{entries:[],total:2,totalAll:2}:query?.offset?current.promise:{entries:[star],total:2,totalAll:2});api.starred=starred
 await act(async()=>window.dispatchEvent(new Event('focus')));await act(async()=>intersect())
 await click([...host.querySelectorAll<HTMLButtonElement>('.sidebar-nav button')].find(node=>node.querySelector('.nav-label')?.textContent==='Starred')!)
 await act(async()=>intersect());expect(starred.mock.calls.filter(([query])=>query?.offset)).toHaveLength(1)
 await act(async()=>old.resolve({entries:[{...file,path:'old-next',name:'Old next.docx'}],total:2,totalAll:2}))
 await act(async()=>intersect());expect(starred.mock.calls.filter(([query])=>query?.offset)).toHaveLength(1)
 await act(async()=>current.resolve({entries:[next],total:2,totalAll:2}))
 expect([...host.querySelectorAll('.recent-name')].map(node=>node.textContent)).toEqual([star.name,next.name])
})
test.each(['total','overlap','empty'])('paging %s changes reload the first page instead of appending a shifted page',async mode=>{
 const intersect=pagingObserver(),fresh={...file,path:'fresh-file',name:'Fresh.docx'};let initial=true
 const recents=vi.fn(async(query?:{offset?:number})=>{if(query?.offset)return {entries:mode==='empty'?[]:mode==='overlap'?[file]:[fresh],total:mode==='total'?3:2,totalAll:mode==='total'?3:2};const entries=initial?[file]:[fresh];initial=false;return {entries,total:2,totalAll:2}});api.recents=recents
 await act(async()=>window.dispatchEvent(new Event('focus')));await act(async()=>intersect())
 expect(recents.mock.calls.map(([query])=>query?.offset??0)).toEqual([0,1,0])
 expect([...host.querySelectorAll('.recent-name')].map(node=>node.textContent)).toEqual([fresh.name])
})
test('a pending first page prevents fetching the previous view offset',async()=>{
 const intersect=pagingObserver(),pending=deferred<{entries:RecentEntry[];total:number;totalAll:number}>()
 api.recents=async()=>({entries:[file],total:2,totalAll:2})
 await act(async()=>window.dispatchEvent(new Event('focus')))
 const starred=vi.fn(async(query?:{offset?:number;limit?:number})=>query?.limit===0?{entries:[],total:2,totalAll:2}:pending.promise);api.starred=starred
 await click([...host.querySelectorAll<HTMLButtonElement>('.sidebar-nav button')].find(node=>node.querySelector('.nav-label')?.textContent==='Starred')!)
 expect(host.querySelector('.recent-item')).toBeNull()
 expect(host.querySelector('[role="status"][aria-busy="true"]')).not.toBeNull()
 await act(async()=>intersect());expect(starred.mock.calls.filter(([query])=>query?.offset)).toHaveLength(0)
 await act(async()=>pending.resolve({entries:[{...file,path:'new-view',name:'New view.docx'}],total:2,totalAll:2}))
})
test('a new view with unchanged row count rearms its visible sentinel after the first page settles',async()=>{
 const callbacks:IntersectionObserverCallback[]=[]
 vi.stubGlobal('IntersectionObserver',class{constructor(callback:IntersectionObserverCallback){callbacks.push(callback)}observe(){}disconnect(){}})
 api.recents=async()=>({entries:[file],total:2,totalAll:2})
 await act(async()=>window.dispatchEvent(new Event('focus')))
 const pending=deferred<{entries:RecentEntry[];total:number;totalAll:number}>(),next={...file,path:'next-star',name:'Next star.docx'}
 const starred=vi.fn(async(query?:{offset?:number;limit?:number})=>query?.limit===0?{entries:[],total:2,totalAll:2}:query?.offset?{entries:[next],total:2,totalAll:2}:pending.promise);api.starred=starred
 const count=callbacks.length
 await click([...host.querySelectorAll<HTMLButtonElement>('.sidebar-nav button')].find(node=>node.querySelector('.nav-label')?.textContent==='Starred')!)
 await act(async()=>callbacks.at(-1)!([{isIntersecting:true} as IntersectionObserverEntry],{} as IntersectionObserver))
 await act(async()=>pending.resolve({entries:[{...file,path:'first-star',name:'First star.docx'}],total:2,totalAll:2}))
 expect(callbacks.length).toBeGreaterThan(count)
 await act(async()=>callbacks.at(-1)!([{isIntersecting:true} as IntersectionObserverEntry],{} as IntersectionObserver))
 expect(starred.mock.calls.filter(([query])=>query?.offset)).toHaveLength(1)
})
test('a failed new-view first page blocks old-offset paging until a successful focus refresh',async()=>{
 const intersect=pagingObserver();api.recents=async()=>({entries:[file],total:2,totalAll:2})
 await act(async()=>window.dispatchEvent(new Event('focus')))
 let fail=true
 const first={...file,path:'star-first',name:'Star first.docx'},next={...file,path:'star-next',name:'Star next.docx'}
 const starred=vi.fn(async(query?:{offset?:number;limit?:number})=>{
  if(query?.limit===0)return {entries:[],total:2,totalAll:2}
  if(query?.offset)return {entries:[next],total:2,totalAll:2}
  if(fail)throw Error('Starred first page unavailable')
  return {entries:[first],total:2,totalAll:2}
 });api.starred=starred
 await click([...host.querySelectorAll<HTMLButtonElement>('.sidebar-nav button')].find(node=>node.querySelector('.nav-label')?.textContent==='Starred')!)
 expect(host.querySelector('[role="alert"]')?.textContent).toContain('Starred first page unavailable')
 await act(async()=>intersect());expect(starred.mock.calls.filter(([query])=>query?.offset)).toHaveLength(0)
 expect(host.querySelector('.recent-item')).toBeNull()
 expect(button('Retry')).toBeTruthy()
 fail=false;await act(async()=>window.dispatchEvent(new Event('focus')));await act(async()=>intersect())
 expect(starred.mock.calls.filter(([query])=>query?.offset)).toHaveLength(1)
 expect([...host.querySelectorAll('.recent-name')].map(node=>node.textContent)).toEqual([first.name,next.name])
})

test('Web file-menu portal closes when the restored content scrollport moves', async () => {
 await act(async () => root.render(h(LocaleProvider, {initial: 'en', children: h(Home, {accountEntry: h('div', null, 'Account'), supportedNewFormats: [], supportedFormats: ['docx']})})))
 const content = host.querySelector<HTMLElement>('.content')!
 content.scrollTop = 120
 await click(host.querySelector<HTMLButtonElement>('.recent-item .more-btn')!)
 const menu = document.body.querySelector('.row-menu')!
 expect(menu).not.toBeNull()
 expect(content.contains(menu)).toBe(false)
 await act(async () => content.dispatchEvent(new Event('scroll')))
 expect(document.body.querySelector('.row-menu')).not.toBeNull()
 content.scrollTop = 121
 await act(async () => content.dispatchEvent(new Event('scroll')))
 expect(document.body.querySelector('.row-menu')).toBeNull()
})

test('a changed search immediately hides old hits and rejects their late response during debounce', async () => {
  vi.useFakeTimers()
  try {
    const late = deferred<Awaited<ReturnType<HomeApi['searchFiles']>>>()
    api.searchFiles = vi.fn(async ({q}) => q === 'old' ? late.promise : ({hits: [], total: 0, index: {indexed: 0, pending: 0, scanning: false}}))
    const search = host.querySelector<HTMLInputElement>('input[type="search"]')!
    await fill(search, 'old')
    await act(async () => {await vi.advanceTimersByTimeAsync(150)})
    expect(api.searchFiles).toHaveBeenCalledTimes(1)
    await fill(search, 'new')
    await act(async () => late.resolve({hits: [{...file, snippet: null, needles: ['old']}], total: 1, index: {indexed: 1, pending: 0, scanning: false}}))
    expect(host.querySelector('.search-row')).toBeNull()
    await act(async () => {await vi.advanceTimersByTimeAsync(150)})
    expect(host.querySelector('.search-row')).toBeNull()
    await fill(search, 'old')
    await act(async () => {await vi.advanceTimersByTimeAsync(150)})
    expect(host.querySelector('.search-row')).not.toBeNull()
    await fill(search, 'another')
    expect(host.querySelector('.search-row')).toBeNull()
  } finally {vi.useRealTimers()}
})

test('searching clears hidden file selections before any bulk action can target them', async () => {
  api.searchFiles = async () => ({hits: [], total: 0, index: {indexed: 0, pending: 0, scanning: false}})
  await click(host.querySelector<HTMLInputElement>('.row-check')!)
  expect(host.querySelector('.selection-count')?.textContent).toContain('1')
  await fill(host.querySelector<HTMLInputElement>('input[type="search"]')!, 'unrelated')
  expect(host.querySelector('.selection-bar')).toBeNull()
  await fill(host.querySelector<HTMLInputElement>('input[type="search"]')!, '')
  expect(host.querySelector<HTMLInputElement>('.row-check')?.checked).toBe(false)
})

test('search results beyond the first hundred remain reachable without duplicate requests',async()=>{
 vi.useFakeTimers()
 try{
  const hits=Array.from({length:105},(_,i)=>({...file,path:`search-${i}`,name:`match-${i}.docx`,snippet:null,needles:['match']}))
  const next=deferred<Awaited<ReturnType<HomeApi['searchFiles']>>>()
  api.searchFiles=vi.fn(async({offset=0})=>offset?next.promise:{hits:hits.slice(0,100),total:105,index:{indexed:105,pending:0,scanning:false}})
  await fill(host.querySelector<HTMLInputElement>('input[type="search"]')!,'match');await act(async()=>{await vi.advanceTimersByTimeAsync(150)})
  expect(host.querySelectorAll('.search-row')).toHaveLength(100)
  const more=button('Load more results');await click(more);await click(more)
  expect(api.searchFiles).toHaveBeenCalledTimes(2);expect(api.searchFiles).toHaveBeenLastCalledWith({q:'match',ext:undefined,offset:100,limit:100})
  await act(async()=>next.resolve({hits:hits.slice(100),total:105,index:{indexed:105,pending:0,scanning:false}}))
  expect(host.querySelectorAll('.search-row')).toHaveLength(105);expect(host.querySelector('.search-more')).toBeNull()
 }finally{vi.useRealTimers()}
})
test('late additional search results cannot replace a changed query',async()=>{
 vi.useFakeTimers()
 try{
  const next=deferred<Awaited<ReturnType<HomeApi['searchFiles']>>>(),hit={...file,snippet:null,needles:['old']}
  api.searchFiles=vi.fn(async({q,offset=0})=>offset?next.promise:{hits:q==='old'?[hit]:[],total:q==='old'?2:0,index:{indexed:2,pending:0,scanning:false}})
  const search=host.querySelector<HTMLInputElement>('input[type="search"]')!;await fill(search,'old');await act(async()=>{await vi.advanceTimersByTimeAsync(150)})
  await click(button('Load more results'));await fill(search,'new')
  await act(async()=>next.resolve({hits:[{...hit,path:'late'}],total:2,index:{indexed:2,pending:0,scanning:false}}))
  expect(host.querySelector('.search-row')).toBeNull();await act(async()=>{await vi.advanceTimersByTimeAsync(150)});expect(host.querySelector('.search-row')).toBeNull()
 }finally{vi.useRealTimers()}
})
test('a failed additional search retains existing rows and permits an explicit retry',async()=>{
 vi.useFakeTimers()
 try{
  let attempt=0;const hit={...file,snippet:null,needles:['match']}
  api.searchFiles=async({offset=0})=>{if(offset&&attempt++===0)throw Error('Search page unavailable');return {hits:[{...hit,path:offset?'second':'first'}],total:2,index:{indexed:2,pending:0,scanning:false}}}
  await fill(host.querySelector<HTMLInputElement>('input[type="search"]')!,'match');await act(async()=>{await vi.advanceTimersByTimeAsync(150)})
  await click(button('Load more results'));expect(host.querySelectorAll('.search-row')).toHaveLength(1);expect(host.querySelector('[role="alert"]')?.textContent).toContain('Search page unavailable')
  await click(button('Load more results'));expect(host.querySelectorAll('.search-row')).toHaveLength(2)
 }finally{vi.useRealTimers()}
})

test('a changed search listing refreshes its first page instead of looping at a duplicate offset',async()=>{
 vi.useFakeTimers()
 try{
  const hits=Array.from({length:105},(_,i)=>({...file,path:`search-${i}`,name:`match-${i}.docx`,snippet:null,needles:['match']}));let live=hits
  api.searchFiles=vi.fn(async({offset=0})=>({hits:live.slice(offset,offset+100),total:live.length,index:{indexed:live.length,pending:0,scanning:false}}))
  await fill(host.querySelector<HTMLInputElement>('input[type="search"]')!,'match');await act(async()=>{await vi.advanceTimersByTimeAsync(150)})
  live=[{...hits[0],path:'inserted',name:'new-match.docx'},...hits]
  await click(button('Load more results'));await act(async()=>{await vi.advanceTimersByTimeAsync(150)})
  expect(api.searchFiles).toHaveBeenCalledTimes(3);expect(api.searchFiles).toHaveBeenLastCalledWith({q:'match',ext:undefined,limit:100})
  expect(host.querySelector('.search-row')?.textContent).toContain('new-match.docx')
  await click(button('Load more results'));expect(host.querySelectorAll('.search-row')).toHaveLength(106);expect(host.querySelector('.search-more')).toBeNull()
 }finally{vi.useRealTimers()}
})

 test('a type filter clears previous rows while loading and retries its own failed query',async()=>{
 const pending=deferred<Awaited<ReturnType<HomeApi['recents']>>>()
 let fail=true
 api.recents=vi.fn(async(query)=>{if(query?.ext==='pdf' && query.limit!==0){if(fail){await pending.promise;throw Error('PDF unavailable')}return {entries:[{...file,path:'pdf-file',name:'Result.pdf',ext:'pdf'}],total:1,totalAll:1}}return {entries:[file],total:1,totalAll:1}})
 await click(button('PDF'))
 expect(host.querySelector('.recent-item')).toBeNull()
 expect(host.querySelector('[role="status"][aria-busy="true"]')).not.toBeNull()
 await act(async()=>pending.resolve({entries:[],total:0,totalAll:0}))
 expect(host.querySelector('.recent-item')).toBeNull()
 fail=false;await click(button('Retry'))
 expect(host.querySelector('.recent-name')?.textContent).toBe('Result.pdf')
 expect(api.recents).toHaveBeenLastCalledWith(expect.objectContaining({ext:'pdf',offset:0}))
 })
 test('a failed same-view refresh preserves the currently matching rows',async()=>{
 api.recents=async()=>{throw Error('Refresh unavailable')}
 await act(async()=>window.dispatchEvent(new Event('focus')))
 expect(host.querySelector('.recent-name')?.textContent).toBe(file.name)
 expect(host.querySelector('[role="alert"]')?.textContent).toContain('Refresh unavailable')
 })

test('a late failed view request cannot replace a newer successful view with an error',async()=>{
 const pending=deferred<Awaited<ReturnType<HomeApi['starred']>>>()
 api.starred=async query=>query?.limit===0?{entries:[],total:0,totalAll:0}:pending.promise.then(()=>{throw Error('Old starred failure')})
 const nav=(label:string)=>[...host.querySelectorAll<HTMLButtonElement>('.sidebar-nav button')].find(node=>node.querySelector('.nav-label')?.textContent===label)!
 await click(nav('Starred'));await click(nav('Recent'))
 await act(async()=>pending.resolve({entries:[],total:0,totalAll:0}))
 expect(host.querySelector('.recent-name')?.textContent).toBe(file.name)
 expect(host.querySelector('[role="alert"]')).toBeNull()
 expect(host.querySelector('[role="status"][aria-busy="true"]')).toBeNull()
})

test('search distinguishes a pending first page from failure and retries the unchanged query',async()=>{
 vi.useFakeTimers()
 try{
  const pending=deferred<Awaited<ReturnType<HomeApi['searchFiles']>>>()
  let fail=true
  api.searchFiles=vi.fn(async()=>{if(fail){await pending.promise;throw Error('Search unavailable')}return {hits:[{...file,snippet:null,needles:['report']}],total:1,index:{indexed:1,pending:0,scanning:false}}})
  await fill(host.querySelector<HTMLInputElement>('input[type="search"]')!,'report')
  expect(host.querySelector('.search-results [role="status"][aria-busy="true"]')).not.toBeNull()
  await act(async()=>{await vi.advanceTimersByTimeAsync(150)})
  await act(async()=>pending.resolve({hits:[],total:0,index:{indexed:0,pending:0,scanning:false}}))
  expect(host.querySelector('.search-results [role="alert"]')?.textContent).toContain('Search unavailable')
  expect(host.querySelector('.search-results [aria-busy="true"]')).toBeNull()
  fail=false;await click(button('Retry',host.querySelector('.search-results')!))
  await act(async()=>{await vi.advanceTimersByTimeAsync(150)})
  expect(host.querySelector('.search-row')?.textContent).toContain(file.name)
  expect(host.querySelector('.search-results [role="alert"]')).toBeNull()
  expect(api.searchFiles).toHaveBeenLastCalledWith(expect.objectContaining({q:'report'}))
 }finally{vi.useRealTimers()}
})
test('an indexing poll failure stops the indexing indicator, retains matching hits and offers retry',async()=>{
 vi.useFakeTimers()
 try{
  let count=0
  api.searchFiles=vi.fn(async()=>{if(++count>1)throw Error('Index poll failed');return {hits:[{...file,snippet:null,needles:['report']}],total:1,index:{indexed:1,pending:1,scanning:true}}})
  await fill(host.querySelector<HTMLInputElement>('input[type="search"]')!,'report')
  await act(async()=>{await vi.advanceTimersByTimeAsync(150)})
  expect(host.querySelector('.search-status')).not.toBeNull()
  await act(async()=>{await vi.advanceTimersByTimeAsync(1500)})
  expect(host.querySelector('.search-status')).toBeNull()
  expect(host.querySelector('.search-row')?.textContent).toContain(file.name)
  expect(host.querySelector('.search-results [role="alert"]')?.textContent).toContain('Index poll failed')
  expect(button('Retry',host.querySelector('.search-results')!)).toBeTruthy()
 }finally{vi.useRealTimers()}
})

test('late failure from a previous search does not replace newer results or leave a retry banner',async()=>{
 vi.useFakeTimers()
 try{
  const late=deferred<void>()
  api.searchFiles=vi.fn(async({q})=>{if(q==='old'){await late.promise;throw Error('Late old failure')}return {hits:[{...file,snippet:null,needles:['report']}],total:1,index:{indexed:1,pending:0,scanning:false}}})
  const input=host.querySelector<HTMLInputElement>('input[type="search"]')!
  await fill(input,'old');await act(async()=>{await vi.advanceTimersByTimeAsync(150)})
  await fill(input,'report');await act(async()=>{await vi.advanceTimersByTimeAsync(150)})
  await act(async()=>late.resolve())
  expect(host.querySelector('.search-row')?.textContent).toContain(file.name)
  expect(host.querySelector('[role="alert"]')).toBeNull()
  await fill(input,'')
  expect(host.querySelector('.search-results')).toBeNull()
 }finally{vi.useRealTimers()}
})

test('failed polling of an empty partial index does not claim zero final search results',async()=>{
 vi.useFakeTimers()
 try{
  let count=0
  api.searchFiles=async()=>{if(++count>1)throw Error('Partial index unavailable');return {hits:[],total:0,index:{indexed:0,pending:1,scanning:true}}}
  await fill(host.querySelector<HTMLInputElement>('input[type="search"]')!,'report')
  await act(async()=>{await vi.advanceTimersByTimeAsync(1650)})
  expect(host.querySelector('.search-results [role="alert"]')?.textContent).toContain('Partial index unavailable')
  expect(host.querySelector('.recents-heading .file-count')).toBeNull()
  expect(host.querySelector('.search-status')).toBeNull()
  expect(host.querySelector('.search-results')?.textContent).not.toContain('No files')
 }finally{vi.useRealTimers()}
})

test('search result buttons support Space and Enter without page scrolling or key-repeat opens',async()=>{
 vi.useFakeTimers()
 try{
  api.openPath=vi.fn(async()=>{})
  api.searchFiles=async()=>({hits:[{...file,snippet:null,needles:['report']}],total:1,index:{indexed:1,pending:0,scanning:false}})
  await fill(host.querySelector<HTMLInputElement>('input[type="search"]')!,'report')
  await act(async()=>{await vi.advanceTimersByTimeAsync(150)})
  const row=host.querySelector<HTMLElement>('.search-row')!
  row.focus()
  for(const key of [' ','Enter']){
   const event=new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true})
   await act(async()=>row.dispatchEvent(event))
   expect(event.defaultPrevented).toBe(true)
  }
  await act(async()=>row.dispatchEvent(new KeyboardEvent('keydown',{key:' ',repeat:true,bubbles:true,cancelable:true})))
  expect(api.openPath).toHaveBeenCalledTimes(2)
  expect(api.openPath).toHaveBeenLastCalledWith(file.path)
 }finally{vi.useRealTimers()}
})
