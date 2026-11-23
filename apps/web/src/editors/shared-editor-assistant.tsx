import { AiExecutionRecord, compactExecutionOutput, delegatedAgentResult, type ExecutionTool } from '@genoffice/ui'
import {bindDocumentHandoff,createAttachmentsSkill,withAttachedSkills,ATTACHMENT_IMAGE_EXTS,type AgentImage,type AttachedSkill} from '@genoffice/agent-core'
import {useEffect,useLayoutEffect,useMemo,useRef,useState,type CSSProperties,type ReactNode} from 'react'
import {AgentLoop,composeSkills} from '../../../../packages/agent-core/src/index'
import {AiComposer,AiSkillChips,AiSkillsMenu,Markdown,useAiPanelResize,useAssistantFocusRoot,type MarkdownNav,type AiAttachmentLike} from '@genoffice/ui'
import {GensparkMark} from '../../../docs/src/renderer/components/icons'
import type {createEditorAssistant} from './assistant'
import '@genoffice/ui/ai-model-picker.css'
import './shared-editor-assistant.css'
import './ai-dock-theme.css'

type Assistant=Awaited<ReturnType<typeof createEditorAssistant>>
type DraftFile=AiAttachmentLike&{image?:AgentImage}
type ComposerDraft={text:string;files:DraftFile[];skills:string[];version:number}
type ChatItem={id:number;role:'user'|'assistant';text:string;sender?:'dsh';files?:string[];skills?:string[];tools?:ExecutionTool[]}
type ImageAttachments=ReadonlyMap<string,{name:string;image:AgentImage}>
const toolImageAttachments=new WeakMap<AbortSignal,ImageAttachments>()
export function resolveTurnImageAttachment(reference:string,signal?:AbortSignal){
 return signal&&!signal.aborted?toolImageAttachments.get(signal)?.get(reference)?.image:undefined
}

