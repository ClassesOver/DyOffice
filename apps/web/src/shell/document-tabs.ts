import type {TabSummary} from '../../../shell/src/shared/tabs-api'

export type DocumentFormat = 'docx' | 'xlsx' | 'pptx' | 'pdf'
export interface DocumentTab {id: string; format: DocumentFormat; name: string; src: string; sourceRevision?: string}
export type DocumentCloseGuard = () => boolean | Promise<boolean>
interface DocumentOpenToken {renameVersion: number; sequence: number}
export class CitationTabUnverified extends Error {
  constructor() { super('The open editor cannot verify the cited revision.') }
}
const kinds: Record<DocumentFormat, TabSummary['kind']> = {docx:'docs',xlsx:'sheets',pptx:'slides',pdf:'pdf'}

export function createDocumentTabs({displayedRevision=()=>undefined,isCitationExpired=()=>false}:{displayedRevision?:(id:string)=>string|undefined;isCitationExpired?:(id:string)=>boolean}={}) {
  const documents: DocumentTab[] = []
  const mounted = new Set<string>()
  const listeners = new Set<(tabs: TabSummary[]) => void>()
  const guards = new Map<string, DocumentCloseGuard>()
  const closing = new Map<string, Promise<boolean>>()
  const closedAt = new Map<string, number>()
  const names = new Map<string, {name: string; renameVersion: number; sequence: number}>()
  let openSequence = 0
  let selectionSequence = 0
  let active = 'home'
  let entryLocks = 0
  const assertEntriesAllowed = () => {if(entryLocks)throw new Error('正在退出，请稍候再打开文档。')}
  function list(): TabSummary[] {
    return [{id:'home',kind:'home',title:'首页',closable:false,active:active==='home'},
      ...documents.map(document => ({id:document.id,kind:kinds[document.format],title:document.name,closable:true,active:active===document.id}))]
  }
  function emit() { for (const listener of listeners) listener(list()) }
  function activate(id: string) {
    if(id !== 'home')assertEntriesAllowed()
    if (id !== 'home' && !documents.some(document => document.id === id)) return
    selectionSequence = ++openSequence
    if (id === active) return
    active = id; if(id !== 'home')mounted.add(id); emit()
  }
  function reserveOpen(id: string): DocumentOpenToken {
    assertEntriesAllowed()
    selectionSequence = ++openSequence
    return {renameVersion: names.get(id)?.renameVersion ?? 0, sequence: openSequence}
  }
  function open(document: DocumentTab, token?: DocumentOpenToken) {
    assertEntriesAllowed()
    if (document.id === 'home') throw new Error('文档标识不能使用 home。')
    if (token && token.sequence <= (closedAt.get(document.id) ?? 0)) return
    const select = !token || token.sequence === selectionSequence
    if (document.sourceRevision && !select) return
    if (!token) selectionSequence = ++openSequence
    const known = names.get(document.id)
    const fresh = !token || (token.renameVersion === (known?.renameVersion ?? 0) && token.sequence >= (known?.sequence ?? 0))
    const name = fresh ? document.name : known?.name ?? document.name
    const current = documents.find(current => current.id === document.id)
    if (select && current && document.sourceRevision && mounted.has(document.id) && displayedRevision(document.id)!==document.sourceRevision) throw new CitationTabUnverified()
    names.set(document.id, {name, renameVersion: known?.renameVersion ?? 0, sequence: Math.max(known?.sequence ?? 0, token?.sequence ?? 0)})
    if (current) {
      const pinDormant = select && document.sourceRevision && !mounted.has(document.id)
      const reopen = select && !document.sourceRevision && current.sourceRevision && (current.format==='docx'||isCitationExpired(document.id))
      if (pinDormant || reopen) {
        current.src=document.src
        if(document.sourceRevision)current.sourceRevision=document.sourceRevision
        else delete current.sourceRevision
      } else if (current.name === name && (!select || active === document.id)) return
      current.name = name
      if (select) {active = document.id; mounted.add(document.id)}
      emit(); return
    }
    documents.push({...document, name})
    if (select) {active = document.id; mounted.add(document.id)}
    emit()
  }
  function rename(id: string, name: string) {
    if (id === 'home') return
    const known = names.get(id)
    if (known?.name !== name) names.set(id, {name, renameVersion: (known?.renameVersion ?? 0) + 1, sequence: known?.sequence ?? 0})
    const document = documents.find(document => document.id === id)
    if (!document || document.name === name) return
    document.name = name; emit()
  }
  function close(id: string): Promise<boolean> {
    if (id === 'home' || !documents.some(document => document.id === id)) return Promise.resolve(false)
    const existing = closing.get(id)
    if (existing) return existing
    const work = Promise.resolve().then(async () => {
      const guard = guards.get(id)
      if (!guard && mounted.has(id) && documents.find(document => document.id === id)?.src.startsWith('/native-')) return false
      if (guard && !await guard()) return false
      const index = documents.findIndex(document => document.id === id)
      if (index < 0) return false
      closedAt.set(id, openSequence)
      documents.splice(index, 1); guards.delete(id); mounted.delete(id)
      if (active === id) {
        selectionSequence = ++openSequence
        active = entryLocks ? 'home' : documents[Math.min(index, documents.length - 1)]?.id ?? 'home'
        if(active !== 'home')mounted.add(active)
      }
      emit(); return true
    }).finally(() => { closing.delete(id) })
    closing.set(id, work)
    return work
  }
  function reorder(id: string, toIndex: number) {
    if (id === 'home' || !Number.isFinite(toIndex)) return
    const index = documents.findIndex(document => document.id === id)
    if (index < 0) return
    const target = Math.max(0, Math.min(documents.length - 1, Math.trunc(toIndex) - 1))
    if (index === target) return
    const [document] = documents.splice(index, 1)
    documents.splice(target, 0, document); emit()
  }
  return {
    list,
    // Covers both fresh requests and completions that reserved a token earlier.
    suspendEntries(){entryLocks++;let released=false;return ()=>{if(!released){released=true;entryLocks--}}},
    // Startup only, after authenticated metadata resolution. Never replaces live drafts.
    restoreEntries(entries:DocumentTab[],selected:string){
      assertEntriesAllowed()
      if(documents.length||openSequence)throw new Error('Cannot restore over a live workspace')
      for(const entry of entries){if(entry.id==='home'||documents.some(doc=>doc.id===entry.id))continue;documents.push({...entry})}
      active=documents.some(doc=>doc.id===selected)?selected:'home'
      if(active!=='home')mounted.add(active)
      emit()
    },
    renderedDocuments:()=>documents.filter(document=>mounted.has(document.id)).map(document=>({...document})),
    documents: () => documents.map(document => ({...document})),
    subscribe(listener: (tabs: TabSummary[]) => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    open, activate, close, reorder, rename, reserveOpen, isCitationExpired,
    isOpenCurrent:(token:DocumentOpenToken)=>token.sequence===selectionSequence,
    setGuard(id: string, guard: DocumentCloseGuard | null) {
      if (!documents.some(document => document.id === id)) return
      if (guard) guards.set(id, guard); else guards.delete(id)
    },
  }
}
