import type {TabSummary} from '../../../shell/src/shared/tabs-api'

export type DocumentFormat = 'docx' | 'xlsx' | 'pptx' | 'pdf'
export interface DocumentTab {id: string; format: DocumentFormat; name: string; src: string}
export type DocumentCloseGuard = () => boolean | Promise<boolean>
interface DocumentOpenToken {renameVersion: number; sequence: number}
const kinds: Record<DocumentFormat, TabSummary['kind']> = {docx:'docs',xlsx:'sheets',pptx:'slides',pdf:'pdf'}

export function createDocumentTabs() {
  const documents: DocumentTab[] = []
  const listeners = new Set<(tabs: TabSummary[]) => void>()
  const guards = new Map<string, DocumentCloseGuard>()
  const closing = new Map<string, Promise<boolean>>()
  const names = new Map<string, {name: string; renameVersion: number; sequence: number}>()
  let openSequence = 0
  let active = 'home'
  function list(): TabSummary[] {
    return [{id:'home',kind:'home',title:'首页',closable:false,active:active==='home'},
      ...documents.map(document => ({id:document.id,kind:kinds[document.format],title:document.name,closable:true,active:active===document.id}))]
  }
  function emit() { for (const listener of listeners) listener(list()) }
  function activate(id: string) {
    if (id === active || (id !== 'home' && !documents.some(document => document.id === id))) return
    active = id; emit()
  }
  function reserveOpen(id: string): DocumentOpenToken {
    return {renameVersion: names.get(id)?.renameVersion ?? 0, sequence: ++openSequence}
  }
  function open(document: DocumentTab, token?: DocumentOpenToken) {
    if (document.id === 'home') throw new Error('文档标识不能使用 home。')
    const known = names.get(document.id)
    const fresh = !token || (token.renameVersion === (known?.renameVersion ?? 0) && token.sequence >= (known?.sequence ?? 0))
    const name = fresh ? document.name : known?.name ?? document.name
    names.set(document.id, {name, renameVersion: known?.renameVersion ?? 0, sequence: Math.max(known?.sequence ?? 0, token?.sequence ?? 0)})
    const current = documents.find(current => current.id === document.id)
    if (current) {
      if (current.name === name && active === document.id) return
      current.name = name; active = document.id; emit(); return
    }
    documents.push({...document, name}); active = document.id; emit()
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
      if (!guard && documents.find(document => document.id === id)?.src.startsWith('/native-')) return false
      if (guard && !await guard()) return false
      const index = documents.findIndex(document => document.id === id)
      if (index < 0) return false
      documents.splice(index, 1); guards.delete(id)
      if (active === id) active = documents[Math.min(index, documents.length - 1)]?.id ?? 'home'
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
    documents: () => documents.map(document => ({...document})),
    subscribe(listener: (tabs: TabSummary[]) => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    open, activate, close, reorder, rename, reserveOpen,
    setGuard(id: string, guard: DocumentCloseGuard | null) {
      if (!documents.some(document => document.id === id)) return
      if (guard) guards.set(id, guard); else guards.delete(id)
    },
  }
}
