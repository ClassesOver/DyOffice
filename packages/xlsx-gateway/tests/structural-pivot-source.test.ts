import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'

import {
  createBufferEntrySource,
  planCellEditsToXlsx,
  type SheetStructuralOps,
} from '../src/gateway/xlsx-gateway'
import { StructuralShiftError } from '../src/gateway/xlsx-structure'

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/pivotCache/pivotCacheDefinition1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml"/>
  <Override PartName="/xl/pivotTables/report.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml"/>
</Types>`

const PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Report" sheetId="2" r:id="rId2"/><sheet name="Other" sheetId="3" r:id="rId3"/></sheets>
</workbook>`

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>
</Relationships>`

function worksheetXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:B2"/>
  <sheetData>
    <row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c></row>
    <row r="2"><c r="A2"><v>3</v></c><c r="B2"><v>4</v></c></row>
  </sheetData>
</worksheet>`
}

const CACHE_DEFINITION = `<?xml version="1.0" encoding="UTF-8"?>
<pivotCacheDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cacheSource type="worksheet"><worksheetSource ref="A1:C100" sheet="Data"/></cacheSource>
</pivotCacheDefinition>`
const CACHE_PATH = 'xl/pivotCache/pivotCacheDefinition1.xml'

const PIVOT_PATH = 'xl/pivotTables/report.xml'
const PIVOT_XML = `<p:pivotTableDefinition xmlns:p="http://schemas.openxmlformats.org/spreadsheetml/2006/main" name="Sales" cacheId="1">
  <p:location firstHeaderRow="1" ref="F5:G8" firstDataRow="1" firstDataCol="1" rowPageCount="1" colPageCount="1"/>
  <p:pageFields count="1"><p:pageField fld="0"/></p:pageFields>
</p:pivotTableDefinition>`
const REPORT_RELS = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="../pivotTables/report.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotTable" Id="rId1"/>
</Relationships>`

async function fixture(
  cachePath = CACHE_PATH,
  cacheXml = CACHE_DEFINITION,
  pivotXml = PIVOT_XML,
): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', CONTENT_TYPES.replace(CACHE_PATH, encodeURI(cachePath)))
  zip.file('_rels/.rels', PACKAGE_RELS)
  zip.file('xl/workbook.xml', WORKBOOK)
  zip.file('xl/_rels/workbook.xml.rels', WORKBOOK_RELS)
  zip.file('xl/worksheets/sheet1.xml', worksheetXml())
  zip.file(
    'xl/worksheets/sheet2.xml',
    worksheetXml().replace(
      '</sheetData>',
      '<row r="3"><c r="F3" t="inlineStr"><is><t>Region</t></is></c></row>' +
        '<row r="5"><c r="F5" t="inlineStr"><is><t>Sales</t></is></c></row>' +
        '</sheetData>',
    ),
  )
  zip.file('xl/worksheets/sheet3.xml', worksheetXml())
  zip.file('xl/worksheets/_rels/sheet2.xml.rels', REPORT_RELS)
  zip.file(PIVOT_PATH, pivotXml)
  zip.file(cachePath, cacheXml)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

async function plan(ops: SheetStructuralOps[], options: Parameters<typeof fixture> = []) {
  const source = await createBufferEntrySource(await fixture(...options))
  return planCellEditsToXlsx(source, [], ops)
}

describe('structural edits against a pivot cache source sheet', () => {
  it('protects the source of a cache with a custom package part name', async () => {
    await expect(
      plan(
        [{ sheetName: 'Data', ops: [{ kind: 'insert-rows', index: 0, count: 1 }] }],
        ['xl/cache/report source.xml'],
      ),
    ).rejects.toThrow(StructuralShiftError)
  })

  it('ignores a foreign cache-shaped part when finding protected source sheets', async () => {
    const foreign = CACHE_DEFINITION.replace(
      'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
      'urn:example:cache',
    )
    await expect(
      plan(
        [{ sheetName: 'Data', ops: [{ kind: 'insert-rows', index: 0, count: 1 }] }],
        [CACHE_PATH, foreign],
      ),
    ).resolves.toBeDefined()
  })
  it('refuses a row insert on the sheet the cache reads from', async () => {
    await expect(
      plan([{ sheetName: 'Data', ops: [{ kind: 'insert-rows', index: 0, count: 1 }] }]),
    ).rejects.toThrow(StructuralShiftError)
  })

  it('refuses a column delete on the sheet the cache reads from', async () => {
    await expect(
      plan([{ sheetName: 'Data', ops: [{ kind: 'remove-cols', index: 0, count: 1 }] }]),
    ).rejects.toThrow(StructuralShiftError)
  })

  it('still saves a structural edit on an unrelated sheet', async () => {
    const mutation = await plan([
      { sheetName: 'Other', ops: [{ kind: 'insert-rows', index: 0, count: 1 }] },
    ])
    expect(mutation).toBeDefined()
  })
})

describe('structural edits on the sheet hosting a pivot report', () => {
  it('moves the worksheet pivot location and preserves a foreign location namesake', async () => {
    const foreign = '<location xmlns="urn:example:pivot" ref="A1:B2"/>'
    const pivot = PIVOT_XML.replace('<p:location', foreign + '<p:location')
    const result = await plan(
      [{ sheetName: 'Report', ops: [{ kind: 'insert-rows', index: 0, count: 1 }] }],
      [CACHE_PATH, CACHE_DEFINITION, pivot],
    )
    expect(result.replaced.get(PIVOT_PATH)).toContain(foreign)
    expect(result.replaced.get(PIVOT_PATH)).toContain('ref="F6:G9"')
  })
  it('moves the report with the rows containing its filters and body', async () => {
    const mutation = await plan([
      {
        sheetName: 'Report',
        ops: [{ kind: 'move-rows', index: 2, count: 6, before: 10 }],
      },
    ])
    expect(mutation.replaced.get(PIVOT_PATH)).toContain(
      '<location firstHeaderRow="1" ref="F7:G10" firstDataRow="1" firstDataCol="1" rowPageCount="1" colPageCount="1"/>',
    )
    const worksheet = mutation.replaced.get('xl/worksheets/sheet2.xml')
    expect(worksheet).toContain('<c r="F5" t="inlineStr"><is><t>Region</t></is></c>')
    expect(worksheet).toContain('<c r="F7" t="inlineStr"><is><t>Sales</t></is></c>')
    expect(mutation.replaced.has('xl/pivotCache/pivotCacheDefinition1.xml')).toBe(false)
  })

  it('leaves the pivot part untouched after an insert beyond its output', async () => {
    const mutation = await plan([
      { sheetName: 'Report', ops: [{ kind: 'insert-rows', index: 8, count: 1 }] },
    ])
    expect(mutation.replaced.has(PIVOT_PATH)).toBe(false)
  })

  it.each([
    { kind: 'insert-cols', index: 6, count: 1 },
    { kind: 'insert-rows', index: 3, count: 1 },
    { kind: 'remove-rows', index: 2, count: 6 },
    { kind: 'move-rows', index: 5, count: 1, before: 7 },
  ] as const)(
    'rejects a structural edit that disrupts the output ($kind at $index)',
    async (op) => {
      await expect(plan([{ sheetName: 'Report', ops: [op] }])).rejects.toThrow(StructuralShiftError)
    },
  )
})

describe('non-shifting edits against a pivot cache source sheet', () => {
  it('saves a row-size change on the sheet the cache reads from', async () => {
    const mutation = await plan([
      { sheetName: 'Data', ops: [{ kind: 'set-row-size', start: 0, end: 0, size: 30 }] },
    ])
    expect(mutation).toBeDefined()
  })

  it('saves a hidden-rows change on the sheet the cache reads from', async () => {
    const mutation = await plan([
      { sheetName: 'Data', ops: [{ kind: 'set-rows-hidden', start: 1, end: 1, hidden: true }] },
    ])
    expect(mutation).toBeDefined()
  })

  it('still refuses when a shifting op rides along with a non-shifting one', async () => {
    await expect(
      plan([
        {
          sheetName: 'Data',
          ops: [
            { kind: 'set-row-size', start: 0, end: 0, size: 30 },
            { kind: 'insert-rows', index: 0, count: 1 },
          ],
        },
      ]),
    ).rejects.toThrow(StructuralShiftError)
  })
})
