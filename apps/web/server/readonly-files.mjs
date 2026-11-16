import { sendJson as json } from './http-response.mjs'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const FILE_PATH = new RegExp(`^/api/v1/files/(${UUID})(?:/(content))?$`, 'i')
const CAPABILITIES = Object.freeze({ docx: 'unsupported', xlsx: 'unsupported', pptx: 'unsupported', pdf: 'unsupported' })

/** Development-only read bridge. The caller MUST authenticate the personal user before invoking this function. */
export async function serveReadOnlyFiles(req, res, { url, state, filePath, capabilities = CAPABILITIES }) {
  const path = url.pathname
  if (path === '/api/v1/capabilities') {
    if (req.method !== 'GET') json(res, 405, { error: 'Method not allowed' })
    else json(res, 200, capabilities)
    return true
  }
  const match = FILE_PATH.exec(path)
  if (!match) return false
  if (req.method !== 'GET') {
    json(res, 405, { error: 'Method not allowed' })
    return true
  }
  const file = state.files.find(f => f.id === match[1])
  if (!file || !['docx', 'xlsx', 'pptx', 'pdf'].includes(file.format)) {
    json(res, 404, { error: 'File not found' })
    return true
  }
  let content
  try { content = await readFile(join(filePath, file.id)) }
  catch (error) {
    if (error.code === 'ENOENT') {
      json(res, 503, { error: 'Stored file unavailable' })
      return true
    }
    throw error
  }
  const sha256 = createHash('sha256').update(content).digest('hex')
  // Legacy imports are immutable. SHA-derived revision is a read validator, NOT a writable revision ledger.
  const revision = `sha256:${sha256}`
  if (match[2] === 'content') {
    const expectedRevision = url.searchParams.get('revision')
    if (!expectedRevision) {
      json(res, 400, { error: 'Revision required' })
      return true
    }
    if (expectedRevision !== revision) {
      json(res, 409, { error: 'Revision mismatch', code: 'REVISION_CONFLICT' })
      return true
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(content.length),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    })
    res.end(content)
    return true
  }
  json(res, 200, {
    file: { fileId: file.id, revision, sha256, size: content.length },
    format: file.format,
    downloadEndpoint: `/api/v1/files/${encodeURIComponent(file.id)}/content`,
    capabilities,
  })
  return true
}
