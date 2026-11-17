/** A local insertion is not permission for a timer/blur/AI-completion save.
 * Existing explicit native save actions may persist it without changing the
 * user's AutoSave preference. Failure and partial saves keep the hold. */
export function createAnalysisSaveConsent(){
 let pending=false,generation=0
 return {
  hold(){pending=true;generation++},
  allowed(automatic:boolean){return !automatic||!pending},
  confirmClean(){pending=false},
  async run<T>(automatic:boolean,action:()=>Promise<T>,clean:(result:T)=>boolean,blocked:T):Promise<T>{
   if(automatic&&pending)return blocked
   const stamp=generation,result=await action()
   if(stamp===generation&&clean(result))pending=false
   return result
  },
 }
}
