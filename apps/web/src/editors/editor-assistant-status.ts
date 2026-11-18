import {createEditorAssistant} from './assistant'
/** Initialization is optional for editing, but its failure must not be invisible.
 * Never surface raw provider/network exception details or weaken the server gate. */
export async function loadEditorAssistant(options?:Parameters<typeof createEditorAssistant>[0]) {
 try {return {assistant:await createEditorAssistant(options),failure:undefined}}
 catch(error){
  const reason=error as {status?:number;code?:string}|null
  return {assistant:undefined,failure:reason?.status===401||reason?.status===403||reason?.code==='stale_session'?'session' as const:'load' as const}
 }
}
type Result=Awaited<ReturnType<typeof loadEditorAssistant>>
export function editorAssistantNotice(result:Result,showAssistant:boolean|undefined,locale:'zh'|'en'):string {
 const en=locale==='en'
 if(showAssistant===false)return en?'AI assistant is hidden in personal preferences. Enable it there to show the panel.':'AI 助手已在个人设置中关闭，可在个人设置中重新开启。'
 if(result.failure==='session')return en?'AI assistant session could not be verified. Save your work before checking your sign-in state.':'AI 助手登录状态未能验证。请先保存当前更改，再核对登录状态。'
 if(result.failure)return en?'AI assistant failed to load. Check your connection; save your work before reopening this document to retry.':'AI 助手加载失败。请检查连接，保存当前更改后重新打开文档重试。'
 if(!result.assistant?.available)return en?'No model is available for AI assistant. Check model configuration, authorization, quota and the server gateway. Save your work before reopening to retry.':'AI 助手没有可用模型。请检查模型配置、授权、额度及服务器网关；保存当前更改后重新打开文档重试。'
 return ''
}
