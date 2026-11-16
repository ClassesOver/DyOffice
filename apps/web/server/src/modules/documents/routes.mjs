import { EDITING_CAPABILITIES, serveDocumentEditing } from '../../../document-editing.mjs'
import { serveReadOnlyFiles } from '../../../readonly-files.mjs'
import { handleRevisionRoutes } from '../revisions/routes.mjs'

export async function handleDocuments(req, res, ctx, { url, state }) {
  if (await handleRevisionRoutes(req, res, ctx, { url, state })) return true
  if (await serveDocumentEditing(req, res, { url, state, store: ctx.store, filePath: ctx.filePath, runtime: ctx.revisionsRuntime })) return true
  if (await serveReadOnlyFiles(req, res, { url, state, filePath: ctx.filePath, capabilities: EDITING_CAPABILITIES })) return true
  return false
}
