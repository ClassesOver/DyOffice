// @vitest-environment jsdom
import { act, createElement, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'

import {
  clearVisualSelection,
  getChartElementSelection,
  installWorkbookVisuals,
  installedVisualFrames,
  selectedVisualIds,
} from '../src/renderer/WorkbookVisuals'
import type { createUniver } from '../src/renderer/create-univer'
import type { WorkbookVisualObject } from '../src/shared/desktop-api'

it('selects and edits a grouped chart while keeping its anchor with the group', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  const components = new Map<string, ComponentType>()
  const worksheet = {
    getMaxRows: () => 100,
    getMaxColumns: () => 100,
    getColumnWidth: () => 64,
    getRowHeight: () => 20,
    getSheet: () => ({ getConfig: () => ({ rightToLeft: 0 }) }),
    getRange: () => ({}),
    addFloatDomToRange: () => ({ dispose: () => undefined }),
  }
  const runtime = {
    univerAPI: {
      getActiveWorkbook: () => ({ getWorkbook: () => ({}), getSheetBySheetId: () => worksheet }),
      registerComponent: (key: string, component: ComponentType) => {
        components.set(key, component)
        return { dispose: () => components.delete(key) }
      },
    },
  } as unknown as ReturnType<typeof createUniver>
  const grouped: WorkbookVisualObject = {
    id: 'grouped',
    sheetId: 'sheet-1',
    kind: 'chart',
    chartPath: 'xl/charts/chart1.xml',
    drawingPath: 'xl/drawings/drawing1.xml',
    flipH: true,
    flipV: true,
    anchor: {
      fromRow: 0,
      fromColumn: 0,
      fromRowOffset: 0,
      fromColumnOffset: 0,
      toRow: 4,
      toColumn: 4,
      toRowOffset: 0,
      toColumnOffset: 0,
    },
    chart: {
      chartTypes: ['lineChart'],
      title: 'Sales',
      series: [{ name: 'Revenue', categories: ['Jan', 'Feb'], values: [1, 2] }],
    },
  }
  const regular = {
    ...grouped,
    id: 'regular',
    chartPath: 'xl/charts/chart2.xml',
    drawingIndex: 1,
    flipH: false,
    flipV: false,
  }
  const rotated: WorkbookVisualObject = {
    ...grouped,
    id: 'rotated',
    chartPath: 'xl/charts/chart3.xml',
    flipH: undefined,
    flipV: undefined,
    groupTransform: { matrix: [0, 1, 1, 0], width: 1905000, height: 952500 },
    anchor: {
      fromRow: 2,
      fromColumn: 3,
      fromRowOffset: -28575,
      fromColumnOffset: -19050,
      toRow: 2,
      toColumn: 3,
      toRowOffset: 1876425,
      toColumnOffset: 933450,
    },
  }
  const editAnchor = vi.fn()
  const editChart = vi.fn()
  const scope = installWorkbookVisuals(
    runtime,
    { sessionId: 'session', visuals: [grouped, regular, rotated] },
    'sheet-1',
    { edits: new Map(), onEdit: editChart },
    { onEdit: editAnchor },
  )
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    act(() => {
      root.render([
        createElement(components.get('xlsx-session-grouped')!, { key: grouped.id }),
        createElement(components.get('xlsx-session-regular')!, { key: regular.id }),
        createElement(components.get('xlsx-session-rotated')!, { key: rotated.id }),
      ])
    })
    expect(
      installedVisualFrames('sheet-1').find((frame) => frame.visual.id === rotated.id),
    ).toMatchObject({
      fromRow: 1,
      fromColumn: 2,
      marginX: 62,
      marginY: 17,
      width: 100,
      height: 200,
    })
    const rotatedFigure = container.querySelector<HTMLElement>(
      '[data-print-visual="rotated"] figure',
    )!
    const surface = rotatedFigure.querySelector<HTMLElement>('.xlsx-group-content')!
    expect(surface.style.transform).toBe('translate(-50%, -50%) matrix(0, 1, 1, 0, 0, 0)')
    expect(surface.contains(rotatedFigure.querySelector('.chart-edit-button'))).toBe(false)
    act(() => surface.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })))
    expect(selectedVisualIds()).toEqual([rotated.id])
    const figure = container.querySelector<HTMLElement>('[data-print-visual="grouped"] figure')!
    const title = figure.querySelector('figcaption')!
    expect(figure.style.flexDirection).toBe('column-reverse')
    expect(title.style.transform).toBe('scale(-1, -1)')
    expect(figure.querySelector<HTMLElement>('.chart-body')!.style.transform).toBe('scale(-1, -1)')
    expect(figure.querySelector<HTMLElement>('.chart-edit-button')!.style.transform).toBe('')
    act(() => {
      title.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      title.click()
    })
    expect(selectedVisualIds()).toEqual([grouped.id])
    expect(getChartElementSelection()).toEqual({ visualId: grouped.id, element: { kind: 'title' } })
    expect(figure.closest('.selected')).toBeTruthy()
    expect(container.querySelector('[data-print-visual="grouped"] .shape-handle')).toBeNull()

    act(() => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }),
      )
    })
    expect(editAnchor).not.toHaveBeenCalled()
    act(() => {
      container
        .querySelector('[data-print-visual="regular"] .shape-editable')!
        .dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, shiftKey: true }))
    })
    expect(selectedVisualIds()).toEqual([regular.id])

    act(() => figure.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 })))
    expect(selectedVisualIds()).toEqual([grouped.id])
    const menuItem = document.querySelector<HTMLButtonElement>('.chart-menu button')!
    act(() => menuItem.click())
    act(() => figure.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    const input = figure.querySelector<HTMLInputElement>('.chart-editor-title')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'Profit',
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      figure.querySelector<HTMLButtonElement>('.chart-editor-apply')!.click()
    })
    expect(editChart).toHaveBeenCalledWith(grouped.chartPath, { title: 'Profit' })
    expect(editAnchor).not.toHaveBeenCalled()
  } finally {
    act(() => root.unmount())
    clearVisualSelection()
    container.remove()
    scope.forEach((disposable) => disposable.dispose())
    vi.unstubAllGlobals()
  }
})
