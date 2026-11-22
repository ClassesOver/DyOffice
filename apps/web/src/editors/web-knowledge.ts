import type {DesktopApi} from '../../../docs/src/shared/ipc'
import type {SettingsRequest} from '../../../../packages/browser-host/src/preferences'
type KbFile=Awaited<ReturnType<DesktopApi['kbList']>>[number]
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const pinnedPath=new RegExp(`^/files/(${uuid})/revisions/(${uuid})/([^/]+)$`)
function source(path:string){
 const match=pinnedPath.exec(path);if(!match)throw Error('Unknown knowledge source')
 const name=decodeURIComponent(match[3]!)
 if(!name||/[\\/\u0000-\u001f\u007f]/.test(name)||encodeURIComponent(name)!==match[3]||!/[.](docx|xlsx|pptx|pdf)$/i.test(name))throw Error('Invalid knowledge source')
 return {fileId:match[1]!,name}
}
/** 使用助手现有的登录绑定请求；知识库路径只是版本引用，不是本地文件路径。 */
export function createWebKnowledge(request?:SettingsRequest){
 let disposed=false,epoch=0,files=new Map<string,KbFile>()
 const active=()=>{if(disposed||!request)throw Error('Knowledge base unavailable')}
 const known=(path:string)=>{active();source(path);if(!files.has(path))throw Error('Unknown knowledge source')}
 function citationPath(path:string){
  if(files.has(path))return path
  const match=pinnedPath.exec(path)
  if(!match)return undefined
  // Markdown may carry a partially double-escaped filename from the model.
  // Reuse the corpus path only when the file, revision and filename all match.
  const encodedName=match[3]!.replace(/%25(?=[0-9a-f]{2})/gi,'%')
  const canonical=`/files/${match[1]}/revisions/${match[2]}/${encodedName}`
  return files.has(canonical)?canonical:undefined
 }
 function parent(){
  const current=window.parent as Window & {aiOffice?:{openPath:(id:string)=>Promise<void>}}
  if(current===window||current.location.origin!==window.location.origin||typeof current.aiOffice?.openPath!=='function')throw Error('Workspace source navigation unavailable')
  return current
 }
 async function kbRead(path:string,offset:number){
  known(path)
  if(!Number.isSafeInteger(offset)||offset<0)throw Error('Invalid knowledge offset')
  const stamp=epoch,page=await request!<Awaited<ReturnType<DesktopApi['kbRead']>>>(`/api/v1/knowledge/read?path=${encodeURIComponent(path)}&offset=${offset}`)
  known(path);if(stamp!==epoch)throw Error('Knowledge corpus changed')
  if(!page||typeof page.text!=='string'||page.text.length>24000||!Number.isSafeInteger(page.totalChars)||page.totalChars<0||page.offset!==offset||(offset>=page.totalChars?page.text.length!==0:page.offset+page.text.length>page.totalChars))throw Error('Invalid knowledge page')
  return page
 }
 return {
  async kbList(){
   active();const stamp=++epoch;files.clear()
   const result=await request!<KbFile[]>('/api/v1/knowledge/files')
   active();if(stamp!==epoch)throw Error('Knowledge corpus changed')
   const next=new Map<string,KbFile>()
   if(!Array.isArray(result))throw Error('Invalid knowledge corpus')
   for(const file of result){
    if(!file||typeof file.path!=='string'||source(file.path).name!==file.name||file.ext!==file.name.split('.').at(-1)?.toLowerCase()||typeof file.folder!=='string'||typeof file.folderPath!=='string'||!Number.isSafeInteger(file.sizeBytes)||file.sizeBytes<0||next.has(file.path))throw Error('Invalid knowledge corpus')
    next.set(file.path,{...file})
   }
   files=next;return [...files.values()].map(file=>({...file}))
  },
  async kbSearch(query:{q:string;limit?:number}){
   active();if(typeof query.q!=='string')throw Error('Invalid knowledge query')
   const q=query.q.trim().slice(0,200),limit=Math.max(1,Math.min(20,Math.trunc(query.limit??8)||8)),stamp=epoch,paths=[...files.keys()]
   if(!q||!paths.length)return []
   const hits=await request!<Awaited<ReturnType<DesktopApi['kbSearch']>>>('/api/v1/knowledge/search','POST',{q,limit,paths})
   active();if(stamp!==epoch)throw Error('Knowledge corpus changed')
   if(!Array.isArray(hits)||hits.length>limit||hits.some(hit=>{const file=files.get(hit.path);return !file||typeof hit.name!=='string'||typeof hit.ext!=='string'||typeof hit.folder!=='string'||typeof hit.snippet!=='string'}))throw Error('Invalid knowledge search results')
   return hits.map(hit=>{const file=files.get(hit.path)!;return {...hit,name:file.name,ext:file.ext,folder:file.folder}})
  },kbRead,citationPath,
  async openSourcePath(path:string){const canonical=citationPath(path);if(!canonical)throw Error('Unknown knowledge source');const host=parent();await kbRead(canonical,0);if(parent()!==host)throw Error('Workspace source navigation changed');await host.aiOffice!.openPath(source(canonical).fileId)},
  dispose(){disposed=true;epoch++;files.clear()},
 }
}
