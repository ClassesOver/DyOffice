import { join } from 'node:path'
import { fail, readBytes } from '../../http-helpers.mjs'
import { ownerIdFromRequest } from '../policy/principal.mjs'

/** Dev-token stand-in. The caller cannot choose another owner. */
export const DEV_PERSONAL_OWNER = 'dev-personal'

export function objectStoreDirectory(dataDirectory) {
  return join(dataDirectory, 'object-store')
}

const OBJECT_PATH = /^\/api\/v1\/objects\/([0-9a-f-]{36})$/i
const FINISH_PATH = /^\/api\/v1\/objects\/uploads\/([0-9a-f-]{36})\/finish$/i
const TRASH_PATH = /^\/api\/v1\/objects\/([0-9a-f-]{36})\/trash$/i
const RESTORE_PATH = /^\/api\/v1\/objects\/([0-9a-f-]{36})\/restore$/i
const PURGE_PATH = /^\/api\/v1\/objects\/([0-9a-f-]{36})\/purge$/i

const STORE_ERRORS = {
  UNSAFE_NAME: ['文件名无效', 400],
  UNSUPPORTED_TYPE: ['仅支持 DOCX、XLSX、PPTX、PDF', 400],
  MAGIC_MISMATCH: ['文件内容与格式不匹配', 400],
  EMPTY: ['文件为空', 400],
  OVERSIZE: ['请求内容过大', 413],
  QUOTA: ['存储配额已满', 413],
  NOT_FOUND: ['文件不存在', 404],
}

function rejectStore(error) {
  const mapped = STORE_ERRORS[error?.code]
  if (mapped) fail(mapped[0], mapped[1])
  fail('服务暂时不可用', 500)
}

function disposition(name) {
  const safe = typeof name === 'string' && name.length > 0 && name.length <= 255 ? name : 'object.bin'
  return `attachment; filename*=UTF-8''${encodeURIComponent(safe)}`
}

/**
 * Download one finished object for the personal dev principal.
 * The owner id comes from the server, never from the request.
 */
export async function handleObjects(req, res, ctx, { path, send }) {
  const ownerId = ownerIdFromRequest(req, ctx.objectOwnerId)
  if (path === '/api/v1/objects') {
    if (req.method !== 'POST') fail('方法不允许', 405)
    let name
    try { name = decodeURIComponent(req.headers['x-file-name'] || '') }
    catch { fail('文件名无效') }
    const bytes = await readBytes(req, ctx.objectMaxBytes)
    let staged
    try {
      staged = await ctx.objectStore.stageUpload({ ownerId, name, bytes })
    } catch (error) {
      rejectStore(error)
    }
    send({
      uploadId: staged.uploadId,
      sha256: staged.sha256,
      size: staged.size,
      format: staged.format,
      finished: false,
    }, 201)
    return true
  }
  const finish = FINISH_PATH.exec(path)
  if (finish) {
    if (req.method !== 'POST') fail('方法不允许', 405)
    let completed
    try {
      completed = await ctx.objectStore.finishUpload({ ownerId, uploadId: finish[1] })
    } catch (error) {
      rejectStore(error)
    }
    send({ objectId: completed.objectId, sha256: completed.sha256, size: completed.size, format: completed.format }, 200)
    return true
  }
  const lifecycle = [
    [TRASH_PATH, (objectId) => ctx.objectStore.trashObject({ ownerId, objectId })],
    [RESTORE_PATH, (objectId) => ctx.objectStore.restoreObject({ ownerId, objectId })],
    [PURGE_PATH, (objectId) => ctx.objectStore.purgeObject({ ownerId, objectId })],
  ]
  for (const [pattern, action] of lifecycle) {
    const hit = pattern.exec(path)
    if (!hit) continue
    if (req.method !== 'POST') fail('方法不允许', 405)
    try {
      send(await action(hit[1]))
    } catch (error) {
      rejectStore(error)
    }
    return true
  }
  const match = OBJECT_PATH.exec(path)
  if (!match) return false
  if (req.method !== 'GET') fail('方法不允许', 405)
  let opened
  try {
    opened = await ctx.objectStore.downloadObject({ ownerId, objectId: match[1] })
  } catch (error) {
    if (error?.code === 'NOT_FOUND') fail('文件不存在', 404)
    fail('服务暂时不可用', 500)
  }
  res.statusCode = 200
  res.setHeader('Content-Type', 'application/octet-stream')
  res.setHeader('Content-Length', String(opened.size))
  res.setHeader('Content-Disposition', disposition(opened.name))
  res.setHeader('X-Content-SHA256', opened.sha256)
  res.end(opened.bytes)
  return true
}
