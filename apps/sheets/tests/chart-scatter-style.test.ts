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
})
