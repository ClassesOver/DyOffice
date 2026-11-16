import type {HomeApi, RecentEntry, RecentQuery} from '../../../shell/src/shared/home-api'
export interface WebFile {id:string;name:string;format:string;size:number;updatedAt:string}
interface Dependencies {
 request(path:string,method?:string,body?:unknown):Promise<unknown>
 open(id:string):Promise<void>
 changed():void
 unsupported(message:string):void
 browse?():Promise<void>
}
/** Only Web-supported behavior is provided. Native mutations never resolve as success. */
export function createWebHomeBridge(deps:Dependencies):HomeApi {
 const stars=new Set<string>() // explicitly session-only until the server exposes a starred API
 const unsupported=async(name:string)=>{const error=new Error(`${name} is not supported in this Web build`);deps.unsupported(error.message);throw error}
 async function entries():Promise<RecentEntry[]>{const files=await deps.request('/files') as WebFile[];return files.map(f=>({path:f.id,name:f.name,ext:f.format,mtimeMs:Date.parse(f.updatedAt),sizeBytes:f.size,starred:stars.has(f.id)}))}
 async function page(query:RecentQuery={},starred=false){const all=(await entries()).filter(f=>!starred||f.starred);const filtered=all.filter(f=>!query.ext||f.ext===query.ext);return {entries:filtered.slice(query.offset||0,(query.offset||0)+(query.limit??50)),total:filtered.length,totalAll:all.length}}
 const bridge:Partial<HomeApi>={
 recents:q=>page(q),starred:q=>page(q,true),starredGroups:async()=>[],
 toggleStar:async path=>{stars.has(path)?stars.delete(path):stars.add(path);deps.changed()},
 unstarPaths:async paths=>{paths.forEach(p=>stars.delete(p));deps.changed()},
 statPaths:async paths=>(await entries()).filter(f=>paths.includes(f.path)),
 folderRoots:async()=>[],onFolderChanged:()=>()=>{},
 openPath:deps.open,browse:deps.browse||(()=>unsupported('Open file')),
 getLanguage:async()=>((await deps.request('/preferences')) as {language:'zh'|'en'}).language,
 setLanguage:async language=>{await deps.request('/preferences','PUT',{language})},
 getTheme:async()=>((await deps.request('/preferences')) as {theme:'system'|'light'|'dark'}).theme,
 setTheme:async theme=>{await deps.request('/preferences','PUT',{theme})},
 onThemeChanged:()=>()=>{},onOpenSettings:()=>()=>{},
 searchFiles:async query=>{const files=(await entries()).filter(f=>(!query.ext||f.ext===query.ext)&&f.name.toLowerCase().includes(query.q.toLowerCase()));return {hits:files.map(f=>({...f,snippet:null,needles:[query.q]})),total:files.length,index:{indexed:files.length,pending:0,scanning:false}} as Awaited<ReturnType<HomeApi['searchFiles']>>},
 rerankSearch:async()=>null,
 }
 return new Proxy(bridge,{get(target,key){if(key in target)return target[key as keyof HomeApi];if(key==='starPromptShouldShow')return undefined;return ()=>unsupported(String(key))}}) as HomeApi
}
