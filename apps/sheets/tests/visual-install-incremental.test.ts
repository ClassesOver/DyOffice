import { describe, expect, it } from 'vitest'

import { installWorkbookVisuals } from '../src/renderer/WorkbookVisuals'
import type { createUniver } from '../src/renderer/create-univer'
import type { WorkbookVisualObject } from '../src/shared/desktop-api'

describe('workbook visual installation', () => {
  it('keeps an untouched chart mounted when another chart moves', () => {
    const registrations = new Map<string, number>()
    const disposals = new Map<string, number>()
    const worksheet = {
      getMaxRows: () => 100,
      getMaxColumns: () => 100,
      getColumnWidth: () => 64,
      getRowHeight: () => 20,
      getSheet: () => ({ getConfig: () => ({ rightToLeft: 0 }) }),
      getRange: () => ({}),
      addFloatDomToRange: (_range: unknown, _config: unknown, _layout: unknown, id: string) => ({
        dispose: () => disposals.set(id, (disposals.get(id) ?? 0) + 1),
      }),
    }
    const model = {}
    const runtime = {
      univerAPI: {
        getActiveWorkbook: () => ({ getWorkbook: () => model, getSheetBySheetId: () => worksheet }),
        registerComponent: (key: string) => {
          registrations.set(key, (registrations.get(key) ?? 0) + 1)
          return { dispose: () => disposals.set(key, (disposals.get(key) ?? 0) + 1) }
        },
      },
    } as unknown as ReturnType<typeof createUniver>
    const chart = (id: string, fromColumn: number): WorkbookVisualObject =>
      ({
        id,
        sheetId: 'sheet-1',
        kind: 'chart',
        chartPath: `xl/charts/${id}.xml`,
        anchor: {
          fromRow: 0,
          fromColumn,
          fromRowOffset: 0,
          fromColumnOffset: 0,
          toRow: 4,
          toColumn: fromColumn + 4,
          toRowOffset: 0,
          toColumnOffset: 0,
        },
        chart: { chartTypes: ['line'], title: id, series: [] },
      }) as WorkbookVisualObject
    const first = chart('first', 0)
    const second = chart('second', 8)
    const host = { sessionId: 'session', visuals: [first, second] }

    const scope = installWorkbookVisuals(runtime, host, 'sheet-1')
    installWorkbookVisuals(runtime, { ...host, visuals: [chart('first', 1), second] }, 'sheet-1')

    expect(registrations.get('xlsx-session-second')).toBe(1)
    expect(registrations.get('xlsx-session-first')).toBe(2)
    expect(disposals.get('session-second')).toBeUndefined()
    expect(disposals.get('session-first')).toBe(1)
    installWorkbookVisuals(runtime, host, 'sheet-2')
    expect(disposals.get('session-second')).toBe(1)
    const restored = installWorkbookVisuals(runtime, host, 'sheet-1')
    expect(registrations.get('xlsx-session-second')).toBe(2)
    scope.forEach((disposable) => disposable.dispose())
    expect(disposals.get('session-second')).toBe(1)
    restored.forEach((disposable) => disposable.dispose())
  })
})
