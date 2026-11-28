import type {TabSummary} from '../../../shell/src/shared/tabs-api'
import {pickTabsToSleep,type SleepPolicy} from '../../../shell/src/main/tab-hibernation'

export type DocumentFormat = 'docx' | 'xlsx' | 'pptx' | 'pdf'
export interface DocumentTab {id: string; format: DocumentFormat; name: string; src: string; sourceRevision?: string}
export type DocumentCloseGuard = (canDispose?:()=>boolean) => boolean | Promise<boolean>
export type TabBulkClose = 'closeOthers' | 'closeRight' | 'closeAll'
export const splitWidths={minimum:25,maximum:75,default:50} as const
export type WorkspaceSplit=Readonly<{left:string;right:string;width?:number}>

export function tabMoveIndex(tabs: readonly TabSummary[], id: string, offset: -1 | 1): number | undefined {
  const index = tabs.findIndex(tab => tab.id === id)
  const target = index + offset
  if (id !== 'home' && index > 0 && target > 0 && target < tabs.length) return target
}

export function tabCloseTargets(tabs: readonly TabSummary[], id: string, action: TabBulkClose): string[] {
  const index = tabs.findIndex(tab => tab.id === id)
  if (index < 0) return []
  const candidates = action === 'closeRight' ? tabs.slice(index + 1) : tabs
  return candidates.filter(tab => tab.id !== 'home' && tab.closable &&
    (action !== 'closeOthers' || tab.id !== id)).map(tab => tab.id)
}
interface DocumentOpenToken {renameVersion: number; sequence: number}
export class CitationTabUnverified extends Error {
  constructor() { super('The open editor cannot verify the cited revision.') }
}
const kinds: Record<DocumentFormat, TabSummary['kind']> = {docx:'docs',xlsx:'sheets',pptx:'slides',pdf:'pdf'}
const maxRecentlyClosed = 20

