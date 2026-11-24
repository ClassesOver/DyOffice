import { describe, expect, it } from 'vitest'

import { createEditJournal } from '../src/renderer/edit-journal'
import { collectCfStates, dropShadowedPaintOnceRules } from '../src/renderer/univer-sync'

const area = (startRow: number, startColumn: number, endRow: number, endColumn: number) => ({
  startRow,
  startColumn,
  endRow,
  endColumn,
})

it('tracks unchanged, edited and deleted imported rules in the renderer save snapshot', () => {
  const ranges = [area(0, 0, 1, 0)]
  const rule = { type: 'dataBar', config: { min: { type: 'num', value: 1 } } }
  const unchanged = { cfId: 'original', ranges, stopIfTrue: false, rule }
  const edited = { cfId: 'edited', ranges, stopIfTrue: true, rule }
  const snapshot = JSON.stringify({
    ranges: [{ startRow: 0, endRow: 1, startColumn: 0, endColumn: 0 }],
    stopIfTrue: false,
    rule,
  })
  const worksheet = { getConditionalFormattingRules: () => [unchanged, edited] }
  const workbook = { getSheetBySheetId: () => worksheet }
  const state = {
    editJournal: createEditJournal(),
    cfSourceRules: new Map([
      [
        'sheet',
        new Map([
          ['original', { priority: 1, snapshot }],
          ['edited', { priority: 2, snapshot }],
          ['removed', { priority: 3, snapshot }],
        ]),
      ],
    ]),
  }
  state.editJournal.cfDirty.add('sheet')
  const [saved] = collectCfStates(
    { univerAPI: { getActiveWorkbook: () => workbook } } as never,
    state as never,
  )
  expect(saved?.rules.map((entry) => entry.source)).toEqual([
    { priority: 1, unchanged: true },
    { priority: 2, unchanged: false },
  ])
  expect(saved?.removedSourcePriorities).toEqual([3])
})

const rule = (
  ruleType: string,
  priority: number,
  ranges: ReturnType<typeof area>[],
): Parameters<typeof dropShadowedPaintOnceRules>[0][number] =>
  ({ ruleType, priority, ranges, formulas: [], percent: false, bottom: false, cfvos: [] }) as never

describe('dropShadowedPaintOnceRules', () => {
  it('drops a color scale fully covered by a higher-precedence one', () => {
    // tdf105272: the real scale (B3:D4, priority 12) plus three stacked
    // duplicates on B4:D4 — Excel paints only the top one.
    const rules = [
      rule('colorScale', 12, [area(2, 1, 3, 3)]),
      rule('colorScale', 13, [area(3, 1, 3, 3)]),
      rule('colorScale', 14, [area(3, 1, 3, 3)]),
      rule('dataBar', 11, [area(3, 4, 3, 4)]),
      rule('dataBar', 16, [area(3, 4, 3, 4)]),
    ]
    expect(dropShadowedPaintOnceRules(rules).map((kept) => kept.priority)).toEqual([12, 11])
  })

  it('keeps partial overlaps and non-paint-once rules', () => {
    const rules = [
      rule('colorScale', 1, [area(0, 0, 5, 5)]),
      rule('colorScale', 2, [area(3, 3, 9, 9)]),
      rule('cellIs', 3, [area(0, 0, 5, 5)]),
      rule('cellIs', 4, [area(0, 0, 5, 5)]),
    ]
    expect(dropShadowedPaintOnceRules(rules)).toHaveLength(4)
  })
})
