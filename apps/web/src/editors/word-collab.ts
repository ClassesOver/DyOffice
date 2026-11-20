import type {Editor} from '@tiptap/core'
import {Step} from '@tiptap/pm/transform'
import {collab,getVersion,receiveTransaction,sendableSteps} from 'prosemirror-collab'
import {TRACK_IGNORE} from '../../../docs/src/shared/track-meta'

export type WordSyncState='joining'|'active'|'offline'|'unavailable'|'stale'
type Request=(input:{revision:string;version?:number;steps?:unknown[]})=>Promise<{
  baseVersion:number;version:number;savedRevision:string;savedVersion:number;steps:unknown[];clientIDs:string[]
}>

// 只有服务器确认的步骤才从未确认队列移除；丢失响应后用同一游标重试。
export function joinWordCollab(editor:Editor,revision:string,clientID:string,request:Request,
  notify:(state:WordSyncState)=>void,onRemote:()=>void,onSynced:(head:{version:number;savedRevision:string;savedVersion:number})=>void) {
  let initialized=false,disposed=false,terminal=false,running:Promise<void>|undefined,timer:ReturnType<typeof setTimeout>|undefined
  let status:WordSyncState='joining'
  function report(next:WordSyncState){if(next!==status){status=next;notify(next)}}
  async function exchange(){
    const from=initialized?getVersion(editor.state):undefined
    const pending=initialized?sendableSteps(editor.state):null
    let steps=pending?.steps.slice(0,64).map(step=>step.toJSON())
    while(steps&&steps.length>1&&new Blob([JSON.stringify(steps)]).size>230000)steps=steps.slice(0,Math.ceil(steps.length/2))
    let response
    try{response=await request({revision,...(from===undefined?{}:{version:from}),...(steps?.length?{steps}:{})})}
    catch(error){
      if(disposed)return
      const code=(error as {status?:number}).status
      if(code===404&&!initialized){terminal=true;report('unavailable')}
      else if(code&&[400,401,403,409,410,413,422].includes(code)){terminal=true;report('stale')}
      else report('offline')
      throw error
    }
    if(disposed||editor.isDestroyed)return
    try {
      const {baseVersion,version,steps,clientIDs}=response
      if(!Array.isArray(steps)||!Array.isArray(clientIDs)||steps.length!==clientIDs.length||
          !Number.isSafeInteger(baseVersion)||baseVersion<0||version!==(from??baseVersion)+steps.length)throw Error('Invalid collaboration version')
      if(!initialized){editor.registerPlugin(collab({version:baseVersion,clientID}));initialized=true}
      if(steps.length){
        const remote=steps.map(step=>Step.fromJSON(editor.schema,step))
        const tr=receiveTransaction(editor.state,remote,clientIDs,{mapSelectionBackward:true}).setMeta(TRACK_IGNORE,true)
        if(clientIDs.some(id=>id!==clientID))tr.setMeta('dyofficeRemoteEdit',true)
        editor.view.dispatch(tr)
        if(getVersion(editor.state)!==version)throw Error('Document rejected remote edit')
        if(clientIDs.some(id=>id!==clientID))onRemote()
      }
      report('active');onSynced(response)
    }catch(error){terminal=true;report('stale');throw error}
  }
  function pump(){
    if(running)return running
    clearTimeout(timer)
    running=exchange().finally(()=>{
      running=undefined
      if(!disposed&&!terminal)timer=setTimeout(poll,status==='offline'?1500:initialized&&sendableSteps(editor.state)?0:500)
    })
    return running
  }
  function poll(){if(!disposed&&!terminal)void pump().catch(()=>{})}
  poll()
  return {
    pending:()=>!initialized||!!sendableSteps(editor.state),
    async checkpoint(){
      if(terminal&&status==='unavailable')return undefined
      for(let i=0;i<25&&!disposed&&!terminal;i++){
        await pump()
        if(initialized&&!sendableSteps(editor.state))return getVersion(editor.state)
      }
      throw Error('文档协同尚未同步，请稍后保存')
    },
    dispose(){disposed=true;clearTimeout(timer);if(initialized&&!editor.isDestroyed)editor.unregisterPlugin('collab')},
  }
}
