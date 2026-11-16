import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sendJson } from './http-response.mjs'
import { rawBody } from './src/http-helpers.mjs'
import { applyDocxTextEdits, projectDocx } from './docx-session.mjs'
import { assertRevisionId } from './src/modules/revisions/errors.mjs'
import { projectCommittedBytes } from './src/modules/revisions/projection.mjs'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const ROUTE = new RegExp(`^/api/v1/files/(${UUID})(?:/(uploads|revisions|lease|docx|content))?$`, 'i')
const MAX_UPLOAD = 50 * 1024 * 1024
const MAX_JSON = 2 * 1024 * 1024

/** Host catalog: only DOCX has a native edit path. Other formats stay downloadable and unsupported for editing. */
export const EDITING_CAPABILITIES = Object.freeze({
  docx: 'editable',
  xlsx: 'unsupported',
  pptx: 'unsupported',
  pdf: 'unsupported',
})

function fail(message, status = 400, publicCode) {
  throw Object.assign(new Error(message), { status, publicCode })
}

async function readBody(request, limit) {
  const captured = request[rawBody]
  if (Buffer.isBuffer(captured)) {
    if (captured.length > limit) fail('请求内容过大', 413)
    return captured
  }
  let size = 0
  const chunks = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) fail('请求内容过大', 413)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function findFile(state, fileId) {
  return state.files.find((file) => file.id === fileId)
}

async function readCurrent(filePath, fileId) {
  try {
    return await readFile(join(filePath, fileId))
  } catch (error) {
    if (error.code === 'ENOENT') fail('存储的文件不可用', 503)
    throw error
  }
}

function requireKey(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 200 || /[^\x21-\x7e]/.test(value)) fail('幂等键无效')
  return value
}

function requireLease(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('编辑租约无效')
  return value
}

function requireBase(value) {
  try { return assertRevisionId(value) }
  catch { fail('版本号无效') }
}

function runtimeOf(runtime) {
  if (!runtime?.revisions || !runtime?.leases || !runtime?.objects || !runtime?.principal) fail('服务暂时不可用', 503)
  return runtime
}

async function registerCurrent(runtime, file, filePath, fileId) {
  const bytes = await readCurrent(filePath, fileId)
  await runtime.revisions.registerHead(runtime.principal, { fileId, name: file.name, bytes })
  return bytes
}

async function commitStaged(runtime, store, filePath, fileId, input) {
  const saved = await runtime.revisions.commitRevision(runtime.principal, input)
  const opened = await runtime.objects.downloadObject({ ownerId: runtime.principal.ownerId, objectId: saved.objectId })
  if (opened.sha256 !== saved.ref.sha256) fail('存储的文件不可用', 503)
  await projectCommittedBytes({ store, filePath, fileId, bytes: opened.bytes })
  return saved.ref
}

