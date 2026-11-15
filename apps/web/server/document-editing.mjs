import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sendJson } from './http-response.mjs'
import { DocumentEditError, applyDocxTextEdits, projectDocx } from './docx-session.mjs'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const ROUTE = new RegExp(`^/api/v1/files/(${UUID})(?:/(uploads|revisions|lease|docx|content))?$`, 'i')
const REVISION = /^sha256:([a-f0-9]{64})$/
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

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function revisionOf(bytes) {
  const digest = sha256(bytes)
  return { revision: `sha256:${digest}`, sha256: digest, size: bytes.length }
}

function editingOf(state) {
  if (!state.editing || typeof state.editing !== 'object') state.editing = {}
  for (const key of ['leases', 'history', 'saves', 'uploads']) {
    if (!state.editing[key] || typeof state.editing[key] !== 'object' || Array.isArray(state.editing[key])) state.editing[key] = {}
  }
  return state.editing
}

function leaseOf(editing, fileId) {
  const value = editing?.leases?.[fileId]
  return Number.isSafeInteger(value) && value >= 1 ? value : 1
}

async function readBody(request, limit) {
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
  return state.files.find(file => file.id === fileId)
}

async function readCurrent(filePath, fileId) {
  try {
    return await readFile(join(filePath, fileId))
  } catch (error) {
    if (error.code === 'ENOENT') fail('存储的文件不可用', 503)
    throw error
  }
}

