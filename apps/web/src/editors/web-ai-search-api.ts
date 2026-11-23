import type {SettingsRequest} from '../../../../packages/browser-host/src/preferences.ts'
import type {AssistantDocumentFormat} from '../../../../packages/web-contracts/src/assistant.ts'

type SearchConfig={defaults?:Record<string,string>;catalog?:Array<{id:string;kind:string;ready?:boolean}>}
type WebSearchReply={results:Array<{title:string;url:string;snippet:string}>;answer?:string;method:string;error?:string}
type ImageSearchReply={images:Array<{title:string;imageUrl:string;sourceUrl:string;source:string;width?:number;height?:number}>;method:string;error?:string}

export function configuredAiTool(settings:SearchConfig,kind:string):boolean{
 const id=settings.defaults?.[kind]
 return !!id&&settings.catalog?.some(entry=>entry.id===id&&entry.kind===kind&&entry.ready===true)===true
}

export function officeToolsWithConfiguredAiTools(nativeTools:ReadonlySet<string>,settings:SearchConfig,format:AssistantDocumentFormat):ReadonlySet<string>{
 const result=new Set(nativeTools)
 for(const name of ['web_search','image_search','generate_image','analyze_media'])result.delete(name)
 const configured=(kind:string)=>configuredAiTool(settings,kind)
 for(const kind of ['web_search','image_search']){
  if(configured(kind))result.add(kind)
 }
 if(configured('image_generation'))result.add('generate_image')
 if((format==='docx'||format==='pptx')&&(configured('image_analysis')||configured('video_analysis')))result.add('analyze_media')
 return result
}

export function createWebAiSearchApi(request:SettingsRequest){
 return {
  webSearch(query:string,maxResults=6):Promise<WebSearchReply>{
   const count=Number.isSafeInteger(maxResults)?Math.min(6,Math.max(1,maxResults)):6
   return request('/api/v1/ai/search','POST',{kind:'web_search',query,maxResults:count})
  },
  imageSearch(query:string,maxResults=8,signal?:AbortSignal):Promise<ImageSearchReply>{
   const count=Number.isSafeInteger(maxResults)?Math.min(8,Math.max(1,maxResults)):8
   return request('/api/v1/ai/search','POST',{kind:'image_search',query,maxResults:count},...(signal?[signal]:[]))
  },
 }
}
