import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'

import {
  createBufferEntrySource,
  planCellEditsToXlsx,
} from '@genoffice/xlsx-gateway/gateway/xlsx-gateway'
import type { SheetTableEdit } from '@genoffice/xlsx-gateway/gateway/xlsx-gateway'
import { removeTablePart } from '@genoffice/xlsx-gateway/gateway/xlsx-table-edit'
import { buildKitchenSinkFixture } from './fixture-builder'

// The kitchen-sink fixture carries Table1 (A1:B2, columns A / hdr) on sheet Data.
async function planWith(
  edits: SheetTableEdit[],
  structuralOps: Parameters<typeof planCellEditsToXlsx>[2] = [],
  fixture?: Buffer,
) {
  const source = await createBufferEntrySource(fixture ?? await buildKitchenSinkFixture())
  const args: unknown[] = [source, [], structuralOps]
  while (args.length < 27) args.push(args.length === 10 ? null : [])
  args[4] = undefined
  args[21] = null
  args[22] = null
  args[26] = edits
  return planCellEditsToXlsx(...(args as Parameters<typeof planCellEditsToXlsx>))
}

function edit(overrides: Partial<SheetTableEdit> = {}): SheetTableEdit {
  return { sheetName: 'Data', tableName: 'Table1', ...overrides }
}

