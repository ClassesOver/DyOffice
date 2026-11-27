import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { XMLValidator } from 'fast-xml-parser'
import JSZip from 'jszip'
import { applyDvRules } from '../../../../packages/xlsx-gateway/src/gateway/xlsx-dv.ts'
import { buildSheetsGateway } from '../../server/sheets/build.mjs'
import { configuredSheetsRuntime } from '../../server/src/modules/sheets/runtime.ts'
import { sheetsSaveRequest } from '../helpers/sheets-request.mjs'

const dvUri = '{CCE6A557-97BC-4B89-ADB6-D9C93CAAB3DF}'
const x14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main'
const xm = 'http://schemas.microsoft.com/office/excel/2006/main'
const spreadsheet = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const path = 'xl/worksheets/sheet1.xml'
const fixture = new URL('../fixtures/sheets/acceptance.xlsx', import.meta.url)
const area = (column) => ({ startRow: 1, endRow: 1, startColumn: column, endColumn: column })
const bounds = { startRow: 0, endRow: 2, startColumn: 0, endColumn: 4 }
const list = (column, source) => ({
  ranges: [area(column)],
  rule: { type: 'list', formula1: `=${source}` },
})
const body =
  `<dv:dataValidations xmlns:m="${xm}" count="1"><dv:dataValidation type="list">` +
  '<dv:formula1><m:f>Acceptance!$A$2:$A$3</m:f></dv:formula1><m:sqref>C2 E2</m:sqref>' +
  '</dv:dataValidation></dv:dataValidations>'
const unrelated = `<ext uri="unrelated" xmlns:dv="${x14}">${body}</ext>`
const namesake = body.replace(
  '<dv:dataValidations ',
  '<dv:dataValidations xmlns:dv="urn:unrelated" ',
)
const cell = `<c r="A2"><v>12</v><extLst><ext uri="${dvUri}" xmlns:dv="${x14}">${body}</ext></extLst></c>`
const worksheet =
  `<worksheet xmlns="${spreadsheet}"><sheetData><row r="2">${cell}</row></sheetData>` +
  `<extLst><ext uri="${dvUri}" xmlns:dv="${x14}">${body}${namesake}</ext>${unrelated}</extLst></worksheet>`

async function workbook(xml) {
  const zip = await JSZip.loadAsync(await readFile(fixture))
  zip.file(path, xml)
  return zip.generateAsync({ type: 'nodebuffer' })
}

test('Web Node rewrites aliased worksheet validations without touching other extensions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-sheets-dv-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await buildSheetsGateway(join(directory, 'gateway.mjs'))
  const runtime = await configuredSheetsRuntime(
    {
      DYOFFICE_AUTH_MODE: 'local',
      DYOFFICE_SANDBOX_MODE: 'subprocess',
      DYOFFICE_DEPLOYMENT_ID: randomUUID(),
      DYOFFICE_XLSX_NODE_ENGINE: join(directory, 'xlsx-node-engine.mjs'),
      DYOFFICE_XLSX_GATEWAY_RUNNER: join(directory, 'gateway-process.mjs'),
    },
    { enabled: true },
  )
  t.after(() => runtime.close())
  const validation = async (bytes, sheetName = 'Acceptance') => {
    const { dataValidations } = await runtime.sheetsNative.readRange(bytes, sheetName, bounds)
    return dataValidations.map(({ ranges, formulas }) => [ranges, formulas])
  }
  const current = 'Acceptance!$A$2:$A$3'
  const added = 'Acceptance!$B$2:$B$3'
  const original = await workbook(worksheet)
  assert.deepEqual(await validation(original), [[[area(2), area(4)], [current]]])

  await t.test('replaces the alias block with one section and two readable rules', async () => {
    const request = sheetsSaveRequest('sheet-1', [])
    request.dvStates = [{ sheetId: 'sheet-1', rules: [list(2, current), list(3, added)] }]
    const plan = await runtime.sheetsWorkbookPlanner(original, request)
    const { bytes } = await runtime.sheetsNative.savePlan(original, plan)
    const zip = await JSZip.loadAsync(bytes)
    const xml = await zip.file(path).async('string')
    assert.equal(XMLValidator.validate(xml), true)
    assert.ok(xml.includes(cell))
    assert.ok(xml.includes(unrelated))
    assert.ok(xml.includes(namesake))
    assert.ok(
      !xml
        .replace(cell, '')
        .replace(unrelated, '')
        .replace(namesake, '')
        .includes('<dv:dataValidations'),
    )
    assert.deepEqual(await validation(bytes), [
      [[area(2)], [current]],
      [[area(3)], [added]],
    ])
  })

  await t.test(
    'replaces and removes areas in append mode without detaching namespace aliases',
    async () => {
      const xml = applyDvRules(worksheet, [list(3, added)], { append: true, remove: [area(2)] })
      assert.equal(XMLValidator.validate(xml), true)
      assert.ok(xml.includes(cell))
      assert.ok(xml.includes(unrelated))
      assert.ok(xml.includes(namesake))
      assert.deepEqual(await validation(await workbook(xml)), [
        [[area(4)], [current]],
        [[area(3)], [added]],
      ])
    },
  )

  await t.test(
    'moves and renames a legacy validation while preserving foreign formulas',
    async () => {
      const foreign = '<formula1 xmlns="urn:unrelated">Acceptance!A2</formula1>'
      const legacy =
        `<s:dataValidations xmlns:s="${spreadsheet}" count="1">` +
        '<s:dataValidation type="custom" sqref="B2">' +
        foreign +
        '<s:formula1><![CDATA[Acceptance!A2>0]]></s:formula1></s:dataValidation></s:dataValidations>'
      const source = await workbook(
        `<worksheet xmlns="${spreadsheet}"><sheetData/>` + legacy + '</worksheet>',
      )
      assert.deepEqual(await validation(source), [[[area(1)], ['Acceptance!A2>0']]])
      const request = {
        ...sheetsSaveRequest('sheet-1', []),
        structuralOps: [{ sheetId: 'sheet-1', kind: 'insert-rows', index: 0, count: 1 }],
        sheetOps: [{ sheetId: 'sheet-1', kind: 'rename-sheet', newName: 'Validated Sheet' }],
      }
      const plan = await runtime.sheetsWorkbookPlanner(source, request)
      const { bytes } = await runtime.sheetsNative.savePlan(source, plan)
      const moved = { ...area(1), startRow: 2, endRow: 2 }
      assert.deepEqual(await validation(bytes, 'Validated Sheet'), [
        [[moved], ["'Validated Sheet'!A3>0"]],
      ])
      const xml = await (await JSZip.loadAsync(bytes)).file(path).async('string')
      assert.ok(xml.includes(foreign))
    },
  )
})
