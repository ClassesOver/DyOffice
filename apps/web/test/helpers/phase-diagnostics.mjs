// Failure-only, synchronous snapshots. Never serialize browser objects or errors.
const stages = new Set(['fixture','open','editor-ready','type-first','route-install','first-save-key','first-commit-wait','edit-newer','read-first','release','first-response-wait','first-response-finished','native-incomplete','native-dirty','dirty-assert','second-save-wait','read-final','login-fill','login-click','login-response','complete'])
const counters = new Set(['attempt','request','response','failed','pageerror','route-entered','fetch-started','fetch-resolved','fulfilled','route-error','first-request-finished','first-request-failed','first-failure-aborted','first-failure-other','first-failure-unavailable'])
export function phaseDiagnostics(signal, emit = line => console.error(line)) {
  let stage = 'fixture', printed = false
  const counts = Object.create(null), statuses = []
  const report = () => {
    if (printed || stage === 'complete') return
    printed = true
    try { emit('browser-phase ' + JSON.stringify({stage,counts:{...counts},statuses:[...statuses]})) } catch {}
  }
  signal.addEventListener('abort', report, {once:true})
  return {
    stage(value) { if (stages.has(value)) stage = value },
    count(key) { if (counters.has(key)) counts[key] = Math.min(10000,(counts[key] || 0) + 1) },
    status(value) { if (Number.isInteger(value) && value >= 100 && value <= 599 && statuses.length < 32) statuses.push(value) },
    report,
    dispose() { signal.removeEventListener('abort', report) },
  }
}

// No URLs, bodies, headers or raw errors are retained. Register before releasing
// the route; watch only the first exact Request object, never a URL match.
export function observeFirstRequest(page, diagnostic) {
  let target, disposed = false
  const matches = request => !disposed && target !== undefined && request === target
  const finished = request => { if (matches(request)) diagnostic.count('first-request-finished') }
  const failed = request => {
    if (!matches(request)) return
    diagnostic.count('first-request-failed')
    let category = 'first-failure-unavailable'
    try {
      const text = request.failure()?.errorText
      if (typeof text === 'string') category = text === 'net::ERR_ABORTED' ? 'first-failure-aborted' : 'first-failure-other'
    } catch { /* Failure metadata is optional and cannot mask the original failure. */ }
    diagnostic.count(category)
  }
  page.on('requestfinished', finished)
  page.on('requestfailed', failed)
  return {
    watch(request) { if (!disposed && target === undefined && request != null) target = request },
    dispose() { disposed = true; target = undefined; page.off('requestfinished', finished); page.off('requestfailed', failed) },
  }
}
