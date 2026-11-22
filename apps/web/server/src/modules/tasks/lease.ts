// Both stores issue 30-second leases. Stop execution before an unconfirmed lease expires.
export function maintainTaskLease(controller: AbortController, intervalMs: number, renew: () => Promise<boolean>) {
  let stopped = false
  let inFlight: Promise<void> | undefined
  const deadline = () => setTimeout(() => controller.abort(), 25_000)
  let expiry = deadline()
  expiry.unref()
  const timer = setInterval(() => {
    if (inFlight || controller.signal.aborted || stopped) return
    inFlight = Promise.resolve().then(renew).then(live => {
      if (stopped || controller.signal.aborted) return
      if (!live) { controller.abort(); return }
      clearTimeout(expiry)
      expiry = deadline()
      expiry.unref()
    }).catch(() => {
      // The next tick retries transport errors; the independent deadline covers hung renewals.
    }).finally(() => { inFlight = undefined })
  }, intervalMs)
  timer.unref()
  return () => {
    stopped = true
    clearTimeout(expiry)
    clearInterval(timer)
    // The store fences late renewals by state and claim. A stalled transport
    // must not keep the worker from settling or processing its next task.
  }
}
