import type { ToolDescriptor } from '../../../../../../packages/web-contracts/src/tools.ts'
import type { McpXlsxCell } from '../../db/context.ts'
import { authError } from '../auth/sessions.ts'
import { uuid } from '../files/queries.ts'
import { createSheetsSaveService, type SheetsPlanner, type SheetsSaveNative, type SheetsWorkbookPlanner } from '../sheets/save.ts'
import { approvedSaveResultSchema, createApprovedOfficeSave, type ApprovedSaveOptions } from './approved-save.ts'
import type { McpExternalCredential } from './credential.ts'
import { officeReadDescriptor } from './office-read.ts'

const { fileId, revision } = officeReadDescriptor.inputSchema.properties
const sheetIdPattern = /^sheet-[1-9][0-9]{0,9}$/
const maxCells = 100
const maxRows = 1_048_576
const maxColumns = 16_384
const maxString = 2_000
// PostgreSQL JSONB cannot store NUL or unpaired UTF-16 surrogates.
const unsupportedText = /[\u0000\uD800-\uDFFF]/u

export const xlsxCellsDescriptor = {
  name: 'set_xlsx_cells',
  schemaVersion: 1,
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['fileId', 'revision', 'cells'],
    properties: {
      fileId, revision,
      cells: {
        type: 'array', minItems: 1, maxItems: maxCells, items: {
          type: 'object', additionalProperties: false, required: ['sheetId', 'row', 'column', 'value'],
          properties: {
            sheetId: { type: 'string', pattern: sheetIdPattern.source },
            row: { type: 'integer', minimum: 0, maximum: maxRows - 1, description: 'Zero-based row' },
            column: { type: 'integer', minimum: 0, maximum: maxColumns - 1, description: 'Zero-based column' },
            value: { anyOf: [{ type: 'string', maxLength: maxString }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] },
          },
        },
      },
    },
  },
  outputSchema: approvedSaveResultSchema,
  effect: 'document_write',
  executionMode: 'headless',
  requiresActiveEditor: false,
  requiredScopes: ['files:write'],
  maxDurationMs: 45_000,
} satisfies ToolDescriptor

export function parseXlsxCells(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3) throw authError(400)
  const input = value as Record<string, unknown>
  if (!Array.isArray(input.cells) || input.cells.length < 1 || input.cells.length > maxCells) throw authError(400)
  const cells: McpXlsxCell[] = []
  const seen = new Set<string>()
  for (const cell of input.cells) {
    if (!cell || typeof cell !== 'object' || Array.isArray(cell) || Object.keys(cell).length !== 4) throw authError(400)
    const { sheetId, row, column, value } = cell
    if (typeof sheetId !== 'string' || !sheetIdPattern.test(sheetId) ||
      !Number.isInteger(row) || row < 0 || row >= maxRows || !Number.isInteger(column) || column < 0 || column >= maxColumns ||
      !(value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) ||
        (typeof value === 'string' && value.length <= maxString && !unsupportedText.test(value)))) throw authError(400)
    const coordinate = `${sheetId}:${row}:${column}`
    if (seen.has(coordinate)) throw authError(400)
    seen.add(coordinate)
    cells.push({ sheetId, row: row || 0, column: column || 0, value: typeof value === 'number' ? value || 0 : value })
  }
  cells.sort((a, b) => a.sheetId.localeCompare(b.sheetId, 'en') || a.row - b.row || a.column - b.column)
  return { fileId: uuid(input.fileId as string), revision: uuid(input.revision as string), cells }
}

export interface McpSheetsSaveRuntime {
  native: SheetsSaveNative
  plan: SheetsPlanner
  planFromWorkbook: SheetsWorkbookPlanner
}

export function createMcpXlsxCells(options: ApprovedSaveOptions & McpSheetsSaveRuntime) {
  const save = createApprovedOfficeSave(options)
  let active = 0
  return async (credential: McpExternalCredential, args: unknown, signal: AbortSignal) => {
    const { fileId, revision, cells } = parseXlsxCells(args)
    if (active >= 2) throw authError(429)
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(xlsxCellsDescriptor.maxDurationMs)])
    active++
    try {
      return await save(credential, { fileId, revision }, { kind: 'xlsx.cells', cells }, deadline, async input => {
        const { files, leases, revisions, token, fileId, baseRevision, editorId, leaseEpoch, signal } = input
        const service = createSheetsSaveService({
          files, leases, revisions, native: options.native, plan: options.plan, planFromWorkbook: options.planFromWorkbook,
        })
        return service.prepare(token, fileId, {
          baseRevision, editorId, leaseEpoch,
          request: {
            sessionId: editorId, mode: 'save', edits: cells.map(cell => ({ ...cell, writeValue: true })),
            structuralOps: [], chartEdits: [], visualEdits: [], visualAdditions: [], tableAdditions: [], pivotAdditions: [],
            sheetOps: [], sheetOrder: [], filterStates: [], hyperlinkEdits: [], cfStates: [], dvStates: [], pageSetupStates: [],
            noteStates: [], formulaValues: [], pivotCacheRefreshPaths: [], pivotRefreshUpdates: [],
            sheetProtections: [], sparklineAdditions: [], definedNamesState: null,
          },
        }, signal)
      })
    } finally { active-- }
  }
}
