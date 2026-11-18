// Test-only bounded diagnostics. Never record URLs, request bodies, IDs or errors.
const stages=new Set(['fixture','settings','budget-setup','skills','import','app','listen','browser','auth','catalog','editor','skill-cancel','skill-gate','cancel-stop','cancel-settled','first-send','first-visible','first-response','first-finished','first-ui-settled','wire','second-send','second-visible','second-response','second-finished','second-ui-settled','ledger','original-bytes','complete'])
export function assistantDiagnostics(signal,emit=value=>console.error('assistant-phase',value)) {
 let stage='fixture',reported=false,disposed=false,pageErrors=0,armed
 const failureWaiters=new Set(),abortWaiters=new Set()
 const requests={},state={first:{request:false,response:'none',finished:false,failed:false,failureKind:'none'},second:{request:false,response:'none',finished:false,failed:false,failureKind:'none'}},cleanups=[]
 const report=()=>{if(!reported&&!disposed&&stage!=='complete'){reported=true;try{emit(JSON.stringify({stage,pageErrors,first:{...state.first},second:{...state.second}}))}catch{/* Telemetry must never mask the original failure or escape an abort listener. */}}}
 signal.addEventListener('abort',report,{once:true})
 return {
  stage(value){if(!stages.has(value))throw Error('Invalid diagnostic stage');stage=value},
  arm(value){if(value!=='first'&&value!=='second')throw Error('Invalid diagnostic turn');armed=value},
  observe(page){
   const request=r=>{if(armed&&!requests[armed]&&r.method()==='POST'&&r.url().endsWith('/api/v1/ai/turns')){requests[armed]=r;state[armed].request=true;armed=undefined}}
   const response=r=>{for(const slot of ['first','second'])if(requests[slot]===r.request()){const n=r.status();state[slot].response=n>=200&&n<300?'2xx':n>=400&&n<500?'4xx':n>=500&&n<600?'5xx':'other'}}
   const terminal=key=>r=>{for(const slot of ['first','second'])if(requests[slot]===r){state[slot][key]=true;if(key==='failed'){let reason;try{reason=r.failure()?.errorText}catch{};state[slot].failureKind=reason==='net::ERR_ABORTED'?'aborted':reason==='net::ERR_CONNECTION_RESET'?'connection-reset':reason==='net::ERR_CONNECTION_CLOSED'?'connection-closed':'other';for(const waiter of failureWaiters)waiter(r)}}}
   const listeners={request,response,requestfinished:terminal('finished'),requestfailed:terminal('failed'),pageerror:()=>{pageErrors=Math.min(99,pageErrors+1)}}
   for(const [event,fn] of Object.entries(listeners)){page.on(event,fn);cleanups.push(()=>page.off(event,fn))}
  },report,
  async finished(response){
   const request=response.request(),slot=['first','second'].find(key=>requests[key]===request)
   if(!slot)throw Error('Assistant HTTP request was not observed')
   if(state[slot].failed)throw Error('Assistant HTTP request failed')
   if(signal.aborted||disposed)throw Error('Assistant HTTP wait aborted')
   let failed,abort
   const failure=new Promise((_,reject)=>{
    failed=r=>{if(r===request)reject(Error('Assistant HTTP request failed'))}
    abort=()=>reject(Error('Assistant HTTP wait aborted'))
    failureWaiters.add(failed);abortWaiters.add(abort);signal.addEventListener('abort',abort,{once:true})
   })
   try{return await Promise.race([response.finished(),failure])}
   finally{failureWaiters.delete(failed);abortWaiters.delete(abort);signal.removeEventListener('abort',abort)}
  },
  dispose(){disposed=true;for(const abort of abortWaiters)abort();abortWaiters.clear();signal.removeEventListener('abort',report);for(const remove of cleanups)remove();cleanups.length=0},
 }
}
