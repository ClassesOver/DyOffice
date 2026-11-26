import { describe, expect, it } from 'vitest'

import type { MutablePackage } from '../src/gateway/xlsx-drawing-add'
import { applyPivotAdditions, type PivotAddition } from '../src/gateway/xlsx-pivot-add'

const WORKSHEET = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>Region</t></is></c><c r="B1" t="inlineStr"><is><t>Product</t></is></c><c r="C1" t="inlineStr"><is><t>Amount</t></is></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t>East</t></is></c><c r="B2" s="1"/><c r="C2"><v>9</v></c></row>
  </sheetData>
</worksheet>`

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets>
</workbook>`

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`

function inMemoryPackage(entries: Record<string, string>): MutablePackage {
  const files = new Map(Object.entries(entries))
  return {
    paths: async () => [...files.keys()],
    has: async (path) => files.has(path),
    readText: async (path) => {
      const content = files.get(path)
      if (content === undefined) throw new Error(`missing part: ${path}`)
      return content
    },
    write: (path, content) => void files.set(path, content),
    add: (path, content) => void files.set(path, content),
    addBinary: (path, bytes) => void files.set(path, new TextDecoder().decode(bytes)),
    remove: (path) => void files.delete(path),
  }
}

function addition(): PivotAddition {
  return {
    worksheetPath: 'xl/worksheets/sheet1.xml',
    sourceSheetName: 'Data',
    sourceArea: { startRow: 0, startColumn: 0, endRow: 1, endColumn: 2 },
    location: { startRow: 0, startColumn: 4, endRow: 2, endColumn: 5 },
    name: 'Pivot1',
    fieldNames: ['Region', 'Product', 'Amount'],
    rowFieldIndices: [0],
    rowItems: ['East'],
    values: [{ fieldIndex: 1, agg: 'sum' }],
  }
}

async function cacheRecords(worksheet = WORKSHEET, endRow = 1): Promise<string> {
  const pkg = inMemoryPackage({
    '[Content_Types].xml': CONTENT_TYPES,
    'xl/workbook.xml': WORKBOOK,
    'xl/_rels/workbook.xml.rels': WORKBOOK_RELS,
    'xl/worksheets/sheet1.xml': worksheet,
  })
  const pivot = addition()
  await applyPivotAdditions(pkg, [{ ...pivot, sourceArea: { ...pivot.sourceArea, endRow } }], WORKBOOK, new Set())
  return pkg.readText('xl/pivotCache/pivotCacheRecords1.xml')
}

describe('pivot source cell reads', () => {
  it('keeps a self-closing styled blank cell from absorbing the next cell', async () => {
    const records = await cacheRecords()
    expect(records).toContain('count="1"')
    expect(records).toContain('<r><x v="0"/><m/><n v="9"/></r>')
  })

  it('preserves the grid value types in saved pivot cache records', async () => {
    const worksheet = WORKSHEET.replace('</sheetData>', [
      '<row r="3"><c r="B3" t="b"><v>unknown</v></c><c r="C3"><v>0x10</v></c></row>',
      '<row r="4"><c r="B4" t="b"><v> false </v></c><c r="C4"><v> +.5e1 </v></c></row>',
      '<row r="5"><c r="B5"><v> _x0041_ </v></c><c r="C5" t="e"><v>#DIV/0!</v></c></row>',
      '<row r="6"><c r="B6" t="str"><v> 42 </v></c><c r="C6" t="str"><v>_x0001_</v></c></row>',
      '</sheetData>',
    ].join(''))
    const records = await cacheRecords(worksheet, 5)
    expect(records).toContain('<r><m/><m/><s v="0x10"/></r>')
    expect(records).toContain('<r><m/><b v="0"/><n v="5"/></r>')
    expect(records).toContain('<r><m/><s v=" A "/><s v="#DIV/0!"/></r>')
    expect(records).toContain('<r><m/><n v="42"/><s v="_x0001_"/></r>')
  })
})
