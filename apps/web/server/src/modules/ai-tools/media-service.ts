import {AI_MEDIA_PROVIDERS,providerHasCapability} from '../../../../../../packages/ai-provider/src/media.ts'
import {analyzeMediaWithProvider,generateImageWithProvider,type ByokMediaProviderId,type MediaBlob} from '../../../../../../packages/ai-provider/src/media-protocols.ts'
import {loadMediaReferences} from '../../../../../../packages/ai-search/src/media-tools.ts'
import type {PrincipalTransactions} from '../../db/context.ts'
import {tokenHash} from '../auth/sessions.ts'
import type {SecretKeyring,SecretEnvelope} from '../admin/secrets.ts'
import {createSecretBox} from '../admin/secrets.ts'

type MediaKind='image_generation'|'image_analysis'|'video_analysis'
type Config={revision:number;id:string;kind:MediaKind;providerId:string;model:string;baseUrl:string;envelope:SecretEnvelope|null}
type MediaInput={mediaUrls:string[];requirements:string}
type GenerateInput={prompt:string;aspectRatio?:string;referenceImageUrls?:string[];transparentBackground?:boolean}
type MediaRunners={
 generate:(provider:ByokMediaProviderId,config:{apiKey:string;baseUrl?:string;imageModel:string;analysisModel:string},input:{prompt:string;aspectRatio?:string;references?:MediaBlob[];transparent?:boolean})=>Promise<MediaBlob>
 analyze:(provider:ByokMediaProviderId,config:{apiKey:string;baseUrl?:string;imageModel:string;analysisModel:string},input:{media:MediaBlob[];requirements:string})=>Promise<string>
 loadMedia:(refs:readonly string[])=>Promise<MediaBlob[]>
}
const unavailable=()=>new Error('AI media unavailable')
const MAX_ITEMS=12
const MAX_PROMPT_CHARS=4000
const MAX_REQUIREMENTS_CHARS=2000
const MAX_MEDIA_ITEM_BYTES=5*1024*1024
const MAX_MEDIA_TOTAL_BYTES=12*1024*1024
const MAX_OUTPUT_BYTES=12*1024*1024
const ratios=new Set(['1:1','4:3','16:9','9:16','3:4','2:3','3:2','auto'])
const allowedReference=(value:unknown)=>typeof value==='string'&&(value.startsWith('data:')||/^https?:\/\//i.test(value))

export function createAiMediaService({transactions,keyring,media={generate:generateImageWithProvider,analyze:analyzeMediaWithProvider,loadMedia:refs=>loadMediaReferences(refs,{maxItems:MAX_ITEMS,maxItemBytes:MAX_MEDIA_ITEM_BYTES,maxTotalBytes:MAX_MEDIA_TOTAL_BYTES,concurrency:2})}}:{transactions:PrincipalTransactions;keyring?:SecretKeyring;media?:MediaRunners}){
 const box=keyring?createSecretBox(keyring):undefined
 async function configuration(token:string,kind:MediaKind,capability:'image'|'analysis'|'video'){
  const saved=await transactions.withPrincipalTransaction({kind:'session',token},async(connection,principal)=>{
   if(!principal.roles.includes('personal'))throw unavailable()
   await connection.query("SELECT set_config('dyoffice.global_session_hash',$1,true),set_config('dyoffice.global_idle_ms',$2,true)",[tokenHash(token),String(transactions.sessionIdleMs)])
   const result=await connection.query<{config:Config|null}>('SELECT global_ai_tool_provider($1) AS config',[kind])
   const value=result.rows[0]?.config
   if(!value||value.kind!==kind||!Number.isSafeInteger(value.revision)||value.revision<0||typeof value.id!=='string'||typeof value.providerId!=='string'||typeof value.model!=='string'||typeof value.baseUrl!=='string')throw unavailable()
   return {value,deploymentId:principal.deploymentId}
  })
  const {value,deploymentId}=saved,meta=AI_MEDIA_PROVIDERS.find(item=>item.id===value.providerId)
  if(!meta||value.providerId==='genspark'||!providerHasCapability(meta,capability))throw unavailable()
  let apiKey=''
  if(value.envelope){
   if(!box)throw unavailable()
   try{apiKey=box.unseal(value.envelope,{deploymentId,configId:value.id,providerId:value.providerId,kind})}catch{throw unavailable()}
  }
  if(meta.needsBaseUrl?!value.baseUrl:!apiKey)throw unavailable()
  const config={apiKey,baseUrl:value.baseUrl||undefined,imageModel:kind==='image_generation'?value.model:'',analysisModel:kind==='image_generation'?'':value.model}
  return {provider:value.providerId as ByokMediaProviderId,config}
 }
 async function load(refs:unknown){
  if(!Array.isArray(refs)||refs.length<1||refs.length>MAX_ITEMS||!refs.every(allowedReference))throw unavailable()
  try{
   const result=await media.loadMedia(refs as string[])
   if(!Array.isArray(result)||result.length!==refs.length||result.some(item=>!item||!(item.bytes instanceof Uint8Array)||item.bytes.byteLength<1||item.bytes.byteLength>MAX_MEDIA_ITEM_BYTES||typeof item.mime!=='string'))throw unavailable()
   if(result.reduce((sum,item)=>sum+item.bytes.byteLength,0)>MAX_MEDIA_TOTAL_BYTES)throw unavailable()
   return result
  }catch{throw unavailable()}
 }
 async function generateImage(token:string,input:GenerateInput){
  if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token)||!input||typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>MAX_PROMPT_CHARS||(input.aspectRatio!==undefined&&!ratios.has(input.aspectRatio))||(input.transparentBackground!==undefined&&typeof input.transparentBackground!=='boolean'))throw unavailable()
  const references=input.referenceImageUrls===undefined?undefined:await load(input.referenceImageUrls)
  if(references?.some(item=>!item.mime.startsWith('image/')))throw unavailable()
  const {provider,config}=await configuration(token,'image_generation','image')
  try{
   const image=await media.generate(provider,config,{prompt:input.prompt.trim(),...(input.aspectRatio?{aspectRatio:input.aspectRatio}:{}),...(references?{references}:{}),...(input.transparentBackground?{transparent:true}:{})})
   if(!(image.bytes instanceof Uint8Array)||image.bytes.length<1||image.bytes.length>MAX_OUTPUT_BYTES||!['image/png','image/jpeg','image/webp'].includes(image.mime))throw unavailable()
   return {url:`data:${image.mime};base64,${Buffer.from(image.bytes).toString('base64')}`}
  }catch{throw unavailable()}
 }
 async function analyzeMedia(token:string,input:MediaInput){
  if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token)||!input||typeof input.requirements!=='string'||!input.requirements.trim()||input.requirements.length>MAX_REQUIREMENTS_CHARS)throw unavailable()
  const items=await load(input.mediaUrls)
  const capability=items.every(item=>item.mime.startsWith('image/'))?'analysis':'video'
  const kind=capability==='analysis'?'image_analysis':'video_analysis'
  const {provider,config}=await configuration(token,kind,capability)
  try{
   const text=await media.analyze(provider,config,{media:items,requirements:input.requirements.trim()})
   if(typeof text!=='string'||!text.trim()||text.length>64_000)throw unavailable()
   return {text}
  }catch{throw unavailable()}
 }
 async function fetchImage(token:string,url:string){
  if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token)||typeof url!=='string'||url.length>4096||!/^https:\/\//i.test(url))throw unavailable()
  const [image]=await load([url])
  if(!image||!['image/png','image/jpeg','image/gif','image/webp'].includes(image.mime))throw unavailable()
  return {base64:Buffer.from(image.bytes).toString('base64'),mime:image.mime}
 }
 return {generateImage,analyzeMedia,fetchImage}
}
