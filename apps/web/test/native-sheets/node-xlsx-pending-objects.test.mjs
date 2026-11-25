import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { buildSheetsGateway } from '../../server/sheets/build.mjs'
import { configuredSheetsRuntime } from '../../server/src/modules/sheets/runtime.ts'
import { sheetsSaveRequest } from '../helpers/sheets-request.mjs'
import {
  createEditJournal,
  recordHyperlinkEdit,
  recordSparklineAdd,
  recordSetRangeValues,
  recordSheetRename,
  recordStructuralOp,
  toSaveHyperlinkEdits,
  toSaveSparklineAdds,
  toSaveEdits,
  toSaveSheetOps,
  toSaveStructuralOps,
} from '../../../sheets/src/renderer/edit-journal.ts'

const original = await readFile(new URL('../fixtures/sheets/acceptance.xlsx', import.meta.url))
const sheetId = 'sheet-1'
const originalName = 'Acceptance'
const renamed = 'New Tab'
const range = { startRow: 0, endRow: 10, startColumn: 0, endColumn: 10 }

test(
  'Web XLSX saves new sparklines and internal hyperlinks at their shifted references',
  { timeout: 120000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'dyoffice-xlsx-pending-objects-'))
    let runtime
    t.after(async () => {
      await runtime?.close()
      await rm(dir, { recursive: true, force: true })
    })
    await buildSheetsGateway(join(dir, 'gateway.mjs'))
    runtime = await configuredSheetsRuntime(
      {
        DYOFFICE_AUTH_MODE: 'local',
        DYOFFICE_SANDBOX_MODE: 'subprocess',
        DYOFFICE_DEPLOYMENT_ID: randomUUID(),
        DYOFFICE_XLSX_NODE_ENGINE: join(dir, 'xlsx-node-engine.mjs'),
        DYOFFICE_XLSX_GATEWAY_RUNNER: join(dir, 'gateway-process.mjs'),
      },
      { enabled: true },
    )
    const journal = createEditJournal()
    recordHyperlinkEdit(journal, sheetId, 1, 3, "#'Acceptance'!B2")
    recordSparklineAdd(journal, {
      id: 'pending-spark',
      sheetId,
      type: 'column',
      cells: [{ cell: 'G2', sourceRef: "'Acceptance'!$A$2:$C$2" }],
    })
    recordSetRangeValues(journal, sheetId, {
      7: { 1: { v: 'link target removed' } },
      1: { 4: { v: 'keep this source cell' } },
    })
    recordHyperlinkEdit(journal, sheetId, 1, 4, "#'Acceptance'!B8")
    recordStructuralOp(journal, sheetId, { kind: 'insert-rows', index: 0, count: 1 }, originalName)
    recordStructuralOp(journal, sheetId, { kind: 'insert-cols', index: 0, count: 1 }, originalName)
    recordStructuralOp(journal, sheetId, { kind: 'remove-rows', index: 8, count: 1 }, originalName)
    recordSheetRename(journal, sheetId, renamed, originalName)
    const request = {
      ...sheetsSaveRequest(sheetId, []),
      edits: toSaveEdits(journal),
      structuralOps: toSaveStructuralOps(journal),
      sheetOps: toSaveSheetOps(journal),
      hyperlinkEdits: toSaveHyperlinkEdits(journal),
      sparklineAdditions: toSaveSparklineAdds(journal),
    }
    const plan = await runtime.sheetsWorkbookPlanner(original, request)
    const saved = (await runtime.sheetsNative.savePlan(original, plan)).bytes
    const workbook = await runtime.sheetsNative.inspect(saved, undefined, true)
    const sheet = workbook.sheets[0]
    const reopened = await runtime.sheetsNative.readRange(saved, renamed, range)
    assert.equal(sheet.name, renamed)
    assert.ok(
      reopened.cells.some((cell) => cell.row === 2 && cell.column === 1 && cell.value === 12.5),
    )

    await t.test('shifts a new sparkline and its source', () => {
      const actual = sheet.sparklines.flatMap((group) => group.cells)
      const expected = [{ cell: 'H3', sourceRef: "'New Tab'!$B$3:$D$3" }]
      assert.deepEqual(actual, expected)
    })
    await t.test('shifts the anchor and target of a new link', () => {
      const actual = reopened.hyperlinks.find((link) => link.row === 2 && link.column === 4)
      const expected = { row: 2, column: 4, target: "#'New Tab'!C3" }
      assert.deepEqual(actual, expected)
    })
    await t.test('clears a link whose target was deleted while keeping the source cell', () => {
      const actual = reopened.hyperlinks.find((link) => link.row === 2 && link.column === 5)
      assert.ok(
        reopened.cells.some(
          (cell) => cell.row === 2 && cell.column === 5 && cell.value === 'keep this source cell',
        ),
      )
      assert.ok(!reopened.cells.some((cell) => cell.value === 'link target removed'))
      assert.equal(actual, undefined)
    })
  },
)
