import { setTimeout as delay } from 'node:timers/promises'
import { SandboxError, type SandboxSession } from '../sandbox/contracts.ts'

export interface NativeProcess {
  run<T>(input: Uint8Array, execute: (session: SandboxSession) => Promise<T>, options?: { signal?: AbortSignal }): Promise<T>
}

const MAX_INPUT = 32 * 1024 * 1024
const CONCURRENCY = 2, MAX_QUEUED = 8, MAX_CAPTURED_BYTES = 64 * 1024 * 1024
const busy = (statusCode = 503) => Object.assign(new SandboxError('SANDBOX_BUSY'), { statusCode, retryAfter: 1 })

/** One adapter for every XLSX operation, including inspect/save. The host's
 * independent, global systemd limits remain authoritative. Busy retries hold a
 * slot and may only replay admission, never an execute callback that has begun.
 * timeoutMs bounds queue + host admission, not an already running native call
 * (the host owns that call's wall timeout and must finish cleanup before reuse).
 */
export function createNativeAdmission(process: NativeProcess, { timeoutMs = 30_000, retryMs = 50 }: { timeoutMs?: number; retryMs?: number } = {}): NativeProcess {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 || !Number.isSafeInteger(retryMs) || retryMs < 1 || retryMs > timeoutMs) throw new Error('Invalid native admission limits')
  const queue: { start(): void }[] = []
  let inFlight = 0, capturedBytes = 0
  const pump = () => { while (inFlight < CONCURRENCY && queue.length) queue.shift()!.start() }
  return {
    run<T>(input: Uint8Array, execute: (session: SandboxSession) => Promise<T>, { signal }: { signal?: AbortSignal } = {}): Promise<T> {
      if (!(input instanceof Uint8Array) || input.byteLength < 1 || input.byteLength > MAX_INPUT) return Promise.reject(new SandboxError('INPUT_LIMIT'))
      if (signal?.aborted) return Promise.reject(new SandboxError('ABORTED'))
      // Reject before allocating: both active and queued snapshots count. The
      // host makes its own bounded copy; outputs are returned without copying.
      if (queue.length >= MAX_QUEUED || capturedBytes + input.byteLength > MAX_CAPTURED_BYTES) return Promise.reject(busy(429))
      const bytes = Buffer.from(input)
      capturedBytes += bytes.byteLength
      return new Promise<T>((resolve, reject) => {
        const controller = new AbortController(), deadline = Date.now() + timeoutMs
        let running = false, settled = false, started = false, reason: SandboxError | undefined
        const finish = () => {
          settled = true
          clearTimeout(timer)
          signal?.removeEventListener('abort', abort)
          capturedBytes -= bytes.byteLength
          if (running) inFlight--
          pump()
        }
        const cancel = (error: SandboxError) => {
          if (settled || reason) return
          reason = error
          controller.abort()
          // Never release a running slot until process.run's cleanup settles.
          if (!running) {
            const index = queue.indexOf(entry)
            if (index >= 0) queue.splice(index, 1)
            finish()
            reject(error)
          }
        }
        const abort = () => cancel(new SandboxError('ABORTED'))
        const timer = setTimeout(() => cancel(busy()), timeoutMs)
        const entry = {
          start() {
            running = true
            inFlight++
            void (async () => {
              try {
                for (;;) {
                  if (reason) throw reason
                  if (Date.now() >= deadline) throw busy()
                  try {
                    const result = await process.run(bytes, async session => {
                      if (reason) throw reason
                      if (Date.now() >= deadline) throw busy()
                      started = true
                      clearTimeout(timer)
                      return execute(session)
                    }, { signal: controller.signal })
                    if (reason) throw reason
                    resolve(result)
                    return
                  } catch (error) {
                    if (reason) throw reason
                    if (!(error instanceof SandboxError) || error.code !== 'SANDBOX_BUSY') throw error
                    if (started || Date.now() >= deadline) throw busy()
                    await delay(Math.min(retryMs, deadline - Date.now()), undefined, { signal: controller.signal })
                  }
                }
              } catch (error) { reject(reason ?? error) }
              finally { finish() }
            })()
          },
        }
        queue.push(entry)
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
        pump()
      })
    },
  }
}
