import type { UniverRuntime } from './univer-state'

/// Calculation can finish before its results reach the sheet model. A non-null
/// cached value can also predate the latest edit. Force a pass and wait for the
/// latest results to be applied before a save/export takes its snapshot.
export const FORMULA_SETTLE_TIMEOUT_MS = 30_000

export async function settleFormulas(runtime: UniverRuntime | null): Promise<void> {
  const workbook = runtime?.univerAPI.getActiveWorkbook()
  // a workbook facade without a snapshot (test doubles) has nothing to settle
  if (!runtime || !workbook || typeof workbook.getSnapshot !== 'function') return
  const formulaCounts = (): { total: number; pending: number } => {
    const snapshot = workbook.getSnapshot() as unknown as {
      sheets?: Record<
        string,
        { cellData?: Record<string, Record<string, { f?: unknown; v?: unknown }> | undefined> }
      >
    } | null
    let total = 0
    let pending = 0
    for (const sheet of Object.values(snapshot?.sheets ?? {})) {
      for (const row of Object.values(sheet?.cellData ?? {})) {
        for (const cell of Object.values(row ?? {})) {
          if (!cell?.f) continue
          total += 1
          if (cell.v === undefined || cell.v === null) pending += 1
        }
      }
    }
    return { total, pending }
  }
  // Cache presence proves neither freshness nor that an async pass has landed.
  if (formulaCounts().total === 0) return
  const formula = runtime.univerAPI.getFormula()
  // Older facades/test doubles expose only calculationEnd.
  const application = formula as typeof formula & {
    onCalculationResultApplied?: (timeout?: number) => Promise<void>
  }
  let subscription: { dispose(): void } | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  const bounded = async (work: Promise<void>, requireApplied = false): Promise<void> => {
    try {
      await Promise.race([
        work,
        new Promise<void>((resolve, reject) => {
          timeout = setTimeout(() => {
            if (requireApplied)
              reject(new Error('Formula results were not applied before the save timeout.'))
            else resolve()
          }, FORMULA_SETTLE_TIMEOUT_MS)
        }),
      ])
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }
  try {
    if (typeof application.onCalculationResultApplied === 'function') {
      // Subscribe before triggering: waitForLatestApplied follows replacement
      // calculation sessions and resolves after result mutations update cells.
      const applied = application.onCalculationResultApplied(FORMULA_SETTLE_TIMEOUT_MS)
      formula.executeCalculation()
      await bounded(applied, true)
      return
    }
    const ended = new Promise<void>((resolve) => {
      subscription = formula.calculationEnd(() => resolve())
    })
    formula.executeCalculation()
    await bounded(ended)
    // Compatibility fallback: older facades cannot distinguish an old non-null
    // cache from a new one, but still wait for missing cold-load results.
    const deadline = Date.now() + FORMULA_SETTLE_TIMEOUT_MS
    while (Date.now() < deadline && formulaCounts().pending > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  } finally {
    subscription?.dispose()
  }
}