async function serveHistorical(req, res, { url, state, fileId, runtime }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  let requested
  try { requested = assertRevisionId(url.searchParams.get('revision')) }
  catch { return false }
  const row = runtime.revisions.readRevision(runtime.principal, fileId, requested)
  if (!row) return false
  let opened
  try {
    opened = await runtime.objects.downloadObject({ ownerId: runtime.principal.ownerId, objectId: row.objectId })
  } catch (error) {
    if (error?.code === 'NOT_FOUND') fail('存储的文件不可用', 503)
    throw error
  }
  if (opened.sha256 !== row.sha256) fail('存储的文件不可用', 503)
  const file = findFile(state, fileId)
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(opened.bytes.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file?.name || 'document')}`,
  })
  res.end(req.method === 'HEAD' ? undefined : opened.bytes)
  return true
}

function assertDocx(file) {
  if (!file) fail('文件不存在', 404)
  if (file.format !== 'docx') fail('仅 DOCX 可以编辑', 400, 'UNSUPPORTED_FORMAT')
}

/** Personal DOCX editing routes. Returns false when another handler owns the request. */
export async function serveDocumentEditing(req, res, { url, state, store, filePath, runtime }) {
  const match = ROUTE.exec(url.pathname)
  if (!match || !match[2]) return false
  const ledger = runtimeOf(runtime)
  const fileId = match[1].toLowerCase()
  const action = match[2].toLowerCase()
  if (action === 'content') return serveHistorical(req, res, { url, state, fileId, runtime: ledger })
  const file = findFile(state, fileId)
  if (action === 'lease') {
    if (req.method !== 'POST') fail('Method not allowed', 405)
    if (!file) fail('文件不存在', 404)
    await registerCurrent(ledger, file, filePath, fileId)
    const lease = await ledger.leases.takeoverLease(ledger.principal, fileId)
    sendJson(res, 200, { leaseEpoch: lease.leaseEpoch })
    return true
  }
  assertDocx(file)
  if (action === 'uploads') {
    if (req.method !== 'POST') fail('Method not allowed', 405)
    const bytes = await readBody(req, MAX_UPLOAD)
    if (bytes.length < 2 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) fail('文件内容与格式不匹配')
    await projectDocx(bytes)
    await registerCurrent(ledger, file, filePath, fileId)
    const staged = await ledger.objects.stageUpload({ ownerId: ledger.principal.ownerId, name: file.name, bytes })
    await ledger.revisions.noteUpload(ledger.principal, { fileId, uploadId: staged.uploadId })
    sendJson(res, 201, { uploadId: staged.uploadId })
    return true
  }
  if (action === 'revisions') {
    if (req.method !== 'POST') fail('Method not allowed', 405)
    const raw = await readBody(req, MAX_JSON)
    let body
    try { body = JSON.parse(raw.toString()) }
    catch { fail('JSON 格式无效') }
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('JSON 格式无效')
    const allowed = ['fileId', 'uploadId', 'baseRevision', 'idempotencyKey', 'leaseEpoch', 'sourceCommandId']
    if (Object.keys(body).some((key) => !allowed.includes(key))) fail('请求包含不支持的字段')
    if (body.fileId !== fileId) fail('文件编号无效')
    if (typeof body.uploadId !== 'string' || !new RegExp(`^${UUID}$`, 'i').test(body.uploadId)) fail('上传编号无效')
    await registerCurrent(ledger, file, filePath, fileId)
    const revision = await commitStaged(ledger, store, filePath, fileId, {
      fileId,
      uploadId: body.uploadId,
      baseRevision: requireBase(body.baseRevision),
      leaseEpoch: requireLease(body.leaseEpoch),
      idempotencyKey: requireKey(body.idempotencyKey),
      sourceCommandId: body.sourceCommandId,
    })
    sendJson(res, 200, revision)
    return true
  }
  if (action === 'docx') {
    if (req.method === 'GET') {
      const bytes = await registerCurrent(ledger, file, filePath, fileId)
      const blocks = await projectDocx(bytes)
      const head = ledger.revisions.current(ledger.principal, fileId)
      const lease = ledger.leases.currentLease(ledger.principal, fileId)
      sendJson(res, 200, { file: head, leaseEpoch: lease.leaseEpoch, blocks })
      return true
    }
    if (req.method !== 'POST') fail('Method not allowed', 405)
    const raw = await readBody(req, MAX_JSON)
    let body
    try { body = JSON.parse(raw.toString()) }
    catch { fail('JSON 格式无效') }
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('JSON 格式无效')
    if (Object.keys(body).some((key) => !['baseRevision', 'leaseEpoch', 'idempotencyKey', 'blocks', 'sourceCommandId'].includes(key))) fail('请求包含不支持的字段')
    const previous = await registerCurrent(ledger, file, filePath, fileId)
    const nextBytes = Buffer.from(await applyDocxTextEdits(previous, body.blocks))
    const staged = await ledger.objects.stageUpload({ ownerId: ledger.principal.ownerId, name: file.name, bytes: nextBytes })
    await ledger.revisions.noteUpload(ledger.principal, { fileId, uploadId: staged.uploadId })
    const revision = await commitStaged(ledger, store, filePath, fileId, {
      fileId,
      uploadId: staged.uploadId,
      baseRevision: requireBase(body.baseRevision),
      leaseEpoch: requireLease(body.leaseEpoch),
      idempotencyKey: requireKey(body.idempotencyKey),
      sourceCommandId: body.sourceCommandId,
    })
    sendJson(res, 200, revision)
    return true
  }
  return false
}
