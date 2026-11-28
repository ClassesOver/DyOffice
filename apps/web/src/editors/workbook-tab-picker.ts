import {workbookPickSelectionSchema, type WorkbookPickSelection} from '../../../sheets/src/shared/desktop-api'
import type {DraftCopyFrame} from './draft-copy-authority'

type PickId = {pickId:string}
type Listener<T> = (value:T) => void
type Tab = {
  wcId:number
  id:string
  live:()=>boolean
  armed:Set<Listener<PickId>>
  selected:Set<Listener<WorkbookPickSelection>>
  cancelled:Set<Listener<PickId>>
}
export type RegisterWorkbookPicker = (caller:Window,fileId:string,ready:()=>boolean) => ReturnType<typeof createWorkbookTabPicker> | undefined
declare global { interface Window { dyofficeRegisterWorkbookPicker?:RegisterWorkbookPicker } }

export function createWorkspaceWorkbookPicker(stage:Window,activate:(id:string)=>void):RegisterWorkbookPicker {
  const tabs = new Map<number,Tab>()
  let next = 0
  let pending: {pickId:string;source:Tab;target:Tab} | undefined
  function cancel() {
    if (!pending) return
    const {source,target,pickId} = pending
    pending = undefined
    for (const tab of [source,target]) for (const listener of tab.cancelled) listener({pickId})
  }
  return (caller,fileId,ready) => {
    let frame: DraftCopyFrame | null
    try { frame = caller.frameElement as DraftCopyFrame | null } catch { return }
    const bound = () => !!frame?.isConnected && frame.ownerDocument === stage.document &&
      frame.contentWindow === caller && frame.dataset.documentId === fileId && frame.dyofficeDraftCopySessionActive?.() === true
    if (!bound()) return
    const tab:Tab = {id:fileId,wcId:++next,live:()=>bound()&&ready(),armed:new Set(),selected:new Set(),cancelled:new Set()}
    tabs.set(tab.wcId,tab)
    return createWorkbookTabPicker(
      () => tab.live() ? [...tabs.values()].filter(other=>other.id!==fileId&&other.live()).map(({id,wcId})=>({id,wcId})) : [],
      async wcId => {
        const target=tabs.get(wcId)
        if (!tab.live() || !target?.live() || target.id===fileId) throw new Error('Workbook tab is unavailable')
        cancel()
        const pickId='pick-'+crypto.randomUUID()
        pending={pickId,source:tab,target}
        activate(target.id)
        for (const listener of target.armed) listener({pickId})
        return {pickId}
      },
      async input => {
        const selection=workbookPickSelectionSchema.safeParse(input)
        if (!selection.success || !pending || pending.target!==tab || pending.pickId!==selection.data.pickId) return
        const {source}=pending
        if (!source.live() || !tab.live()) { cancel(); return }
        pending=undefined
        activate(source.id)
        for (const listener of source.selected) listener(selection.data)
      },
      async pickId => {
        if (pending?.pickId!==pickId || (pending.source!==tab && pending.target!==tab)) return
        const source = pending.source
        cancel()
        if (source.live()) activate(source.id)
      },
      tab,
      () => {
        tabs.delete(tab.wcId)
        if (pending?.source===tab || pending?.target===tab) cancel()
      },
    )
  }
}

function createWorkbookTabPicker(
  list:()=>{id:string;wcId:number}[],arm:(id:number)=>Promise<PickId>,send:(selection:WorkbookPickSelection)=>Promise<void>,
  cancel:(id:string)=>Promise<void>,tab:Tab,dispose:()=>void,
) {
  const subscribe = <T>(listeners:Set<Listener<T>>,listener:Listener<T>) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  return {list,arm,send,cancel,dispose,
    onArmed:(listener:Listener<PickId>)=>subscribe(tab.armed,listener),
    onSelected:(listener:Listener<WorkbookPickSelection>)=>subscribe(tab.selected,listener),
    onCancelled:(listener:Listener<PickId>)=>subscribe(tab.cancelled,listener),
  }
}
