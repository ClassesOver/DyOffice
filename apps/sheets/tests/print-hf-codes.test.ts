import { describe, expect, it } from 'vitest'

import { expandHeaderFooterCodes } from '../src/renderer/print-hf-codes'

const fields = {
  page: 2,
  total: 9,
  date: new Date(2026, 0, 2, 3, 4, 5),
  fileName: 'Budget.xlsx',
  sheetName: 'Q1',
  filePath: '/books',
}

describe('expandHeaderFooterCodes', () => {
  it('resolves the stored codes', () => {
    expect(expandHeaderFooterCodes('Page &P of &N', fields)).toBe('Page 2 of 9')
    expect(expandHeaderFooterCodes('&F / &A', fields)).toBe('Budget.xlsx / Q1')
    expect(expandHeaderFooterCodes('&Z', fields)).toBe('/books')
    expect(expandHeaderFooterCodes('&D', fields)).toBe(fields.date.toLocaleDateString())
    expect(expandHeaderFooterCodes('&T', fields)).toBe(fields.date.toLocaleTimeString())
  })

  it('accepts the bracketed names the Excel UI shows', () => {
    expect(expandHeaderFooterCodes('&[Page] / &[Pages] &[Tab] &[File]', fields)).toBe(
      '2 / 9 Q1 Budget.xlsx',
    )
    expect(expandHeaderFooterCodes('&[Nope]', fields)).toBe('&[Nope]')
  })

  it('offsets the page number', () => {
    expect(expandHeaderFooterCodes('&P+10', fields)).toBe('12')
    expect(expandHeaderFooterCodes('&P-1 of &N', fields)).toBe('1 of 9')
  })

  it('offsets the total page count in stored and named fields', () => {
    expect(expandHeaderFooterCodes('Page &P of &N+2', fields)).toBe('Page 2 of 11')
    expect(expandHeaderFooterCodes('&[Page]+5 of &[Pages]-2', fields)).toBe('7 of 7')
    expect(expandHeaderFooterCodes('&N+12345', fields)).toBe('12354')
    expect(expandHeaderFooterCodes('&N+ copies / &&N+2', fields)).toBe('9+ copies / &N+2')
  })

  it('keeps offsets that exceed the integer range as literal text', () => {
    expect(expandHeaderFooterCodes('&N+99999999999999999999', fields)).toBe(
      '9+99999999999999999999',
    )
  })

  it('keeps literal ampersands and unknown codes', () => {
    expect(expandHeaderFooterCodes('Profit && Loss', fields)).toBe('Profit & Loss')
    expect(expandHeaderFooterCodes('R&Q', fields)).toBe('R&Q')
    expect(expandHeaderFooterCodes('Tail&', fields)).toBe('Tail&')
  })

  it('replaces &G with the picture placeholder only when one is given', () => {
    expect(expandHeaderFooterCodes('&G Logo', fields)).toBe(' Logo')
    expect(expandHeaderFooterCodes('&G Logo', { ...fields, picture: '#' })).toBe('# Logo')
  })
})
