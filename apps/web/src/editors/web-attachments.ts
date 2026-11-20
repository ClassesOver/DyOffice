import { SPREADSHEET_ATTACHMENT_EXTS } from '../../../sheets/src/shared/attachment-formats'

const MAX_BYTES=50*1024*1024
const MAX_IMAGE_BYTES=5*1024*1024
const IMAGE_MIME:Record<string,string>={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp'}
const SUPPORTED=new Set(['txt','md','markdown','csv','tsv','json','yaml','yml','xml','html','htm','log','js','ts','tsx','jsx','py','java','c','h','cpp','go','rs','rb','sh','sql','css','doc','docx','pdf','pptx','ppt','xlsx','xlsm','xls',...Object.keys(IMAGE_MIME)])
type Metadata={path:string;name:string;ext:string;sizeBytes:number}
type Parsed={ok:boolean;kind:'text'|'image'|'unsupported';text?:string;error?:string;truncated?:boolean}
type WebAttachment={file:File;metadata:Metadata;text?:string;truncated?:boolean}
type AddResult={accepted:Metadata[];rejected:string[]}
type Request=<T=unknown>(path:string,method?:string,body?:unknown)=>Promise<T>

export function createWebAttachments(request:Request,format?:string){
 const pending=new Map<string,Promise<WebAttachment>>(),filePaths=new WeakMap<File,string>()
 function register(file:File){
  const known=filePaths.get(file);if(known)return known
  const ext=file.name.split('.').at(-1)?.toLowerCase()??''
  const path='web-attachment:'+crypto.randomUUID()
  filePaths.set(file,path)
  if(!SUPPORTED.has(ext)){
   pending.set(path,Promise.reject(new Error(`${file.name}: unsupported file type`)))
   return path
  }
  if(file.size<1||file.size>MAX_BYTES){pending.set(path,Promise.reject(new Error(`${file.name}: file exceeds the 50 MiB limit`)));return path}
  if(IMAGE_MIME[ext]&&file.size>MAX_IMAGE_BYTES){pending.set(path,Promise.reject(new Error(`${file.name}: image exceeds the 5 MiB limit`)));return path}
  const metadata={path,name:file.name,ext,sizeBytes:file.size}
  const result=(async()=>{
   const attachment:WebAttachment={file,metadata}
   if(!IMAGE_MIME[ext]){
    const parsed=await request<Parsed>(`/api/v1/ai/attachments/parse?name=${encodeURIComponent(file.name)}`,'POST',file)
    if(!parsed.ok||parsed.kind!=='text'||typeof parsed.text!=='string')throw new Error(parsed.error??`${file.name}: text extraction failed`)
    // Excel merges the original file, independently of the extracted preview.
    if(parsed.truncated&&ext!=='xlsx'&&!(format==='xlsx'&&SPREADSHEET_ATTACHMENT_EXTS.has(ext)))
     throw new Error(`${file.name}: extracted text exceeds the Web attachment limit.`)
    attachment.text=parsed.text
    attachment.truncated=parsed.truncated===true
   }
   return attachment
  })()
  pending.set(path,result)
  return path
 }
 async function addFiles(files:readonly File[]):Promise<AddResult>{
  const accepted:Metadata[]=[],rejected:string[]=[]
  for(const file of files){
   const path=register(file)
   try{accepted.push((await pending.get(path)!).metadata)}catch(error){pending.delete(path);rejected.push(error instanceof Error?error.message:String(error))}
  }
  return {accepted,rejected}
 }
 async function addAttachmentPaths(paths:readonly string[]){
  const accepted:Metadata[]=[],rejected:string[]=[]
  for(const path of paths){const task=pending.get(path);if(!task){rejected.push('Attachment is no longer available.');continue}try{accepted.push((await task).metadata)}catch(error){pending.delete(path);rejected.push(error instanceof Error?error.message:String(error))}}
  return {accepted,rejected}
 }
 function pickAttachments():Promise<AddResult>{
  return new Promise(resolve=>{
   const input=document.createElement('input');input.type='file';input.multiple=true;input.accept=[...SUPPORTED].map(ext=>'.'+ext).join(',');input.hidden=true
   const finish=async()=>{input.remove();resolve(await addFiles([...(input.files??[])]))}
   input.addEventListener('change',()=>void finish(),{once:true});input.addEventListener('cancel',()=>{input.remove();resolve({accepted:[],rejected:[]})},{once:true})
   document.body.append(input);input.click()
  })
 }
 async function readAttachment(path:string,offset=0,maxChars=24_000){
  try{const attachment=await pending.get(path);if(!attachment)throw new Error('Attachment is no longer available.')
   if(attachment.truncated)return {ok:false,truncated:true,error:`${attachment.metadata.name}: only partial extracted text is available; the original spreadsheet remains available for merge. Reading the full attachment text is unavailable.`}
   if(IMAGE_MIME[attachment.metadata.ext])throw new Error('Image attachments are sent with the message.')
   const text=attachment.text??'',start=Math.max(0,Math.min(text.length,Math.trunc(offset)||0)),length=Math.max(1,Math.min(24_000,Math.trunc(maxChars)||24_000))
   return {ok:true,name:attachment.metadata.name,totalChars:text.length,offset:start,text:text.slice(start,start+length)}
  }catch(error){return {ok:false,error:error instanceof Error?error.message:String(error)}}
 }
 async function readAttachmentImage(path:string){
  try{
   const attachment=await pending.get(path);if(!attachment)throw new Error('Attachment is no longer available.')
   const mime=IMAGE_MIME[attachment.metadata.ext];if(!mime)throw new Error('Not an image attachment.')
   const bytes=new Uint8Array(await attachment.file.arrayBuffer());let binary=''
   for(let offset=0;offset<bytes.length;offset+=0x8000)binary+=String.fromCharCode(...bytes.subarray(offset,offset+0x8000))
   return {ok:true,base64:btoa(binary),mime}
  }catch(error){return {ok:false,error:error instanceof Error?error.message:String(error)}}
 }
 async function addPastedImage(data:ArrayBuffer,ext:string){
  const normalized=ext.toLowerCase(),mime=IMAGE_MIME[normalized]
  if(!mime)return {accepted:[],rejected:[`Unsupported image type: ${ext}`]}
  return addFiles([new File([data],`pasted.${normalized}`,{type:mime})])
 }
 return {pickAttachments,addFiles,getPathForFile(file:File){return file instanceof File?register(file):''},async getFileForPath(path:string){const attachment=await pending.get(path);return attachment?.file??null},addAttachmentPaths,addPastedImage,readAttachment,readAttachmentImage,dispose(){pending.clear()}}
}
