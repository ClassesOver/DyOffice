import {isRevisionRef,type RevisionRef} from '../../../../packages/web-contracts/src/api.ts'

type Content={title:string;html:string}
export type AiDocCreationResult={ok:true;revision:RevisionRef}|{ok:false;error:string}

/** Opening a tab is not a creation receipt: wait for its native serializer. */
export function createAiDocCreationQueue(timeoutMs=60_000){
 const pending=new Map<string,{content:Content|null;finish:(result:AiDocCreationResult)=>void}>()
 return {
  begin(fileId:string,content:Content):Promise<RevisionRef>{
   if(pending.has(fileId))throw new Error('文档正在生成。')
   const promise=new Promise<RevisionRef>((resolve,reject)=>{
    const timer=setTimeout(()=>finish({ok:false,error:'无法确认正文是否保存，请从最近文件核对，不要重复创建。'}),timeoutMs)
    const finish=(result:AiDocCreationResult)=>{
     const entry=pending.get(fileId)
     if(!entry)return
     clearTimeout(timer);pending.delete(fileId)
     if(!result.ok){reject(new Error(result.error));return}
     if(entry.content||!isRevisionRef(result.revision)||result.revision.fileId!==fileId){reject(new Error('无法确认文档正文的保存版本。'));return}
     resolve(result.revision)
    }
    pending.set(fileId,{content,finish})
   })
   // The iframe may fail while its tab is still opening, before the caller awaits.
   void promise.catch(()=>{})
   return promise
  },
  consume(fileId:string):Content|null{
   const entry=pending.get(fileId)
   if(!entry)return null
   const content=entry.content;entry.content=null;return content
  },
  complete(fileId:string,result:AiDocCreationResult){pending.get(fileId)?.finish(result)},
 }
}
