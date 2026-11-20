import type {AiDocContent} from '../../shared/ipc'
import type {FileActionContext} from '../file-actions'

/** Web uploads a blank template before opening; desktop creates an untitled tab. */
export async function completeCreatedDocumentBoot({content,pendingPath,opened,hosted,getContext,apply,complete}:{
 content:AiDocContent|null;pendingPath?:string;opened:boolean;hosted:boolean
 getContext:()=>FileActionContext
 apply:(ctx:FileActionContext,content:AiDocContent)=>Promise<boolean>
 complete:(accepted:boolean)=>void
}):Promise<void>{
 if(!content||(!hosted&&pendingPath))return
 let accepted=false
 try{
  if(pendingPath&&!opened)return
  // React must publish the document created by loadFile/resetFile first.
  for(let i=0;i<100;i++){
   const ctx=getContext()
   if(ctx.doc&&(!pendingPath||ctx.doc.filePath===pendingPath)){
    accepted=await apply(ctx,content)
    return
   }
   await new Promise(resolve=>setTimeout(resolve,20))
  }
 }finally{complete(accepted)}
}
