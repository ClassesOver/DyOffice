import type {
  WorkbookChartEdit,
  WorkbookVisualEdit,
  WorkbookVisualObject,
} from '../shared/desktop-api'
import { savedJournal, type EditJournal } from './edit-journal'

/** Restore properties whose undo deleted a journal field. Omission would
 * otherwise leave the last saved value in the new backing session. */
export function chartEditsWithUndo(
  journal: EditJournal,
  visuals: readonly WorkbookVisualObject[],
  edits: WorkbookChartEdit[],
): WorkbookChartEdit[] {
  const saved = savedJournal(journal)
  if (!saved) return edits
  const byPath = new Map(edits.map((edit) => [edit.chartPath, edit]))
  for (const [path, previous] of saved.chartEdits) {
    const chart = visuals.find((visual) => visual.chartPath === path)?.chart
    if (!chart) continue
    const current = journal.chartEdits.get(path)
    const reset: Omit<WorkbookChartEdit, 'chartPath'> = {}
    if (previous.title !== undefined && current?.title === undefined) reset.title = chart.title
    if (previous.legend !== undefined && current?.legend === undefined)
      reset.legend = chart.legend ?? 'none'
    if (previous.dataLabels !== undefined && current?.dataLabels === undefined) {
      reset.dataLabels =
        chart.dataLabels === 'category-value-percent'
          ? 'category-percent'
          : (chart.dataLabels ?? 'none')
    }
    for (const key of ['category', 'value'] as const) {
      if (previous.axisTitles?.[key] !== undefined && current?.axisTitles?.[key] === undefined) {
        reset.axisTitles = { ...reset.axisTitles, [key]: chart.axisTitles?.[key] ?? null }
      }
    }
    for (const key of ['min', 'max'] as const) {
      if (previous.valueAxis?.[key] !== undefined && current?.valueAxis?.[key] === undefined) {
        reset.valueAxis = { ...reset.valueAxis, [key]: chart.valueAxis?.[key] ?? null }
      }
    }
    if (previous.gridlines !== undefined && current?.gridlines === undefined)
      reset.gridlines = chart.gridlines ?? false
    if (previous.grouping !== undefined && current?.grouping === undefined)
      reset.grouping = chart.grouping === 'standard' ? 'clustered' : (chart.grouping ?? 'clustered')
    if (previous.gapWidthPct !== undefined && current?.gapWidthPct === undefined)
      reset.gapWidthPct = chart.gapWidthPct ?? 150
    if (previous.holeSizePct !== undefined && current?.holeSizePct === undefined)
      reset.holeSizePct = chart.holeSizePct ?? 50
    if (previous.explosionPct !== undefined && current?.explosionPct === undefined)
      reset.explosionPct = chart.series[0]?.explosionPct ?? 0
    if (previous.dataLabelFormat !== undefined && current?.dataLabelFormat === undefined)
      reset.dataLabelFormat = chart.dataLabelFormat ?? 'General'
    if (previous.dataLabelPosition !== undefined && current?.dataLabelPosition === undefined)
      reset.dataLabelPosition = chart.dataLabelPosition ?? 'center'
    // Series cache/title edits restore each touched series, preserving refs.
    if (previous.series && !current?.seriesSet) {
      const series = new Map((current?.series ?? []).map((entry) => [entry.index, entry]))
      for (const old of previous.series) {
        const original = chart.series[old.index]
        if (!original) continue
        const desired = series.get(old.index)
        series.set(old.index, {
          index: old.index,
          ...(old.name !== undefined && desired?.name === undefined ? { name: original.name } : {}),
          ...(old.values !== undefined && desired?.values === undefined
            ? {
                values: original.values,
                ...(original.valuesRef === undefined ? {} : { valuesRef: original.valuesRef }),
              }
            : {}),
          ...(old.categories !== undefined && desired?.categories === undefined
            ? {
                categories: original.categories,
                ...(original.categoriesRef === undefined
                  ? {}
                  : { categoriesRef: original.categoriesRef }),
              }
            : {}),
          ...desired,
        })
      }
      reset.series = [...series.values()]
    }
    if (Object.keys(reset).length)
      byPath.set(path, {
        chartPath: path,
        ...reset,
        ...byPath.get(path),
        ...(reset.axisTitles
          ? { axisTitles: { ...byPath.get(path)?.axisTitles, ...reset.axisTitles } }
          : {}),
        ...(reset.valueAxis
          ? { valueAxis: { ...byPath.get(path)?.valueAxis, ...reset.valueAxis } }
          : {}),
        ...(reset.series ? { series: reset.series } : {}),
      })
  }
  return [...byPath.values()]
}

export function visualEditsWithUndo(
  journal: EditJournal,
  visuals: readonly WorkbookVisualObject[],
  edits: WorkbookVisualEdit[],
): WorkbookVisualEdit[] {
  const saved = savedJournal(journal)
  if (!saved) return edits
  for (const [id, old] of saved.visualEdits) {
    const current = journal.visualEdits.get(id)
    const visual = visuals.find((entry) => entry.id === id)
    if (!visual || visual.drawingPath === undefined || visual.drawingIndex === undefined) continue
    const reset: WorkbookVisualEdit = {
      drawingPath: visual.drawingPath,
      drawingIndex: visual.drawingIndex,
    }
    if (old.anchor !== undefined && current?.anchor === undefined) reset.anchor = visual.anchor
    if (old.rotation !== undefined && current?.rotation === undefined)
      reset.rotation = visual.rotation ?? 0
    if (old.flipH !== undefined && current?.flipH === undefined) reset.flipH = visual.flipH ?? false
    if (old.flipV !== undefined && current?.flipV === undefined) reset.flipV = visual.flipV ?? false
    if (old.altText !== undefined && current?.altText === undefined)
      reset.altText = visual.altText ?? ''
    if (old.hyperlink !== undefined && current?.hyperlink === undefined)
      reset.hyperlink = visual.hyperlink ?? ''
    if (old.editAs !== undefined && current?.editAs === undefined)
      reset.editAs = visual.editAs ?? 'twoCell'
    if (Object.keys(reset).length === 2) continue
    const index = edits.findIndex(
      (edit) => edit.drawingPath === reset.drawingPath && edit.drawingIndex === reset.drawingIndex,
    )
    if (index < 0) edits.push(reset)
    else edits[index] = { ...reset, ...edits[index] }
  }
  return edits
}
