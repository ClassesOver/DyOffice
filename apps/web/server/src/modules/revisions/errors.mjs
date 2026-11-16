const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PRINCIPAL_PART = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/

/** Suggested single-writer lease lifetime. Callers renew before this elapses. */
export const LEASE_TTL_MS = 45_000

const MESSAGES = {
  REVISION_CONFLICT: '版本冲突，文档已被更新',
  LEASE_CONFLICT: '编辑租约已失效',
  LEASE_HELD: '文件正由另一个编辑会话占用',
  IDEMPOTENCY_CONFLICT: '幂等键已用于不同内容',
  NOT_FOUND: '文件不存在',
  JOURNAL_FAILED: '版本事务失败',
  HASH_MISMATCH: '存储的文件不可用',
  INVALID: '请求无效',
  UNAUTHENTICATED: '请登录',
}

export function revisionError(code, status, message = MESSAGES[code] || code) {
  return Object.assign(new Error(message), { code, status, publicCode: code })
}

export function assertPrincipal(principal) {
  if (!principal || typeof principal !== 'object') throw revisionError('UNAUTHENTICATED', 401)
  if (typeof principal.ownerId !== 'string' || !PRINCIPAL_PART.test(principal.ownerId)) throw revisionError('UNAUTHENTICATED', 401)
  if (typeof principal.deploymentId !== 'string' || !PRINCIPAL_PART.test(principal.deploymentId)) throw revisionError('UNAUTHENTICATED', 401)
  if (typeof principal.sessionId !== 'string' || principal.sessionId.length < 1 || principal.sessionId.length > 200) {
    throw revisionError('UNAUTHENTICATED', 401)
  }
  return principal
}

export function assertFileId(fileId) {
  if (typeof fileId !== 'string' || !FILE_ID.test(fileId)) throw revisionError('NOT_FOUND', 404)
  return fileId.toLowerCase()
}

export function assertUploadId(uploadId) {
  if (typeof uploadId !== 'string' || !FILE_ID.test(uploadId)) throw revisionError('NOT_FOUND', 404, '上传内容不存在')
  return uploadId.toLowerCase()
}

export function assertRevisionId(value) {
  if (typeof value !== 'string') throw revisionError('INVALID', 400, '版本号无效')
  const sha = /^sha256:([a-f0-9]{64})$/i.exec(value)
  if (sha) return `sha256:${sha[1].toLowerCase()}`
  const revision = /^rev_([a-f0-9]{32})$/i.exec(value)
  if (revision) return `rev_${revision[1].toLowerCase()}`
  throw revisionError('INVALID', 400, '版本号无效')
}

export function assertIdempotencyKey(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 200 || /[^\x21-\x7e]/.test(value)) {
    throw revisionError('INVALID', 400, '幂等键无效')
  }
  return value
}

export function assertLeaseEpoch(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw revisionError('INVALID', 400, '编辑租约无效')
  return value
}

export function assertSourceCommand(value) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) throw revisionError('INVALID', 400, '命令编号无效')
  return value
}
