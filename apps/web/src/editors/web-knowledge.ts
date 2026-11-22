import type {DesktopApi} from '../../../docs/src/shared/ipc'
import type {SettingsRequest} from '../../../../packages/browser-host/src/preferences'
type KbFile=Awaited<ReturnType<DesktopApi['kbList']>>[number]
type Source={file:KbFile;serverPath:string;fileId:string;revision:string}
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const pinnedPath=new RegExp(`^(/files/(${uuid})/revisions/(${uuid}))/([^/]+)$`)
function source(path:string){
 const match=pinnedPath.exec(path);if(!match)throw Error('Unknown knowledge source')
 const name=decodeURIComponent(match[4]!)
 if(!name||/[\\/\u0000-\u001f\u007f]/.test(name)||encodeURIComponent(name)!==match[4]||!/[.](docx|xlsx|pptx|pdf)$/i.test(name))throw Error('Invalid knowledge source')
 return {reference:match[1]!,fileId:match[2]!,revision:match[3]!,name}
}
/** 使用助手现有的登录绑定请求；知识库路径只是版本引用，不是本地文件路径。 */
export function createWebKnowledge(request?:SettingsRequest){
 let disposed=false,epoch=0,files=new Map<string,Source>()
 const active=()=>{if(disposed||!request)throw Error('Knowledge base unavailable')}
 function findSource(path:string,allowLegacyEscaping=false){
  const direct=files.get(path)
  if(direct)return direct
  const match=pinnedPath.exec(path)
  if(!match)return undefined
  const entry=files.get(match[1]!)
  if(entry?.serverPath===path)return entry
  // Old conversations may still contain a partially double-escaped filename.
  const legacyName=match[4]!.replace(/%25(?=[0-9a-f]{2})/gi,'%')
  return allowLegacyEscaping&&entry?.serverPath===`${match[1]}/${legacyName}`?entry:undefined
 }
 function known(path:string){
  active()
  const entry=findSource(path)
  if(!entry)throw Error('Unknown knowledge source')
  return entry
 }
 function parent(){
  const current=window.parent as Window & {dyofficeOpenKnowledgeSource?:(id:string,revision:string)=>Promise<void>}
  if(current===window||current.location.origin!==window.location.origin||typeof current.dyofficeOpenKnowledgeSource!=='function')throw Error('Workspace source navigation unavailable')
  return current
 }
 async function kbRead(path:string,offset:number){
  const entry=known(path)
  if(!Number.isSafeInteger(offset)||offset<0)throw Error('Invalid knowledge offset')
  const stamp=epoch,page=await request!<Awaited<ReturnType<DesktopApi['kbRead']>>>(`/api/v1/knowledge/read?path=${encodeURIComponent(entry.serverPath)}&offset=${offset}`)
  known(path);if(stamp!==epoch)throw Error('Knowledge corpus changed')
  if(!page||typeof page.text!=='string'||page.text.length>24000||!Number.isSafeInteger(page.totalChars)||page.totalChars<0||page.offset!==offset||(offset>=page.totalChars?page.text.length!==0:page.offset+page.text.length>page.totalChars))throw Error('Invalid knowledge page')
  return page
 }
 return {
  async kbList(){
   active();const stamp=++epoch;files.clear()
   const result=await request!<KbFile[]>('/api/v1/knowledge/files')
   active();if(stamp!==epoch)throw Error('Knowledge corpus changed')
   const next=new Map<string,Source>()
   if(!Array.isArray(result))throw Error('Invalid knowledge corpus')
   for(const file of result){
    if(!file||typeof file.path!=='string')throw Error('Invalid knowledge corpus')
    const {reference,fileId,revision,name}=source(file.path)
    if(name!==file.name||file.ext!==name.split('.').at(-1)?.toLowerCase()||typeof file.folder!=='string'||typeof file.folderPath!=='string'||!Number.isSafeInteger(file.sizeBytes)||file.sizeBytes<0||next.has(reference))throw Error('Invalid knowledge corpus')
    next.set(reference,{file:{...file,path:reference},serverPath:file.path,fileId,revision})
   }
   files=next;return [...files.values()].map(({file})=>({...file}))
  },
  async kbSearch(query:{q:string;limit?:number}){
   active();if(typeof query.q!=='string')throw Error('Invalid knowledge query')
   const q=query.q.trim().slice(0,200),limit=Math.max(1,Math.min(20,Math.trunc(query.limit??8)||8)),stamp=epoch,paths=[...files.values()].map(entry=>entry.serverPath)
   if(!q||!paths.length)return []
   const hits=await request!<Awaited<ReturnType<DesktopApi['kbSearch']>>>('/api/v1/knowledge/search','POST',{q,limit,paths})
   active();if(stamp!==epoch)throw Error('Knowledge corpus changed')
   if(!Array.isArray(hits)||hits.length>limit)throw Error('Invalid knowledge search results')
   return hits.map(hit=>{
    const entry=typeof hit?.path==='string'?findSource(hit.path):undefined
    if(!entry||entry.serverPath!==hit.path||typeof hit.name!=='string'||typeof hit.ext!=='string'||typeof hit.folder!=='string'||typeof hit.snippet!=='string')throw Error('Invalid knowledge search results')
    const {path,name,ext,folder}=entry.file
    return {path,name,ext,folder,snippet:hit.snippet}
   })
  },kbRead,citationPath:(path:string)=>findSource(path,true)?.file.path,
  async openSourcePath(path:string){
   const entry=findSource(path,true)
   if(!entry)throw Error('Unknown knowledge source')
   const host=parent()
   await kbRead(entry.file.path,0)
   if(parent()!==host)throw Error('Workspace source navigation changed')
   const {fileId,revision}=entry
   await host.dyofficeOpenKnowledgeSource!(fileId,revision)
  },
  dispose(){disposed=true;epoch++;files.clear()},
 }
}