async function writeAtomic(directory, fileId, bytes) {
  const target = join(directory, fileId)
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, bytes, { mode: 0o600 })
  try {
    await rename(temporary, target)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

async function archiveBytes(directory, fileId, bytes, digest) {
  const folder = join(directory, 'revisions', fileId)
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const target = join(folder, digest)
  try {
    await writeFile(target, bytes, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
}

function rememberSave(editing, fileId, key, record) {
  const bucket = editing.saves[fileId] || (editing.saves[fileId] = {})
  bucket[key] = record
  const keys = Object.keys(bucket)
  while (keys.length > 32) delete bucket[keys.shift()]
}

function revisionRef(fileId, description) {
  return { fileId, revision: description.revision, sha256: description.sha256, size: description.size }
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
  if (typeof value !== 'string' || !REVISION.test(value)) fail('版本号无效')
  return value
}

/**
 * Single-process revision bookkeeping. The JSON queue serializes commits in
 * this process only; it is not the planned PostgreSQL CAS/outbox transaction.
 */
async function commitContent(store, filePath, fileId, { baseRevision, leaseEpoch, idempotencyKey, identity, produce }) {
  let result
  await store.update(async state => {
    const editing = editingOf(state)
    const file = findFile(state, fileId)
    if (!file || file.format !== 'docx') fail('文件不存在', 404)
    const bodySha256 = await identity(editing)
    const saved = editing.saves[fileId]?.[idempotencyKey]
    if (saved) {
      if (saved.bodySha256 !== bodySha256) fail('幂等键已用于不同内容', 409, 'IDEMPOTENCY_CONFLICT')
      result = revisionRef(fileId, saved)
      return
    }
    if (leaseOf(editing, fileId) !== leaseEpoch) fail('编辑租约已失效', 409, 'LEASE_CONFLICT')
    const previous = await readCurrent(filePath, fileId)
    const current = revisionOf(previous)
    if (current.revision !== baseRevision) fail('版本冲突，文档已被更新', 409, 'REVISION_CONFLICT')
    const nextBytes = Buffer.from(await produce(previous, editing))
    const next = revisionOf(nextBytes)
    if (next.sha256 !== current.sha256) {
      await archiveBytes(filePath, fileId, previous, current.sha256)
      await writeAtomic(filePath, fileId, nextBytes)
      const history = editing.history[fileId] || (editing.history[fileId] = [])
      history.push({ revision: current.revision, sha256: current.sha256, size: current.size })
      file.size = next.size
      file.updatedAt = new Date().toISOString()
    }
    rememberSave(editing, fileId, idempotencyKey, { bodySha256, ...next })
    result = revisionRef(fileId, next)
  })
  return result
}

async function serveHistorical(req, res, { url, state, filePath, fileId }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  const requested = url.searchParams.get('revision')
  const match = REVISION.exec(requested || '')
  if (!match) return false
  const editing = state.editing
  const entry = editing?.history?.[fileId]?.find(item => item.revision === requested)
  if (!entry || entry.sha256 !== match[1]) return false
  let bytes
  try {
    bytes = await readFile(join(filePath, 'revisions', fileId, entry.sha256))
  } catch (error) {
    if (error.code === 'ENOENT') fail('存储的文件不可用', 503)
    throw error
  }
  if (sha256(bytes) !== entry.sha256) fail('存储的文件不可用', 503)
  const file = findFile(state, fileId)
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(bytes.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file?.name || 'document')}`,
  })
  res.end(req.method === 'HEAD' ? undefined : bytes)
  return true
}

function assertDocx(file) {
  if (!file) fail('文件不存在', 404)
  if (file.format !== 'docx') fail('仅 DOCX 可以编辑', 400, 'UNSUPPORTED_FORMAT')
}

/** Personal DOCX editing routes. Returns false when another handler owns the request. */
export async function serveDocumentEditing(req, res, { url, state, store, filePath }) {
  const match = ROUTE.exec(url.pathname)
  if (!match || !match[2]) return false
  const fileId = match[1].toLowerCase()
  const action = match[2].toLowerCase()
  if (action === 'content') return serveHistorical(req, res, { url, state, filePath, fileId })
  const file = findFile(state, fileId)
  if (action === 'lease') {
    if (req.method !== 'POST') fail('Method not allowed', 405)
    if (!file) fail('文件不存在', 404)
    let leaseEpoch
    await store.update(next => {
      const editing = editingOf(next)
      if (!findFile(next, fileId)) fail('文件不存在', 404)
      leaseEpoch = leaseOf(editing, fileId) + 1
      editing.leases[fileId] = leaseEpoch
    })
    sendJson(res, 200, { leaseEpoch })
    return true
  }
  assertDocx(file)
  if (action === 'uploads') {
    if (req.method !== 'POST') fail('Method not allowed', 405)
    const bytes = await readBody(req, MAX_UPLOAD)
    if (bytes.length < 2 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) fail('文件内容与格式不匹配')
    const uploadId = randomUUID()
    await mkdir(join(filePath, 'uploads'), { recursive: true, mode: 0o700 })
    await writeFile(join(filePath, 'uploads', uploadId), bytes, { mode: 0o600 })
    try {
      await store.update(next => {
        const editing = editingOf(next)
        if (!findFile(next, fileId) || findFile(next, fileId).format !== 'docx') fail('文件不存在', 404)
        editing.uploads[uploadId] = { fileId, sha256: sha256(bytes), size: bytes.length }
      })
    } catch (error) {
      await unlink(join(filePath, 'uploads', uploadId)).catch(() => {})
      throw error
    }
    sendJson(res, 201, { uploadId })
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
    if (Object.keys(body).some(key => !allowed.includes(key))) fail('请求包含不支持的字段')
    if (body.fileId !== fileId) fail('文件编号无效')
    if (typeof body.uploadId !== 'string' || !new RegExp(`^${UUID}$`, 'i').test(body.uploadId)) fail('上传编号无效')
    const idempotencyKey = requireKey(body.idempotencyKey)
    const leaseEpoch = requireLease(body.leaseEpoch)
    const baseRevision = requireBase(body.baseRevision)
    if (body.sourceCommandId !== undefined && (typeof body.sourceCommandId !== 'string' || !body.sourceCommandId || body.sourceCommandId.length > 200)) fail('命令编号无效')
    const uploadId = body.uploadId.toLowerCase()
    const revision = await commitContent(store, filePath, fileId, {
      baseRevision, leaseEpoch, idempotencyKey,
      identity(editing) {
        const upload = editing.uploads[uploadId]
        if (!upload || upload.fileId !== fileId) fail('上传内容不存在', 404)
        return upload.sha256
      },
      async produce(_previous, editing) {
        const upload = editing.uploads[uploadId]
        const staged = await readFile(join(filePath, 'uploads', uploadId)).catch(error => {
          if (error.code === 'ENOENT') fail('上传内容不存在', 404)
          throw error
        })
        if (!upload || sha256(staged) !== upload.sha256) fail('上传内容不存在', 404)
        await projectDocx(staged)
        return staged
      },
    })
    sendJson(res, 200, revision)
    return true
  }
  if (action === 'docx') {
    if (req.method === 'GET') {
      const bytes = await readCurrent(filePath, fileId)
      const blocks = await projectDocx(bytes)
      const current = revisionOf(bytes)
      sendJson(res, 200, { file: revisionRef(fileId, current), leaseEpoch: leaseOf(state.editing, fileId), blocks })
      return true
    }
    if (req.method !== 'POST') fail('Method not allowed', 405)
    const raw = await readBody(req, MAX_JSON)
    let body
    try { body = JSON.parse(raw.toString()) }
    catch { fail('JSON 格式无效') }
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('JSON 格式无效')
    if (Object.keys(body).some(key => !['baseRevision', 'leaseEpoch', 'idempotencyKey', 'blocks', 'sourceCommandId'].includes(key))) fail('请求包含不支持的字段')
    const revision = await commitContent(store, filePath, fileId, {
      baseRevision: requireBase(body.baseRevision),
      leaseEpoch: requireLease(body.leaseEpoch),
      idempotencyKey: requireKey(body.idempotencyKey),
      identity: () => sha256(raw),
      produce: previous => applyDocxTextEdits(previous, body.blocks),
    })
    sendJson(res, 200, revision)
    return true
  }
  return false
}
