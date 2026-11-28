import {createEditorAssistant} from './assistant'
/** Initialization is optional for editing, but its failure must not be invisible.
 * Never surface raw provider/network exception details or weaken the server gate. */
export async function loadEditorAssistant(...options:Parameters<typeof createEditorAssistant>) {
 try {return {assistant:await createEditorAssistant(...options),failure:undefined}}
 catch(error){
  const reason=error as {status?:number;code?:string}|null
  return {assistant:undefined,failure:reason?.status===401||reason?.status===403||reason?.code==='stale_session'?'session' as const:'load' as const}
 }
}
type Result=Awaited<ReturnType<typeof loadEditorAssistant>>
export function editorAssistantNotice(result:Pick<Result,'assistant'|'failure'>,locale:'zh'|'en'):string {
 const en=locale==='en'
 if(result.failure==='session')return en?'AI assistant session could not be verified. Save your work before checking your sign-in state.':'AI 助手登录状态未能验证。请先保存当前更改，再核对登录状态。'
 if(result.failure)return en?'AI assistant failed to load. Check your connection; save your work before reopening this document to retry.':'AI 助手加载失败。请检查连接，保存当前更改后重新打开文档重试。'
 if(!result.assistant?.available)return en?'No model is available for AI assistant. Ask your SaaS administrator to check shared model configuration and service availability. Save your work before reopening to retry.':'AI 助手没有可用模型。请联系 SaaS 管理员检查共享模型配置及服务状态；保存当前更改后重新打开文档重试。'
 return ''
}
