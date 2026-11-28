import { describe, expect, it } from 'vitest'
import { applyCfRules, type DxfSink } from '../src/gateway/xlsx-cf'

const dxfs: DxfSink = { internDxf: () => 0 }

describe('conditional formatting XML scope', () => {
  const xmlns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
  const added = {
    ranges: [{ startRow: 0, endRow: 0, startColumn: 2, endColumn: 2 }],
    stopIfTrue: false,
    rule: { type: 'highlightCell', subType: 'number', operator: 'greaterThan', value: 5 },
  }

  it('replaces and appends worksheet rules without using foreign priorities or anchors', () => {
    const foreign =
      '<conditionalFormatting xmlns="urn:foreign" sqref="B1"><cfRule priority="99"/><extLst/></conditionalFormatting>'
    const foreignRule = '<s:cfRule xmlns:s="urn:foreign" priority="80"/>'
    const coreRule =
      '<s:cfRule type="cellIs" priority="1" operator="greaterThan"><s:formula>3</s:formula></s:cfRule>'
    const sheet =
      `<worksheet xmlns="${xmlns}" xmlns:s="${xmlns}"><sheetData/>` +
      '<s:conditionalFormatting sqref="A1">' +
      coreRule +
      foreignRule +
      '</s:conditionalFormatting>' +
      '<drawing/>' +
      foreign +
      '</worksheet>'

    const rewritten = applyCfRules(sheet, [added], dxfs, { preserveUneditable: true })
    expect(rewritten).toContain(foreign)
    expect(rewritten).toContain(foreignRule)
    expect(rewritten).not.toContain(coreRule)
    expect(rewritten).toMatch(/sqref="C1"><cfRule[^>]*priority="1"/)

    const appended = applyCfRules(sheet, [added], dxfs, { append: true })
    expect(appended).toContain(coreRule)
    expect(appended).toContain(foreign)
    expect(appended).toMatch(
      /<\/s:conditionalFormatting><conditionalFormatting sqref="C1"><cfRule[^>]*priority="2"/,
    )
  })

  it('inserts a new rule at worksheet level before a prefixed tail', () => {
    const sheet = `<s:worksheet xmlns:s="${xmlns}"><s:sheetData><s:row><extLst/></s:row></s:sheetData><s:drawing/></s:worksheet>`
    const result = applyCfRules(sheet, [added], dxfs)
    expect(result).toMatch(
      /<\/s:sheetData><s:conditionalFormatting sqref="C1"><s:cfRule[^>]*>.*<\/s:conditionalFormatting><s:drawing\/>/,
    )
  })

  it('removes the targeted x14 twin while preserving foreign rules with the same ID', () => {
    const id = '{11111111-1111-1111-1111-111111111111}'
    const otherId = '{22222222-2222-2222-2222-222222222222}'
    const foreignExtension =
      '<extLst xmlns="urn:foreign"><ext uri="{78C0D931-6437-407D-A8EE-F0AAD7539E65}"/></extLst>'
    const foreignRule = `<x14:cfRule xmlns:x14="urn:foreign" id="${id}"/>`
    const linked = `<x14:cfRule id="${id}"><x14:dataBar/></x14:cfRule>`
    const sibling = `<x14:cfRule id="${otherId}"><x14:dataBar/></x14:cfRule>`
    const sheet =
      `<worksheet xmlns="${xmlns}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><sheetData/>` +
      '<conditionalFormatting sqref="A1"><cfRule type="dataBar" priority="1">' +
      `<extLst><ext uri="{B025F937-C7B1-47D3-B67F-A62EFF666E3E}"><x14:id>${id}</x14:id></ext></extLst></cfRule></conditionalFormatting>` +
      foreignExtension +
      '<extLst><ext uri="{78C0D931-6437-407D-A8EE-F0AAD7539E65}"><x14:conditionalFormattings><x14:conditionalFormatting>' +
      linked +
      foreignRule +
      '</x14:conditionalFormatting><x14:conditionalFormatting>' +
      sibling +
      '</x14:conditionalFormatting></x14:conditionalFormattings></ext></extLst></worksheet>'
    const updated = applyCfRules(sheet, [], dxfs, {
      preserveUneditable: true,
      removedSourcePriorities: [1],
    })
    expect(updated).toContain(foreignExtension)
    expect(updated).toContain(foreignRule)
    expect(updated).toContain(sibling)
    expect(updated).not.toContain(linked)
    expect(updated).not.toContain('sqref="A1"')
  })
})