export function SharedEditorAssistant({assistant,lang,context='',dock,widthKey,onLocalEditDone,assistantNav,imageAttachmentReferences=false}:{assistant:Assistant;lang:'zh'|'en';context?:string;dock?:{collapsed:boolean;setCollapsed(value:boolean):void};widthKey?:string;onLocalEditDone?:()=>void;assistantNav?:MarkdownNav;imageAttachmentReferences?:boolean}){
 const [items,setItems]=useState<ChatItem[]>([]),[draft,setDraft]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('')
 const [files,setFiles]=useState<DraftFile[]>([]),[attaching,setAttaching]=useState(false)
 const [skills,setSkills]=useState<string[]>([]),[readingSkills,setReadingSkills]=useState(false)
 const pendingSkills=useRef<AbortController|undefined>(undefined),draftVersion=useRef(0)
 const activeFiles=useRef<readonly DraftFile[]>([]),addingFiles=useRef(false)
 const activeImages=useRef<ImageAttachments|undefined>(undefined)
 const clearActiveAttachments=()=>{activeFiles.current=[];activeImages.current=undefined}
 const [localCollapsed,setLocalCollapsed]=useState(false)
 const collapsed=dock?.collapsed??localCollapsed
 const {width,resizing,handle}=useAiPanelResize(widthKey,lang,!collapsed)
 const focusRoot=useAssistantFocusRoot<HTMLDivElement>()
 const inputRef=useRef<HTMLTextAreaElement>(null),railRef=useRef<HTMLButtonElement>(null)
 const focusAfterToggle=useRef(false)
 const changeCollapsed=(next:boolean)=>{focusAfterToggle.current=true;(dock?.setCollapsed??setLocalCollapsed)(next)}
 useEffect(()=>{if(!focusAfterToggle.current)return;focusAfterToggle.current=false;if(collapsed)railRef.current?.focus();else inputRef.current?.focus()},[collapsed])
 const seq=useRef(0),runToken=useRef<string|undefined>(undefined),continueRef=useRef<(instruction:string,token?:string)=>boolean>(()=>false)
 const recoverableDraft=useRef<ComposerDraft|undefined>(undefined)
 const resuming=useRef<AbortController|undefined>(undefined)
 const checkRecovery=useRef<()=>void>(undefined)
 const editDone=useRef(onLocalEditDone),localEdit=useRef<'local'|'edited'|undefined>(undefined)
 const language=useRef(lang)
 language.current=lang
 editDone.current=onLocalEditDone
 const loop=useMemo(()=>{
  const attachmentSkill=createAttachmentsSkill({
   list:()=>activeFiles.current,
   async read(path,offset,count){
    const result=await assistant.api.readAttachment(path,offset,count)
    if(!result.ok||result.text===undefined||result.totalChars===undefined||result.offset===undefined)
     throw Error(result.error??'Attachment could not be read')
    return {text:result.text,totalChars:result.totalChars,offset:result.offset}
   },
  })
  const skill=composeSkills('shared-office-assistant','Use only the provided tools and context supplied by the user or this workspace. Follow the capabilities and limits of the offered skills. Only claim edits or saves confirmed by a successful tool result; never claim to inspect content you were not given.',[...assistant.extraSkills,{...attachmentSkill,get tools(){
    return activeFiles.current.some(file=>!file.image)?attachmentSkill.tools:[]
   },buildContext(){
    const images=activeImages.current
    const references=images?.size?'PDF image references for this message (reference | file name):\n'+
     [...images].map(([reference,{name}])=>reference+' | '+JSON.stringify(name)).join('\n'):''
    return [attachmentSkill.buildContext?.(),references].filter(Boolean).join('\n\n')
   }}])
  const executeTool=skill.executeTool
  skill.executeTool=async(call,signal)=>{
   const images=activeImages.current
   if(!signal||!images?.size||(call.name!=='insert_image'&&call.name!=='replace_image'))return executeTool(call,signal)
   toolImageAttachments.set(signal,images)
   try{return await executeTool(call,signal)}finally{toolImageAttachments.delete(signal)}
  }
  return new AgentLoop({
   transport:assistant.transport,
   skill,
   allowDelegationYield:true,
   allowHarnessResume:!!assistant.continuationRevision,
   // Browser-local attachment handles cannot be recovered after a refresh.
   canCheckpointHarness:()=>!activeFiles.current.length,
   events:{
    onText:text=>{if(text)recoverableDraft.current=undefined;setItems(current=>{const next=[...current];const last=next.at(-1);if(last?.role==='assistant')last.text=text;return next})},
    onToolStart:call=>{
     recoverableDraft.current=undefined
     setItems(current=>current.map((item,index)=>index===current.length-1&&item.role==='assistant'
      ?{...item,tools:[...(item.tools??[]),{name:call.name,summary:call.name,input:JSON.stringify(call.input),running:true}]}:item))
    },
    onToolExecuted:({call,execution})=>{
     if(localEdit.current==='local'&&execution.mutated&&!execution.isError)localEdit.current='edited'
     setItems(current=>current.map((item,index)=>{
      if(index!==current.length-1||item.role!=='assistant')return item
      const tools=[...(item.tools??[])]
      if(tools.at(-1)?.running)tools.pop()
      return {...item,tools:[...tools,{name:call.name,summary:execution.summary,input:JSON.stringify(call.input),
       output:compactExecutionOutput(call.name,execution.output,2000),isError:execution.isError,
       delegation:delegatedAgentResult(call.name,execution.output)}]}
     }))
    },
    onDone:result=>{
     recoverableDraft.current=undefined
     clearActiveAttachments()
     const edited=localEdit.current==='edited'
     localEdit.current=undefined
     const token=runToken.current
     runToken.current=undefined
     const notice=result.truncated?(language.current==='zh'?'回复达到模型长度上限。请将剩余内容分段继续。':'The reply reached the model’s length limit. Continue with smaller requests.'):''
     if(notice)setError(notice)
     if(token)assistant.control?.endRun?.(token,{text:[result.text,notice].filter(Boolean).join('\n\n'),cancelled:result.cancelled,failed:result.turnLimit||result.truncated,yielded:result.yielded})
     else if(result.yielded)assistant.control?.reportYield(result.yielded.taskIds)
     setItems(current=>current.map(item=>item.tools?.some(tool=>tool.running)?{...item,tools:item.tools.filter(tool=>!tool.running)}:item))
     setBusy(false)
     if(edited&&!result.cancelled&&!result.turnLimit&&!result.truncated&&!result.yielded)editDone.current?.()
    },
    onError:message=>{
     const unsent=recoverableDraft.current
     recoverableDraft.current=undefined
     localEdit.current=undefined
     if(unsent?.version===draftVersion.current){
      setDraft(unsent.text);setFiles(unsent.files);setSkills(unsent.skills)
     }
     clearActiveAttachments()
     const token=runToken.current;runToken.current=undefined
     if(token)assistant.control?.endRun?.(token,{text:message,cancelled:false,failed:true})
     setItems(current=>current.map(item=>item.tools?.some(tool=>tool.running)?{...item,tools:item.tools.filter(tool=>!tool.running)}:item))
     setError(message);setBusy(false)
    },
   },
  })
 },[assistant])
 useEffect(()=>bindDocumentHandoff(assistant.transport,async(instruction,handoff)=>{
  const result=runOffice(instruction,undefined,handoff);return typeof result==='boolean'?undefined:result
 }))
 useEffect(()=>()=>{pendingSkills.current?.abort();loop.cancel()},[loop])
 useEffect(()=>{
  const {coding,fileChat,continuationRevision}=assistant
  if(!coding||!fileChat||!continuationRevision)return
  let mounted=true
  const attempted=new Set<string>()
  const check=()=>{
   if(!mounted||resuming.current||pendingSkills.current||loop.busy||loop.messages.length||seq.current||!continuationRevision())return
   const task=coding.snapshot().find(item=>{
    if(!item.continuationModelId||attempted.has(item.id))return false
    if(assistant.catalog.entries.some(entry=>entry.id===item.continuationModelId))return true
    attempted.add(item.id)
    setError(lang==='zh'?'原模型已不可用。请在任务卡片查看结果。':'The original model is unavailable. See the task card for its result.')
    return false
   })
   if(!task)return
   attempted.add(task.id)
   const observer=new AbortController()
   resuming.current=observer;setBusy(true);setError('')
   void (async()=>{
    let started=false
    try{
     const run=await coding.resume(task.id,observer.signal)
     if(!run?.checkpoint.chatTurnId||observer.signal.aborted)return
     const chat=await fileChat.resume(run.checkpoint.chatTurnId,loop)
     if(!mounted||observer.signal.aborted)return
     if(!chat||continuationRevision()!==run.revision)throw Error('Office conversation unavailable')
     localEdit.current='local'
     started=loop.resumeHarness(run.checkpoint,run.result,{chat,modelId:run.modelId,canContinue:()=>continuationRevision()===run.revision})
     if(!started)throw Error('Office conversation unavailable')
    }catch{
     if(mounted&&!observer.signal.aborted)setError(lang==='zh'?'无法继续原对话。请在任务卡片查看结果。':'Could not continue the original conversation. See the task card for its result.')
    }finally{
     if(resuming.current===observer)resuming.current=undefined
     if(mounted&&!started){
      localEdit.current=undefined;setBusy(false)
      if(!observer.signal.aborted)check()
     }
    }
   })()
  }
  const unsubscribe=coding.subscribe(check)
  checkRecovery.current=check
  return ()=>{mounted=false;checkRecovery.current=undefined;resuming.current?.abort();unsubscribe()}
 },[assistant,loop,lang])
 // The host can become ready after the final task event. Recheck after its layout effects update the lifecycle.
 useEffect(()=>{checkRecovery.current?.()})
 function runOffice(instruction:string,continuationToken?:string,handoff?:import('@genoffice/agent-core').DocumentHandoffOptions,composerDraft?:ComposerDraft,skillBodies:readonly AttachedSkill[]=[]){
  if(busy||loop.busy||resuming.current||pendingSkills.current)return false
  const token=assistant.control?.beginRun?.(instruction,continuationToken)
  if(assistant.control?.beginRun&&!token)return false
  const attachments=composerDraft?.files??[]
  activeFiles.current=attachments
  recoverableDraft.current=composerDraft
  localEdit.current=handoff?undefined:'local'
  runToken.current=token;setError('');setItems(current=>[...current,{id:seq.current++,role:'user',text:instruction,files:attachments.map(file=>file.name),skills:composerDraft?.skills,...(handoff&&{sender:'dsh' as const})},{id:seq.current++,role:'assistant',text:''}]);setBusy(true)
  try{
   if(handoff)return loop.runDocumentHandoff(instruction,handoff)
   if(imageAttachmentReferences){
    const images=new Map<string,{name:string;image:AgentImage}>()
    for(const {image,name} of attachments)if(image)images.set('attachment://'+crypto.randomUUID(),{name,image})
    activeImages.current=images
   }
   const prompt=context?`${instruction}\n\nOpen file context:\n${context}`:instruction
   loop.run(withAttachedSkills(prompt,skillBodies),attachments.flatMap(file=>file.image?[file.image]:[]),skillBodies.length?instruction:undefined,continuationToken?undefined:{text:instruction})
   return true
  }catch(error){if(token)assistant.control?.endRun?.(token,{text:String(error),cancelled:false,failed:true});runToken.current=undefined;clearActiveAttachments();setBusy(false);return false}
 }
 useLayoutEffect(()=>{
  continueRef.current=(instruction,token)=>runOffice(instruction,token)===true
 })
 useEffect(()=>{
  const control=assistant.control
  if(!control)return
  return control.register({
   isBusy:()=>loop.busy||!!pendingSkills.current,
   cancelRun:token=>{if(runToken.current===token)loop.cancel()},
   requestYield:taskIds=>loop.requestYield(taskIds),
   continue:(instruction,token)=>continueRef.current(instruction,token),
   execute:(instruction,signal)=>loop.runScoped(instruction,{signal,allowedTools:control.allowedTools}),
  })
 },[assistant,loop])
 async function attach(load:()=>ReturnType<Assistant['api']['pickAttachments']>){
  if(busy||loop.busy||addingFiles.current||pendingSkills.current)return
  addingFiles.current=true;setAttaching(true);setError('')
  try{
   const {accepted,rejected}=await load(),next:DraftFile[]=[]
   let imageChars=files.reduce((sum,file)=>sum+(file.image?.base64.length??0),0)
   for(const file of accepted){
    if(files.some(item=>item.path===file.path)||next.some(item=>item.path===file.path))continue
    if(files.length+next.length>=20){
     rejected.push(lang==='zh'?'每条消息最多添加 20 个附件。':'A message can have up to 20 attachments.')
     break
    }
    if(ATTACHMENT_IMAGE_EXTS.has(file.ext)){
     const result=await assistant.api.readAttachmentImage(file.path)
     if(!result.ok||!result.base64||!result.mime){rejected.push(result.error??file.name);continue}
     // Leave room for the prompt, document context, and tool results in the request.
     if(imageChars+result.base64.length>8*1024*1024){
      rejected.push(lang==='zh'?'附件图片总量过大。请压缩或分条发送。':'Attached images are too large together. Compress them or send them separately.')
      continue
     }
     imageChars+=result.base64.length
     next.push({...file,image:{base64:result.base64,mime:result.mime}})
    }else next.push(file)
   }
   if(next.length){draftVersion.current++;setFiles(current=>[...current,...next])}
   if(rejected.length)setError(rejected.join(' · '))
  }catch(error){setError(error instanceof Error?error.message:String(error))}
  finally{addingFiles.current=false;setAttaching(false)}
 }
 function toggleSkill(name:string){
  if(pendingSkills.current)return
  draftVersion.current++
  setSkills(current=>current.includes(name)?current.filter(item=>item!==name):[...current,name])
 }
 async function send(){
  const text=draft.trim()
  if(!text||busy||loop.busy||resuming.current||addingFiles.current||pendingSkills.current)return
  setError('')
  if(!assistant.workspace.isOffice()){
   const hasExtras=files.length>0||skills.length>0
   if(hasExtras){await assistant.workspace.submit(text,true);return}
   const id=seq.current++, version=draftVersion.current
   setDraft('')
   setItems(current=>[...current,{id,role:'user',text}])
   if(await assistant.workspace.submit(text,false)==='failed'){
    setItems(current=>current.filter(item=>item.id!==id))
    if(draftVersion.current===version)setDraft(draft)
   }
   return
  }
  const original={text:draft,files,skills,version:draftVersion.current}
  let bodies:AttachedSkill[]=[]
  if(skills.length){
   const preparation=new AbortController()
   pendingSkills.current=preparation;setReadingSkills(true)
   try{
    bodies=await Promise.all(skills.map(async name=>({name,body:await assistant.api.skillText(name)})))
   }catch{
    if(!preparation.signal.aborted)setError(lang==='zh'?'无法读取所选技能。请重试，或移除不可用的技能。':'Could not read the selected skills. Try again or remove unavailable skills.')
    return
   }finally{
    if(pendingSkills.current===preparation){pendingSkills.current=undefined;setReadingSkills(false)}
   }
   if(preparation.signal.aborted||draftVersion.current!==original.version)return
  }
  setDraft('');setFiles([]);setSkills([])
  if(!runOffice(text,undefined,undefined,original,bodies)){
   recoverableDraft.current=undefined
   setDraft(draft);setFiles(files);setSkills(skills)
  }
 }
 function stop(){
  if(pendingSkills.current){
   pendingSkills.current.abort();pendingSkills.current=undefined;setReadingSkills(false)
   return
  }
  resuming.current?.abort();loop.cancel()
 }
 const conversation=assistant.workspace.conversation
 const messages:ReactNode=<>
  {items.map(item=><div data-sender={item.sender} className={`ai-msg ai-msg-${item.role}`} key={item.id}>{item.text?<><Markdown text={item.text} nav={item.role==='assistant'?assistantNav:undefined}/><AiSkillChips lang={lang} names={item.skills??[]}/>{!!item.files?.length&&<div className="shared-assistant-file-list">{item.files.map((name,index)=><span key={index}>{name}</span>)}</div>}</>:busy&&item.role==='assistant'?<span role="status">{lang==='zh'?'正在思考…':'Thinking…'}</span>:null}{!!item.tools?.length&&<AiExecutionRecord tools={item.tools} lang={lang}/>}</div>)}
  {error&&<p role="alert">{error}</p>}
 </>
 return <div ref={focusRoot} className={`ai-dock shared-assistant-dock${collapsed?' collapsed':''}${resizing?' ai-panel-resizing':''}`} style={widthKey?{'--ai-panel-width':`${width}px`} as CSSProperties:undefined}>
  <button ref={railRef} type="button" className="ai-rail" hidden={!collapsed} aria-label={lang==='zh'?'展开 AI 助手':'Expand AI assistant'} onClick={()=>changeCollapsed(false)}><GensparkMark size={22}/></button>
  <section hidden={collapsed} className="shared-editor-assistant ai-panel" aria-label={lang==='zh'?'Office 助手':'Office assistant'}>
  <header className="shared-editor-assistant-head ai-panel-header"><span className="ai-panel-title"><GensparkMark size={22}/>{lang==='zh'?'AI 助手':'AI Assistant'}</span><div className="ai-panel-header-actions"><button type="button" className="ai-header-btn ai-panel-collapse" aria-label={lang==='zh'?'收起 AI 助手':'Collapse AI assistant'} onClick={()=>changeCollapsed(true)}><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="2" y="3" width="16" height="14" rx="2"/><path d="M7 3v14m6-10-3 3 3 3"/></svg></button></div></header>
  {assistant.workspace.panel}
  <div className="shared-assistant-feed ai-chat">{!items.length&&<div className="ai-chat-empty"><div className="ai-chat-empty-title">{lang==='zh'?'可以帮你做什么？':'How can I help?'}</div><div className="ai-chat-empty-body">{lang==='zh'?'总结内容、核对信息，或描述需要完成的修改。':'Summarize content, check details, or describe a change.'}</div></div>}{conversation?conversation(messages):messages}</div>
  <div className="shared-editor-assistant-composer ai-composer">
   <AiComposer value={draft} busy={busy||readingSkills} textareaRef={inputRef} ariaLabel={lang==='zh'?'消息':'Message'} placeholder={lang==='zh'?'描述你想完成的事…':'Describe what you want done…'} hintIdle="" hintBusy="" sendLabel={lang==='zh'?'发送':'Send'} stopLabel={lang==='zh'?'停止':'Stop'} iconOnly header={<>
   <AiSkillChips lang={lang} names={skills} onRemove={toggleSkill}/>
   {readingSkills&&<span role="status">{lang==='zh'?'正在读取技能…':'Reading skills…'}</span>}
   {(files.length>0||attaching)&&<div className="shared-assistant-file-list">
    {files.map(file=><span key={file.path}><span>{file.name}</span><button type="button" disabled={attaching} aria-label={(lang==='zh'?'移除附件 ':'Remove attachment ')+file.name} onClick={()=>{draftVersion.current++;setFiles(current=>current.filter(item=>item.path!==file.path))}}>×</button></span>)}
    {attaching&&<span role="status">{lang==='zh'?'正在读取附件…':'Reading attachments…'}</span>}
   </div>}
   </>}
   footerStart={<>{assistant.modelPicker}<AiSkillsMenu lang={lang} listSkills={assistant.api.skillsList} selected={skills} onToggle={toggleSkill} onAddFile={()=>void attach(assistant.api.pickAttachments)} onManage={()=>void assistant.api.openSkillsSettings()}/></>}
   onPasteFiles={incoming=>void attach(()=>assistant.api.addAttachmentFiles(incoming))} onChange={value=>{draftVersion.current++;setDraft(value)}} onSend={()=>void send()} onStop={stop}/>
  </div>
  {widthKey&&!collapsed&&<div {...handle}/>}
 </section></div>
}
