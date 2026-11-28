import {documentHandoffPeer} from './document-handoff-peer'
import {documentHandoffPdfTools,readHandoffSkill} from './document-handoff-spec'
import {useSyncExternalStore} from 'react'
import {documentHandoffEditor,type AgentTransport} from '@genoffice/agent-core'

type Format='xlsx'|'pptx'|'pdf'
const formats={
 xlsx:{read:['get_workbook_context','read_range','aggregate_range','load_guide'],write:['propose_operations']},
 pptx:{read:['read_slide','load_guide'],write:['plan_deck','generate_deck','apply_ops']},
}
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(x)
const bound=(x:string,n:number)=>x.slice(0,n).replace(/[\uD800-\uDBFF]$/u,'')
type Row={who:string;text:string}
let transcript:{fileId:string;rows:Row[];generation:number}|undefined
const listeners=new Set<()=>void>()
function publish(value:typeof transcript){transcript=value;for(const listener of listeners)listener()}
export function subscribeDocumentHandoff(listener:()=>void){listeners.add(listener);return ()=>{listeners.delete(listener)}}
export function hasDocumentHandoffMessages(fileId:string){return transcript?.fileId===fileId&&transcript.rows.length>0}
export function resetDocumentHandoffMessages(fileId:string){
 if(transcript?.fileId===fileId)publish({...transcript,rows:[],generation:transcript.generation+1})
}
export function DocumentHandoffMessages({fileId}:{fileId:string}) {
 const value=useSyncExternalStore(subscribeDocumentHandoff,()=>transcript)
 if(value?.fileId!==fileId)return null
 return <>{value.rows.map((row,i)=><article key={i} className="assistant-chat-row"><div className="assistant-chat-message"><strong>{row.who}</strong><p dir="auto" style={{whiteSpace:'pre-wrap'}}>{row.text}</p></div></article>)}</>
}

