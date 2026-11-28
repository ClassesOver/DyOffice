import {splitWidths,type WorkspaceSplit} from './document-tabs'

/** Navigation hints only. Never store bodies, names, URLs, leases or save receipts. */
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const MAX_ENTRIES=20
export type EntrySnapshot={ids:string[];active:string;pinned?:string[];split?:WorkspaceSplit}
const empty=():EntrySnapshot=>({ids:[],active:'home'})
function recoverSplit(value:unknown,ids:readonly string[],active:string):WorkspaceSplit|undefined {
 if(!value||typeof value!=='object'||!['left,right','left,right,width'].includes(Object.keys(value).sort().join(',')))return
 const {left,right,width}=value as Partial<WorkspaceSplit>
 if(typeof left!=='string'||typeof right!=='string'||left===right||
    (left!=='home'&&!ids.includes(left))||(right!=='home'&&!ids.includes(right))||(active!==left&&active!==right))return
 if(width!==undefined&&(!Number.isInteger(width)||width<splitWidths.minimum||width>splitWidths.maximum))return
 return {left,right,...(width===undefined?{}:{width})}
}

export function entryHash(id:string){return uuid.test(id)?`#/file/${id}`:'#/home'}
export function workspaceFileLink(id:string,origin:string){
 if(!uuid.test(id))throw new Error('无效的文档标识。')
 const url=new URL('/',origin)
 url.hash=entryHash(id)
 return url.href
}
export function parseEntryHash(hash:string):string|undefined {
 if(!hash)return undefined
 const match=/^#\/file\/([^/]+)$/.exec(hash)
 return match&&uuid.test(match[1])?match[1]:'home'
}
type EntryStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>
export function createEntryRecovery(storage:EntryStorage|undefined,deploymentId:string,userId:string,lastStorage?:EntryStorage){
 const namespace=`${encodeURIComponent(deploymentId)}:${encodeURIComponent(userId)}`
 const key=`dyoffice:entries:v1:${namespace}`
 const lastKey=`dyoffice:workspace:last:v1:${namespace}`
 const generationKey=`dyoffice:workspace:generation:v1:${namespace}`
 function currentGeneration(){
  try{
   const stored=lastStorage?.getItem(generationKey)??null
   return stored===null||/^[a-f0-9]{32}$/.test(stored)?stored:undefined
  }catch{return undefined}
 }
 let generation=currentGeneration()
 let latest:string|undefined
 let hadDocuments=false
 function clearTab(){
  latest=undefined;hadDocuments=false
  try{storage?.removeItem(key)}catch{/* Storage may be disabled. */}
 }
 function readStored(store:EntryStorage|undefined,entryKey:string):EntrySnapshot|undefined {
   try{
    const raw=store?.getItem(entryKey);if(!raw||raw.length>8192)return
    const value=JSON.parse(raw)
    if(!value||value.version!==1||(value.generation??null)!==(generation??null)||Object.keys(value).some(key=>!['active','generation','ids','pinned','split','version'].includes(key))||!Array.isArray(value.ids)||value.ids.length>MAX_ENTRIES||value.ids.some((id:unknown)=>typeof id!=='string'||!uuid.test(id))||new Set(value.ids).size!==value.ids.length||typeof value.active!=='string'||(value.active!=='home'&&!value.ids.includes(value.active)))return undefined
    if(value.pinned!==undefined&&(!Array.isArray(value.pinned)||value.pinned.length>value.ids.length||
       new Set(value.pinned).size!==value.pinned.length||value.pinned.some((id:unknown)=>!value.ids.includes(id))))return undefined
    const split=recoverSplit(value.split,value.ids,value.active)
   return {ids:[...value.ids],active:value.active,...(value.pinned?.length?{pinned:[...value.pinned]}:{}),...(split?{split}:{})}
   }catch{return undefined}
 }
 return {
  read(allowLast=false):EntrySnapshot {
   if(generation!==currentGeneration())return empty()
   return readStored(storage,key)??(allowLast&&generation!==undefined?readStored(lastStorage,lastKey):undefined)??empty()
  },
  save(ids:string[],active:string,pinned:readonly string[]=[],layout?:WorkspaceSplit|null){
   if(generation!==currentGeneration())return
   const selected=[...new Set(ids.filter(id=>uuid.test(id)))]
   const split=recoverSplit(layout,selected,active)
   const panes=split?[split.left,split.right].filter(id=>id!=='home'):[]
   const prioritized=[...(selected.includes(active)?[active]:[]),...panes,...selected.filter(id=>pinned.includes(id)),...selected]
   const keep=new Set([...new Set(prioritized)].slice(0,MAX_ENTRIES))
   const bounded=selected.filter(id=>keep.has(id))
   const pins=bounded.filter(id=>pinned.includes(id))
   latest=JSON.stringify({version:1,ids:bounded,active:keep.has(active)?active:'home',...(generation?{generation}:{}),...(pins.length?{pinned:pins}:{}),...(split?{split}:{})})
   if(bounded.length)hadDocuments=true
   try{storage?.setItem(key,latest)}catch{/* Storage is optional; navigation must remain usable. */}
  },
  checkpoint(){
   if(!hadDocuments||!latest||generation===undefined||generation!==currentGeneration())return
   try{lastStorage?.setItem(lastKey,latest)}catch{/* Storage may be disabled. */}
  },
  clear(){
   clearTab()
   if(!lastStorage)return
   try{
    const next=Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join('')
    // Keep a marker even when there is no checkpoint. Other open tabs may
    // still hold a previous layout and attempt to write it on pagehide.
    lastStorage.setItem(generationKey,next)
    generation=next
   }catch{/* Storage may be disabled. */}
   try{lastStorage.removeItem(lastKey)}catch{/* Storage may be disabled. */}
  },
  resume(){
   const current=currentGeneration()
   if(generation===current)return
   clearTab()
   generation=current
  },
 }
}

/** Reader must be bound to the authenticated session; never resolves arbitrary URLs. */
export async function resolveEntrySnapshot<T extends {id:string}>(snapshot:EntrySnapshot,route:string|undefined,read:(id:string)=>Promise<T>){
 const active=route??snapshot.active
 const ids=[...snapshot.ids]
 if(active!=='home'&&uuid.test(active)&&!ids.includes(active)){
  if(ids.length>=MAX_ENTRIES){
   let discard=ids.length-1
   while(discard>=0&&snapshot.pinned?.includes(ids[discard]))discard--
   ids.splice(discard,1)
  }
  ids.push(active)
 }
 const entries:T[]=[];let failed=0
 for(const id of ids){
  try{const entry=await read(id);if(entry.id!==id)throw Error('File identity mismatch');entries.push(entry)}
  catch(error){if((error as {status?:number})?.status===401||(error as {code?:string})?.code==='stale_session')throw error;failed++}
 }
 const surviving=entries.map(entry=>entry.id)
 const selected=surviving.includes(active)?active:'home'
 const split=recoverSplit(snapshot.split,surviving,selected)
 return {entries,active:selected,pinned:(snapshot.pinned??[]).filter(id=>surviving.includes(id)),failed,...(split?{split}:{})}
}
