import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sendJson } from '../../../http-response.mjs'
import { rawBody } from '../../http-helpers.mjs'
import { projectCurrentHead } from './projection.mjs'
import { normalizePrincipal } from '../policy/principal.mjs'
import {
  assertIdempotencyKey,
  assertLeaseEpoch,
  assertRevisionId,
  assertSourceCommand,
  assertUploadId,
  revisionError,
} from './errors.mjs'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const LEASE = new RegExp(`^/api/v1/files/(${UUID})/leases/(acquire|renew|takeover)$`, 'i')
const COMMIT = new RegExp(`^/api/v1/files/(${UUID})/commits$`, 'i')
const RESTORE = new RegExp(`^/api/v1/files/(${UUID})/restore$`, 'i')

function readRaw(request) {
  const captured = request[rawBody]
  if (Buffer.isBuffer(captured)) return captured
  return null
}

async function readJson(request) {
  const captured = readRaw(request)
  const raw = captured || await collect(request)
  if (raw.length > 1024 * 1024) throw revisionError('INVALID', 413, '请求内容过大')
  if (raw.length === 0) return {}
  try {
    const body = JSON.parse(raw.toString())
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw revisionError('INVALID', 400, 'JSON 格式无效')
    return body
  } catch (error) {
    if (error.status) throw error
    throw revisionError('INVALID', 400, 'JSON 格式无效')
  }
}

async function collect(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 1024 * 1024) throw revisionError('INVALID', 413, '请求内容过大')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function rejectUnknown(body, allowed) {
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw revisionError('INVALID', 400, '请求包含不支持的字段')
}

async function ensureHead(ctx, state, fileId) {
  const file = state.files.find((entry) => entry.id === fileId)
  if (!file) throw revisionError('NOT_FOUND', 404)
  let bytes
  try {
    bytes = await readFile(join(ctx.filePath, fileId))
  } catch (error) {
    if (error.code === 'ENOENT') throw revisionError('HASH_MISMATCH', 503)
    throw error
  }
  await ctx.revisionsRuntime.revisions.registerHead(ctx.revisionsRuntime.principal, { fileId, name: file.name, bytes })
  return file
}

async function project(ctx, principal, fileId) {
  await projectCurrentHead({
    journal: ctx.revisionsRuntime.journal,
    objects: ctx.revisionsRuntime.objects,
    ownerId: principal.ownerId,
    deploymentId: principal.deploymentId,
    store: ctx.store,
    filePath: ctx.filePath,
    fileId,
  })
}

/** Lease, commit, and restore routes. Identity is the request principal, never a body field. */
export async function handleRevisionRoutes(req, res, ctx, { url, state }) {
  if (!ctx.revisionsRuntime) return false
  const lease = LEASE.exec(url.pathname)
  const commit = COMMIT.exec(url.pathname)
  const restore = RESTORE.exec(url.pathname)
  if (!lease && !commit && !restore) return false
  if (req.method !== 'POST') throw revisionError('INVALID', 405, 'Method not allowed')
  const fileId = (lease || commit || restore)[1].toLowerCase()
  const { revisions, leases } = ctx.revisionsRuntime
  const principal = req.dyofficePrincipal
    ? normalizePrincipal(req.dyofficePrincipal)
    : ctx.revisionsRuntime.principal
  await ensureHead(ctx, state, fileId)
  if (lease) {
    const action = lease[2].toLowerCase()
    if (action === 'renew') {
      const body = await readJson(req)
      rejectUnknown(body, ['leaseEpoch'])
      sendJson(res, 200, await leases.renewLease(principal, fileId, assertLeaseEpoch(body.leaseEpoch)))
      return true
    }
    const body = await readJson(req)
    rejectUnknown(body, [])
    const issued = action === 'takeover'
      ? await leases.takeoverLease(principal, fileId)
      : await leases.acquireLease(principal, fileId)
    sendJson(res, 200, issued)
    return true
  }
  const body = await readJson(req)
  if (commit) {
    rejectUnknown(body, ['fileId', 'uploadId', 'baseRevision', 'idempotencyKey', 'leaseEpoch', 'sourceCommandId'])
    if (body.fileId !== fileId) throw revisionError('INVALID', 400, '文件编号无效')
    const saved = await revisions.commitRevision(principal, {
      fileId,
      uploadId: assertUploadId(body.uploadId),
      baseRevision: assertRevisionId(body.baseRevision),
      idempotencyKey: assertIdempotencyKey(body.idempotencyKey),
      leaseEpoch: assertLeaseEpoch(body.leaseEpoch),
      sourceCommandId: assertSourceCommand(body.sourceCommandId),
    })
    await project(ctx, principal, fileId)
    sendJson(res, 200, saved.ref)
    return true
  }
  rejectUnknown(body, ['sourceRevision', 'baseRevision', 'leaseEpoch', 'idempotencyKey'])
  const saved = await revisions.restoreRevision(principal, {
    fileId,
    sourceRevision: assertRevisionId(body.sourceRevision),
    baseRevision: assertRevisionId(body.baseRevision),
    leaseEpoch: assertLeaseEpoch(body.leaseEpoch),
    idempotencyKey: assertIdempotencyKey(body.idempotencyKey),
  })
  await project(ctx, principal, fileId)
  sendJson(res, 200, saved.ref)
  return true
}
