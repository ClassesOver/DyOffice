/** A tab may only disappear after a confirmed save and lease release. No discard path. */
export function createEditorCloseLifecycle(options:{
 state:()=>{dirty:boolean;blocked:boolean}
 save:()=>Promise<boolean>
 release:()=>Promise<void>
 cleanup:()=>void
 confirm:()=>boolean
 notify:()=>void
 setClosing?:(closing:boolean)=>void
}){
 let disposed=false,checking:Promise<boolean>|null=null,disposing:Promise<boolean>|null=null
 const clean=()=>{const state=options.state();return !state.dirty&&!state.blocked}
 async function check(){
  if(disposed)return true
  const state=options.state()
  if(state.blocked){options.notify();return false}
  if(!state.dirty)return true
  if(!options.confirm())return false
  try{return await options.save()&&clean()}catch{return false}
 }
 return {
  canClose(){if(disposing)return disposing;if(!checking)checking=check().finally(()=>{checking=null});return checking},
  dispose(){
   if(disposed)return Promise.resolve(true)
   if(disposing)return disposing
   if(checking||!clean())return Promise.resolve(false)
   disposing=(async()=>{
    options.setClosing?.(true)
    try{
     await options.release()
     if(!clean())return false
     options.cleanup();disposed=true;return true
    }catch{return false}
    finally{if(!disposed)options.setClosing?.(false);disposing=null}
   })()
   return disposing
  },
 }
}

/** Installed while booting as fail-closed, then replaced by the mounted editor. */
export function installEditorCloseLifecycle(stage:Window,lifecycle:{canClose:()=>Promise<boolean>;dispose:()=>Promise<boolean>}){
 const view=stage as unknown as {dyofficeEditorCanClose?:()=>boolean|Promise<boolean>;dyofficeEditorDispose?:()=>Promise<boolean>}
 view.dyofficeEditorCanClose=lifecycle.canClose
 view.dyofficeEditorDispose=lifecycle.dispose
}
