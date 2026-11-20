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

test('XLSX creation card is enabled only by the safe native capability and invokes the wired action', async () => {
  const {localNewFormats,createLocalNewSheet,createLocalNewSlide}=await import('../../src/shell/local-new-sheet')
  const opened=vi.fn(async()=>{})
  const request=vi.fn(async(path:string)=>path==='/api/v1/capabilities'?{xlsx:'editable',pptx:'editable'}:path==='/api/v1/files/uploads'?{uploadId:'new-upload'}:path.endsWith('/finish')?{file:{fileId:'new-workbook'}}:undefined)
  api.newSheet=createLocalNewSheet({getSessionProof:()=>'A'.repeat(43),bindSession:async()=>({request:request as any}),fetchTemplate:async()=>new Response('xlsx'),open:opened,changed:()=>{}})
  api.newSlide=createLocalNewSlide({getSessionProof:()=>'A'.repeat(43),bindSession:async()=>({request:request as any}),fetchTemplate:async()=>new Response('pptx'),open:opened,changed:()=>{}})
  await act(async()=>root.render(h(LocaleProvider,{initial:'en',children:h(Home,{supportedFormats:['docx','xlsx','pptx','pdf'],supportedNewFormats:localNewFormats({xlsx:'editable'})})})))
  const cards=[...host.querySelectorAll<HTMLButtonElement>('.quick-card')]
  expect(cards.map(card=>card.disabled)).toEqual([true,false,true,true,false])
  await click(cards[1]);await vi.waitFor(()=>expect(opened).toHaveBeenCalledWith('new-workbook',request))
  await act(async()=>root.render(h(LocaleProvider,{initial:'en',children:h(Home,{supportedFormats:['docx','xlsx','pptx','pdf'],supportedNewFormats:localNewFormats({pptx:'editable'})})})))
  expect(host.querySelectorAll<HTMLButtonElement>('.quick-card')[2].disabled).toBe(false)
  await click(host.querySelectorAll<HTMLButtonElement>('.quick-card')[2]);await vi.waitFor(()=>expect(opened).toHaveBeenCalledTimes(2))
  await act(async()=>root.render(h(LocaleProvider,{initial:'en',children:h(Home,{supportedFormats:['docx','xlsx','pptx','pdf'],supportedNewFormats:localNewFormats({xlsx:'unsupported'})})})))
  expect(host.querySelectorAll<HTMLButtonElement>('.quick-card')[1].disabled).toBe(true)
})

test('Web pages request only visible rows, clear selection and reset filtering to the first page', async () => {
  const files=Array.from({length:45},(_,index)=>({...file,path:`file-${index}`,name:`Report ${index}.docx`}))
  api.recents=vi.fn(async query=>({entries:files.slice(query?.offset??0,(query?.offset??0)+(query?.limit??20)),total:files.length,totalAll:files.length}))
  await act(async()=>window.dispatchEvent(new Event('focus')))
  expect(host.querySelectorAll('.recent-row')).toHaveLength(20)
  await click(host.querySelector<HTMLInputElement>('.recent-row .row-check')!)
  await click(button('Next',host.querySelector('.home-file-pager')!))
  expect(api.recents).toHaveBeenLastCalledWith(expect.objectContaining({offset:20,limit:20}))
  expect(host.querySelector('.recent-name')?.textContent).toBe('Report 20.docx')
  expect(host.querySelector('.selection-bar')).toBeNull()
  expect(host.querySelector('.home-file-pager')?.textContent).toContain('Page 2 of 3')
  await click(button('Next',host.querySelector('.home-file-pager')!))
  expect(host.querySelectorAll('.recent-row')).toHaveLength(5)
  expect(button('Next',host.querySelector('.home-file-pager')!).disabled).toBe(true)
  await click(button('Docs',host.querySelector('.filter-pills')!))
  expect(api.recents).toHaveBeenLastCalledWith(expect.objectContaining({offset:0,limit:20,ext:'docx'}))
})

test('select all distinguishes partial, complete and cleared file selection', async () => {
  const files=[file,{...file,path:'second-file',name:'Second.docx'}]
  api.recents=vi.fn(async()=>({entries:files,total:2,totalAll:2}))
  api.listFolder=vi.fn(async path=>({...listings()[path],files:path===project?files:[]}))
  await act(async()=>window.dispatchEvent(new Event('focus')))
  for(const context of ['recent','folder']){
    if(context==='folder')await click([...host.querySelectorAll<HTMLElement>('.tree-name')].find(node=>node.textContent==='Projects')!)
    const selectAll=host.querySelector<HTMLInputElement>('.recent-columns input')!
    expect(selectAll.indeterminate).toBe(false)
    await click(host.querySelector<HTMLInputElement>('.recent-row .row-check')!)
    expect(selectAll.indeterminate).toBe(true)
    expect(selectAll.getAttribute('aria-checked')).toBe('mixed')
    await click(selectAll)
    expect(selectAll.checked).toBe(true)
    expect(selectAll.indeterminate).toBe(false)
    expect([...host.querySelectorAll<HTMLInputElement>('.row-check')].every(node=>node.checked)).toBe(true)
    await click(selectAll)
    expect(selectAll.checked).toBe(false)
    expect(selectAll.indeterminate).toBe(false)
    expect(host.querySelector('.selection-bar')).toBeNull()
  }
})

test('Web refresh returns to the last available page after the final page disappears', async () => {
  let files=Array.from({length:21},(_,index)=>({...file,path:`file-${index}`}))
  api.recents=vi.fn(async query=>({entries:files.slice(query?.offset??0,(query?.offset??0)+(query?.limit??20)),total:files.length,totalAll:files.length}))
  await act(async()=>window.dispatchEvent(new Event('focus')))
  await click(button('Next',host.querySelector('.home-file-pager')!))
  expect(host.querySelectorAll('.recent-row')).toHaveLength(1)
  files=files.slice(0,20)
  await act(async()=>window.dispatchEvent(new Event('focus')))
  expect(host.querySelectorAll('.recent-row')).toHaveLength(20)
  expect(host.querySelector('.home-file-pager')?.textContent).toContain('Page 1 of 1')
  expect(api.recents).toHaveBeenLastCalledWith(expect.objectContaining({offset:0,limit:20}))
})