describe('table edits', () => {
  it('renames the table part by displayName', async () => {
    const plan = await planWith([edit({ name: 'Sales' })])
    const xml = plan.replaced.get('xl/tables/table1.xml')
    expect(xml).toContain('name="Sales" displayName="Sales"')
    expect(xml).toContain('ref="A1:B2"')
  })

  it('edits real table elements with single-quoted attributes and preserves extension markup', async () => {
    const zip = await JSZip.loadAsync(await buildKitchenSinkFixture())
    const path = 'xl/tables/table1.xml'
    const comment = '<!-- <table name="Table1" ref="Z1:Z2"><autoFilter ref="Z1:Z2"/></table> -->'
    const columnComment = '<!-- <tableColumn id="900" name="Ghost"/> -->'
    const ext = '<extLst><ext uri="urn:example"><e:tableStyleInfo name="Foreign"/></ext></extLst>'
    zip.file(path, `${comment}<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:e='urn:example' id='1' name='Table&#49;' displayName='Table&#49;' ref='A1:B2' e:label='A " B'>` +
      "<autoFilter ref='A1:B2'><filterColumn colId='0'><filters><filter val='1'/></filters></filterColumn></autoFilter>" +
      `<tableColumns count='2'>${columnComment}<tableColumn id='3' name='A'/>` +
      "<tableColumn id='7' name='hdr'><calculatedColumnFormula>[@A]*2</calculatedColumnFormula></tableColumn></tableColumns>" +
      `<tableStyleInfo name='TableStyleLight1' showFirstColumn='1'/>${ext}</table>`)

    const plan = await planWith([edit({
      name: 'Sales', style: 'TableStyleLight9', bandedRows: true,
      area: { startRow: 0, startColumn: 0, endRow: 3, endColumn: 1 },
      columnNames: ['A', 'Total'],
    })], [], await zip.generateAsync({ type: 'nodebuffer' }))
    const xml = plan.replaced.get(path)
    expect(xml).toContain(comment)
    expect(xml).toContain('name="Sales" displayName="Sales" ref="A1:B4"')
    expect(xml).toContain("e:label='A \" B'")
    expect(xml).toContain('<autoFilter ref="A1:B4"><filterColumn')
    expect(xml).toContain(columnComment)
    expect(xml).toContain('<tableColumn id=\'7\' name="Total"><calculatedColumnFormula>[@A]*2</calculatedColumnFormula>')
    const style = xml?.match(/<tableStyleInfo\b[^>]*\/>/)?.[0]
    expect(style).toContain('name="TableStyleLight9"')
    expect(style).toContain("showFirstColumn='1'")
    expect(style).toContain('showRowStripes="1"')
    expect(xml).toContain(ext)
  })

  it('writes the style and option flags into tableStyleInfo', async () => {
    const plan = await planWith([
      edit({
        style: 'TableStyleLight9',
        bandedRows: false,
        firstColumn: true,
        bandedColumns: true,
      }),
    ])
    const xml = plan.replaced.get('xl/tables/table1.xml')
    expect(xml).toContain(
      '<tableStyleInfo showFirstColumn="1" showLastColumn="0" showRowStripes="0" showColumnStripes="1" name="TableStyleLight9"/>',
    )
  })

  it('adds a totals row: count, shown flag and a filter that stops above it', async () => {
    const plan = await planWith([
      edit({
        totalsRow: true,
        filterButton: true,
        area: { startRow: 0, startColumn: 0, endRow: 2, endColumn: 1 },
      }),
    ])
    const xml = plan.replaced.get('xl/tables/table1.xml')
    expect(xml).toContain('ref="A1:B3"')
    expect(xml).toContain('totalsRowCount="1"')
    expect(xml).toContain('totalsRowShown="1"')
    expect(xml).toContain('<autoFilter ref="A1:B2"/>')
  })

  it('turning totals off clears totalsRowShown too', async () => {
    const plan = await planWith([edit({ totalsRow: false })])
    const xml = plan.replaced.get('xl/tables/table1.xml')
    expect(xml).not.toContain('totalsRowCount')
    expect(xml).toContain('totalsRowShown="0"')
  })

  it('drops the header row and its filter', async () => {
    const plan = await planWith([
      edit({ headerRow: false, area: { startRow: 1, startColumn: 0, endRow: 2, endColumn: 1 } }),
    ])
    const xml = plan.replaced.get('xl/tables/table1.xml')
    expect(xml).toContain('headerRowCount="0"')
    expect(xml).not.toContain('<autoFilter')
  })

  it('resizes with a new column list, keeping existing column ids', async () => {
    const plan = await planWith([
      edit({
        area: { startRow: 0, startColumn: 0, endRow: 4, endColumn: 2 },
        columnNames: ['A', 'hdr', 'Notes'],
      }),
    ])
    const xml = plan.replaced.get('xl/tables/table1.xml')
    expect(xml).toContain('ref="A1:C5"')
    expect(xml).toContain(
      '<tableColumns count="3"><tableColumn id="1" name="A"/><tableColumn id="2" name="hdr"/><tableColumn id="3" name="Notes"/></tableColumns>',
    )
  })

  it.each([
    ['<mergeCells count="1"><mergeCell ref=\'A3:B3\'/></mergeCells>', 'merged cells (A3:B3)'],
    ["<autoFilter ref='A3:B4'/>", 'sheet auto-filter (A3:B4)'],
  ])('rejects a resize into a real worksheet conflict', async (conflict, message) => {
    const zip = await JSZip.loadAsync(await buildKitchenSinkFixture())
    const path = 'xl/worksheets/sheet1.xml'
    const worksheet = await zip.file(path)!.async('text')
    zip.file(path, worksheet.replace('<autoFilter ref="A1:B2"/>', conflict))
    const fixture = await zip.generateAsync({ type: 'nodebuffer' })
    await expect(planWith([edit({ area: {
      startRow: 0, startColumn: 0, endRow: 3, endColumn: 1,
    } })], [], fixture).then(() => 'saved')).rejects.toThrow(message)
  })

  it('allows resize past markup in a comment and leaves existing filter overlap confined', async () => {
    const zip = await JSZip.loadAsync(await buildKitchenSinkFixture())
    const path = 'xl/worksheets/sheet1.xml'
    const worksheet = await zip.file(path)!.async('text')
    const comment = '<!-- <mergeCells><mergeCell ref="A3:B3"/></mergeCells> -->'
    zip.file(path, worksheet.replace('<legacyDrawing', comment + '<legacyDrawing'))
    const plan = await planWith([edit({ area: {
      startRow: 0, startColumn: 0, endRow: 3, endColumn: 1,
    } })], [], await zip.generateAsync({ type: 'nodebuffer' }))
    expect(plan.replaced.get('xl/tables/table1.xml')).toContain('ref="A1:B4"')
    expect(plan.replaced.get(path)).toBeUndefined()
  })

  it('keeps filter criteria on edits that leave the columns alone', async () => {
    const source = await createBufferEntrySource(await buildKitchenSinkFixture())
    const xmlWithCriteria = (await source.readText('xl/tables/table1.xml')).replace(
      '<tableColumns',
      '<autoFilter ref="A1:B2"><filterColumn colId="0"><filters><filter val="1"/></filters></filterColumn></autoFilter><tableColumns',
    )
    const patched = {
      ...source,
      readText: (path: string) =>
        path === 'xl/tables/table1.xml' ? Promise.resolve(xmlWithCriteria) : source.readText(path),
    }
    const args: unknown[] = [patched, [], []]
    while (args.length < 27) args.push(args.length === 10 ? null : [])
    args[4] = undefined
    args[21] = null
    args[22] = null
    args[26] = [
      edit({ name: 'Sales', area: { startRow: 0, startColumn: 0, endRow: 4, endColumn: 1 } }),
    ]
    const plan = await planCellEditsToXlsx(...(args as Parameters<typeof planCellEditsToXlsx>))
    const xml = plan.replaced.get('xl/tables/table1.xml')
    expect(xml).toContain('<autoFilter ref="A1:B5"><filterColumn colId="0">')
  })

  it('keeps column ids with their sheet column when the left edge moves', async () => {
    const plan = await planWith([
      edit({
        area: { startRow: 0, startColumn: 1, endRow: 2, endColumn: 2 },
        columnNames: ['hdr', 'Notes'],
      }),
    ])
    const xml = plan.replaced.get('xl/tables/table1.xml')
    expect(xml).toContain(
      '<tableColumns count="2"><tableColumn id="2" name="hdr"/><tableColumn id="3" name="Notes"/></tableColumns>',
    )
    expect(xml).toContain('ref="B1:C3"')
  })

  it('removes the part, relationship, tablePart and content type for Convert to Range', async () => {
    const plan = await planWith([edit({ remove: true })])
    expect(plan.removedEntries).toContain('xl/tables/table1.xml')
    expect(plan.replaced.get('xl/worksheets/sheet1.xml')).not.toContain('<tableParts')
    expect(plan.replaced.get('xl/worksheets/_rels/sheet1.xml.rels')).not.toContain(
      'tables/table1.xml',
    )
    expect(plan.replaced.get('[Content_Types].xml')).not.toContain('/xl/tables/table1.xml')
  })

  it('edits the table referenced by the worksheet instead of an orphan with the same name', async () => {
    const zip = await JSZip.loadAsync(await buildKitchenSinkFixture())
    const tablePath = 'xl/tables/table1.xml'
    const orphanPath = 'xl/tables/table2.xml'
    const relsPath = 'xl/worksheets/_rels/sheet1.xml.rels'
    const rels = await zip.file(relsPath)!.async('text')
    const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    zip.file(orphanPath, await zip.file(tablePath)!.async('text'))
    zip.file(relsPath, rels.replace('<Relationship Id="rId1"',
      `<Relationship Id="orphan" Type="${office}/table" Target="../tables/table2.xml"/>` +
      '<Relationship Id="rId1"'))

    const plan = await planWith([edit({ bandedRows: true })], [], await zip.generateAsync({ type: 'nodebuffer' }))
    expect(plan.replaced.has(tablePath)).toBe(true)
    expect(plan.replaced.has(orphanPath)).toBe(false)
  })

  it('converts an aliased table reference to a range without changing XML comments', async () => {
    const zip = await JSZip.loadAsync(await buildKitchenSinkFixture())
    const worksheetPath = 'xl/worksheets/sheet1.xml'
    const relsPath = 'xl/worksheets/_rels/sheet1.xml.rels'
    const worksheet = await zip.file(worksheetPath)!.async('text')
    const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    const comment = '<!-- <tablePart r:id="rId1"/> -->'
    zip.file(worksheetPath, worksheet.replace('<tableParts count="1"><tablePart r:id="rId1"/></tableParts>',
      `${comment}<tableParts count='1' xmlns:t="${office}"><tablePart t:id='rId&#49;'></tablePart></tableParts>`))
    const rels = await zip.file(relsPath)!.async('text')
    zip.file(relsPath, rels.replaceAll('"', "'"))
    const typesPath = '[Content_Types].xml'
    const types = await zip.file(typesPath)!.async('text')
    zip.file(typesPath, types.replace('PartName="/xl/tables/table1.xml"', "PartName='/xl/tables/table1.xml'"))

    const plan = await planWith([edit({ remove: true })], [], await zip.generateAsync({ type: 'nodebuffer' }))
    expect(plan.replaced.get(worksheetPath)).toContain(comment)
    expect(plan.replaced.get(worksheetPath)).not.toContain('<tableParts')
    expect(plan.replaced.get(relsPath)).not.toContain('tables/table1.xml')
    expect(plan.removedEntries).toContain('xl/tables/table1.xml')
    expect(plan.replaced.get(typesPath)).not.toContain('/xl/tables/table1.xml')
  })

  it('updates the remaining count using only actual sibling table references', () => {
    const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    const comment = '<!-- <tablePart t:id="rId1"/> -->'
    const keeper = '<tablePart t:id="rId2"/>'
    const worksheet = `<worksheet><tableParts xmlns:t="${office}" count='2'>${comment}` +
      `<tablePart t:id='rId&#49;'/>${keeper}</tableParts></worksheet>`
    expect(removeTablePart(worksheet, 'rId1')).toBe(
      `<worksheet><tableParts xmlns:t="${office}" count="1">${comment}${keeper}</tableParts></worksheet>`,
    )
  })

  it('applies edits before additions so a converted table frees its cells and name', async () => {
    const source = await createBufferEntrySource(await buildKitchenSinkFixture())
    const args: unknown[] = [source, [], []]
    while (args.length < 27) args.push(args.length === 10 ? null : [])
    args[4] = undefined
    args[21] = null
    args[22] = null
    args[14] = [
      {
        sheetName: 'Data',
        area: { startRow: 0, startColumn: 3, endRow: 1, endColumn: 4 },
        name: 'Table1',
        columnNames: ['A', 'hdr'],
        bandedRows: true,
      },
    ]
    args[26] = [edit({ remove: true })]
    const plan = await planCellEditsToXlsx(...(args as Parameters<typeof planCellEditsToXlsx>))
    expect(plan.removedEntries).toContain('xl/tables/table1.xml')
    expect([...plan.added.keys()].some((path) => path.startsWith('xl/tables/'))).toBe(true)
  })

  it('fails closed on unknown tables, bad names and width mismatches', async () => {
    await expect(planWith([edit({ tableName: 'Nope', name: 'X' })])).rejects.toThrow(/not found/)
    await expect(planWith([edit({ name: 'A1' })])).rejects.toThrow(/not a valid table name/)
    await expect(
      planWith([edit({ area: { startRow: 0, startColumn: 0, endRow: 2, endColumn: 3 } })]),
    ).rejects.toThrow(/spans 4 columns/)
  })

  it('fails closed when a resize rides with row shifts on the same sheet', async () => {
    await expect(
      planWith(
        [edit({ area: { startRow: 0, startColumn: 0, endRow: 4, endColumn: 1 } })],
        [{ sheetName: 'Data', ops: [{ kind: 'insert-rows', index: 0, count: 1 }] }],
      ),
    ).rejects.toThrow(/save the table first/)
  })
})
