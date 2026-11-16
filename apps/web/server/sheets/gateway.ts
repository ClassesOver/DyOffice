import { readWorkbookRedactionSource } from '../../../sheets/src/main/workbook-redactions'
import { parseSlicerState } from '../../../../packages/xlsx-gateway/src/gateway/xlsx-slicer'
import { listWorkbookQueries } from '../../../../packages/xlsx-gateway/src/gateway/xlsx-connections'
import { refreshableQueriesOf } from '../../../../packages/xlsx-gateway/src/gateway/xlsx-connection-refresh'
import { workbookSaveRequestSchema } from '../../../sheets/src/shared/desktop-api'
import { mapWorkbookSaveRequest } from '../../../sheets/src/shared/workbook-save-plan'
import { createBufferEntrySource } from '../../../../packages/xlsx-gateway/src/gateway/xlsx-gateway'
import { planWorkbookMutation } from '../../../../packages/xlsx-gateway/src/gateway/xlsx-package-io'

/** Bundled for the server; no Node gateway code enters the browser build. */
export async function planWorkbookSave(
  bytes: Buffer,
  sheets: readonly { id: string; name: string }[],
  input: unknown,
) {
  try {
    const request = workbookSaveRequestSchema.parse(input)
    // These desktop transports imply paths, dialogs, or process-local state.
    if (
      request.mode !== 'save' ||
      request.targetPath !== undefined ||
      request.overwrite !== undefined ||
      request.restoreWriteBack !== undefined ||
      request.defaultName !== undefined ||
      request.csvContent !== undefined ||
      request.editsTransferId !== undefined
    )
      throw new Error('Unsupported Web save transport')
    const mapping = mapWorkbookSaveRequest(
      new Map(sheets.map((sheet) => [sheet.id, sheet.name])),
      request,
    )
    return await planWorkbookMutation(await createBufferEntrySource(bytes), mapping)
  } catch {
    throw Object.assign(new Error('Invalid workbook edits'), { statusCode: 400 })
  }
}

/** Read preserved package metadata using the same parsers as desktop. This
 * enumerates connections; it never fetches any linked workbook or URL. */
export async function readWorkbookPackage(bytes: Buffer) {
  const source = await createBufferEntrySource(bytes)
  const names = new Set(await source.paths())
  const read = async (path: string) => names.has(path) ? source.readText(path) : undefined
  return {
    redactions: await readWorkbookRedactionSource(source),
    slicers: await parseSlicerState(source),
    connections: {connections: await refreshableQueriesOf(read)},
    queries: await listWorkbookQueries(read),
  }
}
