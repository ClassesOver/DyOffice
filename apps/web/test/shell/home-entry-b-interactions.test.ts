import {afterEach, beforeEach, expect, test, vi} from 'vitest'
import {act, createElement as h} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {Home} from '../../../shell/src/renderer/src/Home'
import {LocaleProvider} from '../../../shell/src/renderer/src/locale'
import type {FolderListing, HomeApi, RecentEntry} from '../../../shell/src/shared/home-api'


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
  await act(async () => root.render(h(LocaleProvider, {initial: 'en', children: h(Home, {accountEntry: h('div', null, 'Account'), supportedFormats: ['docx','xlsx','pptx','pdf'], supportedNewFormats: ['docx'], capabilities: {serverFileSort: true}})})))
})
afterEach(async () => {await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals()})
const button = (label: string, scope: ParentNode = host) => {
  const result = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label)
  expect(result, label).toBeDefined(); return result!
}
async function click(node: HTMLElement) {expect(node).toBeTruthy(); await act(async () => node.click())}
async function fill(node: HTMLInputElement, value: string) {expect(node).toBeTruthy(); await act(async () => {Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new Event('input', {bubbles: true}))})}


// Real Home rendering and bridge interactions. JSDOM is not a pixel/layout check.
test('B entry keeps supported launchers and account entry, without enabling unsupported creation', async () => {
  api.newDoc = vi.fn(async () => {})
  api.newSheet = vi.fn(async () => {})
  api.newSlides = vi.fn(async () => {})
  api.newPdf = vi.fn(async () => {})
  api.browse = vi.fn(async () => {})
  expect(host.querySelector('.home-web')).not.toBeNull()
  expect(host.textContent).toContain('Account')
  const cards = [...host.querySelectorAll<HTMLButtonElement>('.quick-card')]
  expect(cards).toHaveLength(5)
  expect(cards.map(card => card.disabled)).toEqual([false,true,true,true,false])
  await click(cards[0]); await click(cards[4])
  for (const card of cards.slice(1,4)) await click(card)
  expect(api.newDoc).toHaveBeenCalledTimes(1); expect(api.browse).toHaveBeenCalledTimes(1)
  expect(api.newSheet).not.toHaveBeenCalled(); expect(api.newSlides).not.toHaveBeenCalled(); expect(api.newPdf).not.toHaveBeenCalled()
})

test('B entry retains server modified sort, file search and returning to the sorted list', async () => {
  const old = {...file,path:'old',name:'Older.docx',mtimeMs:1}
  const recent = {...file,path:'new',name:'Newer.docx',mtimeMs:2}
  api.recents = vi.fn(async query => ({entries:query?.sort === 'modified-desc' ? [recent,old] : [old,recent],total:2,totalAll:2}))
  await act(async () => window.dispatchEvent(new Event('focus')))
  await click(host.querySelector<HTMLButtonElement>('.cloud-col-sort-btn')!)
  await click(button('Recent',host.querySelector('[role="menu"]')!))
  expect(api.recents).toHaveBeenLastCalledWith(expect.objectContaining({sort:'modified-desc',offset:0}))
  expect([...host.querySelectorAll('.recent-name')].map(node=>node.textContent)).toEqual(['Newer.docx','Older.docx'])
  api.searchFiles = vi.fn(async () => ({hits:[{...old,snippet:null,needles:['Older']}],total:1,index:{indexed:1,pending:0,scanning:false}}))
  vi.useFakeTimers()
  try {
    const input=host.querySelector<HTMLInputElement>('input[type="search"]')!
    await fill(input,'Older')
    await act(async () => {await vi.advanceTimersByTimeAsync(150)})
    expect(api.searchFiles).toHaveBeenLastCalledWith(expect.objectContaining({q:'Older'}))
    expect(host.querySelector('.search-row')?.textContent).toContain('Older.docx')
    await fill(input,'')
    expect(host.querySelector('.search-results')).toBeNull()
    expect([...host.querySelectorAll('.recent-name')].map(node=>node.textContent)).toEqual(['Newer.docx','Older.docx'])
  } finally {vi.useRealTimers()}
})
