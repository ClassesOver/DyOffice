/** A QC pass must have a rollback checkpoint, and must close its batch even on cancellation. */
export async function runQcHistoryBatch<T>(
  history: { begin(): Promise<boolean>; end(): Promise<number | null> },
  run: () => Promise<T>,
): Promise<{ result: T; snapshotId: number | null } | null> {
  // A lost begin response may still have opened the server batch.
  let mustClose = true
  let result: T
  let snapshotId: number | null = null
  try {
    if (!await history.begin()) {
      mustClose = false
      return null
    }
    result = await run()
  } finally {
    if (mustClose) snapshotId = await history.end()
  }
  return { result, snapshotId }
}
