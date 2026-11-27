import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { ScatterChart } from '../src/renderer/WorkbookVisuals'

const series = { name: 'Measurements', categories: ['1', '2'], values: [3, 5] }

function render(scatterStyle: string, marker?: string) {
  return renderToStaticMarkup(createElement(ScatterChart, {
    scatterStyle,
    seriesList: [{ ...series, marker }],
  }))
}

describe('scatter series styling', () => {
  it('draws only the stroke for a plain line and suppresses both defaults for none', () => {
    const line = render('line')
    expect(line).toContain('<polyline')
    expect(line).not.toContain('<circle')
    const none = render('none')
    expect(none).not.toContain('<polyline')
    expect(none).not.toContain('<circle')
  })

  it('renders an authored diamond and lets an explicit marker override the plot default', () => {
    const diamonds = render('line', 'diamond')
    expect(diamonds).toContain('<polyline')
    expect(diamonds.match(/<polygon/g)).toHaveLength(2)
    expect(render('lineMarker', 'none')).not.toContain('<circle')
    expect(render('marker', 'circle')).not.toContain('<polyline')
    expect(render('marker', 'circle').match(/<circle/g)).toHaveLength(2)
  })

  it('draws smooth plot and series strokes while honoring an explicit straight series', () => {
    const zigzag = { ...series, categories: ['1', '2', '3'], values: [3, 7, 5] }
    const chart = (scatterStyle: string, smooth?: boolean) => renderToStaticMarkup(createElement(ScatterChart, {
      scatterStyle, seriesList: [{ ...zigzag, smooth, lineColor: '#10253F', lineWidth: 4 }],
    }))
    expect(chart('smoothMarker')).toMatch(/<path d="M[^\"]+C[^\"]+" fill="none" stroke="#10253F" stroke-width="4"/)
    expect(chart('line', true)).toMatch(/<path d="M[^\"]+C/)
    expect(chart('smooth', false)).toContain('<polyline')
  })

  it('separates gaps, spans missing cells, and draws zero-valued points when requested', () => {
    const sparse = { ...series, categories: ['1', '2', '3', '4', '5'], values: [3, 5, 0, 2, 4], blanks: [2] }
    const chart = (dispBlanksAs: 'gap' | 'span' | 'zero') => renderToStaticMarkup(createElement(ScatterChart, {
      scatterStyle: 'lineMarker', dispBlanksAs, seriesList: [sparse],
    }))
    expect([...chart('gap').matchAll(/<polyline points="([^"]+)"/g)].map(match => match[1]?.split(' ').length)).toEqual([2, 2])
    expect([...chart('span').matchAll(/<polyline points="([^"]+)"/g)].map(match => match[1]?.split(' ').length)).toEqual([4])
    expect(chart('zero').match(/<circle/g) ?? []).toHaveLength(5)
  })
})
