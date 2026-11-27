import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { BarChart, LineChart } from '../src/renderer/WorkbookVisuals'

const series = {
  name: 'Revenue', categories: ['Q1', 'Q2', 'Q3'], values: [3, 7, 5],
  lineWidth: 4, lineColor: '#10253F', smooth: true,
}

describe('smooth line series', () => {
  it('retains the stroke style and the increased width of a selected line', () => {
    const markup = renderToStaticMarkup(createElement(LineChart, {
      seriesList: [series], selectedEl: { kind: 'series', seriesIndex: 0 },
    }))
    expect(markup).toMatch(/<path d="M[^"]+C[^"]+" fill="none" stroke="#10253F" stroke-width="6"/)
  })

  it('honors smoothing and keeps separate gaps in column and line combos', () => {
    const categories = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7']
    const markup = renderToStaticMarkup(createElement(BarChart, {
      seriesList: [{ name: 'Units', categories, values: [1, 2, 3, 4, 5, 6, 7] }],
      lineSeriesList: [{ ...series, categories, values: [3, 7, 5, 0, 6, 9, 3], blanks: [3] }],
      isHorizontal: false, dispBlanksAs: 'gap', secondaryAxis: { min: 0, max: 10 },
    }))
    expect(markup.match(/<path d="M[^"]+C[^"]+" fill="none" stroke="#10253F"/g) ?? []).toHaveLength(2)
  })
})
