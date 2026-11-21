// Failure-only, synchronous snapshots. Never serialize browser objects or errors.
const stages = new Set(['fixture','open','editor-ready','type-first','route-install','first-save-key','first-commit-wait','edit-newer','read-first','release','first-response-wait','first-response-finished','native-incomplete','native-dirty','dirty-assert','second-save-wait','read-final','login-fill','login-click','login-response','complete'])
const counters = new Set(['attempt','request','response','failed','pageerror','commit-request','commit-response-held','route-entered','fetch-started','fetch-resolved','fulfilled','route-error','first-request-finished','first-request-failed','first-failure-aborted','first-failure-other','first-failure-unavailable'])
const events = new Set(['test-aborted','cleanup-started','request-finished','request-failed-before-abort','request-failed-after-abort','request-failed-during-cleanup'])
export function phaseDiagnostics(signal, emit = line => console.error(line)) {
  let stage = 'fixture', printed = false
  const counts = Object.create(null), statuses = [], timeline = []
  const event = value => {if(events.has(value)&&timeline.length<16)timeline.push(value)}
  const report = () => {
    if (printed || stage === 'complete') return
    printed = true
    try { emit('browser-phase ' + JSON.stringify({stage,counts:{...counts},statuses:[...statuses],...(timeline.length?{timeline:[...timeline]}:{})})) } catch {}
  }
  const abort=()=>{event('test-aborted');report()}
  signal.addEventListener('abort', abort, {once:true})
  return {
    stage(value) { if (stages.has(value)) stage = value },
    count(key) { if (counters.has(key)) counts[key] = Math.min(10000,(counts[key] || 0) + 1) },
    status(value) { if (Number.isInteger(value) && value >= 100 && value <= 599 && statuses.length < 32) statuses.push(value) },
    report,event,
    dispose() { signal.removeEventListener('abort', abort) },
  }
}

// No URLs, bodies, headers or raw errors are retained. Register before releasing
// the route; watch only the first exact Request object, never a URL match.
export function observeFirstRequest(page, diagnostic, {signal}={}) {
  let target, disposed = false, failedAlready=false, cleanup=false
  const failures=new Set(),stops=new Set()
  const matches = request => !disposed && target !== undefined && request === target
  const finished = request => { if (matches(request)){diagnostic.count('first-request-finished');if(signal)diagnostic.event('request-finished')} }
  const failed = request => {
    if (!matches(request)) return
    diagnostic.count('first-request-failed')
    let category = 'first-failure-unavailable'
    try {
      const text = request.failure()?.errorText
      if (typeof text === 'string') category = text === 'net::ERR_ABORTED' ? 'first-failure-aborted' : 'first-failure-other'
    } catch { /* Failure metadata is optional and cannot mask the original failure. */ }
    diagnostic.count(category)
    failedAlready=true
    if(signal){diagnostic.event(cleanup?'request-failed-during-cleanup':signal.aborted?'request-failed-after-abort':'request-failed-before-abort');diagnostic.report()}
    for(const reject of failures)reject()
  }
  page.on('requestfinished', finished)
  page.on('requestfailed', failed)
  return {
    watch(request) { if (!disposed && target === undefined && request != null) target = request },
    beginCleanup(){cleanup=true;diagnostic.event('cleanup-started');diagnostic.report();for(const stop of stops)stop()},
    async finished(response){
      if(disposed||cleanup||signal?.aborted)throw Error('HTTP wait stopped')
      if(response.request()!==target||!target)throw Error('First HTTP request was not observed')
      if(failedAlready)throw Error('First HTTP request failed')
      let rejectFailure,stop
      const failure=new Promise((_,reject)=>{
        rejectFailure=()=>reject(Error(cleanup||signal?.aborted?'HTTP wait stopped':'First HTTP request failed'))
        stop=()=>reject(Error('HTTP wait stopped'))
        failures.add(rejectFailure);stops.add(stop);signal?.addEventListener('abort',stop,{once:true})
      })
      try{return await Promise.race([response.finished(),failure])}
      finally{failures.delete(rejectFailure);stops.delete(stop);signal?.removeEventListener('abort',stop)}
    },
    dispose() { disposed = true;for(const stop of stops)stop(); target = undefined; page.off('requestfinished', finished); page.off('requestfailed', failed) },
  }
}
