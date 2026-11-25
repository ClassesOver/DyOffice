import { expect, it } from 'vitest'

import { applyStructuralOps, shiftCrossSheetFormulas } from '../src/gateway/xlsx-structure'

const sparklineUri = '{05C60535-1F16-4FD2-B633-F4F36F0B64E0}'
const conditionalUri = '{78C0D931-6437-407D-A8EE-F0AAD7539E65}'
const x14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main'
const xm = 'http://schemas.microsoft.com/office/excel/2006/main'

function worksheet(sparkSource: string) {
  return `<worksheet xmlns:v="${x14}" xmlns:m="${xm}"><sheetData/>
    <conditionalFormatting sqref="D2"><cfRule type="iconSet">
      <iconSet><cfvo type='formula' val='Data!$A$2'/><cfvo type="num" val="20"/></iconSet>
    </cfRule></conditionalFormatting>
    <extLst>
      <ext uri="${sparklineUri}"><v:sparklineGroups><v:sparklineGroup>
        <v:sparklines><v:sparkline><m:f>${sparkSource}</m:f><m:sqref>D2</m:sqref></v:sparkline></v:sparklines>
      </v:sparklineGroup></v:sparklineGroups></ext>
      <ext uri="${conditionalUri}"><v:conditionalFormattings><v:conditionalFormatting>
        <v:cfRule type="expression"><m:f>Data!A2&gt;0</m:f></v:cfRule>
        <m:sqref>D2</m:sqref>
      </v:conditionalFormatting></v:conditionalFormattings></ext>
      <ext uri="unrelated"><v:conditionalFormattings><m:f>Data!A2</m:f></v:conditionalFormattings></ext>
    </extLst>
  </worksheet>`
}

it('moves qualified external-sheet sources while preserving local targets and other extensions', () => {
  const xml = shiftCrossSheetFormulas(worksheet('Data!A2:A3'), 'Data', [
    { kind: 'insert-rows', index: 1, count: 1 },
  ])
  expect(xml).toContain('<m:f>Data!A3:A4</m:f><m:sqref>D2</m:sqref>')
  expect(xml).toContain('<m:f>Data!A3&gt;0</m:f>')
  expect(xml).toContain('val="Data!$A$3"')
  expect(xml).toContain('type="num" val="20"')
  expect(xml).toContain('<ext uri="unrelated"><v:conditionalFormattings><m:f>Data!A2</m:f>')
})

it('removes visual rules and sparkline groups when all their target cells are deleted', () => {
  const xml = applyStructuralOps(
    worksheet('Data!A2:A4'),
    [{ kind: 'remove-rows', index: 1, count: 1 }],
    'Data',
  )
  expect(xml).not.toContain(sparklineUri)
  expect(xml).not.toContain(conditionalUri)
  expect(xml).not.toContain('<conditionalFormatting')
  expect(xml).toContain('<ext uri="unrelated">')
})