export function mountDocumentHandoff(o:{
 fileId:string;format:Format
 assistant:()=>{available:boolean;transport:AgentTransport}|null|undefined
 prepare?:()=>Promise<void>;activate?:()=>void;ready:()=>boolean;clean:()=>boolean;revision:()=>string;save:(check:()=>boolean)=>Promise<boolean>;pdfTools?:readonly string[]
}) {
 const handoff=documentHandoffPeer()
 if(!handoff)return ()=>{}
 const {shell,peer}=handoff
 const controller=new AbortController(),{signal}=controller
 const spec=o.format==='pdf'?documentHandoffPdfTools(o.pdfTools):formats[o.format]
 let grant:{ticket:string;origin:string;expires:number;write:boolean}|undefined,checking=false,activated=false,started=false
 let job:{id:string;state:string;revision?:string;reply?:string}|undefined
 let lastReview=''
 const followupScope=crypto.randomUUID()
 const turns=new Map<string,{id:string;question:string;answer:string;state:string}>()
 const append=(row:Row)=>{if(!signal.aborted&&transcript?.fileId===o.fileId)publish({...transcript,rows:[...transcript.rows,row]})}
 const en=()=>document.documentElement.lang.startsWith('en')
 const valid=()=>!signal.aborted&&grant?.write===true&&grant.expires>Date.now()&&o.ready()
 const receipt=(state:string)=>{if(job)job.state=state}
 let expiryTimer:ReturnType<typeof setTimeout>|undefined
 let active:AbortController|undefined
 const interact=(event:Event)=>{
   if(event.isTrusted&&active&&!(event.target as Element|null)?.closest?.('.ai-panel,.ai-dock'))active.abort()
 }
 async function write(topic:string,baseRevision:string,skill:ReturnType<typeof readHandoffSkill>,runner:NonNullable<ReturnType<typeof documentHandoffEditor>>) {
   const generation=transcript?.generation
   const j=job!,work=active=new AbortController(),check=()=>valid()&&!work.signal.aborted
   const taskSignal=AbortSignal.any([signal,work.signal])
   let mutated=false,toolFailed=false
   try {
     if(!check()||!o.clean()||o.revision()!==baseRevision){receipt('conflict');return}
     await o.prepare?.()
     if(!check()||!o.clean()||o.revision()!==baseRevision){receipt('conflict');return}
     const result=await runner(topic,{signal:taskSignal,check,...(skill&&{skill}),
       tools:[...spec.read,...spec.write],onText:()=>{},
       onTool:(_name,state,edited)=>{receipt('writing');mutated||=edited;toolFailed=state==='failed'},
     })
     if(!result||!check()||result.cancelled){receipt('conflict');return}
     if(result.truncated||result.turnLimit){receipt('outputLimit');return}
     if(!mutated||toolFailed){receipt(toolFailed?'failed':'noTool');return}
     receipt('saving')
     if(!await o.save(check)||!check()||o.revision()===baseRevision){receipt('saveFailed');return}
     j.reply=bound(result.text,4000);j.revision=o.revision();receipt('saved')
   } catch {receipt(work.signal.aborted?'conflict':'failed')}
   finally{
     active=undefined
     if(j.state!=='saved'&&transcript?.generation===generation)append({who:'DyOffice',text:en()?'Writing was not confirmed.':'未确认完成写入。'})
   }
 }
 async function ask(id:string,question:string,runner:NonNullable<ReturnType<typeof documentHandoffEditor>>) {
   if(!valid()||turns.has(id)||[...turns.values()].some(t=>t.state==='answering'))return
   const t={id,question,answer:'',state:'answering'}
   turns.set(id,t);if(turns.size>20)turns.delete(turns.keys().next().value!)

   const work=active=new AbortController()
   try{
     const taskSignal=AbortSignal.any([signal,work.signal]),check=()=>valid()&&!taskSignal.aborted
     let mutated=false
     const r=await runner(question,{signal:taskSignal,check,tools:[...spec.read,...spec.write],
       onTool:(_name,_state,edited)=>{mutated||=edited},onText:text=>{t.answer=bound(text,8000)}})
     if(!r||r.cancelled||r.turnLimit||r.truncated||!check()||(mutated&&!await o.save(check))){t.state='failed';return}
     t.answer=bound(r.text,8000);t.state=t.answer||mutated?'ready':'failed'
   }catch{t.state='failed'}finally{active=undefined}
 }
 async function receive(e:MessageEvent){
   const data=e.data,ticket=data?.ticket
   if(e.source!==peer||data?.type!=='dsh-dyoffice:draft-request'||data.fileId!==o.fileId||
      !/^(?:https:\/\/|http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$)/u.test(e.origin)||
      typeof ticket!=='string'||!/^\d{13}\.[A-Za-z0-9_-]{43}$/u.test(ticket))return
   if(grant?.ticket!==ticket||grant.origin!==e.origin||grant.expires<=Date.now()){
     if(checking)return
     checking=true
     try{
       const csrf=await fetch('/api/v1/auth/csrf',{signal,cache:'no-store'});if(!csrf.ok)return
       const r=await fetch('/api/v1/assistant-channels/documents/'+o.fileId+'/draft-sync',{method:'POST',signal,
         headers:{'Content-Type':'application/json','X-CSRF-Token':(await csrf.json()).csrfToken},body:JSON.stringify({origin:e.origin,ticket})})
       if(!r.ok)return
       const result=await r.json()
       if(signal.aborted||!Number.isSafeInteger(result.expires)||result.expires<=Date.now())return
       grant={origin:e.origin,ticket,expires:result.expires,write:result.write===true}
       clearTimeout(expiryTimer);expiryTimer=setTimeout(()=>active?.abort(),result.expires-Date.now())
     }catch{return}finally{checking=false}
   }
   const request=data.writing
   if(!grant?.write||!uuid(request?.id)||!uuid(request.baseRevision)||typeof request.topic!=='string'||!request.topic.trim()||request.topic.length>255||signal.aborted){
     return
   }
   if(!activated){activated=true;o.activate?.()}
   if(!job){job={id:request.id,state:'planning'};publish({fileId:o.fileId,rows:[],generation:0})}
   if(job.id!==request.id)return
   const a=o.assistant(),runner=a&&documentHandoffEditor(a.transport)
   if(!started && (a===null||a&&!a.available)){started=true;receipt('noModel')}
   if(!started&&valid()&&runner){
     started=true;window.dispatchEvent(new Event('dyoffice:open-handoff-assistant'))
     void write(request.topic,request.baseRevision,readHandoffSkill(request.skill),runner)
   }
   const review=request.review
   if(job.state==='saved'&&review?.state==='ready'&&typeof review.text==='string'){
     const text=bound(review.text,4000)
     if(text!==lastReview){lastReview=text;append({who:'DSH',text})}
   }
   const q=data.followup
   let followup
   if(uuid(q?.id)){
     const matches=q.scope===undefined||q.scope===followupScope
     if(matches&&job.state==='saved'&&runner&&typeof q.question==='string'&&q.question.trim()&&q.question.length<=4000)void ask(q.id,q.question,runner)
     followup=matches?turns.get(q.id):undefined
     if(!followup&&(!matches||q.question===undefined))followup={id:q.id,state:'unknown',answer:''}
   }
   peer.postMessage({type:'dsh-dyoffice:draft',fileId:o.fileId,writing:job,draft:null,followup,followupScope},e.origin)
 }
 shell.addEventListener('message',receive)
 window.addEventListener('beforeinput',interact,true)
 return ()=>{clearTimeout(expiryTimer);controller.abort();active?.abort();shell.removeEventListener('message',receive);window.removeEventListener('beforeinput',interact,true);if(transcript?.fileId===o.fileId)publish(undefined)}
}
