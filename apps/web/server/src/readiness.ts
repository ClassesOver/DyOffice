import type { Pool } from 'pg'
import type { ObjectStore } from './storage/object-store.ts'

// Read-only, process-local single flight. A timed-out dependency retains its
// slot until it settles: repeated public probes cannot accumulate orphan work.
export function createReadinessProbe(config: { identityReady: () => Promise<void>; businessPool?: Pick<Pool, 'query'>; objectStore?: ObjectStore }, timeoutMs = 5000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('Invalid readiness timeout')
  let running: Promise<boolean> | undefined
  return async (): Promise<boolean> => {
    if (!running) {
      const operation = Promise.resolve().then(async () => {
        await config.identityReady()
        if (config.businessPool) await config.businessPool.query('SELECT 1')
        if (config.objectStore) {
          if (!config.objectStore.checkReady) return false
          await config.objectStore.checkReady()
        }
        return true
      }).catch(() => false)
      running = operation
      void operation.finally(() => { if (running === operation) running = undefined })
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([running, new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs) })]) }
    finally { clearTimeout(timer) }
  }
}
