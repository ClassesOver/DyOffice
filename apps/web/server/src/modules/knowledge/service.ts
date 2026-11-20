import type {PrincipalTransactions} from '../../db/context.ts'
import type {FileService} from '../files/service.ts'
import {runFileTransaction,scope,uuid} from '../files/queries.ts'
import {authError} from '../auth/sessions.ts'
import {parseBytesToText} from '../../../../../../packages/file-parse/src/index.ts'

const MAX_FILES=10_000,MAX_BYTES=50*1024*1024,MAX_TEXT=4_000_000,CHUNK=24_000
const pathPattern=/^\/files\/([0-9a-f-]{36})\/revisions\/([0-9a-f-]{36})\/([^/]+)$/i
function reference(path:string){
 if(typeof path!=='string'||path.length>1500)throw authError(400)
 const match=path.match(pathPattern)
 if(!match)throw authError(400)
 let title:string
 try{title=decodeURIComponent(match[3])}catch{throw authError(400)}
 if(!title||/[\\/\x00-\x1f\x7f]/.test(title))throw authError(400)
 return {fileId:uuid(match[1]),revision:uuid(match[2])}
}
type Row={id:string;revision:string;name:string;format:string;size:number;folder:string;folder_id:string|null}
const entry=(row:Row,path=`/files/${row.id}/revisions/${row.revision}/${encodeURIComponent(row.name)}`)=>({path,name:row.name,ext:row.format,sizeBytes:row.size,folder:row.folder,folderPath:row.folder_id?`/folders/${row.folder_id}`:'/files'})

/** 只读取个人收藏的已保存版本；opaque path永远不是服务器文件系统路径。 */
export function createKnowledgeService({transactions,files}:{transactions:PrincipalTransactions;files:FileService}){
 const rows=(token:string,ref?:{fileId:string;revision:string})=>runFileTransaction(transactions,token,'files:read',async(connection,principal)=>{
  const result=await connection.query<Row>(`
   SELECT f.id,f.name,f.format,r.id AS revision,r.size,COALESCE(d.name,'') AS folder,s.folder_id
   FROM files f
   JOIN workspace_file_state s ON s.deployment_id=f.deployment_id AND s.owner_id=f.owner_id AND s.file_id=f.id AND s.starred
   JOIN file_revisions r ON r.deployment_id=f.deployment_id AND r.owner_id=f.owner_id AND r.file_id=f.id AND r.id=${ref?'$4::uuid':'f.current_revision'}
   LEFT JOIN workspace_folders d ON d.deployment_id=s.deployment_id AND d.owner_id=s.owner_id AND d.id=s.folder_id
   WHERE f.deployment_id=$1 AND f.owner_id=$2 AND f.deleted_at IS NULL AND f.purge_started_at IS NULL
   ${ref?'AND f.id=$3::uuid':''}
   ORDER BY f.id LIMIT 10001`,[...scope(principal),...(ref?[ref.fileId,ref.revision]:[])])
  if(result.rows.length>MAX_FILES)throw authError(413)
  return result.rows
 })
 const requireFile=async(token:string,path:string)=>{
  const ref=reference(path),row=(await rows(token,ref))[0]
  if(!row)throw authError(404)
  if(row.size>MAX_BYTES)throw authError(413)
  return {ref,row}
 }
 async function text(token:string,path:string){
  const {ref,row}=await requireFile(token,path),bytes=await files.readFile(token,ref.fileId,ref.revision)
  if(bytes.length>MAX_BYTES)throw authError(413)
  const parsed=await parseBytesToText('knowledge.'+row.format,bytes)
  if(!parsed.ok||parsed.kind!=='text'||parsed.text===undefined)throw authError(422)
  // 完整解析后检查预算：extractor的maxChars可能按XML前缀截断，
  // 不能以返回字符串短于预算来证明正文完整。
  if(parsed.text.length>MAX_TEXT)throw authError(413)
  await requireFile(token,path)
  return {row,text:parsed.text}
 }
 return {
  async list(token:string){return (await rows(token)).map(row=>entry(row))},
  async read(token:string,path:string,offset=0){
   if(!Number.isSafeInteger(offset)||offset<0)throw authError(400)
   const result=await text(token,path)
   return {text:result.text.slice(offset,offset+CHUNK),totalChars:result.text.length,offset}
  },
  async search(token:string,input:{q:string;limit?:number;paths:string[]}){
   const {q,limit=8,paths}=input
   if(typeof q!=='string'||!q.trim()||[...q].length>200||/[\x00-\x1f\x7f]/.test(q)||!Number.isSafeInteger(limit)||limit<1||limit>20||!Array.isArray(paths)||paths.length>MAX_FILES||new Set(paths).size!==paths.length)throw authError(400)
   // 本轮目录就是搜索快照，后续保存不能悄悄把来源换成新版本。
   for(const path of paths)await requireFile(token,path)
   const terms=q.trim().toLowerCase().split(/\s+/u),hits=[]
   for(const path of paths){
    const result=await text(token,path),lower=result.text.toLowerCase()
    if(!terms.every(term=>lower.includes(term)))continue
    const start=Math.max(0,lower.indexOf(terms[0])-100),file=entry(result.row,path)
    hits.push({path:file.path,name:file.name,ext:file.ext,folder:file.folder,snippet:result.text.slice(start,start+400)})
    if(hits.length>=limit)break
   }
   for(const hit of hits)await requireFile(token,hit.path)
   return hits
  },
 }
}
export type KnowledgeService=ReturnType<typeof createKnowledgeService>
