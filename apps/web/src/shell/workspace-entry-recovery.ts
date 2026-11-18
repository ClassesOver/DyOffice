/** Navigation hints only. Never store bodies, names, URLs, leases or save receipts. */
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const MAX_ENTRIES=20
export type EntrySnapshot={ids:string[];active:string}
const empty=():EntrySnapshot=>({ids:[],active:'home'})
export function entryHash(id:string){return uuid.test(id)?`#/file/${id}`:'#/home'}
export function parseEntryHash(hash:string):string|undefined {
 if(!hash)return undefined
 const match=/^#\/file\/([^/]+)$/.exec(hash)
 return match&&uuid.test(match[1])?match[1]:'home'
}
export function createEntryRecovery(storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>,deploymentId:string,userId:string){
 const key=`dyoffice:entries:v1:${encodeURIComponent(deploymentId)}:${encodeURIComponent(userId)}`
 return {
  read():EntrySnapshot {
   try{
    const raw=storage.getItem(key);if(!raw||raw.length>8192)return empty()
    const value=JSON.parse(raw)
    if(!value||value.version!==1||Object.keys(value).sort().join(',')!=='active,ids,version'||!Array.isArray(value.ids)||value.ids.length>MAX_ENTRIES||value.ids.some((id:unknown)=>typeof id!=='string'||!uuid.test(id))||new Set(value.ids).size!==value.ids.length||typeof value.active!=='string'||(value.active!=='home'&&!value.ids.includes(value.active)))return empty()
    return {ids:[...value.ids],active:value.active}
   }catch{return empty()}
  },
  save(ids:string[],active:string){
   const selected=[...new Set(ids.filter(id=>uuid.test(id)))]
   let bounded=selected.slice(0,MAX_ENTRIES)
   if(selected.includes(active)&&!bounded.includes(active))bounded=[...bounded.slice(0,MAX_ENTRIES-1),active]
   try{storage.setItem(key,JSON.stringify({version:1,ids:bounded,active:bounded.includes(active)?active:'home'}))}catch{/* Storage is optional; navigation must remain usable. */}
  },
  clear(){try{storage.removeItem(key)}catch{/* Storage may be disabled. */}},
 }
}

/** Reader must be bound to the authenticated session; never resolves arbitrary URLs. */
export async function resolveEntrySnapshot<T extends {id:string}>(snapshot:EntrySnapshot,route:string|undefined,read:(id:string)=>Promise<T>){
 const active=route??snapshot.active
 const ids=[...snapshot.ids]
 if(active!=='home'&&uuid.test(active)&&!ids.includes(active)){if(ids.length>=MAX_ENTRIES)ids.pop();ids.push(active)}
 const entries:T[]=[];let failed=0
 for(const id of ids){
  try{const entry=await read(id);if(entry.id!==id)throw Error('File identity mismatch');entries.push(entry)}
  catch(error){if((error as {status?:number})?.status===401||(error as {code?:string})?.code==='stale_session')throw error;failed++}
 }
 return {entries,active:entries.some(entry=>entry.id===active)?active:'home',failed}
}
