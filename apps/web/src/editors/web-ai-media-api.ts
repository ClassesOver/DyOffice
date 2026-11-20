import type {SettingsRequest} from '../../../../packages/browser-host/src/preferences.ts'

type GenerateInput={prompt:string;aspectRatio?:string;referenceImageUrls?:string[];transparentBackground?:boolean}
type GenerateReply={url?:string;error?:string}
type AnalyzeInput={mediaUrls:string[];requirements:string}
type AnalyzeReply={text?:string;error?:string}
type FetchedImage={base64:string;mime:string}

export function createWebAiMediaApi(request:SettingsRequest){
 const generate=(input:GenerateInput,signal?:AbortSignal):Promise<GenerateReply>=>request('/api/v1/ai/media','POST',{action:'generate_image',...input},...(signal?[signal]:[]))
 return {
  aiGenerateImage(input:{prompt:string;aspectRatio?:string}):Promise<GenerateReply>{return generate(input)},
  generateImage(input:GenerateInput,signal?:AbortSignal):Promise<GenerateReply>{return generate(input,signal)},
  analyzeMedia(input:AnalyzeInput):Promise<AnalyzeReply>{return request('/api/v1/ai/media','POST',{action:'analyze_media',...input})},
  async fetchImage(url:string,signal?:AbortSignal):Promise<FetchedImage|null>{
   try{return await request<FetchedImage>('/api/v1/ai/media','POST',{action:'fetch_image',url},...(signal?[signal]:[]))}
   catch{return null}
  },
 }
}

const WORKBOOK_IMAGE_PREFIX = 'https://generated-image.invalid/'
type DocumentImageMedia = Pick<ReturnType<typeof createWebAiMediaApi>, 'generateImage' | 'fetchImage'>

export function createDocumentImageApi(media: DocumentImageMedia) {
  const images = new Map<string, FetchedImage>()
  let disposed=false
  return {
    async generateImage(input: GenerateInput,signal?:AbortSignal): Promise<GenerateReply> {
      signal?.throwIfAborted()
      if(disposed)throw Error('Image session closed')
      const result = await media.generateImage(input,signal)
      signal?.throwIfAborted()
      if(disposed)throw Error('Image session closed')
      if (!result.url?.startsWith('data:')) return result
      const match = /^data:(image\/(?:png|jpeg|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(result.url)
      if (!match||result.url.length>24*1024*1024) return {error: 'The generated image must be a supported PNG, JPEG, or GIF within the document image size limit.'}
      if (images.size === 4) images.delete(images.keys().next().value!)
      // Image operations expect a URL. Keep the bytes out of the model transcript.
      const url = WORKBOOK_IMAGE_PREFIX + crypto.randomUUID()
      images.set(url, {mime: match[1]!, base64: match[2]!})
      return {url}
    },
    async fetchImage(url: string,signal?:AbortSignal): Promise<FetchedImage | null> {
      signal?.throwIfAborted()
      if(disposed)return null
      const image=url.startsWith(WORKBOOK_IMAGE_PREFIX) ? images.get(url) ?? null : await media.fetchImage(url,signal)
      signal?.throwIfAborted()
      return disposed?null:image
    },
    clear() { images.clear() },
    dispose(){disposed=true;images.clear()},
  }
}

export function createImageAttachmentReferences(){
 const attachmentPrefix='https://attached-image.invalid/'
 const attachments=new Map<string,FetchedImage>()
 return {
  matches:(url:string)=>url.startsWith(attachmentPrefix),
  set(files:readonly {name:string;image:FetchedImage}[]){
   attachments.clear()
   return files.map(({name,image})=>{
    const url=attachmentPrefix+crypto.randomUUID()
    attachments.set(url,image)
    return url+' | '+JSON.stringify(name)
   }).join('\n')
  },
  async fetch(url:string,signal?:AbortSignal){
   const attached=attachments.get(url)
   if(!attached)return null
   try{
    const {normalizePdfGeneratedImage}=await import('./pdf-generated-image')
    const image=await normalizePdfGeneratedImage(attached,signal)
    // A stopped or superseded run cannot use an in-flight decode.
    return attachments.get(url)===attached?image:null
   }catch{signal?.throwIfAborted();return null}
  },
 }
}

export function createWorkbookImageApi(media: DocumentImageMedia) {
 const webpPrefix='data:image/webp;base64,'
 const attachments=createImageAttachmentReferences()
 const normalizeWebp=async(base64:string,signal?:AbortSignal)=>{
  const {normalizePdfGeneratedImage}=await import('./pdf-generated-image')
  return normalizePdfGeneratedImage({mime:'image/webp',base64},signal)
 }
 const api=createDocumentImageApi({async generateImage(input,signal){
  const result=await media.generateImage(input,signal)
  if(!result.url?.startsWith(webpPrefix))return result
  try{
   const image=await normalizeWebp(result.url.slice(webpPrefix.length),signal)
   return {url:`data:${image.mime};base64,${image.base64}`}
  }catch{
   signal?.throwIfAborted()
   return {error:'The generated WebP image could not be converted for Excel.'}
  }
 },async fetchImage(url,signal){
  if(attachments.matches(url))return attachments.fetch(url,signal)
  const image=await media.fetchImage(url,signal)
  if(image?.mime!=='image/webp')return image
  try{return await normalizeWebp(image.base64,signal)}
  catch{signal?.throwIfAborted();return null}
 }})
 return {...api,
  setImageAttachments(files:readonly {name:string;image:FetchedImage}[]){
   const references=attachments.set(files)
   return references ? 'Current message image attachments (reference | file name):\n'+references+
    '\nTo place an attached image, use its listed reference as path in propose_operations add_image. Do not search for or regenerate it. Local file paths are unavailable on the Web.' : ''
  },
  clear(){attachments.set([]);api.clear()},
  dispose(){attachments.set([]);api.dispose()},
 }
}
