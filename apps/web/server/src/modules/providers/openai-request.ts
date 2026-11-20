import {createHash} from 'node:crypto'
import {ASSISTANT_MAX_REQUEST_BYTES} from '../../../../../../packages/web-contracts/src/assistant.ts'

export interface OpenAiBodyProfile {readonly model:string;readonly maxOutputTokens:number;readonly reasoningEffort?:'none'}
export interface OpenAiBody {readonly body:Buffer;readonly digest:string}
type Json = null | boolean | number | string | Json[] | {[key:string]:Json}
const invalid=()=>new Error('Invalid provider request')
const MAX_BODY=ASSISTANT_MAX_REQUEST_BYTES, MAX_TEXT=256*1024, MAX_OBJECT=64*1024
const MAX_IMAGE_BYTES=5*1024*1024,MAX_IMAGES=20
const IMAGE_MIMES=new Set(['image/png','image/jpeg','image/gif','image/webp'])
const unsafeKeys=new Set(['__proto__','prototype','constructor'])

/** Strict OpenAI request subset, not authority, token billing or tool execution.
 * The returned metadata is frozen; callers must retain a private body snapshot.
 * Transport must independently copy and verify its SHA256 before sending.
 */
export function buildOpenAiChatRequest(request:unknown,profile:unknown,historicalTools?:ReadonlySet<string>):Readonly<OpenAiBody> {
 try {
  let stringBytes=0,nodes=0
  function text(value:unknown,max=MAX_TEXT):string {
   if(typeof value!=='string'||/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))throw invalid()
   const size=Buffer.byteLength(value,'utf8');stringBytes+=size
   if(size>max||stringBytes>MAX_BODY)throw invalid()
   return value
  }
  function object(value:unknown,allowed?:readonly string[],required:readonly string[]=[]):Record<string,unknown> {
   if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw invalid()
   const keys=Reflect.ownKeys(value)
   if(keys.some(k=>typeof k!=='string'||unsafeKeys.has(k)||(allowed&&!allowed.includes(k))))throw invalid()
   for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key)!;if(!d.enumerable||!Object.hasOwn(d,'value'))throw invalid()}
   if(required.some(k=>!Object.hasOwn(value,k)))throw invalid()
   return value as Record<string,unknown>
  }
  function array(value:unknown,max:number,min=0):unknown[] {
   if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length<min||value.length>max)throw invalid()
   if(Reflect.ownKeys(value).length!==value.length+1)throw invalid()
   for(let i=0;i<value.length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!d.enumerable||!Object.hasOwn(d,'value'))throw invalid()}
   return value
  }
  function json(value:unknown,depth=0,parents=new Set<object>()):Json {
   if(++nodes>20000||depth>24)throw invalid()
   if(value===null||typeof value==='boolean')return value
   if(typeof value==='string')return text(value,MAX_OBJECT)
   if(typeof value==='number'){if(!Number.isFinite(value)||Object.is(value,-0))throw invalid();return value}
   if(!value||typeof value!=='object'||parents.has(value))throw invalid()
   parents.add(value)
   let result:Json
   if(Array.isArray(value))result=array(value,4096).map(v=>json(v,depth+1,parents))
   else {
    const v=object(value),out:Record<string,Json>=Object.create(null)
    for(const key of Object.keys(v).sort()){
     text(key,256);if(/[\u0000-\u001f\u007f]/.test(key))throw invalid()
     out[key]=json(v[key],depth+1,parents)
    }
    result=out
   }
   parents.delete(value)
   return result
  }
  function jsonObject(value:unknown):Record<string,Json> {
   object(value)
   const result=json(value) as Record<string,Json>
   if(Buffer.byteLength(JSON.stringify(result))>MAX_OBJECT)throw invalid()
   return result
  }
  function name(value:unknown,max=64):string {
   const result=text(value,max)
   if(!new RegExp(`^[A-Za-z0-9_-]{1,${max}}$`).test(result))throw invalid()
   return result
  }
  const p=object(profile,['model','maxOutputTokens','reasoningEffort'],['model','maxOutputTokens'])
  const model=text(p.model,256)
  if(!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(model)||typeof p.maxOutputTokens!=='number'||!Number.isSafeInteger(p.maxOutputTokens)||p.maxOutputTokens<1||p.maxOutputTokens>32768)throw invalid()
  if(Object.hasOwn(p,'reasoningEffort')&&p.reasoningEffort!=='none')throw invalid()
  const r=object(request,['system','messages','tools'],['system','messages','tools'])
  const system=text(r.system),declared=new Set<string>()
  const tools=array(r.tools,64).map(raw=>{
   const t=object(raw,['name','description','inputSchema'],['name','description','inputSchema']),n=name(t.name)
   if(declared.has(n))throw invalid();declared.add(n)
   return {type:'function',function:{name:n,description:text(t.description,8192),parameters:jsonObject(t.inputSchema)}}
  })
  const messages:Record<string,unknown>[]=[{role:'system',content:system}]
  const pending=new Map<string,string>(),seen=new Set<string>()
  for(const raw of array(r.messages,512,1)){
   const m=object(raw,['role','text','images','toolCalls','results'],['role'])
   if(pending.size&&m.role!=='tool')throw invalid()
   if(m.role==='user'){
    object(m,['role','text','images'],['role','text']);const content=text(m.text)
    if(!content.length)throw invalid()
    let multimodal:unknown=content
    if(Object.hasOwn(m,'images')){
     const images=array(m.images,MAX_IMAGES,1).map(raw=>{
      const image=object(raw,['base64','mime'],['base64','mime']),mime=text(image.mime,64),base64=text(image.base64,Math.ceil(MAX_IMAGE_BYTES/3)*4)
      if(!IMAGE_MIMES.has(mime)||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))throw invalid()
      const bytes=Buffer.from(base64,'base64')
      if(bytes.length<1||bytes.length>MAX_IMAGE_BYTES||bytes.toString('base64')!==base64)throw invalid()
      return {type:'image_url',image_url:{url:`data:${mime};base64,${base64}`}}
     })
     multimodal=[{type:'text',text:content},...images]
    }
    messages.push({role:'user',content:multimodal})
   }else if(m.role==='assistant'){
    object(m,['role','text','toolCalls'],['role','text']);const content=text(m.text)
    let calls:Record<string,unknown>[]|undefined
    if(Object.hasOwn(m,'toolCalls'))calls=array(m.toolCalls,64,1).map(raw=>{
     const c=object(raw,['id','name','input'],['id','name','input']),id=name(c.id,128),n=name(c.name)
     if(seen.has(id)||(!declared.has(n)&&!historicalTools?.has(n)))throw invalid();seen.add(id);pending.set(id,n)
     return {id,type:'function',function:{name:n,arguments:JSON.stringify(jsonObject(c.input))}}
    })
    if(!content.length&&!calls)throw invalid()
    messages.push({role:'assistant',content,...(calls?{tool_calls:calls}:{})})
   }else if(m.role==='tool'){
    object(m,['role','results'],['role','results']);const results=array(m.results,64,1)
    if(!pending.size||results.length!==pending.size)throw invalid()
    for(const raw of results){
     const result=object(raw,['id','name','output','isError'],['id','name','output'])
     const id=name(result.id,128),n=name(result.name)
     if(pending.get(id)!==n)throw invalid()
     if(Object.hasOwn(result,'isError')&&typeof result.isError!=='boolean')throw invalid()
     const content=JSON.stringify({output:text(result.output),...(Object.hasOwn(result,'isError')?{isError:result.isError}:{})})
     pending.delete(id);messages.push({role:'tool',tool_call_id:id,content})
    }
   }else throw invalid()
  }
  if(pending.size)throw invalid()
  const body=Buffer.from(JSON.stringify({model,max_tokens:p.maxOutputTokens,...(p.reasoningEffort?{reasoning_effort:p.reasoningEffort}:{}),stream:true,stream_options:{include_usage:true},messages,...(tools.length?{tools}:{})}),'utf8')
  if(body.byteLength>MAX_BODY)throw invalid()
  return Object.freeze({body,digest:createHash('sha256').update(body).digest('hex')})
 }catch{throw invalid()}
}