export function createDocumentTabs({displayedRevision=()=>undefined,isCitationExpired=()=>false,now=Date.now}:{displayedRevision?:(id:string)=>string|undefined;isCitationExpired?:(id:string)=>boolean;now?:()=>number}={}) {
  const documents: DocumentTab[] = []
  const mounted = new Set<string>()
  const pinned = new Set<string>()
  const listeners = new Set<(tabs: TabSummary[]) => void>()
  const guards = new Map<string, DocumentCloseGuard>()
  const sleepGuards = new Map<string, DocumentCloseGuard>()
  const sleeping = new Map<string, Promise<boolean>>()
  const sleepGenerations = new Map<string, number>()
  const lastVisible = new Map<string, number>()
  let visible = new Set<string>()
  const closing = new Map<string, Promise<boolean>>()
  const closedAt = new Map<string, number>()
  const recentlyClosed: string[] = []
  let reopening: Promise<void> | undefined
  const names = new Map<string, {name: string; renameVersion: number; sequence: number}>()
  let openSequence = 0
  let selectionSequence = 0
  let active = 'home'
  let split: WorkspaceSplit | null = null
  let entryLocks = 0
  let closingBatch: {targets: Set<string>; work: Promise<void>} | undefined
  const assertEntriesAllowed = () => {if(entryLocks)throw new Error('正在退出，请稍候再打开文档。')}
  function list(): TabSummary[] {
    return [{id:'home',kind:'home',title:'首页',closable:false,active:active==='home'},
      ...documents.map(document => ({id:document.id,kind:kinds[document.format],title:document.name,closable:true,active:active===document.id,
        ...(pinned.has(document.id)?{pinned:true}:{}),
        ...(!mounted.has(document.id)&&sleepGenerations.has(document.id)?{dormant:true}:{})}))]
  }
  function emit() {
    const next = new Set(split ? [split.left,split.right] : [active])
    const timestamp = now()
    for (const id of mounted) {
      if (next.has(id)||visible.has(id)||!lastVisible.has(id)) lastVisible.set(id,timestamp)
    }
    visible=next
    for (const listener of listeners) listener(list())
  }
  function mustStayMounted(id:string) {
    return id===active||pinned.has(id)||split?.left===id||split?.right===id
  }
  function canSleep(id:string) {
    return !entryLocks&&!closingBatch&&!closing.has(id)&&mounted.has(id)&&!mustStayMounted(id)&&
      documents.some(document=>document.id===id&&!document.sourceRevision&&document.src.startsWith('/native-'))
  }
  async function sleepIdleTabs(policy:SleepPolicy,enabled=()=>true) {
    if(!enabled()||sleeping.size||mounted.size<=policy.maxLiveTabs)return []
    const eligible=[...lastVisible].filter(([id])=>canSleep(id)&&sleepGuards.has(id))
      .map(([id,lastActiveAt])=>({id,lastActiveAt}))
    // A guarded disposal can refuse a dirty editor. Keep scanning by age until the live cap is met.
    const candidates=pickTabsToSleep(eligible,mounted.size,{...policy,maxLiveTabs:0},now())
    const slept:string[]=[]
    for(const id of candidates){
      if(!enabled()||mounted.size<=policy.maxLiveTabs)break
      const guard=sleepGuards.get(id)
      if(!guard||sleeping.has(id)||!canSleep(id))continue
      const work=Promise.resolve().then(async()=>{
        if(!enabled()||!canSleep(id)||!await guard(()=>enabled()&&canSleep(id)))return false
        guards.delete(id);sleepGuards.delete(id)
        sleepGenerations.set(id,(sleepGenerations.get(id)??0)+1)
        if(enabled()&&!mustStayMounted(id)){
          mounted.delete(id)
          lastVisible.delete(id)
        }
        emit()
        return !mounted.has(id)
      }).finally(()=>sleeping.delete(id))
      sleeping.set(id,work)
      if(await work)slept.push(id)
    }
    return slept
  }
  function forgetClosed(id: string) {
    const index = recentlyClosed.indexOf(id)
    if (index >= 0) recentlyClosed.splice(index, 1)
  }
  function activateSelection(id:string) {
    if (split && id !== split.left && id !== split.right) split = null
    active = id
  }
  function activate(id: string) {
    if(id !== 'home')assertEntriesAllowed()
    if (id !== 'home' && !documents.some(document => document.id === id)) return
    selectionSequence = ++openSequence
    if (id === active) return
    activateSelection(id); if(id !== 'home')mounted.add(id); emit()
  }
  function splitBeside(id:string) {
    assertEntriesAllowed()
    const index = documents.findIndex(document=>document.id===id)
    if(index<0)return
    const left = active===id ? (documents[index-1]??documents[index+1])?.id??'home' : active
    split={left,right:id}
    if(left!=='home')mounted.add(left)
    mounted.add(id)
    emit()
  }
  function resizeSplit(width:number){
    if(!split||(split.width??splitWidths.default)===width||
       !Number.isInteger(width)||width<splitWidths.minimum||width>splitWidths.maximum)return
    split={...split,width}
    emit()
  }
  function swapSplit(){
    if(!split)return
    split={...split,left:split.right,right:split.left}
    emit()
  }
  function endSplit(){
    if(!split)return
    split=null
    emit()
  }
  function reserveOpen(id: string): DocumentOpenToken {
    assertEntriesAllowed()
    selectionSequence = ++openSequence
    return {renameVersion: names.get(id)?.renameVersion ?? 0, sequence: openSequence}
  }
  function open(document: DocumentTab, token?: DocumentOpenToken, {mountInBackground=false}={}) {
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
    if (!document.sourceRevision) forgetClosed(document.id)
    names.set(document.id, {name, renameVersion: known?.renameVersion ?? 0, sequence: Math.max(known?.sequence ?? 0, token?.sequence ?? 0)})
    if (current) {
      const pinDormant = select && document.sourceRevision && !mounted.has(document.id)
      const reopen = select && !document.sourceRevision && current.sourceRevision && (current.format==='docx'||isCitationExpired(document.id))
      const mountDormant = mountInBackground && !mounted.has(document.id)
      if (pinDormant || reopen) {
        current.src=document.src
        if(document.sourceRevision)current.sourceRevision=document.sourceRevision
        else delete current.sourceRevision
      } else if (current.name === name && (!select || active === document.id) && !mountDormant) return
      current.name = name
      if (select) activateSelection(document.id)
      if (select || mountDormant) mounted.add(document.id)
      emit(); return
    }
    documents.push({...document, name})
    if (select) activateSelection(document.id)
    if (select || mountInBackground) mounted.add(document.id)
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
  function close(id: string, {canDispose,remember=true}:{canDispose?:()=>boolean;remember?:boolean} = {}): Promise<boolean> {
    if (id === 'home' || !documents.some(document => document.id === id)) return Promise.resolve(false)
    const sleep=sleeping.get(id)
    if(sleep)return sleep.then(()=>close(id,{canDispose,remember}))
    const existing = closing.get(id)
    if (existing) return canDispose ? Promise.resolve(false) : existing
    const work = Promise.resolve().then(async () => {
      if (canDispose && !canDispose()) return false
      const guard = guards.get(id)
      if (!guard && mounted.has(id) && documents.find(document => document.id === id)?.src.startsWith('/native-')) return false
      if (guard && !await guard(canDispose)) return false
      const index = documents.findIndex(document => document.id === id)
      if (index < 0) return false
      closedAt.set(id, openSequence)
      if (remember && !documents[index].sourceRevision) {
        forgetClosed(id)
        recentlyClosed.unshift(id)
        if (recentlyClosed.length > maxRecentlyClosed) recentlyClosed.pop()
      }
      documents.splice(index, 1); guards.delete(id); mounted.delete(id); pinned.delete(id)
      sleepGuards.delete(id);sleepGenerations.delete(id);lastVisible.delete(id)
      if(split?.left===id||split?.right===id)split=null
      if (active === id) {
        selectionSequence = ++openSequence
        active = entryLocks ? 'home' : documents[Math.min(index, documents.length - 1)]?.id ?? 'home'
        if(active !== 'home' && !closingBatch?.targets.has(active))mounted.add(active)
      }
      emit(); return true
    }).finally(() => { closing.delete(id) })
    closing.set(id, work)
    return work
  }
  function closeMany(ids: readonly string[], canContinue = () => true): Promise<void> {
    if (closingBatch) return closingBatch.work
    const targets = new Set(ids)
    const selected = [...targets].map(id => documents.find(document => document.id === id))
    const work = Promise.resolve().then(async () => {
      for (const document of selected) {
        if (!canContinue()) break
        if (document && documents.includes(document) && !await close(document.id)) break
      }
    }).finally(() => {
      closingBatch = undefined
      // A selected survivor may have been left dormant while the batch ran.
      if (active !== 'home' && !mounted.has(active)) {
        mounted.add(active)
        emit()
      }
    })
    closingBatch = {targets, work}
    return work
  }
  function reopenClosed(resolve: (id: string) => Promise<DocumentTab>): Promise<void> {
    if (reopening) return reopening
    const candidates = [...recentlyClosed]
    reopening = Promise.resolve().then(async () => {
      for (const id of candidates) {
        if (!recentlyClosed.includes(id)) continue
        if (documents.some(document => document.id === id)) {
          forgetClosed(id); emit(); continue
        }
        const token = reserveOpen(id)
        let document: DocumentTab
        try { document = await resolve(id) }
        catch (error) {
          if (token.sequence !== selectionSequence) return
          const status = (error as {status?: number})?.status
          if (status !== 404 && status !== 410) throw error
          forgetClosed(id); emit(); continue
        }
        if (token.sequence !== selectionSequence) return
        open(document, token)
        return
      }
    }).finally(() => { reopening = undefined })
    return reopening
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
  function setPinned(id: string, value: boolean) {
    if (pinned.has(id) === value || !documents.some(document=>document.id===id)) return
    if (value) {
      pinned.add(id)
      mounted.add(id)
    } else pinned.delete(id)
    emit()
  }
  return {
    list,
    // Covers both fresh requests and completions that reserved a token earlier.
    suspendEntries(){entryLocks++;let released=false;return ()=>{if(!released){released=true;entryLocks--}}},
    // Startup only, after authenticated metadata resolution. Never replaces live drafts.
    restoreEntries(entries:DocumentTab[],selected:string,pinnedIds:readonly string[]=[],layout?:WorkspaceSplit){
      assertEntriesAllowed()
      if(documents.length||openSequence)throw new Error('Cannot restore over a live workspace')
      for(const entry of entries){if(entry.id==='home'||documents.some(doc=>doc.id===entry.id))continue;documents.push({...entry})}
      for (const document of documents) {
        if (!document.sourceRevision && pinnedIds.includes(document.id)) {
          pinned.add(document.id)
          mounted.add(document.id)
        }
      }
      active=documents.some(doc=>doc.id===selected)?selected:'home'
      if(active!=='home')mounted.add(active)
      if(layout&&layout.left!==layout.right&&(active===layout.left||active===layout.right)&&
         [layout.left,layout.right].every(id=>id==='home'||documents.some(doc=>doc.id===id&&!doc.sourceRevision))){
        split=layout
        for(const id of [layout.left,layout.right])if(id!=='home')mounted.add(id)
      }
      emit()
    },
    renderedDocuments:()=>documents.filter(document=>mounted.has(document.id)).map(document=>({...document})),
    documents: () => documents.map(document => ({...document})),
    subscribe(listener: (tabs: TabSummary[]) => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    open, activate, close, closeMany, reopenClosed, canReopenClosed:()=>recentlyClosed.length>0, reorder, rename, setPinned, reserveOpen, isCitationExpired,
    splitBeside,resizeSplit,swapSplit,endSplit,splitView:()=>split,
    sleepIdleTabs,renderGeneration:(id:string)=>sleepGenerations.get(id)??0,
    setSleepGuard(id:string,guard:DocumentCloseGuard|null){
      if(guard&&mounted.has(id))sleepGuards.set(id,guard)
      else if(!guard)sleepGuards.delete(id)
    },
    isOpenCurrent:(token:DocumentOpenToken)=>token.sequence===selectionSequence,
    setGuard(id: string, guard: DocumentCloseGuard | null) {
      if (!documents.some(document => document.id === id)) return
      if (guard) guards.set(id, guard); else guards.delete(id)
    },
  }
}
