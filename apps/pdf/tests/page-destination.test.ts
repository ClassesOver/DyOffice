import { describe, expect, it } from 'vitest'
import { pageDestination } from '../src/renderer/page-destination'

const page = { pw: 400, ph: 800, rot: 0, x0: 10, y0: 20, userUnit: 2 }
const viewport = { width: 600, height: 400 }

describe('pageDestination', () => {
  it('converts an XYZ point through the cropped, rotated page geometry', () => {
    const dest = [0, { name: 'XYZ' }, 30, 60, 1.5]
    expect(pageDestination(dest, { ...page, rot: 90 }, viewport)).toEqual({
      x: 80,
      y: 40,
      scale: 1.5,
    })
  })

  it('retains the page-only behavior for an empty XYZ destination', () => {
    expect(pageDestination([0, 'XYZ', null, null, 0], page, viewport)).toBeNull()
  })

  it.each([
    ['Fit', null, { x: 0, y: 0, scale: 0.5 }],
    ['FitB', null, { x: 0, y: 0, scale: 0.5 }],
    ['FitH', 120, { x: 0, y: 600, scale: 1.5 }],
    ['FitBH', 120, { x: 0, y: 600, scale: 1.5 }],
    ['FitV', 30, { x: 40, y: 0, scale: 0.5 }],
    ['FitBV', 30, { x: 40, y: 0, scale: 0.5 }],
  ])('applies %s with the target page dimensions', (mode, offset, expected) => {
    expect(pageDestination([0, mode, offset], page, viewport)).toEqual(expected)
  })

  it('fits a rectangle after mapping it to the rotated page', () => {
    expect(pageDestination([0, 'FitR', 60, 70, 160, 120], { ...page, rot: 90 }, viewport)).toEqual({
      x: 100,
      y: 100,
      scale: 2,
    })
  })

  it('falls back to the page for a rectangle without area', () => {
    expect(pageDestination([0, 'FitR', 10, 20, 10, 90], page, viewport)).toBeNull()
  })
})
