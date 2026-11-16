/** An explicit owner-side shutdown sequence, not installed in app.ts.
 * Caller must fence/drain other users of shared resources (HTTP authentication,
 * catalog and non-provider jobs) separately before providing closeResources.
 * A failed/timed-out drain deliberately does not close those resources. */
export function createProviderShutdown({ pipeline, closeResources, timeoutMs = 35_000 }: {
  pipeline: { dispose(): void; drain(options?: { timeoutMs?: number }): Promise<void> }
  closeResources(): Promise<void>
  timeoutMs?: number
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 35_000) throw new Error('Invalid provider shutdown deadline')
  let completion: Promise<void> | undefined
  return function shutdown(): Promise<void> {
    if (completion) return completion
    // Shared promise represents this single shutdown, not repeated request work.
    // Assign it before invoking callbacks so reentrant shutdown cannot close twice.
    let resolve!: () => void, reject!: (error: unknown) => void
    completion = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    try {
      pipeline.dispose()
      void pipeline.drain({ timeoutMs }).then(closeResources).then(resolve, reject)
    } catch (error) { reject(error) }
    return completion
  }
}
